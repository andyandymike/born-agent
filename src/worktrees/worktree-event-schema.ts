import { z } from "zod";

import {
  managedWorktreeIdentitySchema,
  promotionBundleSchema,
  workspaceAllocationPlanSchema,
  workspaceBaselineManifestSchema,
} from "./worktree-schema.js";
import { taskPromotionGoalChangeRecordedDataSchema } from "./task-promotion-goal-change.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const graph = {
  graph_id: uuid,
  graph_revision: positive,
  graph_sha256: sha256,
} as const;

export const phase19WorktreeSessionEventDataSchemas = {
  "goal.change.recorded": taskPromotionGoalChangeRecordedDataSchema,
  "task_worktree.allocation.prepared": z.object({
    ...graph,
    allocation_plan: workspaceAllocationPlanSchema,
    allocation_plan_sha256: sha256,
  }).strict(),
  "task_worktree.allocation.approved": z.object({
    ...graph,
    allocation_plan_sha256: sha256,
    approval_identity_sha256: sha256,
    approval_request_id: uuid,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.create.requested": z.object({
    ...graph,
    allocation_plan_sha256: sha256,
    operation_id: uuid,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.created": z.object({
    ...graph,
    identity: managedWorktreeIdentitySchema,
    operation_id: uuid,
  }).strict(),
  "task_worktree.baseline.seeded": z.object({
    ...graph,
    baseline: workspaceBaselineManifestSchema,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.lease.acquired": z.object({
    ...graph,
    attempt_id: uuid,
    lease_nonce_sha256: sha256,
    node_id: nodeId,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.lease.released": z.object({
    ...graph,
    attempt_id: uuid,
    node_id: nodeId,
    terminal_event_id: uuid,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.snapshot.accepted": z.object({
    ...graph,
    attempt_id: uuid,
    changed_bytes: nonnegative,
    changed_files: nonnegative,
    node_id: nodeId,
    snapshot_sha256: sha256,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.promotion.proposed": z.object({
    ...graph,
    bundle: promotionBundleSchema,
    bundle_sha256: sha256,
    proposal_id: uuid,
  }).strict(),
  "task_worktree.promotion.approved": z.object({
    ...graph,
    approval_identity_sha256: sha256,
    approval_request_id: uuid,
    bundle_sha256: sha256,
    target_snapshot_sha256: sha256,
  }).strict(),
  "task_worktree.promotion.requested": z.object({
    ...graph,
    approval_request_id: uuid,
    bundle_sha256: sha256,
    operation_id: uuid,
    target_snapshot_sha256: sha256,
  }).strict(),
  "task_worktree.promotion.applied": z.object({
    ...graph,
    bundle_sha256: sha256,
    changed_paths: z.array(z.string().min(1).max(1024)).max(256),
    operation_id: uuid,
    origin_source_snapshot_sha256: sha256,
    result_snapshot_sha256: sha256,
  }).strict(),
  "task_origin_verification.approved": z.object({
    ...graph,
    action_sha256: sha256,
    approval_identity_sha256: sha256,
    approval_request_id: uuid,
    bundle_sha256: sha256,
    command_sha256: sha256,
    origin_source_snapshot_sha256: sha256,
    promotion_operation_id: uuid,
    verification_id: uuid,
    verification_node_id: nodeId,
    workspace_id: uuid,
  }).strict(),
  "task_origin_verification.requested": z.object({
    ...graph,
    action_sha256: sha256,
    approval_request_id: uuid,
    bundle_sha256: sha256,
    command_sha256: sha256,
    origin_source_snapshot_sha256: sha256,
    promotion_operation_id: uuid,
    verification_id: uuid,
    verification_node_id: nodeId,
    workspace_id: uuid,
  }).strict(),
  "task_origin_verification.completed": z.object({
    ...graph,
    action_sha256: sha256,
    after_source_state_sha256: sha256,
    before_source_state_sha256: sha256,
    bundle_sha256: sha256,
    cleanup_verified: z.boolean(),
    command_sha256: sha256,
    exit_code: z.number().int().nullable(),
    origin_source_snapshot_sha256: sha256,
    promotion_operation_id: uuid,
    receipt_artifact_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    receipt_sha256: sha256,
    status: z.enum(["cancelled", "failed", "passed", "reconciliation_required"]),
    termination: z.enum(["cancelled", "cleanup_failed", "exit", "output_limit_exceeded", "signal", "spawn_error", "stale", "timeout"]),
    verification_id: uuid,
    verification_node_id: nodeId,
    workspace_id: uuid,
  }).strict(),
  "task_worktree.cleanup.requested": z.object({
    ...graph,
    archive_sha256: sha256.nullable(),
    force: z.boolean(),
    operation_id: uuid,
    workspace_id: uuid,
    workspace_snapshot_sha256: sha256,
  }).strict(),
  "task_worktree.cleanup.completed": z.object({
    ...graph,
    operation_id: uuid,
    status: z.enum(["archived", "removed", "retained"]),
    workspace_id: uuid,
  }).strict(),
  "task_worktree.reconciled": z.object({
    ...graph,
    evidence_sha256: sha256,
    observed: z.enum(["applied_divergent", "applied_exact", "not_applied", "unknown"]),
    operation_id: uuid,
    workspace_id: uuid,
  }).strict(),
} as const;
