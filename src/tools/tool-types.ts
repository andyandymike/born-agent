import type { z } from "zod";

import type { ModelToolDefinition } from "../model/model-turn-types.js";

export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export type ToolErrorCategory =
  | "cancelled"
  | "invalid_arguments"
  | "limit"
  | "not_found"
  | "permission"
  | "system"
  | "tool";

export interface ToolError {
  readonly category: ToolErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ToolRawResult =
  | {
      readonly ok: true;
      readonly truncated: boolean;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly error: ToolError; readonly ok: false };

export type ToolExecution =
  | {
      readonly ok: true;
      readonly output: string;
      readonly truncated: boolean;
    }
  | {
      readonly error: ToolError;
      readonly ok: false;
      readonly output: string;
      readonly truncated: false;
    };

export interface ToolContext {
  readonly signal: AbortSignal;
}

export interface ToolDefinition<TInput> {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly name: string;
  execute(input: TInput, context: ToolContext): Promise<ToolRawResult>;
}

export interface ToolInvocation {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly name: string;
}

export interface ToolRegistryLike {
  readonly modelDefinitions: readonly ModelToolDefinition[];
  execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecution>;
}
