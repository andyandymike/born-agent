import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { planItemStatusSchema, sha256Schema } from "../../plans/plan-schema.js";
import { taskGraphBudgetSchema } from "../../task-graph/task-graph-schema.js";
import { delegationExpectedReceiptSchema } from "../delegation-schema.js";
import { DelegationError } from "../delegation-errors.js";

const uuid = z.string().uuid();
const boundedText = (bytes: number) => z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= bytes,
  `must not exceed ${String(bytes)} UTF-8 bytes`,
);
const relativeRef = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
"must be a bounded relative reference");
const path = z.string().min(1).max(1024).refine((value) =>
  value === "." || (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  ), "must be a canonical relative POSIX path");

const acceptedChildReceiptProjection = z.object({
  kind: z.literal("accepted_child_receipt"),
  receiptSha256: sha256Schema,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  verifiedClaimIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).max(16),
}).strict();

const taskNodeReceiptProjection = z.object({
  attemptId: uuid,
  kind: z.literal("task_node_receipt"),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  receiptSha256: sha256Schema,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
}).strict();

const artifactExcerptProjection = z.object({
  kind: z.literal("artifact_excerpt"),
  mediaType: z.enum(["application/json", "text/markdown", "text/plain"]),
  text: boundedText(32 * 1024),
  truncated: z.boolean(),
}).strict();

const repositoryObservationProjection = z.object({
  kind: z.literal("repository_observation"),
  observedPaths: z.array(path).max(128),
  repositoryId: sha256Schema,
  summary: boundedText(8 * 1024),
}).strict();

const ruleSummaryProjection = z.object({
  kind: z.literal("rule_summary"),
  ruleIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)).max(64),
  scopes: z.array(path).max(32),
  summary: boundedText(32 * 1024),
}).strict();

export const contextCapsuleFactProjectionSchema = z.discriminatedUnion("kind", [
  acceptedChildReceiptProjection,
  taskNodeReceiptProjection,
  artifactExcerptProjection,
  repositoryObservationProjection,
  ruleSummaryProjection,
]);

export const contextCapsuleFactSchema = z.object({
  factId: sha256Schema,
  kind: z.enum([
    "accepted_child_receipt",
    "task_node_receipt",
    "artifact_excerpt",
    "repository_observation",
    "rule_summary",
  ]),
  trustClass: z.enum(["host_verified", "historical_untrusted_narrative"]),
  artifactRef: relativeRef,
  artifactSha256: sha256Schema,
  sourceSnapshotSha256: sha256Schema.nullable(),
  boundedProjection: contextCapsuleFactProjectionSchema,
}).strict().superRefine((value, context) => {
  if (value.kind !== value.boundedProjection.kind) {
    context.addIssue({ code: "custom", message: "fact kind must match its bounded projection" });
  }
});

export const contextCapsuleContentSchema = z.object({
  schemaVersion: z.literal(1),
  childActorId: uuid,
  delegationId: uuid,
  delegationRevision: z.number().int().positive(),
  delegationSha256: sha256Schema,
  objective: boundedText(8 * 1024).min(1),
  expectedReceipt: delegationExpectedReceiptSchema,
  goal: z.object({
    goalId: uuid,
    revision: z.number().int().positive(),
    objective: boundedText(8 * 1024).min(1),
    constraints: z.array(boundedText(1024)).max(32),
  }).strict(),
  planItems: z.array(z.object({
    planItemId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
    title: boundedText(1024).min(1),
    statusAtFreeze: planItemStatusSchema,
  }).strict()).max(16),
  facts: z.array(contextCapsuleFactSchema).max(32),
  repository: z.object({
    repositoryId: sha256Schema,
    sourceSnapshotSha256: sha256Schema,
    ruleManifestRef: relativeRef.nullable(),
    ruleManifestSha256: sha256Schema.nullable(),
    indexGenerationId: uuid.nullable(),
    indexSourceSnapshotSha256: sha256Schema.nullable(),
  }).strict().superRefine((value, context) => {
    const rule = [value.ruleManifestRef, value.ruleManifestSha256];
    const index = [value.indexGenerationId, value.indexSourceSnapshotSha256];
    if (!(rule.every((item) => item === null) || rule.every((item) => item !== null))) {
      context.addIssue({ code: "custom", message: "rule manifest identity must be complete or null" });
    }
    if (!(index.every((item) => item === null) || index.every((item) => item !== null))) {
      context.addIssue({ code: "custom", message: "index identity must be complete or null" });
    }
  }),
  workspace: z.object({
    logicalWorkspaceId: z.string().min(1).max(256),
    lineageId: sha256Schema,
    mode: z.enum(["origin_read_only", "managed_worktree"]),
    baselineSha256: sha256Schema,
    declaredPathPrefixes: z.array(path).max(32),
  }).strict(),
  constraints: z.object({
    taskProfile: z.enum(["read-only", "coding"]),
    toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(32),
    capabilityIds: z.array(z.string().min(1).max(512)).max(16),
    maximumBudget: taskGraphBudgetSchema,
    delegationDepth: z.literal(1),
  }).strict(),
  omittedFacts: z.array(z.object({
    requestedRef: sha256Schema,
    reasonCode: z.enum([
      "artifact_missing",
      "hash_mismatch",
      "index_stale",
      "path_denied",
      "sensitive",
      "source_stale",
      "too_large",
      "unsupported_kind",
      "unverified",
    ]),
  }).strict()).max(32),
}).strict();

export const contextCapsuleSchema = contextCapsuleContentSchema.extend({
  capsuleSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { capsuleSha256, ...content } = value;
  if (sha256Canonical(content) !== capsuleSha256) {
    context.addIssue({ code: "custom", message: "capsule hash does not match canonical content" });
  }
});

export type ContextCapsuleFactV1 = Readonly<z.infer<typeof contextCapsuleFactSchema>>;
export type ContextCapsuleContentV1 = Readonly<z.infer<typeof contextCapsuleContentSchema>>;
export type ContextCapsuleV1 = Readonly<z.infer<typeof contextCapsuleSchema>>;

export function createContextCapsule(content: unknown, maximumBytes: number): ContextCapsuleV1 {
  const parsed = contextCapsuleContentSchema.parse(content);
  const capsule = contextCapsuleSchema.parse({ ...parsed, capsuleSha256: sha256Canonical(parsed) });
  const bytes = Buffer.byteLength(canonicalJson(capsule), "utf8");
  if (bytes > maximumBytes) {
    throw new DelegationError("delegation_context_too_large", `context capsule exceeds ${String(maximumBytes)} bytes`);
  }
  return Object.freeze(capsule);
}
