export type ChatProvider = "anthropic" | "ollama" | "openai";

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
