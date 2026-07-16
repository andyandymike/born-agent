import { z } from "zod";

// PHASE2: RunEvent 是 BornAgent 自己的长期存储协议。
// TypeScript 只能检查编译期代码，Zod 还会检查 SDK 数据、磁盘 JSONL 和未来读回的数据。
const uuidSchema = z.string().uuid();
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const utf8StringWithin = (maximumBytes: number) =>
  z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      `must not exceed ${maximumBytes} UTF-8 bytes`,
    );
const commonEnvelope = {
  // PHASE2: 每种事件共享同一个 envelope，data 才是不同事件的载荷。
  // schema_version 支持未来迁移；seq 用于发现丢失、乱序或重复写入。
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
        tools: z.array(toolNameSchema).optional(),
        tools_enabled: z.boolean().optional(),
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
        model_turns: positiveInteger.optional(),
        output_tokens: nonnegativeInteger,
        total_tokens: nonnegativeInteger,
        usage_incomplete: z.boolean().optional(),
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
        model_turns: positiveInteger.optional(),
        output_chars: nonnegativeInteger,
        provider_response_id: z.string().min(1).optional(),
        tool_calls: nonnegativeInteger.optional(),
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

const toolCallRequestedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        arguments_json: utf8StringWithin(16 * 1024),
        call_id: z.string().min(1).max(200),
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        tool_name: toolNameSchema,
      })
      .strict(),
    type: z.literal("tool.call.requested"),
  })
  .strict();

const toolCallCompletedSchema = z
  .object({
    ...commonEnvelope,
    data: z
      .object({
        call_id: z.string().min(1).max(200),
        duration_ms: nonnegativeInteger,
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
        output: utf8StringWithin(64 * 1024),
        retryable: z.boolean().optional(),
        status: z.enum(["error", "success"]),
        step: positiveInteger,
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
            message: "tool result error fields do not match status",
          });
        }
      }),
    type: z.literal("tool.call.completed"),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("type", [
  // PHASE2: type 是判别字段。解析成功后，TypeScript 能依据 event.type 自动缩小 data 类型。
  runStartedSchema,
  textDeltaSchema,
  usageSchema,
  toolCallRequestedSchema,
  toolCallCompletedSchema,
  runCompletedSchema,
  runFailedSchema,
  runCancelledSchema,
]);
