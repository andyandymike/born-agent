import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { sha256Schema } from "../../plans/plan-schema.js";
import { DelegationError } from "../delegation-errors.js";

const uuid = z.string().uuid();
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = (bytes: number) => z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= bytes,
  `must not exceed ${String(bytes)} UTF-8 bytes`,
);
const relativeRef = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."));

export const childReceiptBudgetUsageSchema = z.object({
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

export const childReceiptEvidenceSchema = z.object({
  kind: z.enum([
    "artifact",
    "change_bundle",
    "file_digest",
    "repository_observation",
    "symbol_observation",
    "verification_generation",
  ]),
  artifactRef: relativeRef,
  sha256: sha256Schema,
  sourceSnapshotSha256: sha256Schema.nullable(),
}).strict();

export const childReceiptClaimSchema = z.object({
  claimId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  kind: z.enum([
    "answer",
    "file_observation",
    "symbol_observation",
    "change_bundle",
    "verification_result",
  ]),
  status: z.enum(["verified", "unverified", "stale"]),
  narrative: boundedText(8 * 1024),
  evidence: z.array(childReceiptEvidenceSchema).max(16),
}).strict();

export const childReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  delegationId: uuid,
  delegationRevision: z.number().int().positive(),
  delegationSha256: sha256Schema,
  childActorId: uuid,
  childAttemptId: uuid,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  summary: boundedText(4 * 1024),
  claims: z.array(childReceiptClaimSchema).max(16),
  workspace: z.object({
    logicalWorkspaceId: z.string().min(1).max(256),
    sourceSnapshotSha256: sha256Schema,
    resultSnapshotSha256: sha256Schema.nullable(),
    changeBundleRef: relativeRef.nullable(),
    changeBundleSha256: sha256Schema.nullable(),
  }).strict().superRefine((value, context) => {
    const change = [value.changeBundleRef, value.changeBundleSha256];
    if (!(change.every((item) => item === null) || change.every((item) => item !== null))) {
      context.addIssue({ code: "custom", message: "change bundle identity must be complete or null" });
    }
  }),
  verificationGenerationIds: z.array(uuid).max(32),
  unresolvedEffects: z.array(z.string().min(1).max(200)).max(32),
  budgetUsage: childReceiptBudgetUsageSchema,
  terminalEventId: uuid,
}).strict().superRefine((value, context) => {
  if (new Set(value.claims.map((claim) => claim.claimId)).size !== value.claims.length) {
    context.addIssue({ code: "custom", message: "receipt claim IDs must be unique" });
  }
  const refs = value.claims.reduce((count, claim) => count + claim.evidence.length, 0);
  if (refs > 64) context.addIssue({ code: "custom", message: "receipt has more than 64 evidence refs" });
  if (value.status === "succeeded" && value.unresolvedEffects.length > 0) {
    context.addIssue({ code: "custom", message: "succeeded receipt cannot contain unresolved effects" });
  }
});

export const childReceiptSchema = childReceiptContentSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...content } = value;
  if (sha256Canonical(content) !== receiptSha256) {
    context.addIssue({ code: "custom", message: "child receipt hash mismatch" });
  }
});

export type ChildReceiptEvidenceV1 = Readonly<z.infer<typeof childReceiptEvidenceSchema>>;
export type ChildReceiptClaimV1 = Readonly<z.infer<typeof childReceiptClaimSchema>>;
export type ChildReceiptBudgetUsageV1 = Readonly<z.infer<typeof childReceiptBudgetUsageSchema>>;
export type ChildReceiptV1 = Readonly<z.infer<typeof childReceiptSchema>>;

export function createChildReceipt(content: unknown): ChildReceiptV1 {
  const parsed = childReceiptContentSchema.parse(content);
  const receipt = childReceiptSchema.parse({ ...parsed, receiptSha256: sha256Canonical(parsed) });
  if (Buffer.byteLength(canonicalJson(receipt), "utf8") > 64 * 1024) {
    throw new DelegationError("delegation_receipt_invalid", "child receipt exceeds 64 KiB");
  }
  return Object.freeze(receipt);
}
