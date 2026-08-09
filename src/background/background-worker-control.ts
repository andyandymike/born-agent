import type { BackgroundWorkerProjectionV1 } from "./background-projector.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { BackgroundError } from "./background-errors.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import { graphWorkerCancelControlSchema, type GraphWorkerCancelControlV1 } from "./background-schema.js";

export async function queueBackgroundWorkerCancel(input: {
  readonly current: BackgroundWorkerProjectionV1 | null;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly now: () => string;
  readonly randomUuid: () => string;
  readonly reason: string;
  readonly userStateRoot: string;
}): Promise<{ readonly control: GraphWorkerCancelControlV1; readonly controlSha256: string }> {
  const current = input.current;
  if (
    current === null || current.status !== "running" || current.graphRevision !== input.graphRevision ||
    current.graphSha256 !== input.graphSha256
  ) {
    throw new BackgroundError("worker_control_stale", "cancel selector does not exact-match the current background worker");
  }
  const store = await BackgroundOperationStore.openExisting({
    operationId: current.operationId,
    repositoryId: current.repositoryId,
    root: input.userStateRoot,
  });
  const handoff = await store.readHandoff();
  if (
    handoff === null || handoff.owner !== "worker" || handoff.state !== "worker_owned" ||
    handoff.operationId !== current.operationId || handoff.workerId !== current.workerId ||
    handoff.workerNonceSha256 !== current.workerNonceSha256 || handoff.graphSha256 !== current.graphSha256
  ) {
    throw new BackgroundError("worker_control_stale", "background worker no longer owns the exact handoff");
  }
  const reason = input.reason.trim();
  const control = graphWorkerCancelControlSchema.parse({
    graphId: current.graphId,
    graphRevision: current.graphRevision,
    graphSha256: current.graphSha256,
    operationId: current.operationId,
    reason,
    requestId: input.randomUuid(),
    requestedAt: input.now(),
    schemaVersion: 1,
    workerId: current.workerId,
    workerNonceSha256: current.workerNonceSha256,
  });
  await store.createCancel(control);
  return Object.freeze({ control: Object.freeze(control), controlSha256: sha256Canonical(control) });
}
