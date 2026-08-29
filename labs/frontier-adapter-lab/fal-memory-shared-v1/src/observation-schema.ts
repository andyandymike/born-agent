import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  benchmarkSplits,
  SHARED_MEMORY_BENCHMARK_ID,
} from "./benchmark-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(160);
const finiteDuration = z.number().finite().min(0);
const recordKeys = (maximum: number) => z.array(identifier).max(maximum);

const thresholdBehaviorSchema = z.object({
  thresholdSimilarityMicros: z.number().int().min(-1_000_000).max(1_000_001),
  orderedTop5RecordKeys: recordKeys(5),
  orderedTop10RecordKeys: recordKeys(10),
  vectorAcceptedCount: z.number().int().min(0).max(100),
}).strict();

const retrievalProbeObservationSchema = z.object({
  probeId: identifier,
  queryKind: z.enum(["exact_id", "lexical", "quoted_phrase"]),
  baselineTop5RecordKeys: recordKeys(5),
  baselineTop10RecordKeys: recordKeys(10),
  canonicalRefetches: z.number().int().nonnegative(),
  revalidationFailures: z.number().int().nonnegative(),
  queryEmbeddingCalls: z.union([z.literal(0), z.literal(1)]),
  queryEmbeddingDurationMs: finiteDuration.nullable(),
  totalPreparationDurationMs: finiteDuration,
  top1SimilarityMicros: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  top2SimilarityMicros: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  marginMicros: z.number().int().min(0).max(2_000_000).nullable(),
  thresholdBehaviors: z.array(thresholdBehaviorSchema).min(1).max(101),
}).strict().superRefine((value, context) => {
  const thresholds = value.thresholdBehaviors.map((entry) => entry.thresholdSimilarityMicros);
  if (new Set(thresholds).size !== thresholds.length) {
    context.addIssue({ code: "custom", message: "threshold behaviors must be unique" });
  }
  if (!thresholds.includes(1_000_001)) {
    context.addIssue({ code: "custom", message: "threshold behaviors must include reject-all" });
  }
  if (thresholds.some((entry, index) => index > 0 && entry >= thresholds[index - 1]!)) {
    context.addIssue({ code: "custom", message: "threshold behaviors must be descending" });
  }
});

const foldingObservationSchema = z.object({
  baselineProviderContext: z.string().min(1).max(1_048_576),
  selectedProviderContext: z.string().min(1).max(1_048_576),
  baselineBytes: z.number().int().positive(),
  baselineTokens: z.number().int().positive(),
  candidateBytes: z.number().int().positive().nullable(),
  candidateTokens: z.number().int().positive().nullable(),
  diagnosticCode: z.string().min(1).max(4_096).nullable(),
  foldSha256: sha256.nullable(),
  losslessExpansion: z.boolean(),
  mode: z.enum(["baseline", "fold"]),
  reason: z.enum([
    "disabled",
    "selected",
    "not_beneficial",
    "over_bound",
    "deadline_expired",
    "candidate_fault",
    "invalid_input",
  ]),
  selected: z.boolean(),
  modelCalls: z.literal(0),
  networkCalls: z.literal(0),
  toolCalls: z.literal(0),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.baselineProviderContext, "utf8") !== value.baselineBytes) {
    context.addIssue({ code: "custom", message: "baseline provider context byte count mismatch" });
  }
  if (value.selected !== (value.mode === "fold" && value.reason === "selected")) {
    context.addIssue({ code: "custom", message: "fold selection flags are inconsistent" });
  }
  if (value.selected && value.foldSha256 === null) {
    context.addIssue({ code: "custom", message: "selected fold must carry its fold hash" });
  }
});

const timelineObservationSchema = z.object({
  timelineId: identifier,
  recordPoolSha256: sha256,
  projection: z.object({
    eligibleVectorRecordKeys: z.array(identifier).max(1_024),
    buildDurationMs: finiteDuration,
    embeddingDurationMs: finiteDuration,
    inputSecurityFailures: z.number().int().nonnegative(),
    recordEmbeddingCalls: z.number().int().nonnegative(),
    rowSecurityFailures: z.number().int().nonnegative(),
  }).strict(),
  folding: foldingObservationSchema,
  probes: z.array(retrievalProbeObservationSchema).length(10),
}).strict();

const retrievalObservationContentSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  split: z.enum(benchmarkSplits),
  generatedAt: z.string().datetime({ offset: true }),
  executionBoundary: z.literal("executor_inputs_plus_frozen_candidates_no_goldens_no_network"),
  candidate: z.object({
    embeddingModelArtifactManifestSha256: sha256,
    embeddingProjectionSchemaSha256: sha256,
    embeddingRrfK: z.literal(60),
    foldingEstimatorVersion: z.literal("fal-cf2-v2"),
  }).strict(),
  coldEmbeddingModelLoadMs: finiteDuration,
  timelines: z.array(timelineObservationSchema).min(1).max(12),
}).strict();

export const retrievalObservationPackSchema = retrievalObservationContentSchema.extend({
  observationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { observationSha256, ...content } = value;
  if (sha256Canonical(content) !== observationSha256) {
    context.addIssue({
      code: "custom",
      message: "retrieval observation logical hash mismatch",
      path: ["observationSha256"],
    });
  }
});

export type RetrievalObservationPack = Readonly<
  z.infer<typeof retrievalObservationPackSchema>
>;

export function createRetrievalObservationPack(input: unknown): RetrievalObservationPack {
  const content = retrievalObservationContentSchema.parse(input);
  return Object.freeze(retrievalObservationPackSchema.parse({
    ...content,
    observationSha256: sha256Canonical(content),
  }));
}
