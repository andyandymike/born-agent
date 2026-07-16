import type { ChatUsage } from "../chat/types.js";
import type { ProviderFailure } from "../chat/stream-types.js";

// PHASE3: continuation 是 provider adapter 的短生命周期状态。
// 核心层只能原样传回，不能检查、持久化或把 provider 原始 output item 写入 RunEvent。
export abstract class ModelContinuation {
  declare private readonly modelContinuationBrand: "ModelContinuation";
}

export interface ModelToolDefinition {
  // PHASE3: 这是发给模型看的工具说明，不是本地 executor。本地执行仍由 ToolRegistry 决定。
  readonly description: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface ModelToolCall {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly name: string;
}

export type ModelTurnInput =
  // PHASE3/4: 第一回合输入 user prompt；每个后续回合输入上一次 callId 对应的工具结果。
  | { readonly kind: "user_prompt"; readonly text: string }
  | {
      readonly callId: string;
      readonly continuation: ModelContinuation;
      readonly kind: "tool_result";
      readonly output: string;
    };

export interface ModelTurnRequest {
  readonly input: ModelTurnInput;
  readonly instructions: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly tools: readonly ModelToolDefinition[];
}

export type ModelTurnSignal =
  // PHASE3: turn_completed 只代表一次 provider 请求结束，不代表整个 run 已完成。
  // 有 tool_call 时，orchestrator 还要执行工具并发起第二个 model turn。
  | { readonly delta: string; readonly type: "text_delta" }
  | { readonly call: ModelToolCall; readonly type: "tool_call" }
  | { readonly type: "usage"; readonly usage: ChatUsage }
  | {
      readonly continuation: ModelContinuation;
      readonly providerResponseId?: string;
      readonly type: "turn_completed";
    }
  | { readonly error: ProviderFailure; readonly type: "failed" };

export interface ModelTurnClient {
  // PHASE3: provider adapter 的唯一入口。核心层只消费这些 provider-neutral signals。
  streamTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTurnSignal>;
}
