import { sha256Canonical } from "../completion/canonical-json.js";
import { taskMutationBlocker, type TaskMutationContext, type TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import type { ProcessIdentityProbe } from "../sessions/process-identity.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { Phase19TaskGraphSessionEventData } from "../task-graph/task-graph-event-schema.js";
import { BackgroundError } from "./background-errors.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import { backgroundHandoffRecordSchema, backgroundHandoffTransitionId } from "./background-schema.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

export interface BackgroundWorkerTakeoverResultV1 {
  readonly observation: "not_started" | "owner_dead_clean";
  readonly operationId: string;
  readonly reconciledEventId: string;
  readonly schemaVersion: 1;
  readonly workerId: string;
}

type CleanTakeoverObservation = BackgroundWorkerTakeoverResultV1["observation"];

function isCleanTakeoverObservation(value: string): value is CleanTakeoverObservation {
  return value === "not_started" || value === "owner_dead_clean";
}

/**
 * V1 takeover is intentionally narrow: it closes only a dead worker that has
 * not started a Graph attempt and whose session effect ledger is clean. It
 * never adopts a running attempt, guesses from heartbeat age, or reuses an
 * approval. The caller may then launch a fresh background owner.
 */
export class BackgroundWorkerTakeoverReconciler {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly ownerProbe: ProcessIdentityProbe;
    readonly userStateRoot: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  async reconcile(input: {
    readonly graphRevision: number;
    readonly graphSha256: string;
  }): Promise<BackgroundWorkerTakeoverResultV1> {
    const writer = await (this.options.writerFactory ?? defaultWriterFactory)(this.options.context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      const worker = session.background.current;
      const execution = session.taskExecution;
      if (
        execution === null ||
        execution.status !== "queued" ||
        execution.activeAttempt !== null ||
        execution.enqueue.requestedExecution !== "background" ||
        execution.graph.revision !== input.graphRevision ||
        execution.graph.graphSha256 !== input.graphSha256
      ) {
        throw new BackgroundError("worker_reconciliation_required", "takeover is forbidden after a Graph attempt starts");
      }
      const blocker = taskMutationBlocker(session);
      if (blocker !== null) {
        throw new BackgroundError("worker_reconciliation_required", blocker.details.join(", "));
      }

      if (worker === null) {
        const matchingLifecycle = writer.events.filter((event) => {
          if (event.scope !== "session" || !event.type.startsWith("task_worker.")) return false;
          const data = event.data as { readonly graph_revision?: number; readonly graph_sha256?: string };
          return data.graph_revision === input.graphRevision && data.graph_sha256 === input.graphSha256;
        });
        const lastLifecycle = matchingLifecycle.at(-1);
        if (lastLifecycle?.type !== "task_worker.reconciled") {
          throw new BackgroundError("worker_control_stale", "takeover has no exact live or recoverable durable worker identity");
        }
        const reconciled = lastLifecycle.data as Phase19TaskGraphSessionEventData<"task_worker.reconciled">;
        if (!isCleanTakeoverObservation(reconciled.observation)) {
          throw new BackgroundError("worker_reconciliation_required", "takeover cannot recover an unknown worker observation");
        }
        const duplicateCount = matchingLifecycle.filter((event) => {
          if (event.type !== "task_worker.reconciled") return false;
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worker.reconciled">;
          return data.operation_id === reconciled.operation_id && data.worker_id === reconciled.worker_id &&
            isCleanTakeoverObservation(data.observation);
        }).length;
        if (duplicateCount !== 1) {
          throw new BackgroundError("worker_handoff_conflict", "takeover contains duplicate clean reconciliation events");
        }
        const historicalWorker = session.background.workers.find((candidate) =>
          candidate.operationId === reconciled.operation_id && candidate.workerId === reconciled.worker_id
        );
        if (
          historicalWorker === undefined ||
          historicalWorker.status !== "terminal" ||
          historicalWorker.graphId !== reconciled.graph_id ||
          historicalWorker.graphRevision !== reconciled.graph_revision ||
          historicalWorker.graphSha256 !== reconciled.graph_sha256
        ) {
          throw new BackgroundError("worker_protocol_mismatch", "takeover reconciliation has no exact historical worker identity");
        }
        const store = await BackgroundOperationStore.openExisting({
          operationId: historicalWorker.operationId,
          repositoryId: historicalWorker.repositoryId,
          root: this.options.userStateRoot,
        });
        const handoff = await store.readHandoff();
        const expectedOwner = historicalWorker.startedEventId === null ? "parent" : "worker";
        const expectedState = historicalWorker.startedEventId === null ? "launching" : "worker_owned";
        if (
          handoff === null ||
          handoff.operationId !== historicalWorker.operationId ||
          handoff.workerId !== historicalWorker.workerId ||
          handoff.workerNonceSha256 !== historicalWorker.workerNonceSha256 ||
          handoff.graphSha256 !== historicalWorker.graphSha256 ||
          handoff.owner !== expectedOwner
        ) {
          throw new BackgroundError("worker_handoff_conflict", "takeover recovery handoff disagrees with the durable worker identity");
        }
        if (handoff.state === expectedState) {
          const owner = await this.options.ownerProbe.probe({
            pid: handoff.ownerPid,
            startIdentity: handoff.ownerProcessStartIdentity,
          });
          if (owner === "matching") {
            throw new BackgroundError("worker_owner_active", "takeover recovery cannot replace an active exact worker owner");
          }
          if (owner !== "missing" && owner !== "different") {
            throw new BackgroundError("worker_owner_unknown", "takeover recovery requires a confirmed dead exact process owner");
          }
          await store.compareAndSwapHandoff({
            expectedOwner,
            expectedState,
            next: backgroundHandoffRecordSchema.parse({
              ...handoff,
              state: "terminal",
              updatedAt: this.options.context.now(),
            }),
            nonce: this.options.context.randomUuid(),
            transitionId: backgroundHandoffTransitionId({
              operationId: historicalWorker.operationId,
              transition: "takeover_terminal",
              workerId: historicalWorker.workerId,
            }),
          });
        } else if (handoff.state !== "terminal") {
          throw new BackgroundError("worker_handoff_conflict", "takeover recovery handoff is neither pending nor terminal");
        }
        return Object.freeze({
          observation: reconciled.observation,
          operationId: historicalWorker.operationId,
          reconciledEventId: lastLifecycle.eventId,
          schemaVersion: 1,
          workerId: historicalWorker.workerId,
        });
      }

      if (
        (worker.status !== "launching" && worker.status !== "running") ||
        worker.graphRevision !== input.graphRevision ||
        worker.graphSha256 !== input.graphSha256
      ) {
        throw new BackgroundError("worker_control_stale", "takeover has no exact live durable worker identity");
      }
      const store = await BackgroundOperationStore.openExisting({
        operationId: worker.operationId,
        repositoryId: worker.repositoryId,
        root: this.options.userStateRoot,
      });
      const handoff = await store.readHandoff();
      const expectedOwner = worker.status === "launching" ? "parent" : "worker";
      const expectedState = worker.status === "launching" ? "launching" : "worker_owned";
      if (
        handoff === null ||
        handoff.operationId !== worker.operationId ||
        handoff.workerId !== worker.workerId ||
        handoff.workerNonceSha256 !== worker.workerNonceSha256 ||
        handoff.graphSha256 !== worker.graphSha256 ||
        handoff.owner !== expectedOwner ||
        handoff.state !== expectedState
      ) {
        throw new BackgroundError("worker_handoff_conflict", "takeover handoff disagrees with the durable worker projection");
      }
      const owner = await this.options.ownerProbe.probe({
        pid: handoff.ownerPid,
        startIdentity: handoff.ownerProcessStartIdentity,
      });
      if (owner === "matching") {
        throw new BackgroundError("worker_owner_active", "takeover cannot replace an active exact worker owner");
      }
      if (owner !== "missing" && owner !== "different") {
        throw new BackgroundError("worker_owner_unknown", "takeover requires a confirmed dead exact process owner");
      }
      const observation = worker.status === "launching" ? "not_started" : "owner_dead_clean";
      const event = await writer.appendTaskGraphEvent("task_worker.reconciled", {
        evidence_sha256: sha256Canonical({
          active_attempt: null,
          effect_ledger: "clean",
          graph_sha256: worker.graphSha256,
          handoff: sha256Canonical(handoff),
          observation,
          operation_id: worker.operationId,
          owner_process: owner,
        }),
        graph_id: worker.graphId,
        graph_revision: worker.graphRevision,
        graph_sha256: worker.graphSha256,
        observation,
        operation_id: worker.operationId,
        worker_id: worker.workerId,
      });
      await store.compareAndSwapHandoff({
        expectedOwner,
        expectedState,
        next: backgroundHandoffRecordSchema.parse({
          ...handoff,
          state: "terminal",
          updatedAt: this.options.context.now(),
        }),
        nonce: this.options.context.randomUuid(),
        transitionId: backgroundHandoffTransitionId({
          operationId: worker.operationId,
          transition: "takeover_terminal",
          workerId: worker.workerId,
        }),
      });
      return Object.freeze({
        observation,
        operationId: worker.operationId,
        reconciledEventId: event.eventId,
        schemaVersion: 1,
        workerId: worker.workerId,
      });
    } finally {
      await writer.close();
    }
  }
}
