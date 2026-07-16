import { z } from "zod";

const uuidSchema = z.string().uuid();
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const nonnegativeInteger = z.number().int().nonnegative();
const commonEnvelope = {
  event_id: uuidSchema,
  run_id: uuidSchema,
  schema_version: z.literal(1),
  seq: z.number().int().positive(),
  session_id: uuidSchema,
  timestamp: timestampSchema,
};

const runStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        command: z.literal("chat"),
        input: z
          .object({ role: z.literal("user"), text: z.string() })
          .strict(),
        model: z.string().min(1),
        provider: z.enum(["openai", "ollama"]),
        timeout_ms: nonnegativeInteger,
        workspace: z.string().min(1),
      })
      .strict(),
    type: z.literal("run.started"),
  })
  .strict();

const textDeltaSchema = z
  .object({
    ...commonEnvelope,
    data: z.object({ delta: z.string().min(1) }).strict(),
    type: z.literal("text.delta"),
  })
  .strict();

const usageSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        cached_input_tokens: nonnegativeInteger.optional(),
        input_tokens: nonnegativeInteger,
        output_tokens: nonnegativeInteger,
        total_tokens: nonnegativeInteger,
      })
      .strict(),
    type: z.literal("usage"),
  })
  .strict();

const runCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        output_chars: nonnegativeInteger,
        provider_response_id: z.string().min(1).optional(),
      })
      .strict(),
    type: z.literal("run.completed"),
  })
  .strict();

const runFailedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        category: z.enum([
          "auth",
          "rate_limit",
          "quota",
          "network",
          "provider",
          "timeout",
          "protocol",
          "storage",
          "internal",
        ]),
        code: z.string().regex(/^[a-z0-9_]+$/u),
        duration_ms: nonnegativeInteger,
        message: z.string().min(1).max(500),
        provider_request_id: z.string().min(1).optional(),
        retryable: z.boolean(),
      })
      .strict(),
    type: z.literal("run.failed"),
  })
  .strict();

const runCancelledSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        reason: z.literal("user"),
      })
      .strict(),
    type: z.literal("run.cancelled"),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("type", [
  runStartedSchema,
  textDeltaSchema,
  usageSchema,
  runCompletedSchema,
  runFailedSchema,
  runCancelledSchema,
]);
