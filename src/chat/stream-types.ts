import type { ChatRequest, ChatUsage } from "./types.js";

export type ProviderFailureCategory =
  | "auth"
  | "network"
  | "protocol"
  | "provider"
  | "quota"
  | "rate_limit";

export interface ProviderFailure {
  readonly category: ProviderFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export type ChatStreamSignal =
  | { readonly delta: string; readonly type: "text_delta" }
  | { readonly type: "usage"; readonly usage: ChatUsage }
  | {
      readonly providerResponseId?: string;
      readonly type: "completed";
    }
  | { readonly error: ProviderFailure; readonly type: "failed" };

export interface StreamingChatClient {
  stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamSignal>;
}
