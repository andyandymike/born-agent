import type { BackgroundWorkerProjectionV1 } from "./background-projector.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { persistedTaskUserOrigin, type AuthenticatedTaskMutationBindingV1 } from "../coordination/task-control-plane.js";
import { BackgroundError } from "./background-errors.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import { graphWorkerCancelControlSchema, type GraphWorkerCancelControlV1 } from "./background-schema.js";

export async function queueBackgroundWorkerCancel(input: {
  readonly authenticatedMutation?: AuthenticatedTaskMutationBindingV1;
  readonly current: BackgroundWorkerProjectionV1 | null;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly now: () => string;
  readonly randomUuid: () => string;
  readonly reason: string;
  readonly repositoryId?: string;
  readonly requestId?: string;
  readonly requestedAt?: string;
  readonly sessionCancel?: Readonly<{ readonly eventId: string; readonly rawEventSha256: string; readonly sessionSeq: number }>;
  readonly sessionId?: string;
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
  const authenticated = input.authenticatedMutation;
  const isApplicationControl = authenticated !== undefined;
  const reason = isApplicationControl ? input.reason : input.reason.trim();
  if (isApplicationControl && (
    input.requestId === undefined || input.repositoryId === undefined || input.sessionId === undefined || input.sessionCancel === undefined ||
    authenticated.applicationCommit.actionKind !== "graph.cancel" ||
    authenticated.applicationCommit.operationId !== input.requestId ||
    current.repositoryId !== input.repositoryId
  )) {
    throw new BackgroundError("worker_protocol_mismatch", "background cancel application binding is incomplete or inconsistent");
  }
  const control = graphWorkerCancelControlSchema.parse({
    graphId: current.graphId,
    graphRevision: current.graphRevision,
    graphSha256: current.graphSha256,
    operationId: current.operationId,
    reason,
    ...(isApplicationControl ? {
      origin: persistedTaskUserOrigin(
        authenticated.surface.surface === "tui" ? "tui" : "cli",
        authenticated,
      ),
      repositoryId: input.repositoryId,
      sessionCancel: input.sessionCancel,
      sessionId: input.sessionId,
    } : {}),
    requestId: input.requestId ?? input.randomUuid(),
    requestedAt: input.requestedAt ?? input.now(),
    schemaVersion: isApplicationControl ? 2 : 1,
    workerId: current.workerId,
    workerNonceSha256: current.workerNonceSha256,
  });
  const durable = isApplicationControl ? await store.createCancelIdempotent(control) : (await store.createCancel(control), control);
  return Object.freeze({ control: Object.freeze(durable), controlSha256: sha256Canonical(durable) });
}
