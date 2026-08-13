import { z } from "zod";

import type { CliIO, CliRuntime } from "../../cli/types.js";
import { canonicalJson } from "../../completion/canonical-json.js";
import { childReceiptSchema } from "../../delegation/receipts/child-receipt-schema.js";
import { taskNodeReceiptSchema } from "../../task-graph/task-node-receipt.js";
import { taskGraphRevisionContentSchema } from "../../task-graph/task-graph-schema.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { originVerificationReceiptSchema } from "../../worktrees/origin-verification-receipt.js";
import {
  applicationPaginationCursorV1Schema,
  expectedResourceVersionV1Schema,
  type ApplicationEnvelopeV1,
  type ApplicationPaginationCursorV1,
  type ExpectedResourceVersionV1,
  type SessionLiveObservationV1,
} from "../application-protocol.js";
import type {
  DelegationDoctorQueryResultV1,
  DelegationParentQueryResultV1,
  DelegationReceiptQueryResultV1,
  DelegationSummariesQueryResultV1,
  GraphLogsQueryResultV1,
  GraphRevisionQueryResultV1,
  GraphStatusQueryResultV1,
  GraphWorktreesQueryResultV1,
  PlanReviewQueryResultV1,
} from "../use-cases/task-surface-queries.js";
import {
  adoptLegacySessionThroughApplicationService,
  contextForRuntime,
  planeForRuntime,
  registerCurrentRepository,
} from "./agent-cli-adapter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const NODE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const FORBIDDEN_KEYS = new Set([
  "application_cancel_request",
  "application_commit",
  "envelopePath",
  "first_raw_event_sha256",
  "objectRef",
  "productEntrypointPath",
  "raw_event_sha256",
  "request_event_sha256",
  "resultPath",
  "runtimeExecutablePath",
  "session_file_path",
]);

export type TaskSurfaceCliQueryResultV1<TResult> = Readonly<{
  readonly exitCode: 0 | 1 | 2 | 8;
  readonly value: TResult | null;
}>;

export type GraphLogsCliQueryResultV1 = GraphLogsQueryResultV1 & Readonly<{
  readonly nextCursor: string | null;
}>;

type SessionVersion = Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }>;

const graphCursorSchema = z.object({
  pageCursor: applicationPaginationCursorV1Schema,
  resourceVersion: expectedResourceVersionV1Schema.refine(
    (value): value is SessionVersion => value.kind === "session_ledger_head",
  ),
  schemaVersion: z.literal(1),
}).strict();

function failureExit(envelope: ApplicationEnvelopeV1<unknown>): 1 | 2 | 8 {
  const code = envelope.error?.code ?? "control_operation_corrupt";
  if ([
    "control_catalog_conflict",
    "control_operation_busy",
    "control_resync_required",
    "control_session_not_started",
    "control_stale_projection",
  ].includes(code)) return 8;
  return [
    "control_authentication_failed",
    "control_authorization_denied",
    "control_payload_invalid",
    "control_query_unknown",
    "control_target_invalid",
  ].includes(code) ? 2 : 1;
}

function failure<TResult>(
  envelope: ApplicationEnvelopeV1<unknown>,
  io: CliIO,
): TaskSurfaceCliQueryResultV1<TResult> {
  io.stderr.write(`${envelope.error?.code ?? "control_operation_corrupt"}: ${envelope.error?.message ?? "application query failed"}\n`);
  return Object.freeze({ exitCode: failureExit(envelope), value: null });
}

function corrupt<TResult>(io: CliIO, message: string): TaskSurfaceCliQueryResultV1<TResult> {
  io.stderr.write(`control_operation_corrupt: ${message}\n`);
  return Object.freeze({ exitCode: 1, value: null });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, depth + 1));
  return Object.entries(value as Readonly<Record<string, unknown>>).some(
    ([key, entry]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(entry, depth + 1),
  );
}

function isGraphIdentity(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return UUID.test(String(value.graphId ?? "")) && SHA256.test(String(value.graphSha256 ?? "")) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) > 0 && typeof value.status === "string";
}

function isSurfaceGraphRevision(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, [
    "approvedEventId", "artifact", "binding", "content", "createdEventId", "decisionEventId",
    "graphId", "graphSha256", "revision", "status", "terminalEventId",
  ])) return false;
  const artifact = value.artifact;
  if (!isRecord(artifact) || !exactKeys(artifact, ["artifactId", "bytes", "sha256"])) return false;
  return UUID.test(String(value.graphId ?? "")) && SHA256.test(String(value.graphSha256 ?? "")) &&
    UUID.test(String(value.createdEventId ?? "")) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) > 0 &&
    typeof value.status === "string" && typeof artifact.artifactId === "string" &&
    Number.isSafeInteger(artifact.bytes) && (artifact.bytes as number) >= 0 && SHA256.test(String(artifact.sha256 ?? "")) &&
    taskGraphRevisionContentSchema.safeParse(value.content).success;
}

function isGraphRevisionResult(value: unknown): value is GraphRevisionQueryResultV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "current", "currentApproved", "currentDraft", "currentExecution", "currentObservation", "revisions", "revisionsTruncated", "trackingMode",
  ])) return false;
  return (value.current === null || isSurfaceGraphRevision(value.current)) && Array.isArray(value.revisions) &&
    value.revisions.length <= 100 && value.revisions.every(isSurfaceGraphRevision) &&
    typeof value.revisionsTruncated === "boolean" &&
    ["current", "stale", "unavailable"].includes(String(value.currentObservation)) && typeof value.trackingMode === "string";
}

function isPlanReviewResult(value: unknown): value is PlanReviewQueryResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["plan"])) return false;
  if (value.plan === null) return true;
  if (!isRecord(value.plan) || !isRecord(value.plan.content) || !Array.isArray(value.plan.items)) return false;
  return UUID.test(String(value.plan.content.planId ?? "")) &&
    Number.isSafeInteger(value.plan.content.revision) && (value.plan.content.revision as number) > 0 &&
    SHA256.test(String(value.plan.planSha256 ?? "")) && typeof value.plan.status === "string";
}

function isGraphStatusResult(value: unknown): value is GraphStatusQueryResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["background", "execution", "graph", "worktrees"])) return false;
  if (!isBackgroundDocument(value.background) || !isWorktreesDocument(value.worktrees, false) || !isGraphIdentity(value.graph)) return false;
  if (value.execution === null) return true;
  if (!isRecord(value.execution) || !exactKeys(value.execution, [
    "activeAttempt", "blocker", "budget", "enqueue", "graph", "lastSessionSeq", "nodes", "readyNodeIds", "schedulerLeaseNonceSha256", "status",
  ]) || !isGraphIdentity(value.execution.graph) || !Array.isArray(value.execution.nodes) ||
      !Array.isArray(value.execution.readyNodeIds)) return false;
  return value.execution.nodes.every((node) => isRecord(node) && NODE_ID.test(String(node.nodeId ?? "")) &&
    Array.isArray(node.attempts) && typeof node.status === "string") && typeof value.execution.status === "string";
}

function isBackgroundDocument(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["current", "lastSessionSeq", "workers"]) ||
      !Number.isSafeInteger(value.lastSessionSeq) || !Array.isArray(value.workers) || value.workers.length > 128) return false;
  const worker = (candidate: unknown): boolean => isRecord(candidate) && exactKeys(candidate, [
    "acceptedControlIds", "descriptorSha256", "graphId", "graphRevision", "graphSha256", "operationId", "repositoryId",
    "spawnEventId", "startedEventId", "status", "terminal", "workerId", "workerNonceSha256",
  ]) && Array.isArray(candidate.acceptedControlIds) && candidate.acceptedControlIds.length <= 128 &&
    SHA256.test(String(candidate.descriptorSha256 ?? "")) && UUID.test(String(candidate.graphId ?? "")) &&
    Number.isSafeInteger(candidate.graphRevision) && SHA256.test(String(candidate.graphSha256 ?? "")) &&
    UUID.test(String(candidate.operationId ?? "")) && UUID.test(String(candidate.workerId ?? "")) && typeof candidate.status === "string";
  return (value.current === null || worker(value.current)) && value.workers.every(worker);
}

function isGraphLogsResult(value: unknown): value is GraphLogsQueryResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["graph", "records"]) || !isGraphIdentity(value.graph) ||
      !Array.isArray(value.records) || value.records.length > 20) return false;
  return value.records.every((record) => {
    if (!isRecord(record) || !Number.isSafeInteger(record.sessionSeq) || (record.sessionSeq as number) < 1 ||
        !NODE_ID.test(String(record.nodeId ?? ""))) return false;
    if (record.kind === "origin_verification") {
      return exactKeys(record, ["kind", "nodeId", "promotionOperationId", "receipt", "sessionSeq", "status", "verificationId"]) &&
        originVerificationReceiptSchema.safeParse(record.receipt).success;
    }
    return record.kind === "node_attempt" &&
      exactKeys(record, ["attemptId", "kind", "nodeId", "receipt", "sessionSeq", "terminal"]) &&
      UUID.test(String(record.attemptId ?? "")) &&
      (record.receipt === null || taskNodeReceiptSchema.safeParse(record.receipt).success);
  });
}

function isGraphWorktreesResult(value: unknown): value is GraphWorktreesQueryResultV1 {
  return isWorktreesDocument(value, true);
}

function isWorktreesDocument(value: unknown, withGraph: boolean): boolean {
  if (!isRecord(value) || !exactKeys(value, withGraph
    ? ["graph", "originVerifications", "pendingOperationIds", "promotions", "workspaces"]
    : ["originVerifications", "pendingOperationIds", "promotions", "workspaces"])) return false;
  if (withGraph && value.graph !== null && !isSurfaceGraphRevision(value.graph)) return false;
  return Array.isArray(value.originVerifications) && value.originVerifications.length <= 256 &&
    Array.isArray(value.pendingOperationIds) && value.pendingOperationIds.length <= 256 &&
    Array.isArray(value.promotions) && value.promotions.length <= 256 &&
    Array.isArray(value.workspaces) && value.workspaces.length <= 256 &&
    value.workspaces.every((workspace) => isRecord(workspace) && exactKeys(workspace, [
      "activeAttemptId", "baselineSha256", "lastSnapshotSha256", "nodeIds", "sourceNodeId", "status", "workspaceId",
    ]) && UUID.test(String(workspace.workspaceId ?? "")) && NODE_ID.test(String(workspace.sourceNodeId ?? "")) &&
      SHA256.test(String(workspace.baselineSha256 ?? "")) && Array.isArray(workspace.nodeIds));
}

function isDelegationSummary(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, [
    "authority", "budget", "child", "context", "delegationId", "objective", "parent", "receipt", "revision",
    "schemaVersion", "sequence", "sha256", "status", "title", "workspace",
  ])) return false;
  return value.schemaVersion === 1 && UUID.test(String(value.delegationId ?? "")) && SHA256.test(String(value.sha256 ?? "")) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) > 0 && Number.isSafeInteger(value.sequence) &&
    typeof value.status === "string" && typeof value.title === "string" && typeof value.objective === "string" && isRecord(value.authority) &&
    isRecord(value.budget) && isRecord(value.child) && isRecord(value.context) && isRecord(value.parent) &&
    isRecord(value.receipt) && isRecord(value.workspace);
}

function isDelegationSummariesResult(value: unknown): value is DelegationSummariesQueryResultV1 {
  return isRecord(value) && exactKeys(value, ["records", "truncated"]) && Array.isArray(value.records) &&
    value.records.length <= 200 && typeof value.truncated === "boolean" && value.records.every(isDelegationSummary);
}

function isDelegationParentResult(value: unknown): value is DelegationParentQueryResultV1 {
  return isRecord(value) && exactKeys(value, ["parentRunId"]) && UUID.test(String(value.parentRunId ?? ""));
}

function isDelegationReceiptResult(value: unknown): value is DelegationReceiptQueryResultV1 {
  return isRecord(value) && exactKeys(value, ["receipt"]) && childReceiptSchema.safeParse(value.receipt).success;
}

function isDelegationDoctorResult(value: unknown): value is DelegationDoctorQueryResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["activeActorSlots", "activeConflictClaims", "operations", "trackingMode"]) ||
      !Number.isSafeInteger(value.activeActorSlots) || !Number.isSafeInteger(value.activeConflictClaims) ||
      !Array.isArray(value.operations) || value.operations.length > 128 || typeof value.trackingMode !== "string") return false;
  return value.operations.every((operation) => isRecord(operation) && exactKeys(operation, [
    "childAttemptId", "childRunId", "delegationId", "operationId", "operationSha256", "reconcile", "state",
  ]) && UUID.test(String(operation.childAttemptId ?? "")) && UUID.test(String(operation.childRunId ?? "")) &&
    UUID.test(String(operation.delegationId ?? "")) && UUID.test(String(operation.operationId ?? "")) &&
    SHA256.test(String(operation.operationSha256 ?? "")) && isRecord(operation.reconcile));
}

async function querySurface<TResult>(input: Readonly<{
  readonly atVersion?: SessionVersion | null;
  readonly io: CliIO;
  readonly pageCursor?: ApplicationPaginationCursorV1 | null;
  readonly payload: unknown;
  readonly queryKind: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface?: "cli" | "tui";
  readonly validate: (value: unknown) => value is TResult;
}>): Promise<TaskSurfaceCliQueryResultV1<Readonly<{
  readonly nextPageCursor: ApplicationPaginationCursorV1 | null;
  readonly resourceVersion: SessionVersion;
  readonly liveObservation: SessionLiveObservationV1 | null;
  readonly value: TResult;
}>>> {
  if (input.runtime.controlPlaneStateRoot === undefined) throw new TypeError("application control state root is unavailable");
  const plane = await planeForRuntime(input.runtime, input.io);
  const context = contextForRuntime(plane, input.runtime, input.surface ?? "cli");
  const repository = await registerCurrentRepository(plane, context, input.runtime, input.io);
  if (!("repositoryId" in repository)) return failure(repository, input.io);
  const queryOnce = async () => plane.queries.query(context, {
    atVersion: input.atVersion ?? null,
    pageCursor: input.pageCursor ?? null,
    payload: input.payload,
    queryKind: input.queryKind,
    requestId: input.runtime.randomUUID(),
    resourceScope: {
      kind: "session" as const,
      repositoryId: repository.repositoryId,
      sessionId: input.sessionId,
      teamId: null,
    },
    schemaVersion: 1 as const,
  });
  let response = await queryOnce();
  if (response.status !== "ok" && response.error?.code === "control_authorization_denied") {
    // PHASE21: a product query always crosses the authorized named-query
    // boundary first. Only a missing catalog entry may then enter the typed
    // legacy-adoption action and retry; adapters never probe raw session files.
    const adopted = await adoptLegacySessionThroughApplicationService(
      plane,
      context,
      input.runtime,
      repository.repositoryId,
      input.sessionId,
      input.io,
    );
    if ("status" in adopted) return failure(adopted, input.io);
    response = await queryOnce();
  }
  if (response.status !== "ok" || response.result === null) return failure(response, input.io);
  if (
    response.resourceScope?.kind !== "session" ||
    response.resourceScope.repositoryId !== repository.repositoryId ||
    response.resourceScope.sessionId !== input.sessionId ||
    response.resourceVersion?.kind !== "session_ledger_head" ||
    containsForbiddenKey(response.result.value) ||
    !input.validate(response.result.value)
  ) {
    return corrupt(input.io, `${input.queryKind} failed its strict typed result contract`);
  }
  return Object.freeze({
    exitCode: 0,
    value: Object.freeze({
      nextPageCursor: response.result.nextPageCursor,
      resourceVersion: response.resourceVersion,
      liveObservation: response.liveObservation,
      value: response.result.value,
    }),
  });
}

function decodeGraphCursor(value: string | undefined): Readonly<{
  readonly pageCursor: ApplicationPaginationCursorV1 | null;
  readonly resourceVersion: SessionVersion | null;
}> {
  if (value === undefined) return Object.freeze({ pageCursor: null, resourceVersion: null });
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw new RangeError("Graph log cursor is invalid");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength < 2 || bytes.byteLength > 1536) throw new RangeError("cursor bound exceeded");
    const parsed = graphCursorSchema.parse(parseStrictJson(bytes.toString("utf8")));
    return Object.freeze({ pageCursor: parsed.pageCursor, resourceVersion: parsed.resourceVersion });
  } catch (error) {
    throw new RangeError("Graph log cursor is invalid", { cause: error });
  }
}

function encodeGraphCursor(pageCursor: ApplicationPaginationCursorV1 | null, resourceVersion: SessionVersion): string | null {
  return pageCursor === null ? null : Buffer.from(canonicalJson({
    pageCursor,
    resourceVersion,
    schemaVersion: 1,
  }), "utf8").toString("base64url");
}

export async function queryGraphRevisionsThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly revision: number | null;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<TaskSurfaceCliQueryResultV1<GraphRevisionQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: { revision: input.revision }, queryKind: "graph.revisions", validate: isGraphRevisionResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryPlanReviewThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly planId: string;
  readonly revision: number;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly sha256: string;
}>): Promise<TaskSurfaceCliQueryResultV1<PlanReviewQueryResultV1>> {
  const queried = await querySurface({
    ...input,
    payload: { planId: input.planId, revision: input.revision, sha256: input.sha256 },
    queryKind: "plan.review",
    validate: isPlanReviewResult,
  });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryGraphStatusThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly live: boolean;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<TaskSurfaceCliQueryResultV1<Readonly<{
  readonly liveObservation: SessionLiveObservationV1 | null;
  readonly status: GraphStatusQueryResultV1;
}>>> {
  const queried = await querySurface({ ...input, payload: { live: input.live }, queryKind: "graph.status", validate: isGraphStatusResult });
  return Object.freeze({
    exitCode: queried.exitCode,
    value: queried.value === null ? null : Object.freeze({
      liveObservation: queried.value.liveObservation,
      status: queried.value.value,
    }),
  });
}

export async function queryGraphLogsThroughApplicationService(input: Readonly<{
  readonly cursor?: string;
  readonly io: CliIO;
  readonly nodeId: string | null;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<TaskSurfaceCliQueryResultV1<GraphLogsCliQueryResultV1>> {
  const continuation = decodeGraphCursor(input.cursor);
  const queried = await querySurface({
    atVersion: continuation.resourceVersion,
    io: input.io,
    pageCursor: continuation.pageCursor,
    payload: { limit: 20, nodeId: input.nodeId },
    queryKind: "graph.logs",
    runtime: input.runtime,
    sessionId: input.sessionId,
    validate: isGraphLogsResult,
  });
  return Object.freeze({
    exitCode: queried.exitCode,
    value: queried.value === null ? null : Object.freeze({
      ...queried.value.value,
      nextCursor: encodeGraphCursor(queried.value.nextPageCursor, queried.value.resourceVersion),
    }),
  });
}

export async function queryGraphWorktreesThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<TaskSurfaceCliQueryResultV1<GraphWorktreesQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: {}, queryKind: "graph.worktrees", validate: isGraphWorktreesResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryDelegationSummariesThroughApplicationService(input: Readonly<{
  readonly delegationId: string | null;
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly status: string | null;
  readonly surface?: "cli" | "tui";
}>): Promise<TaskSurfaceCliQueryResultV1<DelegationSummariesQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: { delegationId: input.delegationId, limit: 200, status: input.status }, queryKind: "delegation.summaries", validate: isDelegationSummariesResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryDelegationParentThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface?: "cli" | "tui";
}>): Promise<TaskSurfaceCliQueryResultV1<DelegationParentQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: {}, queryKind: "delegation.parent", validate: isDelegationParentResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryDelegationReceiptThroughApplicationService(input: Readonly<{
  readonly delegationId: string;
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly surface?: "cli" | "tui";
}>): Promise<TaskSurfaceCliQueryResultV1<DelegationReceiptQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: { delegationId: input.delegationId }, queryKind: "delegation.receipt", validate: isDelegationReceiptResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}

export async function queryDelegationDoctorThroughApplicationService(input: Readonly<{
  readonly delegationId: string | null;
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
  readonly status: string | null;
  readonly surface?: "cli" | "tui";
}>): Promise<TaskSurfaceCliQueryResultV1<DelegationDoctorQueryResultV1>> {
  const queried = await querySurface({ ...input, payload: { delegationId: input.delegationId, limit: 128, status: input.status }, queryKind: "delegation.doctor", validate: isDelegationDoctorResult });
  return Object.freeze({ exitCode: queried.exitCode, value: queried.value?.value ?? null });
}
