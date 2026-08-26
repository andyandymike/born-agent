import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import {
  ml1EpisodeRecordV1Schema,
  ml1MemoryScopeV1Schema,
  type Ml1EpisodeRecordV1,
  type Ml1MemoryScopeV1,
} from "./ml1-episode-record.js";
import { Ml1MemoryError } from "./ml1-memory-error.js";

export const MEMORY_RECORD_MAX_BYTES = 8 * 1024;
export const MEMORY_EXPLICIT_TEXT_MAX_BYTES = 4 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentitySchema = z.string().min(1).max(512);
const explicitRecordIdSchema = z.string().regex(/^memory_[a-f0-9]{64}$/u);
const revisionIdSchema = z.string().regex(/^revision_[a-f0-9]{64}$/u);

export const explicitMemoryKindV1Schema = z.enum([
  "fact",
  "preference",
  "decision",
  "constraint",
]);

export const explicitMemorySourceV1Schema = z.object({
  command: z.literal("remember"),
  commandId: boundedIdentitySchema,
  kind: z.literal("local_user_command"),
  occurredAt: z.string().datetime({ offset: true }),
  supersedesRevisionId: revisionIdSchema.nullable(),
}).strict();

const explicitMemoryContentV1Schema = z.object({
  kind: explicitMemoryKindV1Schema,
  occurredAt: z.string().datetime({ offset: true }),
  origin: z.literal("explicit_user"),
  recordId: explicitRecordIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revisionId: revisionIdSchema,
  schemaVersion: z.literal(1),
  scope: ml1MemoryScopeV1Schema,
  source: explicitMemorySourceV1Schema,
  text: z.string().min(1).max(MEMORY_EXPLICIT_TEXT_MAX_BYTES).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MEMORY_EXPLICIT_TEXT_MAX_BYTES,
    "explicit memory text exceeds its UTF-8 byte bound",
  ),
}).strict();

export const explicitMemoryRecordV1Schema = explicitMemoryContentV1Schema.extend({
  recordSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { recordSha256, revisionId, ...identity } = value;
  const expectedRevisionId = `revision_${sha256Canonical(identity)}`;
  if (revisionId !== expectedRevisionId) {
    context.addIssue({ code: "custom", message: "explicit memory revision identity mismatch" });
  }
  if (recordSha256 !== sha256Canonical({ ...identity, revisionId })) {
    context.addIssue({ code: "custom", message: "explicit memory record hash mismatch" });
  }
  if (value.occurredAt !== value.source.occurredAt) {
    context.addIssue({ code: "custom", message: "explicit memory source time mismatch" });
  }
  if (
    (value.revision === 1 && value.source.supersedesRevisionId !== null) ||
    (value.revision > 1 && value.source.supersedesRevisionId === null)
  ) {
    context.addIssue({ code: "custom", message: "explicit memory revision linkage mismatch" });
  }
  if (value.revision === 1) {
    const expectedRecordId = `memory_${sha256Canonical({
      command_id: value.source.commandId,
      schema_version: 1,
      scope: value.scope,
    })}`;
    if (value.recordId !== expectedRecordId) {
      context.addIssue({ code: "custom", message: "explicit memory record identity mismatch" });
    }
  }
});

// MEMORY-ML4: episode canonical bytes remain byte-for-byte ML1-compatible.
// The formal v1 record is a strict union, not a wrapper that rewrites old evidence.
export const memoryRecordV1Schema = z.union([
  ml1EpisodeRecordV1Schema,
  explicitMemoryRecordV1Schema,
]);

export type ExplicitMemoryKindV1 = z.infer<typeof explicitMemoryKindV1Schema>;
export type ExplicitMemorySourceV1 = Readonly<z.infer<typeof explicitMemorySourceV1Schema>>;
export type ExplicitMemoryRecordV1 = Readonly<z.infer<typeof explicitMemoryRecordV1Schema>>;
export type MemoryRecordV1 = Ml1EpisodeRecordV1 | ExplicitMemoryRecordV1;

export function normalizeExplicitMemoryText(input: string): string {
  return input.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

export function createExplicitMemoryRecordV1(input: Readonly<{
  readonly commandId: string;
  readonly kind: ExplicitMemoryKindV1;
  readonly occurredAt: string;
  readonly recordId?: string;
  readonly revision: number;
  readonly scope: Ml1MemoryScopeV1;
  readonly supersedesRevisionId: string | null;
  readonly text: string;
}>): ExplicitMemoryRecordV1 {
  const text = normalizeExplicitMemoryText(input.text);
  if (text.length === 0) {
    throw new Ml1MemoryError("memory_record_invalid", "explicit memory text is empty");
  }
  if (Buffer.byteLength(text, "utf8") > MEMORY_EXPLICIT_TEXT_MAX_BYTES) {
    throw new Ml1MemoryError("memory_record_too_large", "explicit memory text exceeds its hard byte bound");
  }
  try {
    const scope = ml1MemoryScopeV1Schema.parse(input.scope);
    const recordId = input.recordId ?? `memory_${sha256Canonical({
      command_id: input.commandId,
      schema_version: 1,
      scope,
    })}`;
    const identity = {
      kind: input.kind,
      occurredAt: input.occurredAt,
      origin: "explicit_user" as const,
      recordId,
      revision: input.revision,
      schemaVersion: 1 as const,
      scope,
      source: {
        command: "remember" as const,
        commandId: input.commandId,
        kind: "local_user_command" as const,
        occurredAt: input.occurredAt,
        supersedesRevisionId: input.supersedesRevisionId,
      },
      text,
    };
    const revisionId = `revision_${sha256Canonical(identity)}`;
    return explicitMemoryRecordV1Schema.parse({
      ...identity,
      recordSha256: sha256Canonical({ ...identity, revisionId }),
      revisionId,
    });
  } catch (error) {
    if (error instanceof Ml1MemoryError) throw error;
    throw new Ml1MemoryError("memory_record_invalid", "explicit memory record is invalid", { cause: error });
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function encodeMemoryRecordV1(record: MemoryRecordV1): Buffer {
  let parsed: MemoryRecordV1;
  try {
    parsed = memoryRecordV1Schema.parse(record) as MemoryRecordV1;
  } catch (error) {
    throw new Ml1MemoryError("memory_record_invalid", "memory record is invalid", { cause: error });
  }
  const bytes = Buffer.from(canonicalJson(parsed), "utf8");
  if (bytes.byteLength <= 0 || bytes.byteLength > MEMORY_RECORD_MAX_BYTES) {
    throw new Ml1MemoryError("memory_record_too_large", "memory record exceeds its hard byte bound");
  }
  return bytes;
}

export function decodeMemoryRecordV1(bytes: Uint8Array): MemoryRecordV1 {
  if (bytes.byteLength <= 0 || bytes.byteLength > MEMORY_RECORD_MAX_BYTES) {
    throw new Ml1MemoryError("memory_store_corrupt", "stored memory record byte bound is invalid");
  }
  try {
    const source = STRICT_UTF8.decode(bytes);
    const value = memoryRecordV1Schema.parse(parseStrictJson(source)) as MemoryRecordV1;
    if (canonicalJson(value) !== source) throw new Error("stored memory record is not canonical JSON");
    return value;
  } catch (error) {
    if (error instanceof Ml1MemoryError) throw error;
    throw new Ml1MemoryError("memory_store_corrupt", "stored memory record failed strict decoding", { cause: error });
  }
}

export function memoryRecordRevision(record: MemoryRecordV1): number {
  return record.kind === "episode" ? 1 : record.revision;
}

export function memoryRecordRevisionId(record: MemoryRecordV1): string {
  return record.kind === "episode" ? record.recordId : record.revisionId;
}

export function memoryRecordSearchTitle(record: MemoryRecordV1): string {
  return record.kind === "episode" ? record.taskPreview : `${record.kind}: ${record.text}`;
}

export function memoryRecordSourceReferenceSha256(record: MemoryRecordV1): string {
  return record.kind === "episode" ? record.source.rangeSha256 : sha256Canonical(record.source);
}

export function memoryRecordSourceEventIds(record: MemoryRecordV1): readonly string[] {
  return record.kind === "episode"
    ? Object.freeze([record.source.startEventId, record.source.endEventId])
    : Object.freeze([record.source.commandId]);
}

export function sameMemoryScope(left: Ml1MemoryScopeV1, right: Ml1MemoryScopeV1): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}
