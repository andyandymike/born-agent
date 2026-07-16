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

const inputSchema = z
  .object({ role: z.literal("user"), text: z.string() })
  .strict();
const commonRunStartedData = {
  input: inputSchema,
  model: z.string().min(1),
  provider: z.enum(["openai", "ollama"]),
  tools: z.array(toolNameSchema).optional(),
  tools_enabled: z.boolean().optional(),
  workspace: z.string().min(1),
};
const chatRunStartedDataSchema = z
  .object({
    ...commonRunStartedData,
    command: z.literal("chat"),
    timeout_ms: nonnegativeInteger,
  })
  .strict();
const agentRunStartedDataSchema = z
  .object({
    ...commonRunStartedData,
    command: z.literal("agent"),
    max_duration_ms: positiveInteger,
    max_steps: positiveInteger,
    max_tokens: positiveInteger,
    max_tool_output_bytes: positiveInteger,
    request_timeout_ms: positiveInteger,
  })
  .strict();
const runStartedSchema = z
  .object({
    ...commonEnvelope,
    data: z.discriminatedUnion("command", [
      chatRunStartedDataSchema,
      agentRunStartedDataSchema,
    ]),
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

const agentStepStartedSchema = z
  // PHASE4: step.started 记录本步输入来源和动作前剩余预算，是“允许发起模型请求”的审计点。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        input_kind: z.enum(["user_task", "tool_result"]),
        max_steps: positiveInteger,
        remaining_duration_ms: nonnegativeInteger,
        remaining_tokens: nonnegativeInteger,
        remaining_tool_output_bytes: nonnegativeInteger,
        step: positiveInteger,
      })
      .strict(),
    type: z.literal("agent.step.started"),
  })
  .strict();

const modelUsageSchema = z
  // PHASE4: 每个 step 单独记录 provider usage，run 级 usage 只能由这些事件精确聚合。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        cached_input_tokens: nonnegativeInteger.optional(),
        input_tokens: nonnegativeInteger,
        output_tokens: nonnegativeInteger,
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        total_tokens: nonnegativeInteger,
      })
      .strict(),
    type: z.literal("model.usage"),
  })
  .strict();

const agentStepCompletedSchema = z
  // PHASE4: outcome 区分“继续执行工具”与“得到 final”，tool_call outcome 必须绑定 call_id。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        outcome: z.enum(["final", "tool_call"]),
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        text_chars: nonnegativeInteger,
        tool_call_id: z.string().min(1).max(200).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.outcome === "tool_call" && value.tool_call_id === undefined) ||
          (value.outcome === "final" && value.tool_call_id !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message: "tool_call_id does not match step outcome",
          });
        }
      }),
    type: z.literal("agent.step.completed"),
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
        steps: positiveInteger.optional(),
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
        output_chars: nonnegativeInteger.optional(),
        provider_request_id: z.string().min(1).optional(),
        retryable: z.boolean(),
        steps: nonnegativeInteger.optional(),
        tool_calls: nonnegativeInteger.optional(),
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
        output_chars: nonnegativeInteger.optional(),
        reason: z.literal("user"),
        steps: nonnegativeInteger.optional(),
        tool_calls: nonnegativeInteger.optional(),
      })
      .strict(),
    type: z.literal("run.cancelled"),
  })
  .strict();

const toolCallRequestedSchema = z
  // PHASE3: requested 保存模型实际提出的 call_id/name/原始 arguments 证据，但不代表已获准执行。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        arguments_json: utf8StringWithin(16 * 1024),
        call_id: z.string().min(1).max(200),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        provider_response_id: z.string().min(1).optional(),
        step: positiveInteger,
        tool_name: toolNameSchema,
      })
      .strict(),
    type: z.literal("tool.call.requested"),
  })
  .strict();

const runBudgetExceededSchema = z
  // PHASE4: budget terminal 保存 reason/limit/observed，使停止原因能从 JSONL 独立验证。
  .object({
    ...commonEnvelope,
    data: z
      .object({
        duration_ms: nonnegativeInteger,
        limit: positiveInteger,
        observed: nonnegativeInteger,
        output_chars: nonnegativeInteger,
        reason: z.enum([
          "max_steps",
          "max_duration",
          "max_tokens",
          "max_tool_output",
          "repeated_tool_call",
        ]),
        steps: nonnegativeInteger,
        tool_calls: nonnegativeInteger,
      })
      .strict(),
    type: z.literal("run.budget_exceeded"),
  })
  .strict();

const toolCallCompletedSchema = z
  // PHASE3: completed 保存实际 observation；output 就是随后交给模型的同一字符串。
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
        // PHASE3: success 不得混入错误字段；error 必须完整携带稳定分类、code 和 retryable。
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
  agentStepStartedSchema,
  modelUsageSchema,
  agentStepCompletedSchema,
  usageSchema,
  toolCallRequestedSchema,
  toolCallCompletedSchema,
  runCompletedSchema,
  runFailedSchema,
  runCancelledSchema,
  runBudgetExceededSchema,
]);
