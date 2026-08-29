import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { FAL_EM0_EXPERIMENT_ID } from "./fal-em0-manifest.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ratio = z.number().finite().min(0).max(1);
const recordKey = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96);

const falEm0RetrievalArmResultSchema = z.object({
  queryKind: z.enum(["exact_id", "lexical", "quoted_phrase"]),
  orderedTopRecordKeys: z.array(recordKey).max(5),
  recallAt1: ratio.nullable(),
  recallAt5: ratio.nullable(),
  reciprocalRank: ratio.nullable(),
  abstained: z.boolean(),
  abstentionReason: z.enum([
    "no_available_match",
    "no_searchable_terms",
    "result_budget_exhausted",
  ]).nullable(),
  candidatesMatched: nonnegative,
  candidatesAvailable: nonnegative,
  candidatesTruncated: z.boolean(),
  textBytesUsed: nonnegative,
  estimatedTokensUsed: nonnegative,
  resultSha256: sha256,
}).strict();

export const falEm0CaseResultSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96),
  split: z.enum(["calibration", "evaluation"]),
  class: z.enum(["representative", "security", "stress"]),
  baseline: falEm0RetrievalArmResultSchema,
  candidate: falEm0RetrievalArmResultSchema.nullable(),
  correctness: z.object({
    requiredTop1: z.boolean(),
    requiredTop5: z.boolean(),
    forbiddenTop5Count: nonnegative,
    abstentionCorrect: z.boolean(),
    sourceFresh: z.boolean(),
    scopeExact: z.boolean(),
    actionParameterSupported: z.boolean().nullable(),
  }).strict(),
  cost: z.object({
    localQueryEmbeddingCalls: nonnegative,
    localRecordEmbeddingCalls: nonnegative,
    remoteModelCalls: nonnegative,
    toolCalls: nonnegative,
    networkCallsDuringSearch: nonnegative,
    queryEmbeddingDurationMs: z.number().finite().nonnegative().nullable(),
    vectorScanDurationMs: z.number().finite().nonnegative().nullable(),
    totalSearchDurationMs: z.number().finite().nonnegative(),
  }).strict(),
  status: z.enum(["pass", "fail", "not_applicable"]),
}).strict();

const entryGateReasonSchema = z.enum([
  "semantic_recall_below_75_percent",
  "at_least_five_semantic_top5_misses",
  "misses_have_no_literal_term_overlap",
  "semantic_gap_not_observed",
  "unexplained_baseline_miss",
  "hard_gate_failure",
]);

const falEm0ReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_EM0_EXPERIMENT_ID),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable(),
  manifestSha256: sha256,
  baseline: z.object({
    retrieverId: z.literal("bornagent.lexical-memory-search"),
    retrieverVersion: z.literal("ml2-v2"),
    implementationSha256: sha256,
    semanticRecallAt5: ratio,
    semanticMrrAt5: ratio,
    candidatePermitted: z.boolean(),
    entryGateReasons: z.array(entryGateReasonSchema),
  }).strict(),
  candidate: z.object({
    implementationSha256: sha256,
    modelArtifactManifestSha256: sha256,
    vectorProjectionSchemaSha256: sha256,
    thresholdSimilarityMicros: z.number().int().min(0).max(1_000_000),
    thresholdFrozenBeforeEvaluation: z.boolean(),
    calibrationResultSha256: sha256,
    semanticRecallAt5: ratio,
    semanticMrrAt5: ratio,
  }).strict().nullable(),
  cases: z.array(falEm0CaseResultSchema).length(36),
  aggregate: z.object({
    calibrationCases: z.literal(8),
    evaluationCases: z.literal(28),
    hardGateFailures: nonnegative,
    securityLeaks: nonnegative,
    vectorAddedForbiddenHits: nonnegative,
    fallbackMismatches: nonnegative,
  }).strict(),
  cost: z.object({
    modelArtifactBytes: nonnegative.nullable(),
    dependencyInstallDeltaBytes: nonnegative.nullable(),
    packedArtifactDeltaBytes: z.number().int().min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER).nullable(),
    vectorStoreBytesAt10000: nonnegative.nullable(),
    coldLoadP95Ms: z.number().finite().nonnegative().nullable(),
    warmQueryEmbeddingP95Ms: z.number().finite().nonnegative().nullable(),
    vectorScan10000P95Ms: z.number().finite().nonnegative().nullable(),
    hybridSearchP95Ms: z.number().finite().nonnegative().nullable(),
  }).strict(),
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

export const falEm0ReceiptSchema = falEm0ReceiptContentSchema
  .extend({ receiptSha256: sha256 })
  .strict()
  .superRefine((value, context) => {
    const { receiptSha256, ...content } = value;
    if (falEm0LogicalReceiptIdentity(content) !== receiptSha256) {
      context.addIssue({ code: "custom", message: "logical experiment receipt hash mismatch" });
    }
  });

export type FalEm0RetrievalArmResultV1 = Readonly<
  z.infer<typeof falEm0RetrievalArmResultSchema>
>;
export type FalEm0CaseResultV1 = Readonly<z.infer<typeof falEm0CaseResultSchema>>;
export type FalEm0ReceiptContentV1 = Readonly<z.infer<typeof falEm0ReceiptContentSchema>>;
export type FalEm0ReceiptV1 = Readonly<z.infer<typeof falEm0ReceiptSchema>>;

export function falEm0LogicalReceiptIdentity(
  content: FalEm0ReceiptContentV1,
): string {
  return sha256Canonical({
    ...content,
    sourceCommit: null,
    actualFocusedMinutes: 0,
    cases: content.cases.map((entry) => ({
      ...entry,
      cost: {
        ...entry.cost,
        queryEmbeddingDurationMs: null,
        totalSearchDurationMs: 0,
        vectorScanDurationMs: null,
      },
    })),
    cost: {
      ...content.cost,
      coldLoadP95Ms: null,
      hybridSearchP95Ms: null,
      vectorScan10000P95Ms: null,
      warmQueryEmbeddingP95Ms: null,
    },
  });
}

export function createFalEm0Receipt(input: unknown): FalEm0ReceiptV1 {
  const content = falEm0ReceiptContentSchema.parse(input);
  return Object.freeze(falEm0ReceiptSchema.parse({
    ...content,
    receiptSha256: falEm0LogicalReceiptIdentity(content),
  }));
}
