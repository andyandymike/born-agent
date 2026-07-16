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

// PHASE2: 供应商适配边界。
// OpenAI/Ollama 的原始流事件先被压缩成这四种短生命周期信号；业务层因此不需要
// 理解 response.output_text.delta 等供应商协议细节，也不会把 SDK 类型写进 session。
export type ChatStreamSignal =
  | { readonly delta: string; readonly type: "text_delta" }
  | { readonly type: "usage"; readonly usage: ChatUsage }
  | {
      readonly providerResponseId?: string;
      readonly type: "completed";
    }
  | { readonly error: ProviderFailure; readonly type: "failed" };

export interface StreamingChatClient {
  // PHASE2: AsyncIterable 表示结果会随网络陆续到达，而不是一次返回完整字符串。
  // AbortSignal 从 CLI 一直传到 SDK，使 timeout 和 Ctrl+C 都能停止底层请求。
  stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamSignal>;
}
