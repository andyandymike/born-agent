import type { ChatUsage } from "../chat/types.js";
import type { ProviderFailure } from "../chat/stream-types.js";

// PHASE3: continuation 是 provider adapter 的短生命周期状态。
// 核心层只能原样传回，不能检查、持久化或把 provider 原始 output item 写入 RunEvent。
export abstract class ModelContinuation {
  declare private readonly modelContinuationBrand: "ModelContinuation";
}

export interface ModelToolDefinition {
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
  streamTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTurnSignal>;
}
