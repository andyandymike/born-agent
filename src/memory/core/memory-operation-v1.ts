import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { ml1MemoryScopeV1Schema, type Ml1MemoryScopeV1 } from "./ml1-episode-record.js";
import { Ml1MemoryError } from "./ml1-memory-error.js";

export const MEMORY_OPERATION_MAX_BYTES = 4 * 1024;
export const MEMORY_MAX_OPERATIONS = 20_000;
export const MEMORY_MAX_OPERATION_BYTES = 64 * 1024 * 1024;

const boundedIdentitySchema = z.string().min(1).max(512);
const revisionIdentitySchema = z.string().regex(/^(?:episode|revision)_[a-f0-9]{64}$/u);
const recordIdentitySchema = z.string().regex(/^(?:episode|memory)_[a-f0-9]{64}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const memoryOperationActorV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deterministic_episode") }).strict(),
  z.object({ commandId: boundedIdentitySchema, kind: z.literal("local_user_command") }).strict(),
]);

const memoryOperationContentV1Schema = z.object({
  actor: memoryOperationActorV1Schema,
  newRevisionId: revisionIdentitySchema.nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  operation: z.enum(["ADD", "SUPERSEDE", "RETRACT"]),
  operationId: z.string().regex(/^operation_[a-f0-9]{64}$/u),
  recordId: recordIdentitySchema,
  schemaVersion: z.literal(1),
  scope: ml1MemoryScopeV1Schema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetRevisionId: revisionIdentitySchema.nullable(),
}).strict();

export const memoryOperationV1Schema = memoryOperationContentV1Schema.extend({
  operationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { operationId, operationSha256, ...identity } = value;
  if (operationId !== `operation_${sha256Canonical(identity)}`) {
    context.addIssue({ code: "custom", message: "memory operation identity mismatch" });
  }
  if (operationSha256 !== sha256Canonical({ ...identity, operationId })) {
    context.addIssue({ code: "custom", message: "memory operation hash mismatch" });
  }
  const validShape = value.operation === "ADD"
    ? value.newRevisionId !== null && value.targetRevisionId === null
    : value.operation === "SUPERSEDE"
      ? value.newRevisionId !== null && value.targetRevisionId !== null && value.newRevisionId !== value.targetRevisionId
      : value.newRevisionId === null && value.targetRevisionId !== null;
  if (!validShape) context.addIssue({ code: "custom", message: "memory operation linkage mismatch" });
});

export type MemoryOperationActorV1 = Readonly<z.infer<typeof memoryOperationActorV1Schema>>;
export type MemoryOperationTypeV1 = "ADD" | "SUPERSEDE" | "RETRACT";
export type MemoryOperationV1 = Readonly<z.infer<typeof memoryOperationV1Schema>>;

export function createMemoryOperationV1(input: Readonly<{
  readonly actor: MemoryOperationActorV1;
  readonly newRevisionId: string | null;
  readonly occurredAt: string;
  readonly operation: MemoryOperationTypeV1;
  readonly recordId: string;
  readonly scope: Ml1MemoryScopeV1;
  readonly sequence: number;
  readonly targetRevisionId: string | null;
}>): MemoryOperationV1 {
  const identity = {
    actor: input.actor,
    newRevisionId: input.newRevisionId,
    occurredAt: input.occurredAt,
    operation: input.operation,
    recordId: input.recordId,
    schemaVersion: 1 as const,
    scope: input.scope,
    sequence: input.sequence,
    targetRevisionId: input.targetRevisionId,
  };
  const operationId = `operation_${sha256Canonical(identity)}`;
  return memoryOperationV1Schema.parse({
    ...identity,
    operationId,
    operationSha256: sha256Canonical({ ...identity, operationId }),
  });
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function encodeMemoryOperationV1(operation: MemoryOperationV1): Buffer {
  let parsed: MemoryOperationV1;
  try {
    parsed = memoryOperationV1Schema.parse(operation);
  } catch (error) {
    throw new Ml1MemoryError("memory_record_invalid", "memory operation is invalid", { cause: error });
  }
  const bytes = Buffer.from(canonicalJson(parsed), "utf8");
  if (bytes.byteLength <= 0 || bytes.byteLength > MEMORY_OPERATION_MAX_BYTES) {
    throw new Ml1MemoryError("memory_record_too_large", "memory operation exceeds its hard byte bound");
  }
  return bytes;
}

export function decodeMemoryOperationV1(bytes: Uint8Array): MemoryOperationV1 {
  if (bytes.byteLength <= 0 || bytes.byteLength > MEMORY_OPERATION_MAX_BYTES) {
    throw new Ml1MemoryError("memory_store_corrupt", "stored memory operation byte bound is invalid");
  }
  try {
    const source = STRICT_UTF8.decode(bytes);
    const value = memoryOperationV1Schema.parse(parseStrictJson(source));
    if (canonicalJson(value) !== source) throw new Error("stored memory operation is not canonical JSON");
    return value;
  } catch (error) {
    if (error instanceof Ml1MemoryError) throw error;
    throw new Ml1MemoryError("memory_store_corrupt", "stored memory operation failed strict decoding", { cause: error });
  }
}
