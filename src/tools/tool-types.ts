import type { z } from "zod";

import type { ModelToolDefinition } from "../model/model-turn-types.js";

export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

// PHASE3: 工具错误是可以安全写入 session/反馈给模型的稳定分类，不能携带 stack、
// 绝对宿主路径或原始子进程 stderr。
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
  // PHASE3: executor 返回结构化 value；Registry 统一负责 JSON 序列化、脱敏和最终字节上限。
  | {
      readonly ok: true;
      readonly truncated: boolean;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly error: ToolError; readonly ok: false };

export type ToolExecution =
  // PHASE3: Registry 的最终 output 必须与 tool.call.completed 中记录、
  // 以及第二回合实际提交给模型的字符串完全一致。
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
  // PHASE3: inputSchema 是参数合同的唯一运行时真相，同时用于本地 Zod 校验和模型 JSON Schema。
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
