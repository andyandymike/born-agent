import { z } from "zod";

import { ArtifactStore } from "../../artifacts/artifact-store.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { canonicalDelegationIdentity } from "../../delegation/delegation-identity.js";
import type {
  DelegationProjectionV1,
} from "../../delegation/delegation-projector.js";
import {
  classifyDelegationReconcileOutcome,
  type DelegationOperationInspectionV1,
} from "../../delegation/delegation-reconciler.js";
import {
  delegationChildOperationSchema,
  type DelegationChildOperationV1,
} from "../../delegation/delegation-operation-schema.js";
import { childReceiptSchema, type ChildReceiptV1 } from "../../delegation/receipts/child-receipt-schema.js";
import { preparedChildEnvelopeSchema } from "../../delegation/context/child-envelope-schema.js";
import type {
  BackgroundProjectionV1,
  BackgroundWorkerProjectionV1,
} from "../../background/background-projector.js";
import {
  backgroundWorkerLiveObservationV1Schema,
  type BackgroundWorkerLiveObservationV1,
} from "../../background/background-worker-live-status.js";
import type { PlanRevisionProjection, TaskStateProjection } from "../../coordination/task-state-types.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { taskNodeReceiptSchema, type TaskNodeReceiptV1 } from "../../task-graph/task-node-receipt.js";
import { canonicalTaskGraphIdentity } from "../../task-graph/task-graph-identity.js";
import type {
  TaskGraphProjectionV1,
  TaskGraphRevisionProjectionV1,
} from "../../task-graph/task-graph-projector.js";
import { observeTaskGraphBinding } from "../../task-graph/task-graph-projector.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import { parseStrictJson } from "../../system/strict-json.js";
import type { WorktreeProjectionV1 } from "../../worktrees/worktree-projector.js";
import {
  originVerificationReceiptMatchesCompletedEvent,
  originVerificationReceiptSchema,
  type OriginVerificationReceiptV1,
} from "../../worktrees/origin-verification-receipt.js";
import { ApplicationControlError } from "../application-errors.js";
import { createStrictCodec, type ResourceScopeV1 } from "../application-protocol.js";
import type {
  ApplicationQueryDefinitionV1,
  ApplicationStableSnapshotV1,
} from "../application-query-registry.js";
import type {
  ProductSessionProjectionBodyV1,
  StableSessionApplicationSnapshotV1,
} from "../session-projection-service.js";

const emptyPayload = z.object({}).strict();
const graphRevisionPayload = z.object({ revision: z.number().int().positive().nullable() }).strict();
const graphLogPayload = z.object({
  limit: z.number().int().min(1).max(20),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).nullable(),
}).strict();
const delegationListPayload = z.object({
  delegationId: z.string().uuid().nullable(),
  limit: z.number().int().min(1).max(200),
  status: z.string().min(1).max(64).nullable(),
}).strict();
const delegationIdPayload = z.object({ delegationId: z.string().uuid() }).strict();
const planReviewPayload = z.object({
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export interface PlanReviewQueryResultV1 {
  readonly plan: PlanRevisionProjection | null;
}

export type GraphSurfaceRevisionV1 = Readonly<{
  readonly approvedEventId: string | null;
  readonly artifact: Readonly<{ readonly artifactId: string; readonly bytes: number; readonly sha256: string }>;
  readonly binding: TaskGraphRevisionProjectionV1["binding"];
  readonly content: TaskGraphRevisionProjectionV1["content"];
  readonly createdEventId: string;
  readonly decisionEventId: string | null;
  readonly graphId: string;
  readonly graphSha256: string;
  readonly revision: number;
  readonly status: string;
  readonly terminalEventId: string | null;
}>;

export interface GraphRevisionQueryResultV1 {
  readonly current: GraphSurfaceRevisionV1 | null;
  readonly currentApproved: TaskGraphProjectionV1["currentApproved"];
  readonly currentDraft: TaskGraphProjectionV1["currentDraft"];
  readonly currentExecution: TaskGraphProjectionV1["currentExecution"];
  readonly currentObservation: "current" | "stale" | "unavailable";
  readonly revisions: readonly GraphSurfaceRevisionV1[];
  readonly revisionsTruncated: boolean;
  readonly trackingMode: TaskGraphProjectionV1["trackingMode"];
}

export interface GraphExecutionDocumentV1 {
  readonly activeAttempt: TaskExecutionProjectionV1["activeAttempt"];
  readonly blocker: TaskExecutionProjectionV1["blocker"];
  readonly budget: TaskExecutionProjectionV1["budget"];
  readonly enqueue: TaskExecutionProjectionV1["enqueue"];
  readonly graph: Readonly<{
    readonly graphId: string;
    readonly graphSha256: string;
    readonly revision: number;
    readonly status: string;
  }>;
  readonly lastSessionSeq: number;
  readonly nodes: readonly Readonly<{
    readonly attempts: TaskExecutionProjectionV1["nodes"][number]["attempts"];
    readonly nextAttemptOrigin: TaskExecutionProjectionV1["nodes"][number]["nextAttemptOrigin"];
    readonly nodeId: string;
    readonly sequence: number;
    readonly status: string;
    readonly terminalEventId: string | null;
    readonly title: string;
  }>[];
  readonly readyNodeIds: readonly string[];
  readonly schedulerLeaseNonceSha256: string | null;
  readonly status: string;
}

export interface GraphBackgroundWorkerDocumentV1 {
  readonly acceptedControlIds: readonly string[];
  readonly descriptor: BackgroundWorkerProjectionV1["descriptor"];
  readonly descriptorSha256: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly operationId: string;
  readonly repositoryId: string;
  readonly spawnEventId: string;
  readonly startedEventId: string | null;
  readonly status: string;
  readonly terminal: Readonly<{
    readonly eventId: string;
    readonly graphStatus: string;
    readonly processTreeCleanup: string;
    readonly receiptSha256: string;
  }> | null;
  readonly workerId: string;
  readonly workerNonceSha256: string;
}

export interface GraphBackgroundDocumentV1 {
  readonly current: GraphBackgroundWorkerDocumentV1 | null;
  readonly lastSessionSeq: number;
  readonly workers: readonly GraphBackgroundWorkerDocumentV1[];
}

export interface GraphStatusQueryResultV1 {
  readonly background: GraphBackgroundDocumentV1;
  readonly execution: GraphExecutionDocumentV1 | null;
  readonly graph: Readonly<{ readonly graphId: string; readonly graphSha256: string; readonly revision: number; readonly status: string }> | null;
  readonly worktrees: Omit<GraphWorktreesQueryResultV1, "graph">;
}

export type GraphLogRecordV1 = Readonly<{
  readonly attemptId: string;
  readonly kind: "node_attempt";
  readonly nodeId: string;
  readonly receipt: TaskNodeReceiptV1 | null;
  readonly sessionSeq: number;
  readonly terminal: string;
}> | Readonly<{
  readonly kind: "origin_verification";
  readonly nodeId: string;
  readonly promotionOperationId: string;
  readonly receipt: OriginVerificationReceiptV1;
  readonly sessionSeq: number;
  readonly status: string;
  readonly verificationId: string;
}>;

export interface GraphLogsQueryResultV1 {
  readonly graph: Readonly<{ readonly graphId: string; readonly graphSha256: string; readonly revision: number; readonly status: string }> | null;
  readonly records: readonly GraphLogRecordV1[];
}

export interface GraphWorktreesQueryResultV1 {
  readonly graph: GraphSurfaceRevisionV1 | null;
  readonly originVerifications: readonly Readonly<{
    readonly promotionOperationId: string;
    readonly receiptSha256: string | null;
    readonly status: string;
    readonly verificationId: string;
    readonly verificationNodeId: string;
    readonly workspaceId: string;
  }>[];
  readonly pendingOperationIds: readonly string[];
  readonly promotions: readonly Readonly<{
    readonly bundleSha256: string;
    readonly nodeId: string;
    readonly status: string;
    readonly workspaceId: string;
  }>[];
  readonly workspaces: readonly Readonly<{
    readonly activeAttemptId: string | null;
    readonly baselineSha256: string;
    readonly lastSnapshotSha256: string | null;
    readonly nodeIds: readonly string[];
    readonly sourceNodeId: string;
    readonly status: string;
    readonly workspaceId: string;
  }>[];
}

export interface DelegationSummaryQueryResultV1 {
  readonly authority: Readonly<{ readonly capabilities: number; readonly profile: string; readonly tools: number }>;
  readonly budget: Readonly<Record<string, unknown>>;
  readonly child: Readonly<{
    readonly actorId: string | null;
    readonly attemptId: string | null;
    readonly attemptNumber: number;
    readonly model: string | null;
  }>;
  readonly context: Readonly<{ readonly bytes: number | null; readonly capsuleSha256: string | null }>;
  readonly delegationId: string;
  readonly objective: string;
  readonly parent: Readonly<{
    readonly actorId: string;
    readonly graphId: string | null;
    readonly nodeId: string | null;
    readonly runId: string;
  }>;
  readonly receipt: Readonly<{
    readonly blockers: readonly string[];
    readonly sha256: string | null;
    readonly verifiedClaims: number;
  }>;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly sha256: string;
  readonly status: string;
  readonly title: string;
  readonly workspace: Readonly<{ readonly id: string; readonly mode: string; readonly status: string }>;
}

export interface DelegationSummariesQueryResultV1 {
  readonly records: readonly DelegationSummaryQueryResultV1[];
  readonly truncated: boolean;
}

export interface DelegationParentQueryResultV1 {
  readonly parentRunId: string;
}

export interface DelegationReceiptQueryResultV1 {
  readonly receipt: ChildReceiptV1;
}

export interface DelegationDoctorQueryResultV1 {
  readonly activeActorSlots: number;
  readonly activeConflictClaims: number;
  readonly operations: readonly Omit<DelegationOperationInspectionV1, "ownerObservation">[];
  readonly trackingMode: DelegationProjectionV1["trackingMode"];
}

export interface TaskSurfaceQueryOperationPortV1 {
  readonly inspectDelegationOperationSidecars: (
    sessionId: string,
  ) => Promise<readonly DelegationChildOperationV1[]>;
  readonly observeBackgroundWorkerLive?: (input: Readonly<{
    readonly current: BackgroundProjectionV1["workers"][number];
    readonly repositoryId: string;
    readonly sessionId: string;
  }>) => Promise<BackgroundWorkerLiveObservationV1 | null>;
}

type TaskSurfaceStableSnapshotV1 = StableSessionApplicationSnapshotV1 & Readonly<{
  readonly delegationOperationSidecars?: readonly DelegationChildOperationV1[];
  readonly taskSurfaceHydration?: Readonly<{
    readonly hydrationKind: string;
    readonly payloadSha256: string;
    readonly value: unknown;
  }>;
}>;

type SessionRead = (
  scope: ResourceScopeV1,
  requested: Parameters<ApplicationQueryDefinitionV1["readStableSnapshot"]>[1],
  context?: Parameters<ApplicationQueryDefinitionV1["readStableSnapshot"]>[2],
) => Promise<ApplicationStableSnapshotV1<StableSessionApplicationSnapshotV1>>;

type RepositoryReadPort = Readonly<{
  get(id: string): Promise<Readonly<{ readonly status: string }> | null>;
  readRoot(registration: Readonly<{ readonly status: string }>): Promise<string>;
}>;

function deepFreezeHydration<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeHydration(entry);
  } else {
    for (const entry of Object.values(value)) deepFreezeHydration(entry);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function hydratedSessionRead(input: Readonly<{
  readonly hydrate: (snapshot: StableSessionApplicationSnapshotV1, payload: unknown) => Promise<unknown>;
  readonly hydrationKind: string;
  readonly maximumHydrationBytes: number;
  readonly readSessionSnapshot: SessionRead;
}>): SessionRead {
  return async (scope, requested, context) => {
    if (context === undefined) {
      throw new ApplicationControlError("control_operation_corrupt", "query hydration requires its decoded payload binding");
    }
    const stable = await input.readSessionSnapshot(scope, requested, context);
    const value = deepFreezeHydration(await input.hydrate(stable.snapshot, context.payload));
    const hydration = Object.freeze({
      hydrationKind: input.hydrationKind,
      payloadSha256: sha256Canonical(context.payload),
      value,
    });
    if (Buffer.byteLength(canonicalJson(hydration), "utf8") > input.maximumHydrationBytes) {
      throw new ApplicationControlError("control_payload_invalid", "query hydration exceeds its fixed snapshot bound");
    }
    const snapshot: TaskSurfaceStableSnapshotV1 = Object.freeze({
      ...stable.snapshot,
      taskSurfaceHydration: hydration,
    });
    return Object.freeze({
      ...stable,
      snapshot,
      snapshotIdentitySha256: sha256Canonical({
        hydration,
        session_snapshot_identity_sha256: stable.snapshotIdentitySha256,
      }),
    });
  };
}

function requireHydration<T>(snapshot: TaskSurfaceStableSnapshotV1, hydrationKind: string, payload: unknown): T {
  const hydration = snapshot.taskSurfaceHydration;
  if (
    hydration === undefined ||
    hydration.hydrationKind !== hydrationKind ||
    hydration.payloadSha256 !== sha256Canonical(payload)
  ) {
    throw new ApplicationControlError("control_operation_corrupt", "query execute lacks its exact bound hydration");
  }
  return hydration.value as T;
}

function sessionBody(snapshot: StableSessionApplicationSnapshotV1): ProductSessionProjectionBodyV1 {
  return snapshot.projection.projection;
}

function requireTaskGraph(body: ProductSessionProjectionBodyV1): Readonly<{
  readonly taskGraph: TaskGraphProjectionV1;
  readonly taskState: TaskStateProjection;
}> {
  if (body.taskGraph === null || body.taskState === null) {
    throw new ApplicationControlError("control_target_invalid", "session has no materialized Graph projection");
  }
  return Object.freeze({ taskGraph: body.taskGraph, taskState: body.taskState });
}

function requireInternalEvents(snapshot: StableSessionApplicationSnapshotV1): readonly DecodedStoredEvent[] {
  if (snapshot.internalEvents === undefined) {
    throw new ApplicationControlError("control_operation_busy", "session owner cannot provide a stable Graph log projection");
  }
  return snapshot.internalEvents;
}

function inspectDelegationOperations(
  snapshot: TaskSurfaceStableSnapshotV1,
): readonly Omit<DelegationOperationInspectionV1, "ownerObservation">[] {
  const sidecars = snapshot.delegationOperationSidecars;
  if (sidecars === undefined) {
    throw new ApplicationControlError("control_operation_corrupt", "delegation query lacks its bound sidecar snapshot");
  }
  if (sidecars.length === 0) return Object.freeze([]);
  let session;
  try {
    session = reconstructMultiRunSession(requireInternalEvents(snapshot));
  } catch (error) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "delegation sidecar cannot be anchored to a valid stable session projection",
      { cause: error },
    );
  }
  return Object.freeze(sidecars.map((operation) => {
    const revisionMatches = session.delegations.revisions.filter((candidate) =>
      candidate.delegationId === operation.delegationId &&
      candidate.parentRunId === operation.parentRunId &&
      candidate.attempts.some((attempt) =>
        attempt.attemptId === operation.childAttemptId &&
        attempt.operationId === operation.operationId &&
        attempt.actorId === operation.childActorId &&
        (attempt.childRunId === operation.childRunId || (
          attempt.childRunId === null &&
          operation.failure !== undefined && operation.failure !== null &&
          operation.failure.phase !== "after_start_barrier"
        ))));
    if (revisionMatches.length !== 1) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "delegation sidecar has no unique durable attempt anchor in the bound session",
      );
    }
    const revision = revisionMatches[0]!;
    const run = session.runs.find((candidate) => candidate.runId === operation.childRunId);
    if (operation.process !== null && run === undefined) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "started delegation sidecar has no durable child run in the bound session",
      );
    }
    // Durable named queries do not publish process liveness. Reconciliation
    // classification is therefore deliberately conservative for started
    // children; live observations belong in the envelope sibling.
    const ownerObservation = operation.process === null ? "not_started" as const : "unknown" as const;
    return Object.freeze({
      childAttemptId: operation.childAttemptId,
      childRunId: operation.childRunId,
      delegationId: operation.delegationId,
      operationId: operation.operationId,
      operationSha256: operation.operationSha256,
      reconcile: classifyDelegationReconcileOutcome({
        operation,
        ownerObservation,
        ...(revision === undefined ? {} : { revision }),
        ...(run === undefined ? {} : { run }),
      }),
      state: operation.state,
    });
  }));
}

function delegationStableRead(input: {
  readonly operations: TaskSurfaceQueryOperationPortV1;
  readonly readSessionSnapshot: SessionRead;
}): SessionRead {
  return async (scope, requested, context) => {
    if (scope.kind !== "session") {
      throw new ApplicationControlError("control_target_invalid", "delegation query requires a session resource");
    }
    const stable = await input.readSessionSnapshot(scope, requested, context);
    const raw = await input.operations.inspectDelegationOperationSidecars(scope.sessionId);
    if (raw.length > 128) {
      throw new ApplicationControlError("control_payload_invalid", "delegation operation projection exceeds its fixed bound");
    }
    const sidecars = Object.freeze(raw.map((operation) =>
      Object.freeze(delegationChildOperationSchema.parse(operation))));
    const snapshot: TaskSurfaceStableSnapshotV1 = Object.freeze({
      ...stable.snapshot,
      delegationOperationSidecars: sidecars,
    });
    return Object.freeze({
      ...stable,
      snapshot,
      snapshotIdentitySha256: sha256Canonical({
        delegation_operation_sidecars_sha256: sha256Canonical(sidecars),
        session_snapshot_identity_sha256: stable.snapshotIdentitySha256,
      }),
    });
  };
}

async function sessionArtifactStore(input: {
  readonly repositories: RepositoryReadPort;
  readonly snapshot: StableSessionApplicationSnapshotV1;
}): Promise<ArtifactStore> {
  const registration = await input.repositories.get(input.snapshot.resourceScope.repositoryId);
  if (registration === null || registration.status !== "active") {
    throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
  }
  const root = await input.repositories.readRoot(registration);
  return ArtifactStore.create({ sessionId: input.snapshot.resourceScope.sessionId, workspace: root });
}

function verifiedGraphArtifact(
  stored: Awaited<ReturnType<ArtifactStore["readVerified"]>>,
  revision: TaskGraphRevisionProjectionV1,
): boolean {
  const identity = canonicalTaskGraphIdentity(revision.content);
  return stored.metadata.bytes === revision.artifact.bytes &&
    stored.metadata.sha256 === revision.artifact.sha256 &&
    stored.objectRef === revision.artifact.objectRef &&
    stored.bytes.equals(identity.bytes);
}

async function hydrateGraphRevisions(
  repositories: RepositoryReadPort,
  snapshot: StableSessionApplicationSnapshotV1,
  payload: unknown,
): Promise<Readonly<{
  readonly allRevisionCount: number;
  readonly revisions: readonly TaskGraphRevisionProjectionV1[];
}>> {
  const parsed = graphRevisionPayload.parse(payload);
  const { taskGraph } = requireTaskGraph(sessionBody(snapshot));
  const allRevisions = parsed.revision === null
    ? taskGraph.revisions
    : taskGraph.revisions.filter((candidate) => candidate.revision === parsed.revision);
  const revisions = Object.freeze(allRevisions.slice(-100));
  if (revisions.length > 0) {
    const store = await sessionArtifactStore({ repositories, snapshot });
    for (const revision of revisions) {
      const stored = await store.readVerified(revision.artifact.artifactId);
      if (!verifiedGraphArtifact(stored, revision)) {
        throw new ApplicationControlError("control_artifact_invalid", "Graph revision artifact does not match its durable facts");
      }
    }
  }
  return Object.freeze({ allRevisionCount: allRevisions.length, revisions });
}

async function hydrateGraphLogRecords(
  repositories: RepositoryReadPort,
  snapshot: StableSessionApplicationSnapshotV1,
  payload: unknown,
): Promise<Readonly<{
  readonly candidateCount: number;
  readonly records: readonly GraphLogRecordV1[];
  readonly selectedSessionSeqs: readonly number[];
}>> {
  const parsed = graphLogPayload.parse(payload);
  const candidates = requireInternalEvents(snapshot).filter((event) =>
    event.scope === "session" && (
      (event.type === "task_node.attempt.terminal" && (parsed.nodeId === null || event.data.node_id === parsed.nodeId)) ||
      (event.type === "task_origin_verification.completed" && (parsed.nodeId === null || event.data.verification_node_id === parsed.nodeId))
    )
  );
  // One snapshot hydrates the complete bounded named-query view so every
  // continuation consumes identical bytes without filesystem re-reads.
  if (candidates.length > 500) {
    throw new ApplicationControlError("control_payload_invalid", "Graph log projection exceeds its fixed hydration item bound");
  }
  const store = candidates.some((event) => event.scope === "session" && (
    event.type === "task_origin_verification.completed" ||
    (event.type === "task_node.attempt.terminal" && event.data.receipt_artifact_id !== null)
  )) ? await sessionArtifactStore({ repositories, snapshot }) : null;
  const records: GraphLogRecordV1[] = [];
  for (const event of candidates) {
    if (event.scope !== "session") continue;
    if (event.type === "task_origin_verification.completed") {
      if (store === null) throw new ApplicationControlError("control_operation_corrupt", "Graph receipt store is unavailable");
      const stored = await store.readVerified(event.data.receipt_artifact_id);
      if (stored.metadata.bytes > 8 * 1024) {
        throw new ApplicationControlError("control_artifact_invalid", "origin verification receipt exceeds its fixed query bound");
      }
      const receipt = originVerificationReceiptSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
      if (!originVerificationReceiptMatchesCompletedEvent(receipt, event.data)) {
        throw new ApplicationControlError("control_artifact_invalid", "origin verification receipt does not match its terminal event");
      }
      records.push(Object.freeze({
        kind: "origin_verification" as const,
        nodeId: event.data.verification_node_id,
        promotionOperationId: event.data.promotion_operation_id,
        receipt,
        sessionSeq: event.sessionSeq,
        status: event.data.status,
        verificationId: event.data.verification_id,
      }));
      continue;
    }
    if (event.type !== "task_node.attempt.terminal") continue;
    if (event.data.receipt_artifact_id === null || event.data.receipt_sha256 === null) {
      records.push(Object.freeze({
        attemptId: event.data.attempt_id,
        kind: "node_attempt" as const,
        nodeId: event.data.node_id,
        receipt: null,
        sessionSeq: event.sessionSeq,
        terminal: event.data.terminal,
      }));
      continue;
    }
    if (store === null) throw new ApplicationControlError("control_operation_corrupt", "Graph receipt store is unavailable");
    const stored = await store.readVerified(event.data.receipt_artifact_id);
    if (stored.metadata.bytes > 8 * 1024) {
      throw new ApplicationControlError("control_artifact_invalid", "node receipt exceeds its fixed query bound");
    }
    const receipt = taskNodeReceiptSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
    if (
      receipt.receiptSha256 !== event.data.receipt_sha256 ||
      receipt.attemptId !== event.data.attempt_id ||
      receipt.nodeId !== event.data.node_id
    ) {
      throw new ApplicationControlError("control_artifact_invalid", "node receipt does not match its terminal event");
    }
    records.push(Object.freeze({
      attemptId: event.data.attempt_id,
      kind: "node_attempt" as const,
      nodeId: event.data.node_id,
      receipt,
      sessionSeq: event.sessionSeq,
      terminal: event.data.terminal,
    }));
  }
  return Object.freeze({
    candidateCount: candidates.length,
    records: Object.freeze(records),
    selectedSessionSeqs: Object.freeze(candidates.map((event) => event.sessionSeq)),
  });
}

async function hydrateDelegationSummaries(
  repositories: RepositoryReadPort,
  snapshot: StableSessionApplicationSnapshotV1,
  payload: unknown,
): Promise<Readonly<{ readonly records: readonly DelegationSummaryQueryResultV1[]; readonly truncated: boolean }>> {
  const parsed = delegationListPayload.parse(payload);
  const body = sessionBody(snapshot);
  const delegations = body.delegations as DelegationProjectionV1;
  const worktrees = body.worktrees as WorktreeProjectionV1;
  const candidates = delegations.revisions.filter((revision) =>
    (parsed.delegationId === null || revision.delegationId === parsed.delegationId) &&
    (parsed.status === null || revision.status === parsed.status)
  );
  const selected = candidates.slice(-parsed.limit);
  const store = selected.length === 0 ? null : await sessionArtifactStore({ repositories, snapshot });
  const records: DelegationSummaryQueryResultV1[] = [];
  for (const revision of selected) {
    if (store === null) throw new ApplicationControlError("control_operation_corrupt", "delegation artifact store is unavailable");
    const revisionArtifact = await store.readVerified(revision.artifact.artifactId);
    const identity = canonicalDelegationIdentity(revision.content);
    if (
      revisionArtifact.metadata.bytes !== revision.artifact.bytes ||
      revisionArtifact.metadata.sha256 !== revision.artifact.sha256 ||
      revisionArtifact.objectRef !== revision.artifact.objectRef ||
      !revisionArtifact.bytes.equals(identity.bytes)
    ) {
      throw new ApplicationControlError("control_artifact_invalid", "delegation revision artifact does not match its durable facts");
    }
    const attempt = revision.attempts.at(-1);
    let model: string | null = null;
    let workspaceId = revision.content.workspace.managedWorkspaceId ?? revision.binding.parentWorkspaceLineageId;
    if (revision.envelope !== null) {
      const stored = await store.readVerified(revision.envelope.envelope.artifactId);
      if (stored.metadata.bytes > 256 * 1024) {
        throw new ApplicationControlError("control_artifact_invalid", "delegation envelope exceeds its fixed query bound");
      }
      const envelope = preparedChildEnvelopeSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
      if (
        envelope.envelopeSha256 !== revision.envelope.envelopeSha256 ||
        envelope.actor.delegationId !== revision.delegationId ||
        envelope.actor.delegationRevision !== revision.delegationRevision ||
        envelope.actor.delegationSha256 !== revision.delegationSha256
      ) {
        throw new ApplicationControlError("control_artifact_invalid", "delegation envelope does not match its durable facts");
      }
      model = envelope.model.modelId;
      workspaceId = envelope.workspace.logicalWorkspaceId;
    }
    const workspace = worktrees.workspaces.find((candidate) => candidate.identity.workspaceId === workspaceId);
    records.push(Object.freeze({
      authority: Object.freeze({
        capabilities: revision.content.authorityRequest.capabilityIds.length,
        profile: revision.content.authorityRequest.taskProfile,
        tools: revision.content.authorityRequest.toolIds.length,
      }),
      budget: Object.freeze({
        requested: revision.content.budget,
        reservationId: attempt?.reservationId ?? null,
        terminal: attempt?.terminal ?? null,
      }),
      child: Object.freeze({
        actorId: attempt?.actorId ?? null,
        attemptId: attempt?.attemptId ?? null,
        attemptNumber: attempt?.attemptNumber ?? 0,
        model,
      }),
      context: Object.freeze({
        bytes: revision.envelope?.contextCapsule.bytes ?? null,
        capsuleSha256: revision.envelope?.contextCapsuleSha256 ?? null,
      }),
      delegationId: revision.delegationId,
      objective: revision.content.objective,
      parent: Object.freeze({
        actorId: revision.parentActorId,
        graphId: revision.binding.graphId,
        nodeId: revision.binding.nodeId,
        runId: revision.parentRunId,
      }),
      receipt: Object.freeze({
        blockers: Object.freeze([
          ...revision.blockerCodes,
          ...(revision.receipt?.claimStatuses.filter((claim) => claim.status !== "verified")
            .map((claim) => `${claim.claimId}:${claim.status}`) ?? []),
        ]),
        sha256: revision.receipt?.sha256 ?? null,
        verifiedClaims: revision.receipt?.claimStatuses.filter((claim) => claim.status === "verified").length ?? 0,
      }),
      revision: revision.delegationRevision,
      schemaVersion: 1 as const,
      sequence: revision.content.sequence,
      sha256: revision.delegationSha256,
      status: revision.status,
      title: revision.content.title,
      workspace: Object.freeze({
        id: workspaceId,
        mode: revision.content.workspace.mode,
        status: workspace?.status ?? (revision.content.workspace.mode === "origin_read_only" ? "origin_read_only" : "unavailable"),
      }),
    }));
  }
  return Object.freeze({ records: Object.freeze(records), truncated: candidates.length > selected.length });
}

async function hydrateDelegationReceipt(
  repositories: RepositoryReadPort,
  snapshot: StableSessionApplicationSnapshotV1,
  payload: unknown,
): Promise<DelegationReceiptQueryResultV1> {
  const parsed = delegationIdPayload.parse(payload);
  const delegations = sessionBody(snapshot).delegations as DelegationProjectionV1;
  const revision = [...delegations.revisions].reverse().find((candidate) => candidate.delegationId === parsed.delegationId);
  if (revision?.receipt === null || revision === undefined) {
    throw new ApplicationControlError("control_target_invalid", "delegation has no receipt");
  }
  const store = await sessionArtifactStore({ repositories, snapshot });
  const stored = await store.readVerified(revision.receipt.artifact.artifactId);
  if (stored.metadata.bytes > 64 * 1024) {
    throw new ApplicationControlError("control_artifact_invalid", "delegation receipt exceeds its fixed query bound");
  }
  const receipt = childReceiptSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
  if (
    receipt.receiptSha256 !== revision.receipt.sha256 ||
    receipt.delegationId !== revision.delegationId ||
    receipt.delegationRevision !== revision.delegationRevision ||
    receipt.delegationSha256 !== revision.delegationSha256 ||
    receipt.status !== revision.receipt.status ||
    stored.metadata.sha256 !== revision.receipt.artifact.sha256 ||
    stored.metadata.bytes !== revision.receipt.artifact.bytes
  ) {
    throw new ApplicationControlError("control_artifact_invalid", "delegation receipt does not match its durable facts");
  }
  const required = new Set(revision.content.expectedReceipt.requiredClaims
    .filter((claim) => claim.required).map((claim) => claim.claimId));
  if (receipt.status === "succeeded" && [...required].some((id) =>
    !receipt.claims.some((claim) => claim.claimId === id && claim.status === "verified"))) {
    throw new ApplicationControlError("control_artifact_invalid", "successful delegation receipt lacks a verified required claim");
  }
  return Object.freeze({ receipt });
}

function selectedGraph(
  body: ProductSessionProjectionBodyV1,
): TaskGraphRevisionProjectionV1 | null {
  const execution = body.taskExecution as TaskExecutionProjectionV1 | null;
  return execution?.graph ?? body.taskGraph?.revisions.at(-1) ?? null;
}

function graphSummary(graph: TaskGraphRevisionProjectionV1 | null) {
  return graph === null ? null : Object.freeze({
    graphId: graph.graphId,
    graphSha256: graph.graphSha256,
    revision: graph.revision,
    status: graph.status,
  });
}

function graphSurfaceRevision(graph: TaskGraphRevisionProjectionV1): GraphSurfaceRevisionV1 {
  return Object.freeze({
    approvedEventId: graph.approvedEventId,
    artifact: Object.freeze({
      artifactId: graph.artifact.artifactId,
      bytes: graph.artifact.bytes,
      sha256: graph.artifact.sha256,
    }),
    binding: graph.binding,
    content: graph.content,
    createdEventId: graph.createdEventId,
    decisionEventId: graph.decisionEventId,
    graphId: graph.graphId,
    graphSha256: graph.graphSha256,
    revision: graph.revision,
    status: graph.status,
    terminalEventId: graph.terminalEventId,
  });
}

function executionDocument(execution: TaskExecutionProjectionV1): GraphExecutionDocumentV1 {
  return Object.freeze({
    activeAttempt: execution.activeAttempt,
    blocker: execution.blocker,
    budget: execution.budget,
    enqueue: execution.enqueue,
    graph: Object.freeze({
      graphId: execution.graph.graphId,
      graphSha256: execution.graph.graphSha256,
      revision: execution.graph.revision,
      status: execution.status,
    }),
    lastSessionSeq: execution.lastSessionSeq,
    nodes: Object.freeze(execution.nodes.map((node) => Object.freeze({
      attempts: node.attempts,
      nextAttemptOrigin: node.nextAttemptOrigin,
      nodeId: node.nodeId,
      sequence: node.node.sequence,
      status: node.status,
      terminalEventId: node.terminalEventId,
      title: node.node.title,
    }))),
    readyNodeIds: Object.freeze([...execution.readyNodeIds]),
    schedulerLeaseNonceSha256: execution.schedulerLeaseNonceSha256,
    status: execution.status,
  });
}

function backgroundWorkerDocument(worker: BackgroundProjectionV1["workers"][number]): GraphBackgroundWorkerDocumentV1 {
  return Object.freeze({
    acceptedControlIds: Object.freeze([...worker.acceptedControlIds]),
    descriptor: worker.descriptor,
    descriptorSha256: worker.descriptorSha256,
    graphId: worker.graphId,
    graphRevision: worker.graphRevision,
    graphSha256: worker.graphSha256,
    operationId: worker.operationId,
    repositoryId: worker.repositoryId,
    spawnEventId: worker.spawnEventId,
    startedEventId: worker.startedEventId,
    status: worker.status,
    terminal: worker.terminal === null ? null : Object.freeze({
      eventId: worker.terminal.eventId,
      graphStatus: worker.terminal.graphStatus,
      processTreeCleanup: worker.terminal.processTreeCleanup,
      receiptSha256: worker.terminal.receiptSha256,
    }),
    workerId: worker.workerId,
    workerNonceSha256: worker.workerNonceSha256,
  });
}

function backgroundDocument(background: BackgroundProjectionV1): GraphBackgroundDocumentV1 {
  return Object.freeze({
    current: background.current === null ? null : backgroundWorkerDocument(background.current),
    lastSessionSeq: background.lastSessionSeq,
    workers: Object.freeze(background.workers.map(backgroundWorkerDocument)),
  });
}

function worktreeDocument(worktrees: WorktreeProjectionV1): Omit<GraphWorktreesQueryResultV1, "graph"> {
  return Object.freeze({
    originVerifications: Object.freeze(worktrees.originVerifications.map((verification) => Object.freeze({
      promotionOperationId: verification.promotionOperationId,
      receiptSha256: verification.receiptSha256,
      status: verification.status,
      verificationId: verification.verificationId,
      verificationNodeId: verification.verificationNodeId,
      workspaceId: verification.workspaceId,
    }))),
    pendingOperationIds: Object.freeze([...worktrees.pendingOperationIds]),
    promotions: Object.freeze(worktrees.promotions.map((promotion) => Object.freeze({
      bundleSha256: promotion.bundle.bundleSha256,
      nodeId: promotion.bundle.nodeId,
      status: promotion.status,
      workspaceId: promotion.bundle.workspaceId,
    }))),
    workspaces: Object.freeze(worktrees.workspaces.map((workspace) => Object.freeze({
      activeAttemptId: workspace.activeAttemptId,
      baselineSha256: workspace.baseline.manifestSha256,
      lastSnapshotSha256: workspace.lastSnapshot?.sha256 ?? null,
      nodeIds: Object.freeze([...workspace.nodeIds]),
      sourceNodeId: workspace.identity.sourceNodeId,
      status: workspace.status,
      workspaceId: workspace.identity.workspaceId,
    }))),
  });
}

function assertGraphStatusBounds(
  background: BackgroundProjectionV1,
  execution: TaskExecutionProjectionV1 | null,
  worktrees: WorktreeProjectionV1,
): void {
  if (
    background.workers.length > 128 ||
    background.workers.some((worker) => worker.acceptedControlIds.length > 128) ||
    (execution?.nodes.length ?? 0) > 256 ||
    worktrees.originVerifications.length > 256 ||
    worktrees.pendingOperationIds.length > 256 ||
    worktrees.promotions.length > 256 ||
    worktrees.workspaces.length > 256
  ) {
    throw new ApplicationControlError("control_payload_invalid", "Graph projection exceeds its fixed query item bound");
  }
}

function queryDefinition(input: {
  readonly execute: ApplicationQueryDefinitionV1["execute"];
  readonly maximumBytes: number;
  readonly payloadCodec: ApplicationQueryDefinitionV1["payloadCodec"];
  readonly projectionOwner: string;
  readonly queryKind: string;
  readonly readSessionSnapshot: SessionRead;
  readonly redactionProfileId: string;
  readonly cursorKind?: string;
  readonly maximumItems?: number;
}): ApplicationQueryDefinitionV1 {
  return Object.freeze({
    execute: input.execute,
    pagination: {
      cursorKind: input.cursorKind ?? null,
      maximumBytes: input.maximumBytes,
      maximumCursorLifetimeMs: 60_000,
      maximumItems: input.maximumItems ?? 1,
    },
    payloadCodec: input.payloadCodec,
    projectionOwner: input.projectionOwner,
    queryKind: input.queryKind,
    readStableSnapshot: input.readSessionSnapshot,
    redactionProfileId: input.redactionProfileId,
    requiredScopes: ["session.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["session_ledger_head"] as const, allowCurrentVersion: true, resourceKind: "session" as const }],
  });
}

export function createTaskSurfaceQueryDefinitions(input: {
  readonly operations: TaskSurfaceQueryOperationPortV1;
  readonly readSessionSnapshot: SessionRead;
  readonly repositories: Parameters<typeof sessionArtifactStore>[0]["repositories"];
}): readonly ApplicationQueryDefinitionV1[] {
  const readDelegationSnapshot = delegationStableRead({
    operations: input.operations,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const readGraphRevisionsSnapshot = hydratedSessionRead({
    hydrate: (snapshot, payload) => hydrateGraphRevisions(input.repositories, snapshot, payload),
    hydrationKind: "graph.revisions.v1",
    maximumHydrationBytes: 1024 * 1024,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const readGraphLogsSnapshot = hydratedSessionRead({
    hydrate: (snapshot, payload) => hydrateGraphLogRecords(input.repositories, snapshot, payload),
    hydrationKind: "graph.logs.v1",
    maximumHydrationBytes: 4 * 1024 * 1024,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const readDelegationSummariesSnapshot = hydratedSessionRead({
    hydrate: (snapshot, payload) => hydrateDelegationSummaries(input.repositories, snapshot, payload),
    hydrationKind: "delegation.summaries.v1",
    maximumHydrationBytes: 2 * 1024 * 1024,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const readDelegationReceiptSnapshot = hydratedSessionRead({
    hydrate: (snapshot, payload) => hydrateDelegationReceipt(input.repositories, snapshot, payload),
    hydrationKind: "delegation.receipt.v1",
    maximumHydrationBytes: 128 * 1024,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const readGraphStatusSnapshot = hydratedSessionRead({
    hydrate: async (snapshot, payload) => {
      const parsed = z.object({ live: z.boolean() }).strict().parse(payload);
      const body = sessionBody(snapshot);
      const current = (body.background as BackgroundProjectionV1).current;
      if (!parsed.live || current === null || current === undefined) return null;
      const observe = input.operations.observeBackgroundWorkerLive;
      if (observe === undefined) {
        throw new ApplicationControlError("control_target_invalid", "runtime has no bounded worker observation capability");
      }
      const observedRaw = await observe({
        current,
        repositoryId: snapshot.resourceScope.repositoryId,
        sessionId: snapshot.resourceScope.sessionId,
      });
      const decoded = backgroundWorkerLiveObservationV1Schema.safeParse(observedRaw);
      if (!decoded.success) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "live worker observation failed its strict schema",
        );
      }
      const observed = decoded.data;
      if (
        observed !== null &&
        (observed.operationId !== current.operationId || observed.workerId !== current.workerId)
      ) {
        throw new ApplicationControlError(
          "control_stale_projection",
          "live worker observation does not match the stable session subject",
        );
      }
      if (observed === null) {
        throw new ApplicationControlError(
          "control_stale_projection",
          "live worker observation lost the stable session subject",
        );
      }
      return observed;
    },
    hydrationKind: "graph.status.live.v1",
    maximumHydrationBytes: 8 * 1024,
    readSessionSnapshot: input.readSessionSnapshot,
  });
  const planReview = queryDefinition({
    execute: (context, payload) => {
      const parsed = planReviewPayload.parse(payload);
      const taskState = sessionBody(context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1).taskState;
      const plan = taskState?.plans.find((candidate) =>
        candidate.content.planId === parsed.planId &&
        candidate.content.revision === parsed.revision &&
        candidate.planSha256 === parsed.sha256) ?? null;
      const result: PlanReviewQueryResultV1 = Object.freeze({ plan });
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 512 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: planReviewPayload, schemaId: "phase21a.plan.review.payload.v1" }),
    projectionOwner: "TaskStateProjector",
    queryKind: "plan.review",
    readSessionSnapshot: input.readSessionSnapshot,
    redactionProfileId: "phase21a.plan.review.local-owner.v1",
  });

  const graphRevisions = queryDefinition({
    execute: (context, payload) => {
      const parsed = graphRevisionPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const { taskGraph, taskState } = requireTaskGraph(sessionBody(snapshot));
      const hydrated = requireHydration<Readonly<{
        readonly allRevisionCount: number;
        readonly revisions: readonly TaskGraphRevisionProjectionV1[];
      }>>(snapshot, "graph.revisions.v1", parsed);
      const revisions = hydrated.revisions;
      const current = revisions.find((candidate) =>
        taskGraph.currentExecution?.graphSha256 === candidate.graphSha256 ||
        taskGraph.currentApproved?.graphSha256 === candidate.graphSha256 ||
        taskGraph.currentDraft?.graphSha256 === candidate.graphSha256
      ) ?? revisions.at(-1) ?? null;
      const result: GraphRevisionQueryResultV1 = Object.freeze({
        current: current === null ? null : graphSurfaceRevision(current),
        currentApproved: taskGraph.currentApproved,
        currentDraft: taskGraph.currentDraft,
        currentExecution: taskGraph.currentExecution,
        currentObservation: current === null ? "unavailable" : observeTaskGraphBinding(current, taskState),
        revisions: Object.freeze(revisions.map(graphSurfaceRevision)),
        revisionsTruncated: hydrated.allRevisionCount > revisions.length,
        trackingMode: taskGraph.trackingMode,
      });
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 1024 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 128, schema: graphRevisionPayload, schemaId: "phase21a.graph.revisions.payload.v1" }),
    projectionOwner: "TaskGraphProjector+ArtifactStore",
    queryKind: "graph.revisions",
    readSessionSnapshot: readGraphRevisionsSnapshot,
    redactionProfileId: "phase21a.graph.revisions.local-owner.v1",
  });

  const graphStatus = queryDefinition({
    execute: (context, payload) => {
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const body = sessionBody(snapshot);
      const execution = body.taskExecution as TaskExecutionProjectionV1 | null;
      const background = body.background as BackgroundProjectionV1;
      const worktrees = body.worktrees as WorktreeProjectionV1;
      assertGraphStatusBounds(background, execution, worktrees);
      const result: GraphStatusQueryResultV1 = Object.freeze({
        background: backgroundDocument(background),
        execution: execution === null ? null : executionDocument(execution),
        graph: graphSummary(selectedGraph(body)),
        worktrees: worktreeDocument(worktrees),
      });
      const liveWorker = requireHydration<BackgroundWorkerLiveObservationV1 | null>(snapshot, "graph.status.live.v1", payload);
      const liveObservation = liveWorker === null ? null : Object.freeze({
        coordinator: Object.freeze({
          identitySha256: sha256Canonical({
            operation_id: liveWorker.operationId,
            worker_id: liveWorker.workerId,
          }),
          kind: "background_worker" as const,
          state: liveWorker.state === "observed_running" || liveWorker.state === "observed_unresponsive_owner_alive"
            ? "observed_alive" as const
            : liveWorker.state === "owner_confirmed_dead"
              ? "observed_absent" as const
              : "unknown" as const,
        }),
        evidenceLevel: "observation" as const,
        observedAt: liveWorker.observedAt,
        owner: null,
        schemaVersion: 1 as const,
        sessionId: snapshot.resourceScope.sessionId,
        source: `background_worker/${liveWorker.evidenceLevel}`,
      });
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, liveObservation, nextOffset: 0, result });
    },
    maximumBytes: 1024 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 32, schema: z.object({ live: z.boolean() }).strict(), schemaId: "phase21a.graph.status.payload.v2" }),
    projectionOwner: "TaskExecutionProjector+BackgroundProjector+WorktreeProjector",
    queryKind: "graph.status",
    readSessionSnapshot: readGraphStatusSnapshot,
    redactionProfileId: "phase21a.graph.status.local-owner.v1",
  });

  const graphLogs = queryDefinition({
    execute: (context, payload) => {
      const parsed = graphLogPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const body = sessionBody(snapshot);
      const hydrated = requireHydration<Readonly<{
        readonly candidateCount: number;
        readonly records: readonly GraphLogRecordV1[];
        readonly selectedSessionSeqs: readonly number[];
      }>>(snapshot, "graph.logs.v1", parsed);
      const offset = context.paginationBinding?.nextOffset ?? 0;
      const records = hydrated.records.slice(offset, offset + parsed.limit);
      const selectedSessionSeqs = hydrated.selectedSessionSeqs.slice(offset, offset + parsed.limit);
      const result: GraphLogsQueryResultV1 = Object.freeze({
        graph: graphSummary(selectedGraph(body)),
        records: Object.freeze(records),
      });
      return Promise.resolve({
        hasMore: offset + records.length < hydrated.candidateCount,
        lastItemIdentitySha256: selectedSessionSeqs.length === 0
          ? null
          : sha256Canonical({ sessionSeq: selectedSessionSeqs.at(-1)! }),
        nextOffset: offset + records.length,
        result,
      });
    },
    maximumBytes: 512 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: graphLogPayload, schemaId: "phase21a.graph.logs.payload.v1" }),
    projectionOwner: "TaskGraphLogProjection+ArtifactStore",
    queryKind: "graph.logs",
    readSessionSnapshot: readGraphLogsSnapshot,
    redactionProfileId: "phase21a.graph.logs.local-owner.v1",
    cursorKind: "graph.logs.v1",
    maximumItems: 20,
  });

  const graphWorktrees = queryDefinition({
    execute: (context) => {
      const body = sessionBody(context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1);
      const worktrees = body.worktrees as WorktreeProjectionV1;
      assertGraphStatusBounds(body.background as BackgroundProjectionV1, body.taskExecution as TaskExecutionProjectionV1 | null, worktrees);
      const result: GraphWorktreesQueryResultV1 = Object.freeze({
        graph: selectedGraph(body) === null ? null : graphSurfaceRevision(selectedGraph(body)!),
        ...worktreeDocument(worktrees),
      });
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 512 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 16, schema: emptyPayload, schemaId: "phase21a.graph.worktrees.payload.v1" }),
    projectionOwner: "WorktreeProjector",
    queryKind: "graph.worktrees",
    readSessionSnapshot: input.readSessionSnapshot,
    redactionProfileId: "phase21a.graph.worktrees.local-owner.v1",
  });

  const delegationSummaries = queryDefinition({
    execute: (context, payload) => {
      const parsed = delegationListPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const result = requireHydration<DelegationSummariesQueryResultV1>(snapshot, "delegation.summaries.v1", parsed);
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 1024 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: delegationListPayload, schemaId: "phase21a.delegation.summaries.payload.v1" }),
    projectionOwner: "DelegationProjector+ArtifactStore",
    queryKind: "delegation.summaries",
    readSessionSnapshot: readDelegationSummariesSnapshot,
    redactionProfileId: "phase21a.delegation.summaries.local-owner.v1",
  });

  const delegationParent = queryDefinition({
    execute: (context) => {
      const body = sessionBody(context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1);
      const last = [...body.runs].sort((left, right) => left.startSessionSeq - right.startSessionSeq).at(-1);
      if (last === undefined) {
        throw new ApplicationControlError("control_target_invalid", "session has no parent run");
      }
      const result: DelegationParentQueryResultV1 = Object.freeze({ parentRunId: last.runId });
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 8 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 16, schema: emptyPayload, schemaId: "phase21a.delegation.parent.payload.v1" }),
    projectionOwner: "SessionProjectionService",
    queryKind: "delegation.parent",
    readSessionSnapshot: input.readSessionSnapshot,
    redactionProfileId: "phase21a.delegation.parent.local-owner.v1",
  });

  const delegationReceipt = queryDefinition({
    execute: (context, payload) => {
      const parsed = delegationIdPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const result = requireHydration<DelegationReceiptQueryResultV1>(snapshot, "delegation.receipt.v1", parsed);
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result });
    },
    maximumBytes: 128 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 128, schema: delegationIdPayload, schemaId: "phase21a.delegation.receipt.payload.v1" }),
    projectionOwner: "DelegationProjector+ArtifactStore",
    queryKind: "delegation.receipt",
    readSessionSnapshot: readDelegationReceiptSnapshot,
    redactionProfileId: "phase21a.delegation.receipt.local-owner.v1",
  });

  const delegationDoctor = queryDefinition({
    execute: async (context, payload) => {
      const parsed = delegationListPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as TaskSurfaceStableSnapshotV1;
      const delegations = sessionBody(snapshot).delegations as DelegationProjectionV1;
      const all = inspectDelegationOperations(snapshot);
      const operations = parsed.delegationId === null
        ? all
        : all.filter((operation) => operation.delegationId === parsed.delegationId);
      const result: DelegationDoctorQueryResultV1 = Object.freeze({
        activeActorSlots: delegations.activeActorSlots.length,
        activeConflictClaims: delegations.activeConflictClaims.length,
        operations: Object.freeze([...operations]),
        trackingMode: delegations.trackingMode,
      });
      return { hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result };
    },
    maximumBytes: 512 * 1024,
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: delegationListPayload, schemaId: "phase21a.delegation.doctor.payload.v1" }),
    projectionOwner: "DelegationProjector+DelegationOperationStore",
    queryKind: "delegation.doctor",
    readSessionSnapshot: readDelegationSnapshot,
    redactionProfileId: "phase21a.delegation.doctor.local-owner.v1",
  });

  return Object.freeze([
    planReview,
    graphRevisions,
    graphStatus,
    graphLogs,
    graphWorktrees,
    delegationSummaries,
    delegationParent,
    delegationReceipt,
    delegationDoctor,
  ]);
}
