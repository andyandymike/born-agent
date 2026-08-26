import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";

// MEMORY-ML1: canonical record 是长期事实；SQLite 行和 CLI 只能投影它，不能补写字段。
export const ML1_EPISODE_MAX_BYTES = 8 * 1024;
export const ML1_EPISODE_MAX_RECORDS = 10_000;
export const ML1_EPISODE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const ML1_EPISODE_PAGE_MAX = 100;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentitySchema = z.string().min(1).max(512);

export const ml1MemoryScopeV1Schema = z.object({
  applicationRepositoryId: boundedIdentitySchema,
  canonicalRootIdentitySha256: sha256Schema,
  ownerPrincipalId: boundedIdentitySchema,
}).strict();

export const ml1SessionRangeSourceV1Schema = z.object({
  endEventId: boundedIdentitySchema,
  endRawSha256: sha256Schema,
  endSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.literal("session_run_range"),
  rangeSha256: sha256Schema,
  runId: boundedIdentitySchema,
  sessionId: boundedIdentitySchema,
  startEventId: boundedIdentitySchema,
  startRawSha256: sha256Schema,
  startSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  if (value.startSequence > value.endSequence) {
    context.addIssue({ code: "custom", message: "episode source range is reversed" });
  }
});

export const ml1EpisodeCompletionV1Schema = z.object({
  evidenceSha256: sha256Schema.nullable(),
  mode: z.enum(["model_final", "plan_ready", "verified_finish_task"]),
  reportSha256: sha256Schema.nullable(),
  steps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  toolCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const ml1EpisodeContentV1Schema = z.object({
  completion: ml1EpisodeCompletionV1Schema,
  kind: z.literal("episode"),
  occurredAt: z.string().datetime({ offset: true }),
  origin: z.literal("deterministic_episode"),
  recordId: z.string().regex(/^episode_[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
  scope: ml1MemoryScopeV1Schema,
  source: ml1SessionRangeSourceV1Schema,
  taskInputSha256: sha256Schema,
  taskPreview: z.string().max(2_048).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 2_048,
    "episode task preview exceeds its UTF-8 byte bound",
  ),
  text: z.string().min(1).max(4_096),
}).strict();

export const ml1EpisodeRecordV1Schema = ml1EpisodeContentV1Schema.extend({
  recordSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { recordSha256, ...content } = value;
  const expectedId = `episode_${sha256Canonical({
    schema_version: 1,
    scope: value.scope,
    source: value.source,
  })}`;
  const expectedText = [
    `Task: ${value.taskPreview}`,
    "Outcome: completed",
    `Completion mode: ${value.completion.mode}`,
    `Steps: ${String(value.completion.steps)}`,
    `Tool calls: ${String(value.completion.toolCalls)}`,
    `Evidence: ${value.completion.evidenceSha256 ?? "none"}`,
  ].join("\n");
  if (value.recordId !== expectedId) {
    context.addIssue({ code: "custom", message: "episode record identity mismatch" });
  }
  if (value.text !== expectedText) {
    context.addIssue({ code: "custom", message: "episode text projection mismatch" });
  }
  if (recordSha256 !== sha256Canonical(content)) {
    context.addIssue({ code: "custom", message: "episode record hash mismatch" });
  }
});

export type Ml1MemoryScopeV1 = Readonly<z.infer<typeof ml1MemoryScopeV1Schema>>;
export type Ml1SessionRangeSourceV1 = Readonly<z.infer<typeof ml1SessionRangeSourceV1Schema>>;
export type Ml1EpisodeCompletionV1 = Readonly<z.infer<typeof ml1EpisodeCompletionV1Schema>>;
export type Ml1EpisodeRecordV1 = Readonly<z.infer<typeof ml1EpisodeRecordV1Schema>>;

export function createMl1EpisodeRecordV1(
  input: z.input<typeof ml1EpisodeContentV1Schema>,
): Ml1EpisodeRecordV1 {
  const content = ml1EpisodeContentV1Schema.parse(input);
  return ml1EpisodeRecordV1Schema.parse({
    ...content,
    recordSha256: sha256Canonical(content),
  });
}
