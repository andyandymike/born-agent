import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import type {
  ChatStreamSignal,
  ProviderFailure,
  StreamingChatClient,
} from "../../chat/stream-types.js";
import type { ChatRequest, ChatUsage } from "../../chat/types.js";
import {
  createProviderFailure,
  mapOpenAIError,
  mapOpenAIResponseFailure,
} from "./map-openai-error.js";

export interface OpenAIStreamingRequestBody {
  readonly input: string;
  readonly instructions: string;
  readonly model: string;
  readonly store?: false;
  readonly stream: true;
}

export interface OpenAIStreamingSdkLike {
  readonly responses: {
    create(
      body: OpenAIStreamingRequestBody,
      options: { readonly signal: AbortSignal },
    ): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
}

export interface OpenAIStreamingSdkOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly maxRetries: number;
}

export interface OpenAIStreamingChatClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly includeStore?: boolean;
  readonly providerName?: string;
}

export type OpenAIStreamingSdkFactory = (
  options: OpenAIStreamingSdkOptions,
) => OpenAIStreamingSdkLike;

const createOpenAISdk: OpenAIStreamingSdkFactory = (options) => {
  const client = new OpenAI(options);
  return {
    responses: {
      create: async (body, requestOptions) =>
        client.responses.create(body, requestOptions),
    },
  };
};

class OpenAIStreamProtocolError extends Error {
  constructor() {
    super("unhandled OpenAI stream event");
    this.name = "OpenAIStreamProtocolError";
  }
}

function assertNever(value: never): never {
  void value;
  throw new OpenAIStreamProtocolError();
}

function protocolFailure(providerName: string): ProviderFailure {
  return createProviderFailure("protocol", providerName);
}

function usageFromEvent(
  event: Extract<ResponseStreamEvent, { type: "response.completed" }>,
  providerName: string,
): ChatUsage | ProviderFailure | undefined {
  const usage = event.response.usage;
  if (usage === undefined) {
    return undefined;
  }
  const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (
    values.some(
      (value) => !Number.isInteger(value) || value < 0,
    )
  ) {
    return protocolFailure(providerName);
  }
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  if (
    cachedInputTokens !== undefined &&
    (!Number.isInteger(cachedInputTokens) || cachedInputTokens < 0)
  ) {
    return protocolFailure(providerName);
  }
  return {
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens }),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

export function mapOpenAIStreamEvent(
  event: ResponseStreamEvent,
  providerName = "OpenAI",
): readonly ChatStreamSignal[] {
  switch (event.type) {
    case "response.output_text.delta":
      return event.delta.length === 0
        ? []
        : [{ delta: event.delta, type: "text_delta" }];
    case "response.completed": {
      if (event.response.status !== "completed") {
        return [{ error: protocolFailure(providerName), type: "failed" }];
      }
      const usage = usageFromEvent(event, providerName);
      if (usage !== undefined && "category" in usage) {
        return [{ error: protocolFailure(providerName), type: "failed" }];
      }
      return [
        ...(usage === undefined
          ? []
          : [{ type: "usage" as const, usage }]),
        {
          providerResponseId: event.response.id,
          type: "completed" as const,
        },
      ];
    }
    case "response.failed":
      return [
        {
          error: mapOpenAIResponseFailure(
            event.response.error?.code,
            providerName,
          ),
          type: "failed",
        },
      ];
    case "response.incomplete":
      return [{ error: protocolFailure(providerName), type: "failed" }];
    case "error":
      return [
        {
          error: mapOpenAIResponseFailure(event.code, providerName),
          type: "failed",
        },
      ];
    case "response.audio.delta":
    case "response.audio.done":
    case "response.audio.transcript.delta":
    case "response.audio.transcript.done":
    case "response.code_interpreter_call_code.delta":
    case "response.code_interpreter_call_code.done":
    case "response.code_interpreter_call.completed":
    case "response.code_interpreter_call.in_progress":
    case "response.code_interpreter_call.interpreting":
    case "response.content_part.added":
    case "response.content_part.done":
    case "response.created":
    case "response.custom_tool_call_input.delta":
    case "response.custom_tool_call_input.done":
    case "response.file_search_call.completed":
    case "response.file_search_call.in_progress":
    case "response.file_search_call.searching":
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
    case "response.image_generation_call.completed":
    case "response.image_generation_call.generating":
    case "response.image_generation_call.in_progress":
    case "response.image_generation_call.partial_image":
    case "response.in_progress":
    case "response.mcp_call_arguments.delta":
    case "response.mcp_call_arguments.done":
    case "response.mcp_call.completed":
    case "response.mcp_call.failed":
    case "response.mcp_call.in_progress":
    case "response.mcp_list_tools.completed":
    case "response.mcp_list_tools.failed":
    case "response.mcp_list_tools.in_progress":
    case "response.output_item.added":
    case "response.output_item.done":
    case "response.output_text.annotation.added":
    case "response.output_text.done":
    case "response.queued":
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done":
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_text.done":
    case "response.reasoning_text.delta":
    case "response.reasoning_text.done":
    case "response.refusal.delta":
    case "response.refusal.done":
    case "response.web_search_call.completed":
    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
      return [];
    default:
      return assertNever(event);
  }
}

export class OpenAIStreamingChatClient implements StreamingChatClient {
  private readonly client: OpenAIStreamingSdkLike;
  private readonly includeStore: boolean;
  private readonly providerName: string;

  constructor(
    options: OpenAIStreamingChatClientOptions,
    factory: OpenAIStreamingSdkFactory = createOpenAISdk,
  ) {
    this.client = factory({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      maxRetries: 0,
    });
    this.includeStore = options.includeStore ?? true;
    this.providerName = options.providerName ?? "OpenAI";
  }

  async *stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamSignal> {
    try {
      const events = await this.client.responses.create(
        {
          input: request.prompt,
          instructions: request.instructions,
          model: request.model,
          ...(this.includeStore ? { store: false as const } : {}),
          stream: true,
        },
        { signal },
      );

      for await (const event of events) {
        if (signal.aborted) {
          return;
        }
        const signals = mapOpenAIStreamEvent(event, this.providerName);
        for (const mapped of signals) {
          yield mapped;
          if (mapped.type === "completed" || mapped.type === "failed") {
            return;
          }
        }
      }

      if (!signal.aborted) {
        yield { error: protocolFailure(this.providerName), type: "failed" };
      }
    } catch (error) {
      if (!signal.aborted) {
        yield {
          error:
            error instanceof OpenAIStreamProtocolError
              ? protocolFailure(this.providerName)
              : mapOpenAIError(error, this.providerName),
          type: "failed",
        };
      }
    }
  }
}
