import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { benchmarkSplits, SHARED_MEMORY_BENCHMARK_ID } from "./benchmark-schema.js";

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

const readerArmObservationSchema = z.object({
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

const readerObservationContentSchema = z.object({
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
    arms: z.array(readerArmObservationSchema).length(4),
  }).strict()).min(1).max(12),
}).strict();

export const readerObservationPackSchema = readerObservationContentSchema.extend({
  readerObservationSha256: sha256,
}).strict().superRefine((value, context) => {
  const { readerObservationSha256, ...content } = value;
  if (sha256Canonical(content) !== readerObservationSha256) {
    context.addIssue({ code: "custom", message: "reader observation logical hash mismatch" });
  }
});

export type ReaderAnswer = Readonly<z.infer<typeof readerAnswerSchema>>;
export type ReaderObservationPack = Readonly<z.infer<typeof readerObservationPackSchema>>;
export type SharedReaderArm = typeof sharedReaderArms[number];

export function createReaderObservationPack(input: unknown): ReaderObservationPack {
  const content = readerObservationContentSchema.parse(input);
  return Object.freeze(readerObservationPackSchema.parse({
    ...content,
    readerObservationSha256: sha256Canonical(content),
  }));
}
