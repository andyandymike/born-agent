import { z } from "zod";

import { phase10ContextRunEventDataSchemas } from "../context/context-event-schema.js";
import { phase10ArtifactRunEventDataSchemas } from "../artifacts/artifact-event-schema.js";
import { phase10RepositoryRulesRunEventDataSchemas } from "../repository-rules/repository-rules-event-schema.js";
import { phase12McpRunEventDataSchemas } from "../mcp/mcp-event-schema.js";
import { phase13SandboxRunEventDataSchemas } from "../execution/docker/sandbox-event-schema.js";
import { phase16TaskSessionEventDataSchemas } from "../coordination/task-event-schema.js";
import { phase16GoalChangeRunEventDataSchemas } from "../coordination/goal-change-event-schema.js";
import { phase17RepositoryIntelligenceRunEventDataSchemas } from "../repository-intelligence/repository-intelligence-event-schema.js";
import { phase18SkillRunEventDataSchemas } from "../skills/skill-event-schema.js";
import { phase18HookRunEventDataSchemas } from "../hooks/hook-event-schema.js";

const uuidSchema = z.string().uuid();
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const positiveIntegerSchema = z.number().int().positive();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const stableIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const eventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);
const callIdSchema = z.string().min(1).max(200);
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const boundedTextSchema = (maximumBytes: number) =>
  z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      `must not exceed ${maximumBytes} UTF-8 bytes`,
    );
const relativeReferenceSchema = boundedTextSchema(4096).refine(
  (value) =>
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "must be a normalized relative reference",
);

const commonV2Envelope = {
  data: z.unknown(),
  event_id: uuidSchema,
  schema_version: z.literal(2),
  session_id: uuidSchema,
  session_seq: positiveIntegerSchema,
  timestamp: timestampSchema,
  type: eventTypeSchema,
};

export const sessionScopedEnvelopeV2Schema = z
  .object({
    ...commonV2Envelope,
    scope: z.literal("session"),
  })
  .strict();

export const runScopedEnvelopeV2Schema = z
  .object({
    ...commonV2Envelope,
    run_id: uuidSchema,
    run_seq: positiveIntegerSchema,
    scope: z.literal("run"),
  })
  .strict();

export const storedEventEnvelopeV2Schema = z.discriminatedUnion("scope", [
  sessionScopedEnvelopeV2Schema,
  runScopedEnvelopeV2Schema,
]);

export type SessionScopedEnvelopeV2 = z.infer<
  typeof sessionScopedEnvelopeV2Schema
>;
export type RunScopedEnvelopeV2 = z.infer<typeof runScopedEnvelopeV2Schema>;
export type StoredEventEnvelopeV2 = z.infer<typeof storedEventEnvelopeV2Schema>;

export const sessionLockRecoveredDataSchema = z
  .object({
    previous_nonce_sha256: sha256Schema,
    reason: z.literal("owner_confirmed_dead"),
  })
  .strict();

export const sessionTailRecoveredDataSchema = z
  .object({
    backup_ref: relativeReferenceSchema,
    discarded_bytes: nonnegativeIntegerSchema,
    original_sha256: sha256Schema,
    repair: z.enum(["added_newline", "removed_incomplete_tail"]),
    repaired_sha256: sha256Schema,
  })
  .strict();

export const sessionResumeRequestedDataSchema = z
  .object({
    message: boundedTextSchema(64 * 1024).min(1).optional(),
    requested_mode: z.enum(["exact", "canonical_degraded"]),
    source_run_id: uuidSchema,
  })
  .strict();

export const approvalExpiredDataSchema = z
  .object({
    approval_request_id: uuidSchema,
    reason: z.literal("new_run_requires_new_authority"),
    source_run_id: uuidSchema,
  })
  .strict();

export const sideEffectReconciledDataSchema = z
  .object({
    effect_id: z.string().min(1).max(200),
    effect_kind: z.literal("patch"),
    evidence_sha256: sha256Schema,
    observed: z.enum(["applied", "not_applied"]),
    source_run_id: uuidSchema,
  })
  .strict();

export const backendCheckpointCreatedDataSchema = z
  .object({
    adapter: z.string().min(1).max(200),
    adapter_version: z.string().min(1).max(200),
    bytes: positiveIntegerSchema,
    checkpoint_id: uuidSchema,
    codec_version: stableIdentifierSchema,
    model: z.string().min(1).max(500),
    provider: stableIdentifierSchema,
    ref: relativeReferenceSchema,
    sha256: sha256Schema,
    turn: positiveIntegerSchema,
  })
  .strict();

export const backendCanonicalBoundaryCreatedDataSchema = z
  .object({
    pending_call: z.boolean(),
    transcript_sha256: sha256Schema,
    turn: positiveIntegerSchema,
  })
  .strict();

export const resumePendingCallAdoptedDataSchema = z
  .object({
    call_id: callIdSchema,
    checkpoint_id: uuidSchema,
    source_call_id: callIdSchema,
    source_run_id: uuidSchema,
    step: positiveIntegerSchema,
    tool_name: toolNameSchema,
  })
  .strict();

export const toolCallRecoveredDataSchema = z
  .object({
    call_id: callIdSchema,
    duration_ms: nonnegativeIntegerSchema,
    error_category: z
      .enum([
        "cancelled",
        "invalid_arguments",
        "limit",
        "not_found",
        "permission",
        "system",
        "tool",
      ])
      .optional(),
    error_code: z.string().regex(/^[a-z0-9_]+$/u).optional(),
    output: boundedTextSchema(1_114_112),
    retryable: z.boolean().optional(),
    source_run_id: uuidSchema,
    status: z.enum(["error", "success"]),
    step: positiveIntegerSchema,
    tool_name: toolNameSchema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const errorFields = [
      value.error_category,
      value.error_code,
      value.retryable,
    ];
    if (
      (value.status === "error" && errorFields.some((field) => field === undefined)) ||
      (value.status === "success" && errorFields.some((field) => field !== undefined))
    ) {
      context.addIssue({
        code: "custom",
        message: "recovered tool result error fields do not match status",
      });
    }
  });

export const phase9SessionEventDataSchemas = {
  "approval.expired": approvalExpiredDataSchema,
  "session.lock.recovered": sessionLockRecoveredDataSchema,
  "session.resume.requested": sessionResumeRequestedDataSchema,
  "session.tail.recovered": sessionTailRecoveredDataSchema,
  "side_effect.reconciled": sideEffectReconciledDataSchema,
} as const;

export const phase9RunEventDataSchemas = {
  ...phase10ArtifactRunEventDataSchemas,
  ...phase10ContextRunEventDataSchemas,
  ...phase10RepositoryRulesRunEventDataSchemas,
  ...phase12McpRunEventDataSchemas,
  ...phase13SandboxRunEventDataSchemas,
  ...phase17RepositoryIntelligenceRunEventDataSchemas,
  ...phase18SkillRunEventDataSchemas,
  ...phase18HookRunEventDataSchemas,
  "backend.canonical_boundary.created":
    backendCanonicalBoundaryCreatedDataSchema,
  "backend.checkpoint.created": backendCheckpointCreatedDataSchema,
  "resume.pending_call.adopted": resumePendingCallAdoptedDataSchema,
  "tool.call.recovered": toolCallRecoveredDataSchema,
} as const;

// PHASE16: the decoder owns the complete v2 registry, while the Phase 9
// aliases remain intentionally narrower so 16A does not accidentally expose
// Goal/Plan writer methods before the user and agent authority ports exist.
export const v2SessionEventDataSchemas = {
  ...phase9SessionEventDataSchemas,
  ...phase16TaskSessionEventDataSchemas,
} as const;

export const v2RunEventDataSchemas = {
  ...phase9RunEventDataSchemas,
  ...phase16GoalChangeRunEventDataSchemas,
} as const;

export type Phase9SessionEventType = keyof typeof phase9SessionEventDataSchemas;
export type Phase9RunEventType = keyof typeof phase9RunEventDataSchemas;

export type Phase9SessionEventData<TType extends Phase9SessionEventType> =
  z.infer<(typeof phase9SessionEventDataSchemas)[TType]>;
export type Phase9RunEventData<TType extends Phase9RunEventType> = z.infer<
  (typeof phase9RunEventDataSchemas)[TType]
>;

export type V2SessionEventType = keyof typeof v2SessionEventDataSchemas;
export type V2RunEventType = keyof typeof v2RunEventDataSchemas;
export type V2SessionEventData<TType extends V2SessionEventType> = z.infer<
  (typeof v2SessionEventDataSchemas)[TType]
>;
export type V2RunEventData<TType extends V2RunEventType> = z.infer<
  (typeof v2RunEventDataSchemas)[TType]
>;
