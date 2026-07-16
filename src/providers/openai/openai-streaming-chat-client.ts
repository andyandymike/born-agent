import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import type { ProviderFailure } from "../../chat/stream-types.js";
import type { ChatUsage } from "../../chat/types.js";
import {
  ModelContinuation,
  type ModelToolCall,
  type ModelTurnClient,
  type ModelTurnRequest,
  type ModelTurnSignal,
} from "../../model/model-turn-types.js";
import {
  createProviderFailure,
  mapOpenAIError,
  mapOpenAIResponseFailure,
} from "./map-openai-error.js";

export type OpenAIStreamingRequestBody = ResponseCreateParamsStreaming;

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
  readonly includeEncryptedReasoning?: boolean;
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

class OpenAIContinuation extends ModelContinuation {
  readonly #input: readonly ResponseInputItem[];

  constructor(input: readonly ResponseInputItem[]) {
    super();
    this.#input = input;
  }

  items(): readonly ResponseInputItem[] {
    return this.#input;
  }
}

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
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
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
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function sameToolCall(left: ModelToolCall, right: ModelToolCall): boolean {
  return (
    left.callId === right.callId &&
    left.name === right.name &&
    left.argumentsJson === right.argumentsJson
  );
}

function readToolCall(value: unknown): ModelToolCall | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "function_call" ||
    !("call_id" in value) ||
    typeof value.call_id !== "string" ||
    value.call_id.length === 0 ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !("arguments" in value) ||
    typeof value.arguments !== "string"
  ) {
    return undefined;
  }
  return {
    argumentsJson: value.arguments,
    callId: value.call_id,
    name: value.name,
  };
}

function modelTools(request: ModelTurnRequest): FunctionTool[] {
  return request.tools.map((tool) => ({
    description: tool.description,
    name: tool.name,
    parameters: { ...tool.parameters },
    strict: true,
    type: "function",
  }));
}

function requestInput(request: ModelTurnRequest): {
  readonly bodyInput: NonNullable<ResponseCreateParamsStreaming["input"]>;
  readonly continuationInput: readonly ResponseInputItem[];
} {
  if (request.input.kind === "user_prompt") {
    return {
      bodyInput: request.input.text,
      continuationInput: [
        { content: request.input.text, role: "user", type: "message" },
      ],
    };
  }
  if (!(request.input.continuation instanceof OpenAIContinuation)) {
    throw new OpenAIStreamProtocolError();
  }
  const continuationInput = [
    ...request.input.continuation.items(),
    {
      call_id: request.input.callId,
      output: request.input.output,
      type: "function_call_output" as const,
    },
  ];
  return { bodyInput: continuationInput, continuationInput };
}

export class OpenAIStreamingChatClient implements ModelTurnClient {
  private readonly client: OpenAIStreamingSdkLike;
  private readonly includeEncryptedReasoning: boolean;
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
    this.includeEncryptedReasoning =
      options.includeEncryptedReasoning ?? this.includeStore;
    this.providerName = options.providerName ?? "OpenAI";
  }

  async *streamTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTurnSignal> {
    try {
      const input = requestInput(request);
      const tools = modelTools(request);
      // PHASE2/3: stream:true 让 SDK 返回异步事件流；OpenAI 显式 store:false。
      // stateless reasoning continuation 还请求 encrypted reasoning；Ollama 兼容模式省略两者。
      const events = await this.client.responses.create(
        {
          input: input.bodyInput,
          instructions: request.instructions,
          ...(this.includeEncryptedReasoning
            ? { include: ["reasoning.encrypted_content" as const] }
            : {}),
          model: request.model,
          ...(tools.length === 0
            ? {}
            : {
                parallel_tool_calls: false,
                tool_choice: "auto" as const,
                tools,
              }),
          ...(this.includeStore ? { store: false as const } : {}),
          stream: true,
        },
        { signal },
      );

      const argumentDeltas = new Map<string, string>();
      const argumentDone = new Map<
        string,
        { readonly argumentsJson: string; readonly name?: string }
      >();
      let streamedToolCall: ModelToolCall | undefined;

      for await (const event of events) {
        if (signal.aborted) {
          return;
        }
        // PHASE2/3: Provider event -> provider-neutral ModelTurnSignal。
        // SDK 类型、reasoning item 和 Responses output 都不会写进 session。
        switch (event.type) {
          case "response.output_text.delta":
            if (event.delta.length > 0) {
              yield { delta: event.delta, type: "text_delta" };
            }
            break;
          case "response.function_call_arguments.delta":
            argumentDeltas.set(
              event.item_id,
              `${argumentDeltas.get(event.item_id) ?? ""}${event.delta}`,
            );
            break;
          case "response.function_call_arguments.done":
            argumentDone.set(event.item_id, {
              argumentsJson: event.arguments,
              // Ollama's Responses-compatible stream omits this redundant field.
              // The completed output item remains the authoritative source for
              // the tool name, while arguments are still checked byte-for-byte.
              ...(typeof event.name === "string" ? { name: event.name } : {}),
            });
            break;
          case "response.output_item.done": {
            if (event.item.type !== "function_call") {
              break;
            }
            const call = readToolCall(event.item);
            if (call === undefined || streamedToolCall !== undefined) {
              yield { error: protocolFailure(this.providerName), type: "failed" };
              return;
            }
            const itemId = event.item.id;
            const deltas = itemId === undefined ? undefined : argumentDeltas.get(itemId);
            const done = itemId === undefined ? undefined : argumentDone.get(itemId);
            if (
              (deltas !== undefined && deltas !== call.argumentsJson) ||
              (done !== undefined &&
                (done.argumentsJson !== call.argumentsJson ||
                  (done.name !== undefined && done.name !== call.name)))
            ) {
              yield { error: protocolFailure(this.providerName), type: "failed" };
              return;
            }
            streamedToolCall = call;
            yield { call, type: "tool_call" };
            break;
          }
          case "response.completed": {
            if (event.response.status !== "completed") {
              yield { error: protocolFailure(this.providerName), type: "failed" };
              return;
            }
            const output = Array.isArray(event.response.output)
              ? event.response.output
              : [];
            const finalCalls = output
              .filter((item) => item.type === "function_call")
              .map(readToolCall);
            if (
              finalCalls.length > 1 ||
              finalCalls.some((call) => call === undefined)
            ) {
              yield { error: protocolFailure(this.providerName), type: "failed" };
              return;
            }
            const finalCall = finalCalls[0];
            if (
              streamedToolCall !== undefined &&
              (finalCall === undefined || !sameToolCall(streamedToolCall, finalCall))
            ) {
              yield { error: protocolFailure(this.providerName), type: "failed" };
              return;
            }
            if (streamedToolCall === undefined && finalCall !== undefined) {
              streamedToolCall = finalCall;
              yield { call: finalCall, type: "tool_call" };
            }
            const usage = usageFromEvent(event, this.providerName);
            if (usage !== undefined && "category" in usage) {
              yield { error: usage, type: "failed" };
              return;
            }
            if (usage !== undefined) {
              yield { type: "usage", usage };
            }
            yield {
              continuation: new OpenAIContinuation([
                ...input.continuationInput,
                ...(output as ResponseInputItem[]),
              ]),
              providerResponseId: event.response.id,
              type: "turn_completed",
            };
            return;
          }
          case "response.failed":
            yield {
              error: mapOpenAIResponseFailure(
                event.response.error?.code,
                this.providerName,
              ),
              type: "failed",
            };
            return;
          case "response.incomplete":
            yield { error: protocolFailure(this.providerName), type: "failed" };
            return;
          case "error":
            yield {
              error: mapOpenAIResponseFailure(event.code, this.providerName),
              type: "failed",
            };
            return;
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
            break;
          default:
            return assertNever(event);
        }
      }

      if (!signal.aborted) {
        // PHASE2: 流自然耗尽却没有 completed/failed/cancel reason 时 fail closed。
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
