import { z } from "zod";

import {
  delegationModelEnvelopeSchema,
  preparedChildEnvelopeSchema,
} from "../../delegation/context/child-envelope-schema.js";
import {
  delegationParentBindingSchema,
  delegationRevisionContentSchema,
} from "../../delegation/delegation-schema.js";
import { goalProjectionSchema } from "../../goals/goal-schema.js";
import {
  planItemIdSchema,
  planItemStatusSchema,
  planRevisionContentSchema,
  planRevisionStatusSchema,
  sha256Schema,
} from "../../plans/plan-schema.js";
import {
  taskGraphBindingSchema,
  taskGraphRevisionContentSchema,
  taskNodeSpecSchema,
} from "../../task-graph/task-graph-schema.js";
import {
  managedWorktreeIdentitySchema,
  promotionBundleSchema,
} from "../../worktrees/worktree-schema.js";
import { applicationCancelRequestBindingV1Schema } from "../../events/phase21-run-control-event-schema.js";
import {
  createStrictCodec,
  sessionLedgerHeadV1Schema,
  type StrictCodec,
} from "../application-protocol.js";
import type { PlanRevisionProjection } from "../../coordination/task-state-types.js";
import type { GoalProjection } from "../../goals/goal-schema.js";
import type { TaskGraphRevisionProjectionV1 } from "../../task-graph/task-graph-projector.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import type { DelegationRevisionProjectionV1 } from "../../delegation/delegation-projector.js";
import type { TaskExecutionMutationResultV1 } from "../../scheduling/task-execution-control-plane.js";
import type {
  GraphRunCompositeResultV1,
  PromotionApplyActionResultV1,
  PromotionVerifyOriginActionResultV1,
  WorktreeAllocateActionResultV1,
  WorktreeCleanupActionResultV1,
} from "./graph-composite-actions.js";
import type { GraphCancelResultV1 } from "./graph-cancel-action.js";
import type { DelegationCompositeResultV1 } from "./delegation-composite-actions.js";
import type { SessionResumeOwnerResultV1 } from "./session-resume-action.js";

const uuid = z.string().uuid();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const boundedString = z.string().min(1).max(4_096);

/**
 * One narrow static bridge keeps the exported codecs typed while every wire
 * value is still parsed by the exact, strict Zod schema supplied below.
 */
function resultCodec<TResult>(input: Readonly<{
  readonly maximumBytes?: number;
  readonly schema: z.ZodType;
  readonly schemaId: string;
}>): StrictCodec<TResult> {
  return createStrictCodec({
    maximumBytes: input.maximumBytes ?? 1024 * 1024,
    schema: input.schema as z.ZodType<TResult>,
    schemaId: input.schemaId,
  });
}

const planItemTransitionSchema = z.object({
  eventId: uuid,
  evidenceEventIds: z.array(uuid).max(256),
  from: planItemStatusSchema,
  note: z.string().max(16 * 1024),
  to: planItemStatusSchema,
}).strict();

const planItemProjectionSchema = z.object({
  carriedFromRevision: positive.nullable(),
  content: planRevisionContentSchema.shape.items.element,
  evidenceEventIds: z.array(uuid).max(256),
  lastTransitionEventId: uuid.nullable(),
  note: z.string().max(16 * 1024),
  status: planItemStatusSchema,
  transitions: z.array(planItemTransitionSchema).max(256),
}).strict();

export const planRevisionProjectionResultSchema = z.object({
  completed: z.object({
    completionEvaluatedEventId: uuid,
    eventId: uuid,
    finishTaskCallId: z.string().min(1).max(512),
  }).strict().nullable(),
  content: planRevisionContentSchema,
  createdEventId: uuid,
  decisionEventId: uuid.nullable(),
  itemStatuses: z.record(planItemIdSchema, planItemStatusSchema),
  items: z.array(planItemProjectionSchema).max(32),
  planSha256: sha256Schema,
  status: planRevisionStatusSchema,
  statusTransitions: z.array(z.object({
    eventId: uuid,
    from: planRevisionStatusSchema,
    to: planRevisionStatusSchema,
  }).strict()).max(64),
}).strict();

const artifactSchema = z.object({
  artifactId: boundedString,
  bytes: nonnegative,
  objectRef: boundedString,
  sha256: sha256Schema,
}).strict();

const taskGraphStatusSchema = z.enum([
  "draft", "approved", "queued", "running", "waiting_for_user",
  "awaiting_integration", "completed", "blocked", "cancelled", "failed",
  "rejected", "stale", "superseded",
]);

export const taskGraphRevisionProjectionResultSchema = z.object({
  approvedEventId: uuid.nullable(),
  artifact: artifactSchema,
  binding: taskGraphBindingSchema,
  content: taskGraphRevisionContentSchema,
  createdEventId: uuid,
  decisionEventId: uuid.nullable(),
  graphId: uuid,
  graphSha256: sha256Schema,
  revision: positive,
  status: taskGraphStatusSchema,
  terminalEventId: uuid.nullable(),
}).strict();

const budgetCountersSchema = z.object({
  artifactBytes: nonnegative,
  attempts: nonnegative,
  changedBytes: nonnegative,
  changedFiles: nonnegative,
  commandExecutions: nonnegative,
  commandOutputBytes: nonnegative,
  durationMs: nonnegative,
  modelSteps: nonnegative,
  reportedTokens: nonnegative.nullable(),
}).strict();

const taskAttemptTerminalSchema = z.enum([
  "succeeded",
  "known_failed",
  "cancelled_clean",
  "blocked_unknown_effect",
  "blocked_reconciliation",
  "pre_effect_infrastructure_failure",
]);

const taskAttemptProjectionSchema = z.object({
  attemptId: uuid,
  attemptNumber: positive.max(3),
  nodeId,
  requestEventId: uuid,
  reservation: budgetCountersSchema,
  retryOrigin: z.enum(["automatic", "initial", "user"]),
  runId: uuid.nullable(),
  startEventId: uuid.nullable(),
  status: z.enum(["requested", "running", "waiting_for_user", "terminal"]),
  terminal: taskAttemptTerminalSchema.nullable(),
  terminalEventId: uuid.nullable(),
  workspaceBinding: z.object({
    managed_path_sha256: sha256Schema,
    repository_id: sha256Schema,
    source_snapshot_sha256: sha256Schema,
    workspace_baseline_sha256: sha256Schema,
    workspace_id: uuid,
  }).strict().nullable(),
}).strict();

export const taskExecutionProjectionResultSchema: z.ZodType = z.object({
  activeAttempt: taskAttemptProjectionSchema.nullable(),
  blocker: z.object({ code: boundedString, eventId: uuid, nodeId: nodeId.nullable() }).strict().nullable(),
  budget: z.object({
    consumed: budgetCountersSchema,
    limits: budgetCountersSchema,
    remaining: budgetCountersSchema,
    reserved: budgetCountersSchema,
    usageCompleteness: z.enum(["complete", "none", "partial"]),
  }).strict(),
  enqueue: z.object({
    enqueueId: uuid,
    eventId: uuid,
    requestedExecution: z.enum(["background", "foreground"]),
    runtimeProfileId: z.string().min(1).max(128),
  }).strict(),
  graph: taskGraphRevisionProjectionResultSchema,
  lastSessionSeq: nonnegative,
  nodes: z.array(z.object({
    attempts: z.array(taskAttemptProjectionSchema).max(3),
    nextAttemptOrigin: z.enum(["automatic", "initial", "user"]).nullable(),
    node: taskNodeSpecSchema,
    nodeId,
    status: z.enum(["pending", "ready", "leased", "running", "waiting_for_user", "succeeded", "failed", "blocked", "cancelled", "skipped"]),
    terminalEventId: uuid.nullable(),
  }).strict()).max(32),
  readyNodeIds: z.array(nodeId).max(32),
  schedulerLeaseNonceSha256: sha256Schema.nullable(),
  status: taskGraphStatusSchema,
}).strict();

const delegationBudgetCountersSchema = z.object({
  artifactBytes: nonnegative,
  attempts: nonnegative,
  changedBytes: nonnegative,
  changedFiles: nonnegative,
  commandExecutions: nonnegative,
  commandOutputBytes: nonnegative,
  durationMs: nonnegative,
  modelSteps: nonnegative,
  reportedTokens: nonnegative.nullable(),
}).strict();

export const delegationRevisionProjectionResultSchema = z.object({
  artifact: artifactSchema,
  attempts: z.array(z.object({
    attemptId: uuid,
    attemptNumber: positive.max(2).nullable(),
    actorId: uuid.nullable(),
    childRunId: uuid.nullable(),
    executableEnvelopeSha256: sha256Schema.nullable(),
    operationId: uuid.nullable(),
    reservationId: uuid,
    budgetUsage: delegationBudgetCountersSchema.nullable(),
    budgetSettlementEventId: uuid.nullable(),
    startedEventId: uuid.nullable(),
    terminalEventId: uuid.nullable(),
    terminal: z.enum(["succeeded", "known_failed", "pre_effect_infrastructure_failure", "cancelled_clean", "blocked_unknown_effect"]).nullable(),
    unresolvedEffectIds: z.array(z.string().min(1).max(512)).max(128),
  }).strict()).max(2),
  authorityPreviewSha256: sha256Schema,
  binding: delegationParentBindingSchema,
  content: delegationRevisionContentSchema,
  createdEventId: uuid,
  decisionEventId: uuid.nullable(),
  delegationId: uuid,
  delegationRevision: positive,
  delegationSha256: sha256Schema,
  envelope: z.object({
    contextCapsule: artifactSchema,
    contextCapsuleSha256: sha256Schema,
    envelope: artifactSchema,
    envelopeSha256: sha256Schema,
  }).strict().nullable(),
  envelopePreparationCount: nonnegative.max(2),
  parentActorId: uuid,
  parentRunId: uuid,
  receipt: z.object({
    acceptedEventId: uuid.nullable(),
    artifact: artifactSchema,
    readyEventId: uuid,
    sha256: sha256Schema,
    status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    claimStatuses: z.array(z.object({
      claimId: z.string().min(1).max(128),
      status: z.enum(["verified", "unverified", "stale"]),
    }).strict()).max(32),
  }).strict().nullable(),
  blockerCodes: z.array(z.string().min(1).max(256)).max(128),
  status: z.enum(["draft", "approved", "queued", "active", "waiting_approval", "cancelling", "reconciling", "receipt_ready", "accepted", "failed", "blocked", "cancelled", "stale", "rejected", "superseded"]),
  terminalEventId: uuid.nullable(),
}).strict();

const originVerificationResultSchema = z.object({
  actionSha256: sha256Schema,
  commandSha256: sha256Schema,
  completedEventId: uuid,
  receiptArtifactId: boundedString,
  receiptSha256: sha256Schema,
  status: z.enum(["cancelled", "failed", "passed", "reconciliation_required"]),
  verificationId: uuid,
  verificationNodeId: nodeId,
}).strict();

const preEffectTerminalSchema = z.object({
  actionKind: z.enum(["promotion.apply", "promotion.verify_origin", "worktree.allocate", "worktree.cleanup"]),
  kind: z.literal("pre_effect_terminal"),
  outcome: z.enum(["cancelled", "denied"]),
  targetIdentitySha256: sha256Schema,
}).strict();

const graphRunResultSchema = z.discriminatedUnion("execution", [
  z.object({
    execution: z.literal("background"),
    graph: taskGraphRevisionProjectionResultSchema,
    launch: z.object({ accepted: z.literal(true), operationId: uuid, startedEventId: uuid, workerId: uuid }).strict(),
  }).strict(),
  z.object({
    execution: z.literal("foreground"),
    run: z.object({
      execution: taskExecutionProjectionResultSchema,
      startedAttempts: nonnegative.max(32),
      stopReason: z.enum(["blocked", "cancelled", "completed", "failed", "waiting_for_user"]),
    }).strict(),
  }).strict(),
]);

const taskExecutionMutationResultSchema = z.object({
  deduplicated: z.boolean(),
  execution: taskExecutionProjectionResultSchema,
  graph: taskGraphRevisionProjectionResultSchema,
}).strict();

const worktreeAllocateResultSchema = z.object({
  baselineManifestSha256: sha256Schema,
  identity: managedWorktreeIdentitySchema,
  nodeIds: z.array(nodeId).min(1).max(32),
}).strict();

const promotionResultSchema = z.object({
  bundle: promotionBundleSchema,
  changedPaths: z.array(z.string().min(1).max(1_024)).max(256),
  operationId: uuid,
  originSourceSnapshotSha256: sha256Schema,
  originVerification: originVerificationResultSchema.nullable(),
  resultSnapshotSha256: sha256Schema,
}).strict();

const worktreeCleanupResultSchema = z.object({
  archiveSha256: sha256Schema.nullable(),
  status: z.enum(["archived", "removed"]),
  workspaceId: uuid,
}).strict();

const graphCancelResultSchema = z.discriminatedUnion("delivery", [
  z.object({
    delivery: z.literal("session_request"),
    execution: taskExecutionProjectionResultSchema,
    graph: taskGraphRevisionProjectionResultSchema,
  }).strict(),
  z.object({
    accepted: z.literal(true),
    controlSha256: sha256Schema,
    delivery: z.literal("background_control_queued"),
    graph: taskGraphRevisionProjectionResultSchema,
    operationId: uuid,
    requestId: uuid,
    terminal: z.literal(false),
    workerId: uuid,
  }).strict(),
]);

const reconcileOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resume_same_child"), attemptId: uuid }).strict(),
  z.object({ kind: z.literal("terminal_backfilled"), receiptSha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("retry_pre_effect_allowed") }).strict(),
  z.object({ kind: z.literal("pre_effect_failure_terminal"), attemptId: uuid }).strict(),
  z.object({ kind: z.literal("pre_effect_cancelled"), attemptId: uuid, cancelRequestEventId: uuid }).strict(),
  z.object({ kind: z.literal("cancelled_clean"), receiptSha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("blocked_unknown_effect"), evidenceRefs: z.array(boundedString).max(256) }).strict(),
  z.object({ kind: z.literal("corrupt"), code: boundedString }).strict(),
]);

const delegationOperationInspectionSchema = z.object({
  childAttemptId: uuid,
  childRunId: uuid,
  delegationId: uuid,
  operationId: uuid,
  operationSha256: sha256Schema,
  ownerObservation: z.enum(["different", "matching", "missing", "unknown", "not_started"]),
  reconcile: reconcileOutcomeSchema,
  state: z.enum(["requested", "spawned", "handshaken", "pre_effect_terminal", "running", "terminal_observed", "reconciled", "blocked"]),
}).strict();

const delegationPreparedResultSchema = z.object({
  kind: z.literal("prepared"),
  childNotStarted: z.literal(true),
  capsuleBytes: nonnegative,
  capsuleSha256: sha256Schema,
  envelopeSha256: sha256Schema,
  toolCount: nonnegative.max(32),
  capabilityCount: nonnegative.max(32),
  model: delegationModelEnvelopeSchema,
  workspace: preparedChildEnvelopeSchema.shape.workspace,
}).strict();

const delegationGroupTerminalSchema = z.object({
  kind: z.literal("group_terminal"),
  deferred: z.array(z.object({
    delegationId: uuid,
    reason: z.enum(["actor_limit", "budget", "workspace_conflict"]),
  }).strict()).max(2),
  groupId: uuid,
  results: z.array(z.union([
    z.object({
      childRunId: uuid,
      delegationId: uuid,
      receiptSha256: sha256Schema,
      status: z.enum(["blocked", "cancelled", "failed", "succeeded"]),
    }).strict(),
    z.object({
      cancelRequestEventId: uuid,
      cancelRequestId: uuid,
      childAttemptId: uuid,
      delegationId: uuid,
      operationId: uuid,
      status: z.literal("pre_effect_cancelled"),
      terminalEventId: uuid,
    }).strict(),
    z.object({
      delegationId: uuid,
      diagnostic: z.string().max(16 * 1024),
      error: boundedString,
      status: z.literal("blocked"),
    }).strict(),
  ])).min(1).max(2),
  terminalStatus: z.enum(["blocked", "cancelled", "completed"]),
}).strict();

const delegationPreEffectTerminalSchema = z.object({
  cancelRequestEventId: uuid,
  cancelRequestId: uuid,
  delegationId: uuid,
  kind: z.literal("pre_effect_terminal"),
  outcome: z.literal("cancelled"),
  terminalEventId: uuid,
}).strict();

const delegationResumeResultSchema = z.discriminatedUnion("kind", [
  delegationPreparedResultSchema,
  delegationGroupTerminalSchema,
  delegationPreEffectTerminalSchema,
  z.object({ kind: z.literal("queued"), delegation: delegationRevisionProjectionResultSchema }).strict(),
  z.object({
    kind: z.literal("pre_effect_recovery"),
    observation: delegationOperationInspectionSchema.nullable(),
    operationId: uuid,
    reconciled: z.boolean(),
    retryEligible: z.literal(false),
  }).strict(),
  z.object({
    kind: z.literal("group_takeover"),
    takeover: z.object({
      changed: z.boolean(),
      groupId: uuid,
      previousNonceSha256: sha256Schema,
      releasedLeaseSha256: sha256Schema,
      takeoverEventId: uuid,
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal("operation_recovery"), observation: delegationOperationInspectionSchema }).strict(),
]);

const sessionEntrySchema = z.object({
  createdOperationId: uuid,
  entrySha256: sha256Schema,
  initialLedgerHead: sessionLedgerHeadV1Schema,
  legacyAdoption: z.object({
    eventCount: positive,
    firstEventId: uuid,
    firstRawEventSha256: sha256Schema,
    sessionStorageIdentitySha256: sha256Schema,
  }).strict().optional(),
  repositoryId: uuid,
  sessionId: uuid,
}).strict();

export const repositoryRegisterResultCodec = resultCodec<unknown>({
  schema: z.object({
    created: z.boolean(),
    repository: z.object({
      canonicalRootIdentitySha256: sha256Schema,
      label: z.string().min(1).max(4_096),
      repositoryId: uuid,
      status: z.enum(["active", "unavailable", "retired"]),
    }).strict(),
  }).strict(),
  schemaId: "phase21a.repository.register.result.v1",
});

export const sessionCreateResultCodec = resultCodec<unknown>({
  schema: z.object({ session: sessionEntrySchema }).strict(),
  schemaId: "phase21a.session.create.result.v1",
});

export const sessionAdoptLegacyResultCodec = resultCodec<unknown>({
  schema: z.object({ adopted: z.literal(true), eventCount: positive, session: sessionEntrySchema }).strict(),
  schemaId: "phase21a.session.adopt-legacy.result.v1",
});

export const goalProjectionResultCodec = resultCodec<GoalProjection>({
  schema: goalProjectionSchema,
  schemaId: "phase21a.goal.projection.result.v1",
});

export const planProjectionResultCodec = resultCodec<PlanRevisionProjection>({
  schema: planRevisionProjectionResultSchema,
  schemaId: "phase21a.plan.projection.result.v1",
});

export const graphRevisionResultCodec = resultCodec<TaskGraphRevisionProjectionV1>({
  schema: taskGraphRevisionProjectionResultSchema,
  schemaId: "phase21a.graph.revision.result.v1",
});

export const taskExecutionResultCodec = resultCodec<TaskExecutionProjectionV1>({
  schema: taskExecutionProjectionResultSchema,
  schemaId: "phase21a.graph.execution.result.v1",
});

export const delegationRevisionResultCodec = resultCodec<DelegationRevisionProjectionV1>({
  schema: delegationRevisionProjectionResultSchema,
  schemaId: "phase21a.delegation.revision.result.v1",
});

export const graphRunCompositeResultCodec = resultCodec<GraphRunCompositeResultV1>({
  schema: graphRunResultSchema,
  schemaId: "phase21a.graph.run.result.v1",
});

export const graphRetryCompositeResultCodec = resultCodec<TaskExecutionMutationResultV1>({
  schema: taskExecutionMutationResultSchema,
  schemaId: "phase21a.graph.retry.result.v1",
});

function actionBoundPreEffect(actionKind: string): z.ZodType {
  return preEffectTerminalSchema.refine((value) => value.actionKind === actionKind, {
    message: "pre-effect terminal is bound to another application action",
  });
}

export const worktreeAllocateCompositeResultCodec = resultCodec<WorktreeAllocateActionResultV1>({
  schema: z.union([worktreeAllocateResultSchema, actionBoundPreEffect("worktree.allocate")]),
  schemaId: "phase21a.worktree.allocate.result.v1",
});

export const promotionApplyCompositeResultCodec = resultCodec<PromotionApplyActionResultV1>({
  schema: z.union([promotionResultSchema, actionBoundPreEffect("promotion.apply")]),
  schemaId: "phase21a.promotion.apply.result.v1",
});

export const promotionVerifyOriginCompositeResultCodec = resultCodec<PromotionVerifyOriginActionResultV1>({
  schema: z.union([originVerificationResultSchema, actionBoundPreEffect("promotion.verify_origin")]),
  schemaId: "phase21a.promotion.verify-origin.result.v1",
});

export const worktreeCleanupCompositeResultCodec = resultCodec<WorktreeCleanupActionResultV1>({
  schema: z.union([worktreeCleanupResultSchema, actionBoundPreEffect("worktree.cleanup")]),
  schemaId: "phase21a.worktree.cleanup.result.v1",
});

export const graphCancelResultCodec = resultCodec<GraphCancelResultV1>({
  schema: graphCancelResultSchema,
  schemaId: "phase21a.graph.cancel.result.v1",
});

export type DelegationPrepareActionResultContractV1 = Extract<
  DelegationCompositeResultV1,
  { readonly kind: "prepared" }
>;
export type DelegationStartActionResultContractV1 = Extract<
  DelegationCompositeResultV1,
  { readonly kind: "group_terminal" | "pre_effect_terminal" }
>;

export const delegationPrepareCompositeResultCodec = resultCodec<DelegationPrepareActionResultContractV1>({
  schema: delegationPreparedResultSchema,
  schemaId: "phase21a.delegation.prepare.result.v1",
});

export const delegationStartCompositeResultCodec = resultCodec<DelegationStartActionResultContractV1>({
  schema: z.discriminatedUnion("kind", [delegationGroupTerminalSchema, delegationPreEffectTerminalSchema]),
  schemaId: "phase21a.delegation.start.result.v1",
});

export const delegationResumeCompositeResultCodec = resultCodec<DelegationCompositeResultV1>({
  schema: delegationResumeResultSchema,
  schemaId: "phase21a.delegation.resume.result.v1",
});

export const sessionMessageResultCodec = resultCodec<unknown>({
  schema: z.union([
    z.object({
      exitCode: z.number().int(),
      recovered: z.literal(false),
      runId: uuid,
      terminal: z.enum(["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete", "interrupted"]),
    }).strict(),
    z.object({
      exitCode: z.number().int(),
      recovered: z.literal(true),
      runId: uuid,
      terminal: z.enum(["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete"]),
    }).strict(),
    z.object({
      recovered: z.literal(true),
      runId: uuid,
      terminal: z.enum(["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete"]),
    }).strict(),
  ]),
  schemaId: "phase21a.session-message.result.v1",
});

export const sessionResumeResultCodec = resultCodec<SessionResumeOwnerResultV1>({
  schema: z.object({
    exitCode: z.number().int(),
    newRunId: uuid,
    resumeMode: z.enum(["canonical_degraded", "exact"]),
    sourceRunId: uuid,
    terminal: z.enum(["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete"]),
  }).strict(),
  schemaId: "phase21a.session-resume.result.v1",
});

export const runCancelResultCodec = resultCodec<unknown>({
  schema: z.object({
    ownerGenerationSha256: sha256Schema,
    requestEventId: uuid,
    runId: uuid,
    signalStatus: z.literal("exact_owner_signalled"),
    terminalBinding: applicationCancelRequestBindingV1Schema,
  }).strict(),
  schemaId: "phase21a.run-cancel.result.v1",
});

export interface TaskActionResultContractMapV1 {
  readonly "goal.propose": GoalProjection;
  readonly "goal.decide": GoalProjection;
  readonly "plan.propose": PlanRevisionProjection;
  readonly "plan.decide": PlanRevisionProjection;
  readonly "graph.propose": TaskGraphRevisionProjectionV1;
  readonly "graph.decide": TaskGraphRevisionProjectionV1;
  readonly "graph.enqueue": TaskExecutionProjectionV1;
  readonly "graph.run": GraphRunCompositeResultV1;
  readonly "graph.resume": GraphRunCompositeResultV1;
  readonly "graph.retry": TaskExecutionMutationResultV1;
  readonly "graph.cancel": GraphCancelResultV1;
  readonly "worktree.allocate": WorktreeAllocateActionResultV1;
  readonly "worktree.cleanup": WorktreeCleanupActionResultV1;
  readonly "promotion.apply": PromotionApplyActionResultV1;
  readonly "promotion.verify_origin": PromotionVerifyOriginActionResultV1;
  readonly "delegation.propose": DelegationRevisionProjectionV1;
  readonly "delegation.decide": DelegationRevisionProjectionV1;
  readonly "delegation.enqueue": DelegationRevisionProjectionV1;
  readonly "delegation.prepare": DelegationPrepareActionResultContractV1;
  readonly "delegation.resume": DelegationCompositeResultV1;
  readonly "delegation.start": DelegationStartActionResultContractV1;
  readonly "delegation.cancel": DelegationRevisionProjectionV1;
  readonly "run.cancel": unknown;
}

const taskActionResultCodecs: {
  readonly [TKind in keyof TaskActionResultContractMapV1]: StrictCodec<TaskActionResultContractMapV1[TKind]>;
} = Object.freeze({
  "goal.propose": goalProjectionResultCodec,
  "goal.decide": goalProjectionResultCodec,
  "plan.propose": planProjectionResultCodec,
  "plan.decide": planProjectionResultCodec,
  "graph.propose": graphRevisionResultCodec,
  "graph.decide": graphRevisionResultCodec,
  "graph.enqueue": taskExecutionResultCodec,
  "graph.run": graphRunCompositeResultCodec,
  "graph.resume": graphRunCompositeResultCodec,
  "graph.retry": graphRetryCompositeResultCodec,
  "graph.cancel": graphCancelResultCodec,
  "worktree.allocate": worktreeAllocateCompositeResultCodec,
  "worktree.cleanup": worktreeCleanupCompositeResultCodec,
  "promotion.apply": promotionApplyCompositeResultCodec,
  "promotion.verify_origin": promotionVerifyOriginCompositeResultCodec,
  "delegation.propose": delegationRevisionResultCodec,
  "delegation.decide": delegationRevisionResultCodec,
  "delegation.enqueue": delegationRevisionResultCodec,
  "delegation.prepare": delegationPrepareCompositeResultCodec,
  "delegation.resume": delegationResumeCompositeResultCodec,
  "delegation.start": delegationStartCompositeResultCodec,
  "delegation.cancel": delegationRevisionResultCodec,
  "run.cancel": runCancelResultCodec,
});

export function decodeTaskActionResult<TKind extends keyof TaskActionResultContractMapV1>(
  actionKind: TKind,
  wireValue: unknown,
): TaskActionResultContractMapV1[TKind] {
  return taskActionResultCodecs[actionKind].decodeStrict(wireValue);
}
