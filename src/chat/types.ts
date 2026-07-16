export interface ChatRequest {
  readonly instructions: string;
  readonly model: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ChatUsage {
  readonly cachedInputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type ChatProvider = "ollama" | "openai";

export type ChatClientConfiguration =
  | {
      readonly apiKey: string;
      readonly provider: "openai";
    }
  | {
      readonly baseURL: string;
      readonly provider: "ollama";
    };

export interface ChatCommandOptions {
  readonly model: string | undefined;
  readonly prompt: string;
  readonly provider: string | undefined;
  readonly timeoutMs: string | undefined;
  readonly toolsEnabled?: boolean;
  readonly verbose: boolean;
}

export interface ResolvedChatConfig {
  readonly model: string;
  readonly ollamaBaseURL?: string;
  readonly prompt: string;
  readonly provider: ChatProvider;
  readonly timeoutMs: number;
  readonly toolsEnabled: boolean;
  readonly verbose: boolean;
}
