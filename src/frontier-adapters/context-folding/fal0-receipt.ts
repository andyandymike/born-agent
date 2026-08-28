import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { FAL0_CONTEXT_FOLDING_EXPERIMENT_ID } from "./fal0-manifest.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const fal0CandidateObservationSchema = z.object({
  bytes: nonnegative,
  tokens: nonnegative,
  selected: z.boolean(),
  losslessExpansion: z.boolean(),
  duplicateClaimInstancesRemoved: nonnegative,
  duplicateEvidenceInstancesRemoved: nonnegative,
}).strict();

export const fal0ContextFoldingCaseResultSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96),
  class: z.enum(["representative", "security", "stress"]),
  baseline: z.object({
    rawTrajectoryBytes: nonnegative.nullable(),
    rawTrajectoryTokens: nonnegative.nullable(),
    receiptProjectionBytes: nonnegative,
    receiptProjectionTokens: nonnegative,
    taskContextTokens: nonnegative,
    receiptCount: nonnegative,
    verifiedClaimCount: nonnegative,
  }).strict(),
  candidate: fal0CandidateObservationSchema.nullable(),
  correctness: z.object({
    requiredFactsPresent: z.boolean(),
    forbiddenFactsAbsent: z.boolean(),
    sourceIdentityExact: z.boolean(),
    authorityEquivalent: z.boolean(),
  }).strict(),
  cost: z.object({
    additionalModelCalls: nonnegative,
    additionalToolCalls: nonnegative,
    projectorDurationMs: z.number().finite().nonnegative(),
  }).strict(),
  status: z.enum(["pass", "fail", "not_applicable"]),
}).strict();

const fal0ContextFoldingReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL0_CONTEXT_FOLDING_EXPERIMENT_ID),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable(),
  manifestSha256: sha256,
  estimatorId: sha256,
  baselineImplementationSha256: sha256,
  candidateImplementationSha256: sha256.nullable(),
  cases: z.array(fal0ContextFoldingCaseResultSchema).length(24),
  aggregate: z.object({
    representativeCases: nonnegative,
    foldEligibleCases: nonnegative,
    baselineReceiptTokens: nonnegative,
    selectedReceiptTokens: nonnegative,
    medianEligibleReductionRatio: z.number().min(0).max(1).nullable(),
    hardGateFailures: nonnegative,
  }).strict(),
  qualityEvidence: z.enum(["passed", "failed", "not_run"]),
  platformEvidence: z.object({
    windows: z.enum(["passed", "failed", "not_run"]),
    linux: z.enum(["passed", "failed", "not_run"]),
    packed: z.enum(["passed", "failed", "not_run"]),
  }).strict(),
  outcome: z.enum([
    "baseline_sufficient",
    "lab_verified",
    "rejected",
    "inconclusive",
  ]),
  actualFocusedMinutes: nonnegative,
}).strict();

export const fal0ContextFoldingReceiptSchema =
  fal0ContextFoldingReceiptContentSchema.extend({ receiptSha256: sha256 }).strict()
    .superRefine((value, context) => {
      const { receiptSha256, ...content } = value;
      if (fal0ContextFoldingLogicalReceiptIdentity(content) !== receiptSha256) {
        context.addIssue({ code: "custom", message: "logical experiment receipt hash mismatch" });
      }
    });

export type Fal0ContextFoldingCaseResultV1 = Readonly<
  z.infer<typeof fal0ContextFoldingCaseResultSchema>
>;
export type Fal0ContextFoldingReceiptContentV1 = Readonly<
  z.infer<typeof fal0ContextFoldingReceiptContentSchema>
>;
export type Fal0ContextFoldingReceiptV1 = Readonly<
  z.infer<typeof fal0ContextFoldingReceiptSchema>
>;

export function fal0ContextFoldingLogicalReceiptIdentity(
  content: Fal0ContextFoldingReceiptContentV1,
): string {
  return sha256Canonical({
    ...content,
    actualFocusedMinutes: 0,
    cases: content.cases.map((entry) => ({
      ...entry,
      cost: { ...entry.cost, projectorDurationMs: 0 },
    })),
  });
}

export function createFal0ContextFoldingReceipt(
  input: unknown,
): Fal0ContextFoldingReceiptV1 {
  const content = fal0ContextFoldingReceiptContentSchema.parse(input);
  return Object.freeze(fal0ContextFoldingReceiptSchema.parse({
    ...content,
    receiptSha256: fal0ContextFoldingLogicalReceiptIdentity(content),
  }));
}
