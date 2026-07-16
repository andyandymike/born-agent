import { z } from "zod";

import type { ModelToolDefinition } from "../model/model-turn-types.js";
import { redactSensitiveText } from "../security/redact.js";
import { serializeToolError, toolError } from "./tool-errors.js";
import {
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  type ToolDefinition,
  type ToolExecution,
  type ToolInvocation,
  type ToolRegistryLike,
} from "./tool-types.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

function strictJsonSchema<TInput>(
  definition: ToolDefinition<TInput>,
): Readonly<Record<string, unknown>> {
  const schema = z.toJSONSchema(definition.inputSchema, { target: "draft-7" });
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !Array.isArray(schema.required)
  ) {
    throw new Error(`tool ${definition.name} does not have a strict object schema`);
  }
  const properties = schema.properties ?? {};
  if (Object.keys(properties).some((key) => !schema.required?.includes(key))) {
    throw new Error(`tool ${definition.name} has optional JSON schema properties`);
  }
  return schema;
}

export class ToolRegistry implements ToolRegistryLike {
  readonly modelDefinitions: readonly ModelToolDefinition[];
  private readonly definitions = new Map<string, ToolDefinition<unknown>>();

  constructor(
    definitions: readonly ToolDefinition<unknown>[],
    private readonly secrets: readonly (string | undefined)[] = [],
  ) {
    for (const definition of definitions) {
      if (!TOOL_NAME.test(definition.name)) {
        throw new Error(`invalid tool name: ${definition.name}`);
      }
      if (this.definitions.has(definition.name)) {
        throw new Error(`duplicate tool name: ${definition.name}`);
      }
      this.definitions.set(definition.name, definition);
    }

    this.modelDefinitions = [...this.definitions.values()]
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((definition) => ({
        description: definition.description,
        name: definition.name,
        parameters: strictJsonSchema(definition),
        strict: true as const,
      }));
  }

  async execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
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

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(invocation.argumentsJson) as unknown;
    } catch {
      return serializeToolError(
        toolError(
          "invalid_arguments",
          "invalid_arguments_json",
          "tool arguments must be valid JSON",
        ),
        this.secrets,
      );
    }

    const parsed = definition.inputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return serializeToolError(
        toolError(
          "invalid_arguments",
          "arguments_schema_mismatch",
          "tool arguments do not match the required schema",
        ),
        this.secrets,
      );
    }

    let result;
    try {
      result = await definition.execute(parsed.data, { signal });
    } catch {
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
      return serializeToolError(result.error, this.secrets);
    }

    const output = redactSensitiveText(
      JSON.stringify({ ...result.value, ok: true }),
      this.secrets,
    );
    if (Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
      return serializeToolError(
        toolError(
          "system",
          "tool_output_too_large",
          "tool output exceeded the safety limit",
        ),
        this.secrets,
      );
    }
    return { ok: true, output, truncated: result.truncated };
  }
}
