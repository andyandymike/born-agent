export interface ChatRequest {
  readonly instructions: string;
  readonly model: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ChatResponse {
  readonly model: string;
  readonly providerResponseId?: string;
  readonly text: string;
  readonly usage?: ChatUsage;
}

export interface ChatClient {
  complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
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
  readonly verbose: boolean;
}

export interface ChatRuntime {
  readonly env: Readonly<Record<string, string | undefined>>;
  clearTimer(handle: unknown): void;
  createChatClient(configuration: ChatClientConfiguration): ChatClient;
  now(): number;
  onCancel(listener: () => void): () => void;
  setTimer(listener: () => void, delayMs: number): unknown;
}

export interface ResolvedChatConfig {
  readonly model: string;
  readonly ollamaBaseURL?: string;
  readonly prompt: string;
  readonly provider: ChatProvider;
  readonly timeoutMs: number;
  readonly verbose: boolean;
}

export type ChatRunResult =
  | {
      readonly elapsedMs: number;
      readonly exitCode: 0;
      readonly ok: true;
      readonly provider: ChatProvider;
      readonly response: ChatResponse;
    }
  | {
      readonly error: string;
      readonly exitCode: 1 | 2 | 4 | 5 | 6 | 130;
      readonly ok: false;
    };
