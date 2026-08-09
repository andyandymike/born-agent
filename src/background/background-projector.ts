import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { Phase19TaskGraphSessionEventData } from "../task-graph/task-graph-event-schema.js";
import { BackgroundError } from "./background-errors.js";
import type { BackgroundExecutableDescriptorV1 } from "./background-schema.js";

export interface BackgroundWorkerProjectionV1 {
  readonly acceptedControlIds: readonly string[];
  readonly descriptor: BackgroundExecutableDescriptorV1;
  readonly descriptorSha256: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly operationId: string;
  readonly repositoryId: string;
  readonly spawnEventId: string;
  readonly startedEventId: string | null;
  readonly status: "launching" | "running" | "terminal" | "reconciliation_required";
  readonly terminal: {
    readonly eventId: string;
    readonly graphStatus: string;
    readonly processTreeCleanup: "complete" | "failed";
    readonly receiptRef: string;
    readonly receiptSha256: string;
  } | null;
  readonly workerId: string;
  readonly workerNonceSha256: string;
}

export interface BackgroundProjectionV1 {
  readonly current: BackgroundWorkerProjectionV1 | null;
  readonly lastSessionSeq: number;
  readonly workers: readonly BackgroundWorkerProjectionV1[];
}

type MutableWorker = {
  -readonly [K in keyof BackgroundWorkerProjectionV1]: K extends "acceptedControlIds"
    ? string[]
    : BackgroundWorkerProjectionV1[K];
};

function immutable(worker: MutableWorker): BackgroundWorkerProjectionV1 {
  return Object.freeze({ ...worker, acceptedControlIds: Object.freeze([...worker.acceptedControlIds]) });
}

export class BackgroundProjector {
  static project(events: readonly DecodedStoredEvent[]): BackgroundProjectionV1 {
    const workers = new Map<string, MutableWorker>();
    let current: MutableWorker | null = null;
    let lastSessionSeq = 0;
    for (const event of events) {
      lastSessionSeq = Math.max(lastSessionSeq, event.sessionSeq);
      if (event.scope !== "session") continue;
      switch (event.type) {
        case "task_worker.spawn.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.spawn.requested">;
          if (workers.has(data.operation_id) || (current !== null && ["launching", "running"].includes(current.status))) {
            throw new BackgroundError("worker_handoff_conflict", "session contains overlapping background worker ownership");
          }
          const worker: MutableWorker = {
            acceptedControlIds: [],
            descriptor: data.descriptor,
            descriptorSha256: data.descriptor_sha256,
            graphId: data.graph_id,
            graphRevision: data.graph_revision,
            graphSha256: data.graph_sha256,
            operationId: data.operation_id,
            repositoryId: data.repository_id,
            spawnEventId: event.eventId,
            startedEventId: null,
            status: "launching",
            terminal: null,
            workerId: data.worker_id,
            workerNonceSha256: data.worker_nonce_sha256,
          };
          workers.set(worker.operationId, worker);
          current = worker;
          break;
        }
        case "task_worker.started": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.started">;
          const worker = workers.get(data.operation_id);
          if (worker === undefined || worker.status !== "launching" || worker.workerId !== data.worker_id ||
              worker.workerNonceSha256 !== data.worker_nonce_sha256 || worker.descriptorSha256 !== data.descriptor_sha256 ||
              worker.graphId !== data.graph_id || worker.graphRevision !== data.graph_revision || worker.graphSha256 !== data.graph_sha256) {
            throw new BackgroundError("worker_protocol_mismatch", "worker started event has no exact spawn request");
          }
          worker.startedEventId = event.eventId;
          worker.status = "running";
          current = worker;
          break;
        }
        case "task_worker.control.accepted": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.control.accepted">;
          const worker = workers.get(data.operation_id);
          if (worker === undefined || worker.workerId !== data.worker_id || worker.status !== "running" || worker.acceptedControlIds.includes(data.request_id)) {
            throw new BackgroundError("worker_control_stale", "worker control event has no exact live owner");
          }
          worker.acceptedControlIds.push(data.request_id);
          break;
        }
        case "task_worker.terminal": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.terminal">;
          const worker = workers.get(data.operation_id);
          if (worker === undefined || worker.workerId !== data.worker_id || worker.status !== "running" ||
              worker.graphId !== data.graph_id || worker.graphRevision !== data.graph_revision || worker.graphSha256 !== data.graph_sha256) {
            throw new BackgroundError("worker_protocol_mismatch", "worker terminal event has no exact started owner");
          }
          worker.status = data.process_tree_cleanup === "complete" ? "terminal" : "reconciliation_required";
          worker.terminal = Object.freeze({
            eventId: event.eventId,
            graphStatus: data.graph_status,
            processTreeCleanup: data.process_tree_cleanup,
            receiptRef: data.receipt_ref,
            receiptSha256: data.receipt_sha256,
          });
          current = null;
          break;
        }
        case "task_worker.reconciled": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.reconciled">;
          const worker = workers.get(data.operation_id);
          if (worker === undefined || worker.workerId !== data.worker_id) {
            throw new BackgroundError("worker_protocol_mismatch", "worker reconciliation targets no operation");
          }
          if (data.observation === "unknown") {
            worker.status = "reconciliation_required";
            current = worker;
          } else {
            worker.status = "terminal";
            current = null;
          }
          break;
        }
        default:
          break;
      }
    }
    return Object.freeze({
      current: current === null ? null : immutable(current),
      lastSessionSeq,
      workers: Object.freeze([...workers.values()].map(immutable)),
    });
  }
}
