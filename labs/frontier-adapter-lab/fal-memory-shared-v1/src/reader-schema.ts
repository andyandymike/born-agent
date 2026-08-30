import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { benchmarkSplits, SHARED_MEMORY_BENCHMARK_ID } from "./benchmark-schema.js";
import { SHARED_MEMORY_ANSWER_POLICY_V2_ID } from "./answer-policy-v2.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(160);
const evidenceRef = z.string().regex(/^(?:record|receipt):[a-z0-9-]+(?::[a-z0-9-]+)?$/u);

export const sharedReaderArms = [
  "fts_recency_plus_projection",
  "local_embedding_plus_projection",
  "fts_recency_plus_context_fold",
  "local_embedding_plus_context_fold",
] as const;

export const readerAnswerSchema = z.object({
  probeId: identifier,
  action: z.enum(["answer", "abstain"]),
  answer: z.string().max(4_096),
  evidenceRefs: z.array(evidenceRef).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: "custom", message: "reader evidence refs must be unique" });
  }
  if (value.action === "answer" && value.answer.trim().length === 0) {
    context.addIssue({ code: "custom", message: "reader answer action requires text" });
  }
});

const readerArmObservationBaseShape = {
  arm: z.enum(sharedReaderArms),
  retrievalMode: z.enum(["fts_recency", "local_embedding"]),
  receiptProjectionMode: z.enum(["baseline", "context_fold"]),
  thresholdSimilarityMicros: z.number().int().min(-1_000_000).max(1_000_001).nullable(),
  promptSha256: sha256,
  promptBytes: z.number().int().positive(),
  receiptContextSha256: sha256,
  availableEvidenceRefs: z.array(evidenceRef).max(256),
  parseState: z.enum(["parsed", "invalid_json", "invalid_shape"]),
  rawResponse: z.string().max(1_048_576),
  rawResponseSha256: sha256,
  answers: z.array(readerAnswerSchema).max(10),
  durationMs: z.number().finite().min(0),
} as const;

const localReaderArmObservationSchema = z.object({
  ...readerArmObservationBaseShape,
  localModelCalls: z.number().int().min(0).max(2),
  reusedFromArm: z.enum(sharedReaderArms).nullable(),
}).strict().superRefine((value, context) => {
  if (value.parseState === "parsed" && value.answers.length !== 10) {
    context.addIssue({ code: "custom", message: "parsed reader arm must contain ten answers" });
  }
  if (value.parseState !== "parsed" && value.answers.length !== 0) {
    context.addIssue({ code: "custom", message: "invalid reader arm cannot expose partial answers" });
  }
  if ((value.reusedFromArm === null) !== (value.localModelCalls > 0)) {
    context.addIssue({ code: "custom", message: "reader call/reuse flags are inconsistent" });
  }
});

export const deepSeekCallReceiptSchema = z.object({
  requestStartedAt: z.string().datetime({ offset: true }),
  responseId: z.string().min(1).max(256),
  reportedModel: z.string().min(1).max(256),
  responseStatus: z.enum(["completed", "incomplete"]),
  outputTextSha256: sha256,
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  billingWindow: z.enum(["off_peak", "peak"]),
  estimatedCostUsdMicros: z.number().int().nonnegative(),
  durationMs: z.number().finite().min(0),
}).strict().superRefine((value, context) => {
  if (value.cachedInputTokens > value.inputTokens) {
    context.addIssue({ code: "custom", message: "cached input tokens cannot exceed input tokens" });
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens) {
    context.addIssue({ code: "custom", message: "DeepSeek total tokens must equal input plus output" });
  }
});

const deepSeekReaderArmObservationSchema = z.object({
  ...readerArmObservationBaseShape,
  modelCalls: z.number().int().min(0).max(2),
  callReceipts: z.array(deepSeekCallReceiptSchema).max(2),
  reusedFromArm: z.enum(sharedReaderArms).nullable(),
}).strict().superRefine((value, context) => {
  if (value.parseState === "parsed" && value.answers.length !== 10) {
    context.addIssue({ code: "custom", message: "parsed reader arm must contain ten answers" });
  }
  if (value.parseState !== "parsed" && value.answers.length !== 0) {
    context.addIssue({ code: "custom", message: "invalid reader arm cannot expose partial answers" });
  }
  if ((value.reusedFromArm === null) !== (value.modelCalls > 0)) {
    context.addIssue({ code: "custom", message: "remote reader call/reuse flags are inconsistent" });
  }
  if (value.callReceipts.length !== value.modelCalls) {
    context.addIssue({ code: "custom", message: "remote reader call receipts must match model calls" });
  }
});

const readerObservationContentV1Schema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  split: z.enum(benchmarkSplits),
  generatedAt: z.string().datetime({ offset: true }),
  executionBoundary: z.literal("executor_inputs_plus_retrieval_observations_no_goldens_local_model_only"),
  retrievalObservationSha256: sha256,
  thresholdRole: z.enum(["eligible_operating_point", "diagnostic_only"]),
  thresholdSimilarityMicros: z.number().int().min(-1_000_000).max(1_000_001),
  reader: z.object({
    model: z.literal("qwen3.5:2b"),
    modelDigest: z.literal("324d162be6ca5629ae4517c8710434d0bd2d665bc94dbad46e9af8fbf8a2f0df"),
    ollamaVersion: z.string().min(1).max(128),
    promptContractSha256: sha256,
    temperature: z.literal(0),
    seed: z.literal(42),
    numCtx: z.literal(32_768),
    numPredict: z.literal(4_096),
    think: z.literal(false),
    maximumAttempts: z.literal(1),
    externalNetworkCalls: z.literal(0),
  }).strict(),
  timelines: z.array(z.object({
    timelineId: identifier,
    arms: z.array(localReaderArmObservationSchema).length(4),
  }).strict()).min(1).max(12),
}).strict();

export const deepSeekPricingSnapshotSchema = z.object({
  id: z.literal("deepseek-v4-2026-08-16"),
  sourceUrl: z.literal("https://api-docs.deepseek.com/quick_start/pricing/"),
  currency: z.literal("USD"),
  effectiveAt: z.literal("2026-08-16T16:00:00.000Z"),
  peakWindowUtc: z.literal("weekdays_01_04_and_06_10"),
  offPeak: z.object({
    cacheHitUsdPerMillionTokens: z.literal(0.007),
    cacheMissUsdPerMillionTokens: z.literal(0.22),
    outputUsdPerMillionTokens: z.literal(0.66),
  }).strict(),
  peak: z.object({
    cacheHitUsdPerMillionTokens: z.literal(0.014),
    cacheMissUsdPerMillionTokens: z.literal(0.44),
    outputUsdPerMillionTokens: z.literal(1.32),
  }).strict(),
}).strict();

const readerObservationContentV2Schema = z.object({
  schemaVersion: z.literal(2),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  split: z.enum(benchmarkSplits),
  generatedAt: z.string().datetime({ offset: true }),
  executionBoundary: z.literal(
    "executor_inputs_plus_retrieval_observations_no_goldens_allowlisted_remote_model_only",
  ),
  retrievalObservationSha256: sha256,
  thresholdRole: z.enum(["eligible_operating_point", "diagnostic_only"]),
  thresholdSimilarityMicros: z.number().int().min(-1_000_000).max(1_000_001),
  reader: z.object({
    provider: z.literal("deepseek"),
    api: z.literal("responses"),
    endpoint: z.literal("https://api.deepseek.com/responses"),
    modelAlias: z.literal("deepseek-v4-flash"),
    documentedModelVersion: z.literal("DeepSeek-V4-Flash-0731"),
    reportedModels: z.array(z.string().min(1).max(256)).min(1).max(8),
    promptContractSha256: sha256,
    outputSchemaSha256: sha256,
    temperature: z.literal(0),
    seed: z.null(),
    maxOutputTokens: z.literal(4_096),
    reasoningEffort: z.literal("none"),
    maximumAttempts: z.literal(1),
    externalNetworkCalls: z.number().int().positive().max(96),
    inputPolicy: z.literal("public_synthetic_development_calibration_only"),
    pricing: deepSeekPricingSnapshotSchema,
  }).strict(),
  timelines: z.array(z.object({
    timelineId: identifier,
    arms: z.array(deepSeekReaderArmObservationSchema).length(4),
  }).strict()).min(1).max(12),
}).strict().superRefine((value, context) => {
  const calls = value.timelines.flatMap((timeline) => timeline.arms)
    .reduce((sum, arm) => sum + arm.modelCalls, 0);
  if (calls !== value.reader.externalNetworkCalls) {
    context.addIssue({ code: "custom", message: "DeepSeek external calls must equal model calls" });
  }
  const reportedModels = [...new Set(value.timelines.flatMap((timeline) => timeline.arms)
    .flatMap((arm) => arm.callReceipts.map((receipt) => receipt.reportedModel)))].sort();
  if (JSON.stringify(reportedModels) !== JSON.stringify([...value.reader.reportedModels].sort())) {
    context.addIssue({ code: "custom", message: "DeepSeek reported model summary is inconsistent" });
  }
});

const readerObservationContentV3Schema = z.object({
  schemaVersion: z.literal(3),
  benchmarkId: z.literal(SHARED_MEMORY_ANSWER_POLICY_V2_ID),
  executorSha256: sha256,
  answerPolicyProtocolSha256: sha256,
  split: z.enum(benchmarkSplits),
  generatedAt: z.string().datetime({ offset: true }),
  executionBoundary: z.literal(
    "executor_inputs_plus_retrieval_observations_no_goldens_allowlisted_remote_model_only",
  ),
  retrievalObservationSha256: sha256,
  thresholdRole: z.enum(["eligible_operating_point", "diagnostic_only"]),
  thresholdSimilarityMicros: z.number().int().min(-1_000_000).max(1_000_001),
  reader: z.object({
    provider: z.literal("deepseek"),
    api: z.literal("responses"),
    endpoint: z.literal("https://api.deepseek.com/responses"),
    modelAlias: z.literal("deepseek-v4-flash"),
    documentedModelVersion: z.literal("DeepSeek-V4-Flash-0731"),
    reportedModels: z.array(z.string().min(1).max(256)).min(1).max(8),
    promptContractSha256: sha256,
    outputSchemaSha256: sha256,
    temperature: z.literal(0),
    seed: z.null(),
    maxOutputTokens: z.literal(4_096),
    reasoningEffort: z.literal("none"),
    maximumAttempts: z.literal(1),
    plannedApiCalls: z.number().int().positive().max(96),
    externalNetworkCalls: z.number().int().positive().max(96),
    inputPolicy: z.literal(
      "public_synthetic_answer_policy_v2_development_calibration_only",
    ),
    pricing: deepSeekPricingSnapshotSchema,
  }).strict(),
  timelines: z.array(z.object({
    timelineId: identifier,
    arms: z.array(deepSeekReaderArmObservationSchema).length(4),
  }).strict()).min(1).max(12),
}).strict().superRefine((value, context) => {
  const calls = value.timelines.flatMap((timeline) => timeline.arms)
    .reduce((sum, arm) => sum + arm.modelCalls, 0);
  if (calls !== value.reader.externalNetworkCalls || calls !== value.reader.plannedApiCalls) {
    context.addIssue({
      code: "custom",
      message: "DeepSeek v2 planned, external, and model calls must match",
    });
  }
  const reportedModels = [...new Set(value.timelines.flatMap((timeline) => timeline.arms)
    .flatMap((arm) => arm.callReceipts.map((receipt) => receipt.reportedModel)))].sort();
  if (JSON.stringify(reportedModels) !== JSON.stringify([...value.reader.reportedModels].sort())) {
    context.addIssue({ code: "custom", message: "DeepSeek v2 reported model summary is inconsistent" });
  }
});

const readerObservationPackV1Schema = readerObservationContentV1Schema.extend({
  readerObservationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { readerObservationSha256, ...content } = value;
  if (sha256Canonical(content) !== readerObservationSha256) {
    context.addIssue({ code: "custom", message: "reader observation logical hash mismatch" });
  }
});

const readerObservationPackV2Schema = readerObservationContentV2Schema.extend({
  readerObservationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { readerObservationSha256, ...content } = value;
  if (sha256Canonical(content) !== readerObservationSha256) {
    context.addIssue({ code: "custom", message: "DeepSeek reader observation logical hash mismatch" });
  }
});

const readerObservationPackV3Schema = readerObservationContentV3Schema.extend({
  readerObservationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { readerObservationSha256, ...content } = value;
  if (sha256Canonical(content) !== readerObservationSha256) {
    context.addIssue({
      code: "custom",
      message: "DeepSeek answer-policy v2 reader observation logical hash mismatch",
    });
  }
});

export const readerObservationPackSchema = z.union([
  readerObservationPackV1Schema,
  readerObservationPackV2Schema,
  readerObservationPackV3Schema,
]);

export type ReaderAnswer = Readonly<z.infer<typeof readerAnswerSchema>>;
export type ReaderObservationPack = Readonly<z.infer<typeof readerObservationPackSchema>>;
export type LocalReaderObservationPack = Readonly<z.infer<typeof readerObservationPackV1Schema>>;
export type DeepSeekReaderObservationPack = Readonly<z.infer<typeof readerObservationPackV2Schema>>;
export type DeepSeekAnswerPolicyV2ReaderObservationPack = Readonly<
  z.infer<typeof readerObservationPackV3Schema>
>;
export type DeepSeekCallReceipt = Readonly<z.infer<typeof deepSeekCallReceiptSchema>>;
export type SharedReaderArm = typeof sharedReaderArms[number];

export function createReaderObservationPack(input: unknown): LocalReaderObservationPack {
  const content = readerObservationContentV1Schema.parse(input);
  return Object.freeze(readerObservationPackV1Schema.parse({
    ...content,
    readerObservationSha256: sha256Canonical(content),
  }));
}

export function createDeepSeekReaderObservationPack(input: unknown): DeepSeekReaderObservationPack {
  const content = readerObservationContentV2Schema.parse(input);
  return Object.freeze(readerObservationPackV2Schema.parse({
    ...content,
    readerObservationSha256: sha256Canonical(content),
  }));
}

export function createDeepSeekAnswerPolicyV2ReaderObservationPack(
  input: unknown,
): DeepSeekAnswerPolicyV2ReaderObservationPack {
  const content = readerObservationContentV3Schema.parse(input);
  return Object.freeze(readerObservationPackV3Schema.parse({
    ...content,
    readerObservationSha256: sha256Canonical(content),
  }));
}
