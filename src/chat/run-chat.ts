import { resolveChatConfig } from "./config.js";
import { ChatClientError, formatChatClientError } from "./errors.js";
import { SYSTEM_INSTRUCTIONS } from "./system-instructions.js";
import type {
  ChatClientConfiguration,
  ChatCommandOptions,
  ChatRunResult,
  ChatRuntime,
} from "./types.js";

type CancellationReason = "cancelled" | "timeout";

export function normalizeAssistantText(text: string): string {
  return `${text.trimEnd()}\n`;
}

export async function runChat(
  options: ChatCommandOptions,
  runtime: ChatRuntime,
): Promise<ChatRunResult> {
  const configResult = resolveChatConfig(options, runtime.env);
  if (!configResult.ok) {
    return {
      error: `usage/config error: ${configResult.error}`,
      exitCode: 2,
      ok: false,
    };
  }

  const config = configResult.value;
  let clientConfiguration: ChatClientConfiguration;
  if (config.provider === "openai") {
    const apiKey = runtime.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return {
        error: "OPENAI_API_KEY is not configured",
        exitCode: 4,
        ok: false,
      };
    }
    clientConfiguration = { apiKey, provider: "openai" };
  } else {
    if (config.ollamaBaseURL === undefined) {
      return { error: "internal protocol error", exitCode: 1, ok: false };
    }
    clientConfiguration = {
      baseURL: config.ollamaBaseURL,
      provider: "ollama",
    };
  }

  let client;
  try {
    client = runtime.createChatClient(clientConfiguration);
  } catch {
    return { error: "internal protocol error", exitCode: 1, ok: false };
  }

  const controller = new AbortController();
  let cancellationReason: CancellationReason | undefined;
  const startedAt = runtime.now();
  const timer = runtime.setTimer(() => {
    if (cancellationReason === undefined) {
      cancellationReason = "timeout";
      controller.abort();
    }
  }, config.timeoutMs);
  const stopListening = runtime.onCancel(() => {
    if (cancellationReason === undefined) {
      cancellationReason = "cancelled";
      controller.abort();
    }
  });

  try {
    const response = await client.complete(
      {
        instructions: SYSTEM_INSTRUCTIONS,
        model: config.model,
        prompt: config.prompt,
        timeoutMs: config.timeoutMs,
      },
      controller.signal,
    );

    if (cancellationReason === "cancelled") {
      return { error: "Cancelled", exitCode: 130, ok: false };
    }
    if (cancellationReason === "timeout") {
      return {
        error: `request timed out after ${config.timeoutMs} ms`,
        exitCode: 6,
        ok: false,
      };
    }
    if (response.text.trim().length === 0) {
      return { error: "internal protocol error", exitCode: 1, ok: false };
    }

    return {
      elapsedMs: Math.max(0, runtime.now() - startedAt),
      exitCode: 0,
      ok: true,
      provider: config.provider,
      response,
    };
  } catch (error) {
    if (cancellationReason === "cancelled") {
      return { error: "Cancelled", exitCode: 130, ok: false };
    }
    if (cancellationReason === "timeout") {
      return {
        error: `request timed out after ${config.timeoutMs} ms`,
        exitCode: 6,
        ok: false,
      };
    }
    if (error instanceof ChatClientError) {
      return {
        error: formatChatClientError(error),
        exitCode:
          error.kind === "authentication"
            ? 4
            : error.kind === "provider"
              ? 5
              : 1,
        ok: false,
      };
    }
    return { error: "internal protocol error", exitCode: 1, ok: false };
  } finally {
    runtime.clearTimer(timer);
    stopListening();
  }
}
