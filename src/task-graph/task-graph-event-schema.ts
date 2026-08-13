import { z } from "zod";

import { canonicalTaskGraphIdentity, taskGraphApprovalIdentity } from "./task-graph-identity.js";
import { taskGraphRevisionContentSchema } from "./task-graph-schema.js";
import { phase19WorktreeSessionEventDataSchemas } from "../worktrees/worktree-event-schema.js";
import { phase19BackgroundSessionEventDataSchemas } from "../background/background-event-schema.js";
import { persistedUserActionOriginV2Schema } from "../control-plane/application-protocol.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bounded = (bytes: number) => z.string().refine(
  (value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= bytes,
  `must be NUL-free and at most ${String(bytes)} UTF-8 bytes`,
);
const graphRefFields = {
  graph_id: uuid,
  graph_revision: positive,
  graph_sha256: sha256,
} as const;
const graphBindingEventSchema = z.object({
  session_id: uuid,
  goal_id: uuid,
  goal_revision: positive,
  plan_id: uuid,
  plan_revision: positive,
  plan_sha256: sha256,
}).strict();
const artifactRefSchema = z.object({
  artifact_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  bytes: positive.max(256 * 1024),
  object_ref: bounded(1024).refine((value) => !value.startsWith("/") && !value.includes("\\")),
  sha256,
}).strict().superRefine((value, context) => {
  if (value.artifact_id !== `sha256:${value.sha256}`) {
    context.addIssue({ code: "custom", message: "artifact ID and SHA-256 must match" });
  }
});
const userOriginSchema = persistedUserActionOriginV2Schema;
const agentOriginSchema = z.object({
  kind: z.literal("agent"),
  run_id: uuid,
  call_id: bounded(200).min(1),
  arguments_sha256: sha256,
  agent_mode: z.literal("plan"),
}).strict();
const graphOriginSchema = z.union([userOriginSchema, agentOriginSchema]);

function validateRevisionEvent(
  value: {
    readonly artifact: z.infer<typeof artifactRefSchema>;
    readonly binding: z.infer<typeof graphBindingEventSchema>;
    readonly content: z.infer<typeof taskGraphRevisionContentSchema>;
    readonly graph_id: string;
    readonly graph_sha256: string;
  },
  context: z.RefinementCtx,
): void {
  const identity = canonicalTaskGraphIdentity(value.content);
  const binding = value.content.binding;
  if (
    identity.graphSha256 !== value.graph_sha256 ||
    value.artifact.sha256 !== value.graph_sha256 ||
    value.artifact.bytes !== identity.byteLength ||
    value.graph_id !== value.content.graphId
  ) {
    context.addIssue({ code: "custom", message: "Graph content, artifact, and event identity are inconsistent" });
  }
  if (
    value.binding.session_id !== binding.sessionId ||
    value.binding.goal_id !== binding.goalId ||
    value.binding.goal_revision !== binding.goalRevision ||
    value.binding.plan_id !== binding.planId ||
    value.binding.plan_revision !== binding.planRevision ||
    value.binding.plan_sha256 !== binding.planSha256
  ) {
    context.addIssue({ code: "custom", message: "Graph event binding does not match canonical content" });
  }
}

const proposed = z.object({
  ...graphRefFields,
  artifact: artifactRefSchema,
  binding: graphBindingEventSchema,
  content: taskGraphRevisionContentSchema,
  origin: graphOriginSchema,
}).strict().superRefine((value, context) => {
  if (value.graph_revision !== 1) {
    context.addIssue({ code: "custom", message: "initial Graph proposal must be revision 1" });
  }
  validateRevisionEvent(value, context);
});

const replaced = z.object({
  ...graphRefFields,
  artifact: artifactRefSchema,
  base_revision: positive,
  base_sha256: sha256,
  binding: graphBindingEventSchema,
  content: taskGraphRevisionContentSchema,
  origin: graphOriginSchema,
}).strict().superRefine((value, context) => {
  if (value.graph_revision !== value.base_revision + 1) {
    context.addIssue({ code: "custom", message: "replacement revision must advance exactly one" });
  }
  validateRevisionEvent(value, context);
});

const decisionBase = {
  ...graphRefFields,
  approval_identity_sha256: sha256,
  binding: graphBindingEventSchema,
  decision_request_id: uuid,
  origin: userOriginSchema,
  revision_event_id: uuid,
} as const;

const approved = z.object(decisionBase).strict().superRefine((value, context) => {
  const actual = taskGraphApprovalIdentity({
    approvalRequestId: value.decision_request_id,
    binding: {
      sessionId: value.binding.session_id,
      goalId: value.binding.goal_id,
      goalRevision: value.binding.goal_revision,
      planId: value.binding.plan_id,
      planRevision: value.binding.plan_revision,
      planSha256: value.binding.plan_sha256,
    },
    graphId: value.graph_id,
    graphRevision: value.graph_revision,
    graphSha256: value.graph_sha256,
    sessionId: value.binding.session_id,
  });
  if (actual !== value.approval_identity_sha256) {
    context.addIssue({ code: "custom", message: "Graph approval identity is inconsistent" });
  }
});

const rejected = z.object({
  ...decisionBase,
  reason: bounded(2048).optional(),
}).strict().superRefine((value, context) => {
  const actual = taskGraphApprovalIdentity({
    approvalRequestId: value.decision_request_id,
    binding: {
      sessionId: value.binding.session_id,
      goalId: value.binding.goal_id,
      goalRevision: value.binding.goal_revision,
      planId: value.binding.plan_id,
      planRevision: value.binding.plan_revision,
      planSha256: value.binding.plan_sha256,
    },
    graphId: value.graph_id,
    graphRevision: value.graph_revision,
    graphSha256: value.graph_sha256,
    sessionId: value.binding.session_id,
  });
  if (actual !== value.approval_identity_sha256) {
    context.addIssue({ code: "custom", message: "Graph rejection identity is inconsistent" });
  }
});

const graphExactTarget = z.object({ ...graphRefFields }).strict();
const graphEnqueuedFields = {
  ...graphRefFields,
  enqueue_id: uuid,
  binding: graphBindingEventSchema,
  requested_execution: z.enum(["foreground", "background"]),
  runtime_profile_id: bounded(128).min(1),
} as const;
const graphCancelRequestedFields = {
  ...graphRefFields,
  active_attempt_id: uuid.nullable(),
  reason: bounded(2048).min(1),
  request_id: uuid,
} as const;
const graphRetryRequestedFields = {
  ...graphRefFields,
  attempt_number: positive.max(3),
  node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  requested_by: z.literal("user"),
  terminal_event_id: uuid,
} as const;
const authenticatedGraphRetryRequested = z.object({
  ...graphRetryRequestedFields,
  origin: userOriginSchema,
  previous_terminal: z.enum(["known_failed", "pre_effect_infrastructure_failure", "cancelled_clean"]),
}).strict();

function legacyOrAuthenticatedUserEvent<T extends z.ZodRawShape>(fields: T) {
  return z.union([
    z.object(fields).strict(),
    z.object({ ...fields, origin: userOriginSchema }).strict(),
  ]);
}

export const phase19TaskGraphSessionEventDataSchemas = {
  "task_graph.proposed": proposed,
  "task_graph.replaced": replaced,
  "task_graph.approved": approved,
  "task_graph.rejected": rejected,
  "task_graph.stale": z.object({
    ...graphRefFields,
    classification: z.enum(["goal_changed", "plan_changed", "policy_changed", "capability_changed", "source_changed"]),
    observed_binding_sha256: sha256,
    previous_binding: graphBindingEventSchema,
  }).strict(),
  "task_graph.enqueued": legacyOrAuthenticatedUserEvent(graphEnqueuedFields),
  "task_graph.started": legacyOrAuthenticatedUserEvent({
    ...graphRefFields,
    enqueue_id: uuid,
    scheduler_lease_nonce_sha256: sha256,
  }),
  "task_graph.waiting_for_user": z.object({
    ...graphRefFields,
    attempt_id: uuid.nullable(),
    reason: z.enum(["approval_required", "input_required", "promotion_required", "profile_required", "reconciliation_required"]),
    requested_action_ref: bounded(1024).optional(),
  }).strict(),
  "task_graph.cancel.requested": legacyOrAuthenticatedUserEvent(graphCancelRequestedFields),
  "task_graph.terminal": z.object({
    ...graphRefFields,
    blocker_code: bounded(128).optional(),
    reason: bounded(2048),
    status: z.enum(["completed", "blocked", "cancelled", "failed", "stale", "awaiting_integration"]),
  }).strict(),
  "task_scheduler.lease.acquired": z.object({
    ...graphRefFields,
    lease_nonce_sha256: sha256,
    repository_id: sha256,
  }).strict(),
  "task_scheduler.lease.recovered": z.object({
    ...graphRefFields,
    evidence_sha256: sha256,
    previous_lease_nonce_sha256: sha256,
    repository_id: sha256,
  }).strict(),
  "task_node.attempt.requested": z.object({
    ...graphRefFields,
    attempt_id: uuid,
    attempt_number: positive.max(3),
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    reservation: z.object({
      attempts: positive.max(1),
      duration_ms: nonnegative,
      model_steps: nonnegative,
      command_executions: nonnegative,
      command_output_bytes: nonnegative,
      changed_files: nonnegative,
      changed_bytes: nonnegative,
      artifact_bytes: nonnegative,
      reported_tokens: nonnegative.nullable(),
    }).strict(),
    retry_origin: z.enum(["initial", "automatic", "user"]),
    workspace_binding: z.object({
      managed_path_sha256: sha256,
      repository_id: sha256,
      source_snapshot_sha256: sha256,
      workspace_baseline_sha256: sha256,
      workspace_id: uuid,
    }).strict().optional(),
  }).strict(),
  "task_node.attempt.started": z.object({
    ...graphRefFields,
    attempt_id: uuid,
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    run_id: uuid,
    scheduler_lease_nonce_sha256: sha256,
  }).strict(),
  "task_node.attempt.waiting_for_user": z.object({
    ...graphRefFields,
    attempt_id: uuid,
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    reason: z.enum(["approval_required", "input_required", "promotion_required", "profile_required"]),
    requested_action_ref: bounded(1024),
  }).strict(),
  "task_node.attempt.terminal": z.object({
    ...graphRefFields,
    attempt_id: uuid,
    budget: z.object({
      artifact_bytes: nonnegative,
      attempts: positive.max(1),
      changed_bytes: nonnegative,
      changed_files: nonnegative,
      command_executions: nonnegative,
      command_output_bytes: nonnegative,
      duration_ms: nonnegative,
      model_steps: nonnegative,
      reported_tokens: nonnegative.nullable(),
      usage_completeness: z.enum(["complete", "partial", "none"]),
    }).strict(),
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    receipt_artifact_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
    receipt_sha256: sha256.nullable(),
    run_id: uuid.nullable(),
    terminal: z.enum([
      "succeeded",
      "known_failed",
      "cancelled_clean",
      "blocked_unknown_effect",
      "blocked_reconciliation",
      "pre_effect_infrastructure_failure",
    ]),
  }).strict(),
  "task_node.retry.requested": z.union([
    z.object(graphRetryRequestedFields).strict(),
    authenticatedGraphRetryRequested,
  ]),
  "task_node.skipped": z.object({
    ...graphRefFields,
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    root_blocker_node_ids: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).min(1).max(32),
    terminal_event_ids: z.array(uuid).min(1).max(32),
  }).strict(),
  "task_budget.exhausted": z.object({
    ...graphRefFields,
    counter: z.enum([
      "attempts",
      "duration_ms",
      "model_steps",
      "command_executions",
      "command_output_bytes",
      "changed_files",
      "changed_bytes",
      "artifact_bytes",
      "reported_tokens",
    ]),
    node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).nullable(),
  }).strict(),
  ...phase19WorktreeSessionEventDataSchemas,
  ...phase19BackgroundSessionEventDataSchemas,
} as const;

export type Phase19TaskGraphSessionEventType = keyof typeof phase19TaskGraphSessionEventDataSchemas;
export type Phase19TaskGraphSessionEventData<TType extends Phase19TaskGraphSessionEventType> =
  z.infer<(typeof phase19TaskGraphSessionEventDataSchemas)[TType]>;

export const taskGraphExactTargetSchema = graphExactTarget;
export { artifactRefSchema as taskGraphArtifactRefSchema, graphBindingEventSchema as taskGraphBindingEventSchema };
