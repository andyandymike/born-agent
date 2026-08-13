import { z } from "zod";

import {
  delegationParentBindingSchema,
  delegationRevisionContentSchema,
} from "./delegation-schema.js";
import {
  persistedApplicationCommitBindingV1Schema,
  persistedUserActionOriginV2Schema,
} from "../control-plane/application-protocol.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = (bytes: number) => z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= bytes,
  `must not exceed ${String(bytes)} UTF-8 bytes`,
);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

const artifact = z.object({
  artifact_id: artifactId,
  bytes: positiveInteger,
  object_ref: z.string().min(1).max(1024),
  sha256,
}).strict();

const exactDelegation = {
  delegation_id: uuid,
  delegation_revision: positiveInteger,
  delegation_sha256: sha256,
  parent_actor_id: uuid,
  parent_run_id: uuid,
} as const;

const origin = z.union([
  z.object({
    kind: z.enum(["model", "host"]),
    input_surface: z.enum(["tool", "internal"]),
  }).strict(),
  persistedUserActionOriginV2Schema,
]);

const preEffectCancellationOrigin = z.union([
  z.object({
    kind: z.literal("host"),
    input_surface: z.literal("internal"),
  }).strict(),
  persistedUserActionOriginV2Schema,
]);

const budgetCounters = z.object({
  artifact_bytes: nonnegativeInteger,
  attempts: nonnegativeInteger,
  changed_bytes: nonnegativeInteger,
  changed_files: nonnegativeInteger,
  command_executions: nonnegativeInteger,
  command_output_bytes: nonnegativeInteger,
  duration_ms: nonnegativeInteger,
  model_steps: nonnegativeInteger,
  reported_tokens: nonnegativeInteger.nullable(),
}).strict();

const claimStatus = z.enum(["verified", "unverified", "stale"]);
const terminalStatus = z.enum([
  "succeeded",
  "known_failed",
  "pre_effect_infrastructure_failure",
  "cancelled_clean",
  "blocked_unknown_effect",
]);

export const phase20DelegationSessionEventDataSchemas = {
  "delegation.revision.proposed": z.object({
    ...exactDelegation,
    artifact,
    authority_preview_sha256: sha256,
    binding: delegationParentBindingSchema,
    content: delegationRevisionContentSchema,
    origin,
  }).strict(),
  "delegation.revision.replaced": z.object({
    ...exactDelegation,
    artifact,
    authority_preview_sha256: sha256,
    base_revision: positiveInteger,
    base_sha256: sha256,
    binding: delegationParentBindingSchema,
    content: delegationRevisionContentSchema,
    origin,
  }).strict(),
  "delegation.decision.recorded": z.object({
    ...exactDelegation,
    approval_identity_sha256: sha256,
    authority_preview_sha256: sha256,
    decision: z.enum(["approved", "rejected"]),
    decision_request_id: uuid,
    display_artifact: artifact,
    origin: persistedUserActionOriginV2Schema,
    reason: boundedText(4096).min(1).optional(),
    revision_event_id: uuid,
  }).strict(),
  "delegation.queued": z.object({
    ...exactDelegation,
    queue_request_id: uuid,
    origin,
  }).strict(),
  "delegation.cancel.requested": z.object({
    ...exactDelegation,
    cancel_request_id: uuid,
    reason: boundedText(4096).min(1),
    root_event_id: uuid.nullable(),
    origin,
  }).strict(),
  "delegation.cancelled": z.object({
    ...exactDelegation,
    cancel_request_id: uuid,
    terminal_event_id: uuid.nullable(),
  }).strict(),
  "delegation.owner.pre_effect.terminal": z.object({
    ...exactDelegation,
    cancel_request_event_id: uuid,
    cancel_request_id: uuid,
    child_attempt_id: uuid.optional(),
    operation_id: uuid.optional(),
    origin: preEffectCancellationOrigin,
    owner_application_commit: persistedApplicationCommitBindingV1Schema,
    outcome: z.literal("cancelled"),
  }).strict().superRefine((value, context) => {
    if ((value.child_attempt_id === undefined) !== (value.operation_id === undefined)) {
      context.addIssue({
        code: "custom",
        message: "admitted pre-effect cancellation identity must be complete",
      });
    }
  }),
  "delegation.stale": z.object({
    ...exactDelegation,
    observed_binding_sha256: sha256,
    reason: z.enum([
      "goal_changed",
      "plan_changed",
      "graph_changed",
      "parent_terminal",
      "policy_changed",
      "source_changed",
      "workspace_changed",
    ]),
  }).strict(),
  "delegation.envelope.prepared": z.object({
    ...exactDelegation,
    context_capsule_artifact: artifact,
    context_capsule_sha256: sha256,
    envelope_artifact: artifact,
    envelope_sha256: sha256,
    executable: z.literal(false),
    origin: persistedUserActionOriginV2Schema.optional(),
  }).strict(),
  "delegation.resume.requested": z.object({
    ...exactDelegation,
    origin: persistedUserActionOriginV2Schema,
    resume_request_id: uuid,
  }).strict(),
  "delegation.parent.barrier.requested": z.object({
    barrier_id: uuid,
    parent_actor_id: uuid,
    parent_run_id: uuid,
    required_delegation_ids: z.array(uuid).max(8),
  }).strict(),
  "delegation.parent.barrier.suspended": z.object({
    barrier_id: uuid,
    parent_actor_id: uuid,
    parent_run_id: uuid,
  }).strict(),
  "delegation.parent.barrier.released": z.object({
    barrier_id: uuid,
    parent_actor_id: uuid,
    parent_run_id: uuid,
    receipt_sha256s: z.array(sha256).max(8),
    status: z.enum(["completed", "blocked", "cancelled"]),
  }).strict(),
  "delegation.budget.reserved": z.object({
    ...exactDelegation,
    child_attempt_id: uuid,
    reservation_id: uuid,
    reservation_sha256: sha256,
    reserved: budgetCounters,
  }).strict(),
  "delegation.child.launch_requested": z.object({
    ...exactDelegation,
    child_actor_id: uuid,
    child_attempt_id: uuid,
    child_attempt_number: z.number().int().min(1).max(2),
    envelope_artifact: artifact,
    envelope_sha256: sha256,
    prepared_envelope_sha256: sha256,
    executable_descriptor_sha256: sha256,
    operation_id: uuid,
    operation_nonce_sha256: sha256,
  }).strict(),
  "delegation.child.started": z.object({
    ...exactDelegation,
    child_actor_id: uuid,
    child_attempt_id: uuid,
    child_attempt_number: z.number().int().min(1).max(2),
    child_run_id: uuid,
    envelope_sha256: sha256,
    operation_id: uuid,
    process_start_identity: boundedText(512).min(1),
    process_id: positiveInteger,
  }).strict(),
  "delegation.child.approval_waiting": z.object({
    ...exactDelegation,
    action_digest: sha256,
    action_kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    approval_request_id: uuid,
    child_actor_id: uuid,
    child_attempt_id: uuid,
    workspace_id: uuid.nullable(),
  }).strict(),
  "delegation.child.terminal": z.object({
    ...exactDelegation,
    budget_usage: budgetCounters,
    child_actor_id: uuid,
    child_attempt_id: uuid,
    child_run_id: uuid,
    diagnostic_code: z.string().regex(/^[a-z0-9_.:-]{1,128}$/u).nullable(),
    operation_id: uuid,
    terminal: terminalStatus,
    unresolved_effect_ids: z.array(z.string().min(1).max(200)).max(32),
  }).strict(),
  "delegation.effect.reconciled": z.object({
    ...exactDelegation,
    child_attempt_id: uuid,
    effect_id: z.string().min(1).max(200),
    evidence_sha256: sha256,
    observed: z.enum(["applied", "not_applied", "unknown"]),
  }).strict(),
  "delegation.receipt.ready": z.object({
    ...exactDelegation,
    child_actor_id: uuid,
    child_attempt_id: uuid,
    claim_statuses: z.array(z.object({ claim_id: nodeId, status: claimStatus }).strict()).max(16),
    receipt_artifact: artifact,
    receipt_sha256: sha256,
    status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    terminal_event_id: uuid,
  }).strict(),
  "delegation.receipt.accepted": z.object({
    ...exactDelegation,
    child_attempt_id: uuid,
    receipt_artifact_id: artifactId,
    receipt_sha256: sha256,
    ready_event_id: uuid,
  }).strict(),
  "delegation.budget.settled": z.object({
    ...exactDelegation,
    child_attempt_id: uuid,
    held: budgetCounters,
    released: budgetCounters,
    reservation_id: uuid,
    used: budgetCounters,
  }).strict(),
  "delegation.actor_slot.claimed": z.object({
    actor_id: uuid,
    actor_kind: z.enum(["parent", "child"]),
    claim_id: uuid,
    group_id: uuid,
    slot: z.number().int().min(1).max(2),
  }).strict(),
  "delegation.actor_slot.released": z.object({
    actor_id: uuid,
    claim_id: uuid,
    group_id: uuid,
    release_reason: z.enum(["terminal", "cancelled", "reconciled"]),
  }).strict(),
  "delegation.conflict_claim.granted": z.object({
    access: z.enum(["read", "write"]),
    actor_id: uuid,
    claim_id: uuid,
    group_id: uuid,
    path_prefixes: z.array(z.string().min(1).max(1024)).max(32),
    repository_id: sha256,
    source_lineage_id: sha256,
    source_snapshot_sha256: sha256,
    workspace_id: uuid.nullable(),
  }).strict(),
  "delegation.conflict_claim.released": z.object({
    actor_id: uuid,
    claim_id: uuid,
    group_id: uuid,
  }).strict(),
  "delegation.group.lease.acquired": z.object({
    coordinator_kind: z.enum(["foreground", "phase19_background_worker"]),
    coordinator_process_start_identity: boundedText(512).min(1),
    coordinator_process_id: positiveInteger,
    group_id: uuid,
    lease_nonce_sha256: sha256,
    parent_actor_id: uuid,
    parent_run_id: uuid,
    repository_id: sha256,
    origin: persistedUserActionOriginV2Schema.optional(),
  }).strict(),
  "delegation.group.takeover": z.object({
    group_id: uuid,
    new_lease_nonce_sha256: sha256,
    previous_lease_nonce_sha256: sha256,
    reason: z.literal("owner_confirmed_dead_and_effects_reconciled"),
  }).strict(),
  "delegation.blocked": z.object({
    ...exactDelegation,
    blocker_code: z.string().regex(/^[a-z0-9_]{1,128}$/u),
    evidence_sha256s: z.array(sha256).max(32),
  }).strict(),
} as const;

export type Phase20DelegationSessionEventType = keyof typeof phase20DelegationSessionEventDataSchemas;
export type Phase20DelegationSessionEventData<TType extends Phase20DelegationSessionEventType> =
  z.infer<(typeof phase20DelegationSessionEventDataSchemas)[TType]>;

export const delegationArtifactEventSchema = artifact;
export const delegationBudgetCountersEventSchema = budgetCounters;
