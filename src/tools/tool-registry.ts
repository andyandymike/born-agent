import type { ModelToolDefinition } from "../model/model-backend.js";
import { redactSensitiveText } from "../security/redact.js";
import { serializeToolError, toolError } from "./tool-errors.js";
import { ZodToolValidator } from "./validators/zod-tool-validator.js";
import {
  FatalToolExecutionError,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  type RegisteredTool,
  type ToolRegistration,
  type CompletionRuntimeLike,
  type ToolExecution,
  type ToolInvocation,
  type ToolRegistryLike,
} from "./tool-types.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

function isRegisteredTool(
  definition: ToolRegistration<unknown>,
): definition is RegisteredTool<unknown> {
  return "validator" in definition;
}

function register(
  definition: ToolRegistration<unknown>,
): RegisteredTool<unknown> {
  if (isRegisteredTool(definition)) return definition;
  const validator = new ZodToolValidator(definition.inputSchema);
  const schema = validator.modelSchema;
  const variants =
    schema.type === "object"
      ? [schema]
      : Array.isArray(schema.oneOf)
        ? schema.oneOf.filter(
            (candidate): candidate is Readonly<Record<string, unknown>> =>
              typeof candidate === "object" &&
              candidate !== null &&
              !Array.isArray(candidate),
          )
        : [];
  if (
    variants.length === 0 ||
    (Array.isArray(schema.oneOf) && variants.length !== schema.oneOf.length) ||
    variants.some(
      (variant) =>
        variant.type !== "object" ||
        variant.additionalProperties !== false ||
        !Array.isArray(variant.required),
    )
  ) {
    throw new Error(`tool ${definition.name} does not have a strict object schema`);
  }
  if (
    variants.some((variant) => {
      const properties =
        typeof variant.properties === "object" &&
        variant.properties !== null
          ? (variant.properties as Readonly<Record<string, unknown>>)
          : {};
      const required = variant.required as readonly unknown[];
      return Object.keys(properties).some((key) => !required.includes(key));
    })
  ) {
    throw new Error(`tool ${definition.name} has optional JSON schema properties`);
  }
  return Object.freeze({
    capability: definition.capability,
    description: definition.description,
    execute: definition.execute.bind(definition),
    ...(definition.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: definition.maxOutputBytes }),
    name: definition.name,
    origin: Object.freeze({ kind: "builtin" as const }),
    validator,
  });
}

export class ToolRegistry implements ToolRegistryLike {
  readonly artifactOutput?: NonNullable<ToolRegistryLike["artifactOutput"]>;
  readonly modelDefinitions: readonly ModelToolDefinition[];
  private readonly definitions = new Map<string, RegisteredTool<unknown>>();

  constructor(
    definitions: readonly ToolRegistration<unknown>[],
    private readonly secrets: readonly (string | undefined)[] = [],
    readonly completion?: CompletionRuntimeLike,
    artifactOutput?: NonNullable<ToolRegistryLike["artifactOutput"]>,
  ) {
    if (artifactOutput !== undefined) this.artifactOutput = artifactOutput;
    // PHASE3: 注册阶段 fail fast：工具名必须稳定合法且不能重复。
    for (const source of definitions) {
      const definition = register(source);
      if (!TOOL_NAME.test(definition.name)) {
        throw new Error(`invalid tool name: ${definition.name}`);
      }
      if (this.definitions.has(definition.name)) {
        throw new Error(`duplicate tool name: ${definition.name}`);
      }
      if (
        definition.maxOutputBytes !== undefined &&
        (!Number.isSafeInteger(definition.maxOutputBytes) ||
          definition.maxOutputBytes < MAX_TOOL_OUTPUT_BYTES)
      ) {
        throw new Error(`invalid output limit for tool: ${definition.name}`);
      }
      this.definitions.set(definition.name, definition);
    }

    this.modelDefinitions = [...this.definitions.values()]
      // PHASE3: 稳定排序让请求、测试和 session 证据不受注册顺序影响。
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((definition) => ({
        description: definition.description,
        name: definition.name,
        parameters: definition.validator.modelSchema,
        strict: definition.validator.strictForModel,
      }));
  }

  async execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    // PHASE3: 安全执行漏斗：abort -> 字节上限 -> 工具名 -> JSON.parse -> Zod -> executor
    // -> 统一序列化/脱敏/输出上限。前置检查失败时绝不调用 executor。
    if (signal.aborted) {
      return serializeToolError(
        toolError("cancelled", "tool_cancelled", "tool execution was cancelled"),
        this.secrets,
      );
    }
    if (
      Buffer.byteLength(invocation.argumentsJson, "utf8") >
      MAX_TOOL_ARGUMENT_BYTES
    ) {
      return serializeToolError(
        toolError(
          "invalid_arguments",
          "arguments_too_large",
          "tool arguments exceed 16 KiB",
        ),
        this.secrets,
      );
    }

    const definition = this.definitions.get(invocation.name);
    if (definition === undefined) {
      return serializeToolError(
        toolError(
          "invalid_arguments",
          "unknown_tool",
          `unknown tool: ${invocation.name}`,
        ),
        this.secrets,
      );
    }

    const parsed = definition.validator.parseJson(invocation.argumentsJson);
    if (!parsed.success) {
      const invalidJson = parsed.issues.some((issue) => issue.keyword === "parse");
      return serializeToolError(
        toolError(
          "invalid_arguments",
          invalidJson ? "invalid_arguments_json" : "arguments_schema_mismatch",
          invalidJson
            ? "tool arguments must be valid JSON"
            : "tool arguments do not match the required schema",
        ),
        this.secrets,
      );
    }

    let result;
    try {
      // PHASE12: builtin Zod and discovered MCP JSON Schema validators share
      // this one execution funnel; provider-side strictness is never authority.
      result = await definition.execute(parsed.data, {
        callId: invocation.callId,
        signal,
        step: invocation.step,
        toolName: invocation.name,
      });
    } catch (error) {
      // PHASE5: storage/ambiguous mutation failures cannot become an ordinary model observation;
      // doing so could let the loop continue while the durable audit or workspace state is unknown.
      if (error instanceof FatalToolExecutionError) throw error;
      result = {
        error: toolError(
          "system",
          "tool_execution_failed",
          "tool execution failed",
        ),
        ok: false as const,
      };
    }
    if (!result.ok) {
      if (result.preSerializedOutput !== undefined) {
        const output = redactSensitiveText(result.preSerializedOutput, this.secrets);
        const outputLimit = definition.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;
        if (
          output !== result.preSerializedOutput ||
          Buffer.byteLength(output, "utf8") > outputLimit
        ) {
          return serializeToolError(
            toolError(
              "system",
              "tool_output_contract_failed",
              "tool output failed its exact observation contract",
            ),
            this.secrets,
          );
        }
        return this.materializeExecution(invocation, outputLimit, {
          ...(result.control === undefined ? {} : { control: result.control }),
          error: {
            ...result.error,
            message: redactSensitiveText(result.error.message, this.secrets),
          },
          ok: false,
          output,
          truncated: result.truncated ?? false,
        });
      }
      if (result.value === undefined) {
        return serializeToolError(result.error, this.secrets);
      }
      const safeError = {
        ...result.error,
        message: redactSensitiveText(result.error.message, this.secrets),
      };
      const output = redactSensitiveText(
        JSON.stringify({ ...result.value, error: safeError, ok: false }),
        this.secrets,
      );
      const outputLimit = definition.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;
      if (Buffer.byteLength(output, "utf8") > outputLimit) {
        if (!this.canMaterialize(invocation)) {
          return serializeToolError(
            toolError(
              "system",
              "tool_output_too_large",
              "tool output exceeded the safety limit",
            ),
            this.secrets,
          );
        }
      }
      return this.materializeExecution(invocation, outputLimit, {
        ...(result.control === undefined ? {} : { control: result.control }),
        error: safeError,
        ok: false,
        output,
        truncated: result.truncated ?? false,
      });
    }

    const output = redactSensitiveText(
      // PHASE3: 所有成功结果都由 Registry 统一变成紧凑 JSON，工具本身不手写最终字符串。
      result.preSerializedOutput ?? JSON.stringify({ ...result.value, ok: true }),
      this.secrets,
    );
    if (
      result.preSerializedOutput !== undefined &&
      output !== result.preSerializedOutput
    ) {
      return serializeToolError(
        toolError(
          "system",
          "tool_output_contract_failed",
          "tool output failed its exact observation contract",
        ),
        this.secrets,
      );
    }
    const outputLimit = definition.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;
    if (Buffer.byteLength(output, "utf8") > outputLimit) {
      if (!this.canMaterialize(invocation)) {
        return serializeToolError(
          toolError(
            "system",
            "tool_output_too_large",
            "tool output exceeded the safety limit",
          ),
          this.secrets,
        );
      }
    }
    return this.materializeExecution(invocation, outputLimit, {
      ...(result.control === undefined ? {} : { control: result.control }),
      ok: true,
      output,
      truncated: result.truncated,
    });
  }

  private canMaterialize(invocation: ToolInvocation): boolean {
    return (
      this.artifactOutput !== undefined &&
      invocation.originEventId !== undefined &&
      invocation.name !== "read_artifact"
    );
  }

  private async materializeExecution(
    invocation: ToolInvocation,
    modelObservationBytes: number,
    execution: ToolExecution,
  ): Promise<ToolExecution> {
    if (!this.canMaterialize(invocation)) return execution;
    try {
      const materialized = await this.artifactOutput!.materialize({
        modelObservationBytes,
        originEventId: invocation.originEventId!,
        source: [Buffer.from(execution.output, "utf8")],
      });
      return {
        ...execution,
        output: materialized.modelObservation,
        truncated:
          execution.truncated || materialized.modelObservationTruncated,
      };
    } catch (error) {
      throw new FatalToolExecutionError(
        "storage",
        "tool output artifact could not be persisted durably",
        { cause: error, workspaceMayHaveChanged: false },
      );
    }
  }
}
