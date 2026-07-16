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
  | {
      readonly error: ToolError;
      readonly ok: false;
      // PHASE6: execution failures can still carry bounded stdout/stderr evidence;
      // the Registry remains the single serializer/redactor for that observation.
      readonly truncated?: boolean;
      readonly value?: Readonly<Record<string, unknown>>;
    };

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
      readonly truncated: boolean;
    };

export interface ToolContext {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly step: number;
  readonly toolName: string;
}

export interface ToolDefinition<TInput> {
  // PHASE5: capability 是 Registry 装配时的机械边界；prompt 文字不能保证 chat 保持只读。
  readonly capability: "mutation" | "read";
  // PHASE3: inputSchema 是参数合同的唯一运行时真相，同时用于本地 Zod 校验和模型 JSON Schema。
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  // PHASE6: command observations may legitimately exceed the Phase 3 read-tool cap;
  // each exceptional tool must opt in explicitly so read tools stay bounded at 64 KiB.
  readonly maxOutputBytes?: number;
  readonly name: string;
  execute(input: TInput, context: ToolContext): Promise<ToolRawResult>;
}

export interface ToolInvocation {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly name: string;
  readonly step: number;
}

export class FatalToolExecutionError extends Error {
  readonly workspaceMayHaveChanged: boolean;

  constructor(
    readonly kind:
      | "ambiguous_command_state"
      | "ambiguous_patch_state"
      | "storage"
      | "user_cancelled",
    message: string,
    options: { readonly cause?: unknown; readonly workspaceMayHaveChanged: boolean },
  ) {
    super(message, { cause: options.cause });
    this.name = "FatalToolExecutionError";
    this.workspaceMayHaveChanged = options.workspaceMayHaveChanged;
  }
}

export interface ToolRegistryLike {
  readonly modelDefinitions: readonly ModelToolDefinition[];
  execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecution>;
}
