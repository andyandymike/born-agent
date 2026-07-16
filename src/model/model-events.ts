import type { BackendContinuation } from "./model-backend.js";
import type { ProviderFailure } from "./provider-failure.js";

export type CompleteModelUsage = {
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly completeness: "complete";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type PartialModelUsage = {
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly completeness: "partial";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
};

export type ModelUsage = CompleteModelUsage | PartialModelUsage;

export type ModelEvent =
  | { readonly text: string; readonly type: "text_delta" }
  | {
      readonly argumentsDelta: string;
      readonly callId: string;
      readonly name: string;
      readonly type: "tool_call_delta";
    }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | {
      readonly continuation: BackendContinuation;
      readonly outcome: "text" | "tool_calls";
      readonly providerRequestId?: string;
      readonly type: "turn_completed";
    }
  | { readonly error: ProviderFailure; readonly type: "failed" };

