import type {
  ChatClientConfiguration,
  ChatCommandOptions,
  ResolvedChatConfig,
} from "./types.js";
import type {
  ProviderFailure,
  StreamingChatClient,
} from "./stream-types.js";
import { resolveChatConfig } from "./config.js";
import { SYSTEM_INSTRUCTIONS } from "./system-instructions.js";
import {
  EventPersistenceError,
  EventPublisher,
  type RunEventRenderer,
} from "../events/event-publisher.js";
import type { RunEventDraft } from "../events/run-event.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";

type CancellationReason = "cancelled" | "timeout";
export type StreamingChatExitCode = 0 | 1 | 2 | 4 | 5 | 6 | 130;

export interface StreamingRunRenderer extends RunEventRenderer {
  renderDiagnostic(message: string): void;
  renderStorageError(): void;
}

export interface StreamingChatRuntime {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  clearTimer(handle: unknown): void;
  createSessionWriter(
    workspace: string,
    sessionId: string,
  ): Promise<SessionWriter>;
  createStreamingChatClient(
    configuration: ChatClientConfiguration,
  ): StreamingChatClient;
  now(): number;
  onCancel(listener: () => void): () => void;
  randomUUID(): string;
  setTimer(listener: () => void, delayMs: number): unknown;
  timestamp(): string;
}

function durationMs(runtime: StreamingChatRuntime, startedAt: number): number {
  return Math.max(0, Math.round(runtime.now() - startedAt));
}

function clientConfiguration(
  config: ResolvedChatConfig,
  env: Readonly<Record<string, string | undefined>>,
): ChatClientConfiguration | { readonly error: string } {
  if (config.provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    return apiKey
      ? { apiKey, provider: "openai" }
      : { error: "OPENAI_API_KEY is not configured" };
  }
  return config.ollamaBaseURL === undefined
    ? { error: "internal protocol error" }
    : { baseURL: config.ollamaBaseURL, provider: "ollama" };
}

function failureDraft(
  error: ProviderFailure,
  duration: number,
): RunEventDraft {
  return {
    data: {
      category: error.category,
      code: error.code,
      duration_ms: duration,
      message: error.message,
      ...(error.providerRequestId === undefined
        ? {}
        : { provider_request_id: error.providerRequestId }),
      retryable: error.retryable,
    },
    type: "run.failed",
  };
}

function exitCodeForProviderFailure(error: ProviderFailure): StreamingChatExitCode {
  if (error.category === "auth") {
    return 4;
  }
  return error.category === "protocol" ? 1 : 5;
}

async function publishCancellation(
  reason: CancellationReason,
  config: ResolvedChatConfig,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
): Promise<StreamingChatExitCode> {
  const duration = durationMs(runtime, startedAt);
  if (reason === "cancelled") {
    await publisher.publish({
      data: { duration_ms: duration, reason: "user" },
      type: "run.cancelled",
    });
    return 130;
  }

  await publisher.publish({
    data: {
      category: "timeout",
      code: "request_timeout",
      duration_ms: duration,
      message: `request timed out after ${config.timeoutMs} ms`,
      retryable: true,
    },
    type: "run.failed",
  });
  return 6;
}

async function consumeProviderStream(
  client: StreamingChatClient,
  config: ResolvedChatConfig,
  controller: AbortController,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
  cancellationReason: () => CancellationReason | undefined,
): Promise<StreamingChatExitCode> {
  for await (const signal of client.stream(
    {
      instructions: SYSTEM_INSTRUCTIONS,
      model: config.model,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
    },
    controller.signal,
  )) {
    if (cancellationReason() !== undefined) {
      break;
    }

    switch (signal.type) {
      case "text_delta":
        if (signal.delta.length > 0) {
          await publisher.publish({
            data: { delta: signal.delta },
            type: "text.delta",
          });
        }
        break;
      case "usage":
        await publisher.publish({
          data: {
            ...(signal.usage.cachedInputTokens === undefined
              ? {}
              : {
                  cached_input_tokens: signal.usage.cachedInputTokens,
                }),
            input_tokens: signal.usage.inputTokens,
            output_tokens: signal.usage.outputTokens,
            total_tokens: signal.usage.totalTokens,
          },
          type: "usage",
        });
        break;
      case "completed": {
        await publisher.publish({
          data: {
            duration_ms: durationMs(runtime, startedAt),
            output_chars: publisher.outputLength,
            ...(signal.providerResponseId === undefined
              ? {}
              : { provider_response_id: signal.providerResponseId }),
          },
          type: "run.completed",
        });
        return 0;
      }
      case "failed":
        await publisher.publish(
          failureDraft(signal.error, durationMs(runtime, startedAt)),
        );
        return exitCodeForProviderFailure(signal.error);
    }
  }

  const reason = cancellationReason();
  if (reason !== undefined) {
    return publishCancellation(
      reason,
      config,
      publisher,
      runtime,
      startedAt,
    );
  }

  await publisher.publish({
    data: {
      category: "protocol",
      code: "stream_ended_without_terminal",
      duration_ms: durationMs(runtime, startedAt),
      message: "provider stream ended without a terminal event",
      retryable: false,
    },
    type: "run.failed",
  });
  return 1;
}

export async function runStreamingChat(
  options: ChatCommandOptions,
  runtime: StreamingChatRuntime,
  renderer: StreamingRunRenderer,
): Promise<StreamingChatExitCode> {
  const configResult = resolveChatConfig(options, runtime.env);
  if (!configResult.ok) {
    renderer.renderDiagnostic(`usage/config error: ${configResult.error}`);
    return 2;
  }
  const config = configResult.value;
  const connection = clientConfiguration(config, runtime.env);
  if ("error" in connection) {
    renderer.renderDiagnostic(connection.error);
    return connection.error === "OPENAI_API_KEY is not configured" ? 4 : 1;
  }

  const sessionId = runtime.randomUUID();
  const runId = runtime.randomUUID();
  let writer: SessionWriter;
  try {
    writer = await runtime.createSessionWriter(runtime.cwd, sessionId);
  } catch {
    renderer.renderStorageError();
    return 1;
  }

  const publisher = new EventPublisher({
    randomUUID: runtime.randomUUID,
    renderer,
    runId,
    sessionId,
    timestamp: runtime.timestamp,
    writer,
  });
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
  let exitCode: StreamingChatExitCode;

  try {
    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: config.prompt },
        model: config.model,
        provider: config.provider,
        timeout_ms: config.timeoutMs,
        workspace: runtime.cwd,
      },
      type: "run.started",
    });
    const client = runtime.createStreamingChatClient(connection);
    exitCode = await consumeProviderStream(
      client,
      config,
      controller,
      publisher,
      runtime,
      startedAt,
      () => cancellationReason,
    );
  } catch (error) {
    controller.abort();
    if (error instanceof EventPersistenceError) {
      renderer.renderStorageError();
      exitCode = 1;
    } else if (cancellationReason !== undefined) {
      try {
        exitCode = await publishCancellation(
          cancellationReason,
          config,
          publisher,
          runtime,
          startedAt,
        );
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
        exitCode = 1;
      }
    } else {
      try {
        await publisher.publish({
          data: {
            category: "internal",
            code: "internal_error",
            duration_ms: durationMs(runtime, startedAt),
            message: "internal protocol error",
            retryable: false,
          },
          type: "run.failed",
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
      }
      exitCode = 1;
    }
  } finally {
    runtime.clearTimer(timer);
    stopListening();
  }

  try {
    await writer.close();
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
