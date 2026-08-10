import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { sha256Schema } from "../../plans/plan-schema.js";
import { taskGraphBudgetSchema } from "../../task-graph/task-graph-schema.js";

const uuid = z.string().uuid();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stableId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const relativeRef = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."));
const path = z.string().min(1).max(1024).refine((value) =>
  value === "." || (!value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")));

export const childActorIdentitySchema = z.object({
  actorKind: z.literal("delegated_child"),
  actorId: uuid,
  delegationId: uuid,
  delegationRevision: positive,
  delegationSha256: sha256Schema,
  attemptId: uuid,
  attemptNumber: z.number().int().min(1).max(2),
  parentActorId: uuid,
  parentRunId: uuid,
}).strict();

export const delegationModelEnvelopeContentSchema = z.object({
  executionBackend: z.enum(["provider", "canonical_fake"]),
  policyProfileId: stableId,
  providerId: stableId,
  modelId: z.string().min(1).max(500),
  qualificationId: z.string().min(1).max(256),
  qualificationSha256: sha256Schema,
  delegatedToolProfileSha256: sha256Schema,
  contextCapacity: positive.nullable(),
  networkEligibility: z.enum(["local_only", "remote_explicit"]),
}).strict();

export const delegationModelEnvelopeSchema = delegationModelEnvelopeContentSchema.extend({
  envelopeSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { envelopeSha256, ...content } = value;
  if (sha256Canonical(content) !== envelopeSha256) {
    context.addIssue({ code: "custom", message: "model envelope hash mismatch" });
  }
});

export const delegationBudgetReservationPlanContentSchema = z.object({
  parentBudgetLedgerRevision: z.number().int().nonnegative(),
  graphBudgetLedgerRevision: z.number().int().nonnegative().nullable(),
  ceiling: taskGraphBudgetSchema,
}).strict();

export const delegationBudgetReservationPlanSchema = delegationBudgetReservationPlanContentSchema.extend({
  planSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { planSha256, ...content } = value;
  if (sha256Canonical(content) !== planSha256) {
    context.addIssue({ code: "custom", message: "budget reservation plan hash mismatch" });
  }
});

export const childEnvironmentPolicySchema = z.object({
  schemaVersion: z.literal(1),
  allowedVariableNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)).max(16),
  fixedValueDigests: z.array(z.object({ name: z.string(), sha256: sha256Schema }).strict()).max(16),
  deniedCategories: z.array(stableId).max(16),
  policySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { policySha256, ...content } = value;
  if (sha256Canonical(content) !== policySha256) {
    context.addIssue({ code: "custom", message: "child environment policy hash mismatch" });
  }
});

export const preparedChildEnvelopeContentSchema = z.object({
  schemaVersion: z.literal(1),
  actor: childActorIdentitySchema,
  contextCapsuleRef: relativeRef,
  contextCapsuleSha256: sha256Schema,
  effectiveAuthority: z.object({
    taskProfile: z.enum(["read-only", "coding"]),
    toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(32),
    capabilitySnapshotRef: relativeRef,
    capabilitySnapshotSha256: sha256Schema,
  }).strict(),
  model: delegationModelEnvelopeSchema,
  budgetReservationPlan: delegationBudgetReservationPlanSchema,
  workspace: z.object({
    logicalWorkspaceId: z.string().min(1).max(256),
    lineageId: sha256Schema,
    mode: z.enum(["origin_read_only", "managed_worktree"]),
    sourceSnapshotSha256: sha256Schema,
    declaredPathPrefixes: z.array(path).max(32),
  }).strict(),
  approvalNamespace: sha256Schema,
  environmentPolicy: childEnvironmentPolicySchema,
  preparation: z.object({
    executable: z.literal(false),
    preparedAt: z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z")),
    parentProjectionSha256: sha256Schema,
    policySha256: sha256Schema,
    toolProfileSha256: sha256Schema,
    budgetPlanSha256: sha256Schema,
  }).strict(),
}).strict();

export const preparedChildEnvelopeSchema = preparedChildEnvelopeContentSchema.extend({
  envelopeSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { envelopeSha256, ...content } = value;
  if (sha256Canonical(content) !== envelopeSha256) {
    context.addIssue({ code: "custom", message: "prepared child envelope hash mismatch" });
  }
});

export type ChildActorIdentityV1 = Readonly<z.infer<typeof childActorIdentitySchema>>;
export type DelegationModelEnvelopeV1 = Readonly<z.infer<typeof delegationModelEnvelopeSchema>>;
export type DelegationBudgetReservationPlanV1 = Readonly<z.infer<typeof delegationBudgetReservationPlanSchema>>;
export type PreparedChildEnvelopeV1 = Readonly<z.infer<typeof preparedChildEnvelopeSchema>>;

export function createDelegationModelEnvelope(
  content: z.input<typeof delegationModelEnvelopeContentSchema>,
): DelegationModelEnvelopeV1 {
  const parsed = delegationModelEnvelopeContentSchema.parse(content);
  return Object.freeze(delegationModelEnvelopeSchema.parse({
    ...parsed,
    envelopeSha256: sha256Canonical(parsed),
  }));
}

export function createBudgetReservationPlan(
  content: z.input<typeof delegationBudgetReservationPlanContentSchema>,
): DelegationBudgetReservationPlanV1 {
  const parsed = delegationBudgetReservationPlanContentSchema.parse(content);
  return Object.freeze(delegationBudgetReservationPlanSchema.parse({
    ...parsed,
    planSha256: sha256Canonical(parsed),
  }));
}

export function createPreparedChildEnvelope(
  content: unknown,
): PreparedChildEnvelopeV1 {
  const parsed = preparedChildEnvelopeContentSchema.parse(content);
  return Object.freeze(preparedChildEnvelopeSchema.parse({
    ...parsed,
    envelopeSha256: sha256Canonical(parsed),
  }));
}
