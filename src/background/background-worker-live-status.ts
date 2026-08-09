import type { BackgroundWorkerProjectionV1 } from "./background-projector.js";
import { BackgroundError } from "./background-errors.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import type { ProcessIdentityProbe } from "../sessions/process-identity.js";

export type BackgroundWorkerLiveStateV1 =
  | "launching"
  | "observed_running"
  | "observed_unresponsive_owner_alive"
  | "owner_confirmed_dead"
  | "owner_unknown"
  | "reconciliation_required";

export interface BackgroundWorkerLiveObservationV1 {
  readonly evidenceLevel: "durable_only" | "process_and_heartbeat" | "process_only";
  readonly heartbeatAgeMs: number | null;
  readonly heartbeatSequence: number | null;
  readonly observedAt: string;
  readonly operationId: string;
  readonly state: BackgroundWorkerLiveStateV1;
  readonly workerId: string;
}

export async function observeBackgroundWorkerLive(input: {
  readonly current: BackgroundWorkerProjectionV1 | null;
  readonly now?: () => Date;
  readonly ownerProbe: ProcessIdentityProbe;
  readonly userStateRoot: string;
}): Promise<BackgroundWorkerLiveObservationV1 | null> {
  const current = input.current;
  if (current === null) return null;
  const now = input.now?.() ?? new Date();
  const observedAt = now.toISOString();
  let store: BackgroundOperationStore;
  try {
    store = await BackgroundOperationStore.openExisting({
      operationId: current.operationId,
      repositoryId: current.repositoryId,
      root: input.userStateRoot,
    });
  } catch {
    return Object.freeze({
      evidenceLevel: "durable_only",
      heartbeatAgeMs: null,
      heartbeatSequence: null,
      observedAt,
      operationId: current.operationId,
      state: "reconciliation_required",
      workerId: current.workerId,
    });
  }
  const [handoff, heartbeat] = await Promise.all([store.readHandoff(), store.readHeartbeat()]);
  if (
    handoff === null || handoff.operationId !== current.operationId || handoff.workerId !== current.workerId ||
    handoff.graphSha256 !== current.graphSha256 || handoff.workerNonceSha256 !== current.workerNonceSha256
  ) {
    throw new BackgroundError("worker_reconciliation_required", "live worker handoff does not match durable session identity");
  }
  if (handoff.state === "reconciliation_required" || current.status === "reconciliation_required") {
    return Object.freeze({
      evidenceLevel: "durable_only",
      heartbeatAgeMs: null,
      heartbeatSequence: null,
      observedAt,
      operationId: current.operationId,
      state: "reconciliation_required",
      workerId: current.workerId,
    });
  }
  if (handoff.owner === "parent" && handoff.state === "launching") {
    return Object.freeze({
      evidenceLevel: "durable_only",
      heartbeatAgeMs: null,
      heartbeatSequence: null,
      observedAt,
      operationId: current.operationId,
      state: "launching",
      workerId: current.workerId,
    });
  }
  const process = await input.ownerProbe.probe({ pid: handoff.ownerPid, startIdentity: handoff.ownerProcessStartIdentity });
  const matchingHeartbeat = heartbeat !== null &&
    heartbeat.operationId === current.operationId && heartbeat.workerId === current.workerId &&
    heartbeat.workerNonceSha256 === current.workerNonceSha256 && heartbeat.graphSha256 === current.graphSha256 &&
    heartbeat.workerPid === handoff.ownerPid && heartbeat.workerProcessStartIdentity === handoff.ownerProcessStartIdentity;
  const heartbeatAgeMs = matchingHeartbeat ? Math.max(0, now.getTime() - Date.parse(heartbeat.observedAt)) : null;
  const base = {
    heartbeatAgeMs,
    heartbeatSequence: matchingHeartbeat ? heartbeat.sequence : null,
    observedAt,
    operationId: current.operationId,
    workerId: current.workerId,
  } as const;
  if (process === "missing" || process === "different") {
    return Object.freeze({ ...base, evidenceLevel: "process_only", state: "owner_confirmed_dead" });
  }
  if (process !== "matching") {
    return Object.freeze({ ...base, evidenceLevel: "durable_only", state: "owner_unknown" });
  }
  if (heartbeatAgeMs === null || heartbeatAgeMs > 20_000) {
    return Object.freeze({ ...base, evidenceLevel: matchingHeartbeat ? "process_and_heartbeat" : "process_only", state: "observed_unresponsive_owner_alive" });
  }
  return Object.freeze({ ...base, evidenceLevel: "process_and_heartbeat", state: "observed_running" });
}
