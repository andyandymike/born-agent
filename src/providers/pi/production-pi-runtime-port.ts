import { resolveLoopbackOllamaURL } from "../../security/loopback-ollama-url.js";
import {
  captureFetchForSynchronousFactory,
  createDirectLoopbackFetch,
} from "../../security/direct-loopback-fetch.js";
import type { ProviderId } from "../../model/model-backend.js";
import type {
  PiRuntimeEvent,
  PiRuntimePort,
  PiRuntimeRequest,
  PiRuntimeUsage,
} from "./pi-runtime-port.js";

export type PiSdkToolCall = {
  readonly arguments: Record<string, unknown>;
  readonly id: string;
  readonly name: string;
  readonly type: "toolCall";
};

type PiSdkTextContent = { readonly text: string; readonly type: "text" };
type PiSdkThinkingContent = {
  readonly thinking: string;
  readonly thinkingSignature?: string;
  readonly type: "thinking";
};

export type PiSdkUsage = {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly input: number;
  readonly output: number;
  readonly totalTokens: number;
};

export type PiSdkDiagnostic = {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly code?: string | number;
    readonly message: string;
    readonly name?: string;
  };
  readonly timestamp: number;
  readonly type: string;
};

export type PiSdkAssistantMessage = {
  readonly api: string;
  readonly content: readonly (PiSdkTextContent | PiSdkThinkingContent | PiSdkToolCall)[];
  readonly diagnostics?: readonly PiSdkDiagnostic[];
  readonly errorMessage?: string;
  readonly model: string;
  readonly provider: string;
  readonly responseId?: string;
  readonly role: "assistant";
  readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly timestamp: number;
  readonly usage: PiSdkUsage;
};

type PiSdkMessage =
  | { readonly content: string; readonly role: "user"; readonly timestamp: number }
  | PiSdkAssistantMessage
  | {
      readonly content: readonly PiSdkTextContent[];
      readonly isError: boolean;
      readonly role: "toolResult";
      readonly timestamp: number;
      readonly toolCallId: string;
      readonly toolName: string;
    };

export type PiSdkContext = {
  readonly messages: PiSdkMessage[];
  readonly systemPrompt?: string;
  readonly tools?: readonly {
    readonly description: string;
    readonly name: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[];
};

export type PiSdkStreamOptions = {
  readonly apiKey?: string;
  readonly cacheRetention: "none";
  readonly env: Readonly<Record<string, string>>;
  readonly maxRetries: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
};

export type PiSdkAssistantMessageEvent =
  | { readonly partial: PiSdkAssistantMessage; readonly type: "start" }
  | {
      readonly contentIndex: number;
      readonly partial: PiSdkAssistantMessage;
      readonly type: "text_start" | "thinking_start" | "toolcall_start";
    }
  | {
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: PiSdkAssistantMessage;
      readonly type: "text_delta" | "thinking_delta" | "toolcall_delta";
    }
  | {
      readonly content?: string;
      readonly contentIndex: number;
      readonly partial: PiSdkAssistantMessage;
      readonly type: "text_end" | "thinking_end";
    }
  | {
      readonly contentIndex: number;
      readonly partial: PiSdkAssistantMessage;
      readonly toolCall: PiSdkToolCall;
      readonly type: "toolcall_end";
    }
  | {
      readonly message: PiSdkAssistantMessage;
      readonly reason: "stop" | "length" | "toolUse";
      readonly type: "done";
    }
  | {
      readonly error: PiSdkAssistantMessage;
      readonly reason: "aborted" | "error";
      readonly type: "error";
    };

export type PiSdkModel = {
  readonly api: string;
  readonly baseUrl: string;
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly contextWindow: number;
  readonly cost: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
  };
  readonly id: string;
  readonly input: readonly ("text" | "image")[];
  readonly maxTokens: number;
  readonly name: string;
  readonly provider: string;
  readonly reasoning: boolean;
};

export interface ProductionPiRuntimePortOptions {
  readonly baseUrl?: string;
  readonly credential?: string;
  readonly model: string;
  readonly provider: ProviderId;
}

export interface PiRuntimeDriver {
  readonly model: PiSdkModel;
  stream(
    context: PiSdkContext,
    options: PiSdkStreamOptions,
  ): AsyncIterable<PiSdkAssistantMessageEvent>;
}

export type PiRuntimeDriverLoader = (
  options: ProductionPiRuntimePortOptions,
) => Promise<PiRuntimeDriver>;

class ProductionContinuation {
  readonly #instructions: string;
  readonly #messages: readonly PiSdkMessage[];
  readonly #model: string;
  readonly #owner: object;
  readonly #provider: ProviderId;

  constructor(
    owner: object,
    request: PiRuntimeRequest,
    messages: readonly PiSdkMessage[],
  ) {
    this.#owner = owner;
    this.#provider = request.identity.provider;
    this.#model = request.identity.model;
    this.#instructions = request.instructions;
    this.#messages = messages;
    Object.freeze(this);
  }

  messages(owner: object, request: PiRuntimeRequest): readonly PiSdkMessage[] {
    if (
      owner !== this.#owner ||
      request.identity.provider !== this.#provider ||
      request.identity.model !== this.#model ||
      request.instructions !== this.#instructions
    ) {
      throw new TypeError("pi continuation does not belong to this runtime request");
    }
    return this.#messages;
  }
}

function modelNotFound(provider: ProviderId, model: string): Error {
  const error = new Error(`configured ${provider} model is not in the pinned pi catalog: ${model}`);
  Object.assign(error, { code: "model_not_found", status: 404 });
  return error;
}

function withBaseUrl<TModel extends PiSdkModel>(
  model: TModel,
  baseUrl: string | undefined,
): TModel {
  return baseUrl === undefined ? model : { ...model, baseUrl };
}

type PiProviderModule = {
  readonly anthropicProvider?: () => PiProvider;
  readonly openaiProvider?: () => PiProvider;
};

type PiProvider = {
  readonly getModels: () => readonly PiSdkModel[];
  readonly streamSimple: (
    model: PiSdkModel,
    context: PiSdkContext,
    options: PiSdkStreamOptions,
  ) => AsyncIterable<PiSdkAssistantMessageEvent>;
};

const OPENAI_PROVIDER_MODULE = "@earendil-works/pi-ai/providers/openai";
const ANTHROPIC_PROVIDER_MODULE = "@earendil-works/pi-ai/providers/anthropic";
const OPENAI_COMPLETIONS_MODULE = "@earendil-works/pi-ai/api/openai-completions";

async function loadRemoteDriver(
  options: ProductionPiRuntimePortOptions,
): Promise<PiRuntimeDriver> {
  if (options.provider === "openai") {
    const { openaiProvider } = (await import(OPENAI_PROVIDER_MODULE)) as PiProviderModule;
    if (openaiProvider === undefined) throw new TypeError("pi openai provider is unavailable");
    const provider = openaiProvider();
    const found = provider.getModels().find((model) => model.id === options.model);
    if (found === undefined) throw modelNotFound(options.provider, options.model);
    const model = withBaseUrl(found, options.baseUrl);
    return {
      model,
      stream: (context, streamOptions) =>
        provider.streamSimple(model, context, streamOptions),
    };
  }

  const { anthropicProvider } = (await import(
    ANTHROPIC_PROVIDER_MODULE
  )) as PiProviderModule;
  if (anthropicProvider === undefined) throw new TypeError("pi anthropic provider is unavailable");
  const provider = anthropicProvider();
  const found = provider.getModels().find((model) => model.id === options.model);
  if (found === undefined) throw modelNotFound(options.provider, options.model);
  const model = withBaseUrl(found, options.baseUrl);
  return {
    model,
    stream: (context, streamOptions) =>
      provider.streamSimple(model, context, streamOptions),
  };
}

async function loadOllamaDriver(
  options: ProductionPiRuntimePortOptions,
): Promise<PiRuntimeDriver> {
  const selected = resolveLoopbackOllamaURL(
    options.baseUrl ?? "http://127.0.0.1:11434",
  );
  if (!selected.ok) {
    const error = new Error(selected.error);
    Object.assign(error, { code: "remote_provider_forbidden_by_cost_policy" });
    throw error;
  }
  const { streamSimple } = (await import(OPENAI_COMPLETIONS_MODULE)) as {
    readonly streamSimple: (
      model: PiSdkModel,
      context: PiSdkContext,
      options: PiSdkStreamOptions,
    ) => AsyncIterable<PiSdkAssistantMessageEvent>;
  };
  const model: PiSdkModel = {
    api: "openai-completions",
    baseUrl: `${selected.value}/v1`,
    compat: {
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: true,
    },
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: options.model,
    input: ["text"],
    maxTokens: 8_192,
    name: options.model,
    provider: "ollama",
    reasoning: false,
  };
  const fetcher = createDirectLoopbackFetch({
    allowedMethods: ["POST"],
    baseURL: selected.value,
    path: { prefix: "/v1/" },
  });
  return {
    model,
    stream: (context, streamOptions) =>
      captureFetchForSynchronousFactory(fetcher, () =>
        streamSimple(model, context, streamOptions),
      ),
  };
}

const loadProductionDriver: PiRuntimeDriverLoader = async (options) =>
  options.provider === "ollama"
    ? loadOllamaDriver(options)
    : loadRemoteDriver(options);

function usageFromMessage(message: PiSdkAssistantMessage): PiRuntimeUsage | undefined {
  const usage = {
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
  };
  // PHASE8: pi 0.80.7 initializes usage with zeroes before a provider reports it. A
  // non-empty successful message with an all-zero snapshot therefore carries
  // no authoritative usage fact and must fail the complete-usage contract.
  return Object.values(usage).every((value) => value === 0) ? undefined : usage;
}

const KNOWN_ERROR_CODES = [
  "insufficient_quota",
  "insufficient_credits",
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "model_not_found",
  "invalid_request",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
] as const;

function stableErrorCode(message: PiSdkAssistantMessage): string | undefined {
  for (const diagnostic of message.diagnostics ?? []) {
    const code = diagnostic.error?.code;
    if (typeof code === "string") {
      const normalizedCode = code.toLowerCase();
      const known = KNOWN_ERROR_CODES.find(
        (candidate) =>
          normalizedCode === candidate || normalizedCode.includes(candidate),
      );
      if (known !== undefined) return known;
    }
  }
  const normalized = message.errorMessage?.toLowerCase() ?? "";
  return KNOWN_ERROR_CODES.find((code) => normalized.includes(code));
}

function stableHttpStatus(message: PiSdkAssistantMessage): number | undefined {
  for (const diagnostic of message.diagnostics ?? []) {
    const candidates = [diagnostic.details?.status, diagnostic.error?.code];
    for (const candidate of candidates) {
      if (
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 100 &&
        candidate <= 599
      ) {
        return candidate;
      }
    }
  }
  const text = message.errorMessage ?? "";
  const match =
    /^\s*(?<status>[1-5]\d{2})\b/u.exec(text) ??
    /\b(?:http|status(?: code)?|api error)\D{0,12}(?<status>[1-5]\d{2})\b/iu.exec(
      text,
    );
  const status = match?.groups?.status;
  return status === undefined ? undefined : Number(status);
}

function stableRequestId(message: PiSdkAssistantMessage): string | undefined {
  if (
    message.responseId !== undefined &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(message.responseId)
  ) {
    return message.responseId;
  }
  for (const diagnostic of message.diagnostics ?? []) {
    const details = diagnostic.details;
    const candidate = details?.requestId ?? details?.request_id;
    if (
      typeof candidate === "string" &&
      /^[A-Za-z0-9._:-]{1,200}$/u.test(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function errorFromMessage(
  message: PiSdkAssistantMessage,
  reason: "aborted" | "error",
): {
  readonly code?: string;
  readonly message: string;
  readonly providerRequestId?: string;
  readonly status?: number;
} {
  const code = reason === "aborted" ? "request_cancelled" : stableErrorCode(message);
  const status = stableHttpStatus(message);
  const providerRequestId = stableRequestId(message);
  // PHASE8: pi 0.80.7 collapses SDK errors into errorMessage and optional
  // diagnostics. Extract only allowlisted category facts here; the raw message,
  // stack, response body, and diagnostics must not cross the adapter boundary.
  return {
    ...(code === undefined ? {} : { code }),
    message:
      reason === "aborted"
        ? "pi request aborted"
        : code ?? (status === undefined ? "pi provider error" : `http ${status}`),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(status === undefined ? {} : { status }),
  };
}

function toolCallAt(
  message: PiSdkAssistantMessage,
  contentIndex: number,
): PiSdkToolCall | undefined {
  const content = message.content[contentIndex];
  return content?.type === "toolCall" ? content : undefined;
}

function findToolName(messages: readonly PiSdkMessage[], callId: string): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const call = message.content.find(
      (content): content is PiSdkToolCall =>
        content.type === "toolCall" && content.id === callId,
    );
    if (call !== undefined) return call.name;
  }
  return undefined;
}

function assertNever(event: never): never {
  void event;
  throw new TypeError("pi 0.80.7 emitted an unknown event");
}

export class ProductionPiRuntimePort implements PiRuntimePort {
  readonly #loader: PiRuntimeDriverLoader;
  readonly #options: ProductionPiRuntimePortOptions;
  readonly #owner = Object.freeze({});
  #driverPromise: Promise<PiRuntimeDriver> | undefined;

  constructor(
    options: ProductionPiRuntimePortOptions,
    loader: PiRuntimeDriverLoader = loadProductionDriver,
  ) {
    this.#options = Object.freeze({ ...options });
    this.#loader = loader;
  }

  async *runTurn(
    request: PiRuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<PiRuntimeEvent> {
    if (
      request.identity.provider !== this.#options.provider ||
      request.identity.model !== this.#options.model
    ) {
      throw new TypeError("runtime request does not match its frozen backend");
    }
    if (
      this.#options.provider !== "ollama" &&
      (this.#options.credential === undefined || this.#options.credential.length === 0)
    ) {
      const error = new Error("remote provider credential is missing");
      Object.assign(error, { code: "missing_credential" });
      throw error;
    }
    if (signal.aborted) {
      yield {
        error: { code: "request_cancelled", message: "request aborted" },
        reason: "aborted",
        type: "error",
      };
      return;
    }

    // PHASE8: the fixed pi-ai package and provider SDKs are loaded only after
    // factory preflight/credential/network guards have allowed a request. This
    // is the sole production file that imports pi runtime values.
    this.#driverPromise ??= this.#loader(this.#options);
    const driver = await this.#driverPromise;
    const messages = this.#messages(request);
    const context: PiSdkContext = {
      messages: [...messages],
      systemPrompt: request.instructions,
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              description: tool.description,
              name: tool.name,
              parameters: tool.parameters,
            })),
          }),
    };
    const apiKey =
      this.#options.provider === "ollama"
        ? "ollama-local-no-credential"
        : this.#options.credential;
    const options: PiSdkStreamOptions = {
      ...(apiKey === undefined ? {} : { apiKey }),
      cacheRetention: "none",
      env: {},
      maxRetries: 0,
      signal,
      timeoutMs: request.timeoutMs,
    };

    for await (const event of driver.stream(context, options)) {
      // PHASE8: pi 0.80.7 exposes a cross-provider partial AssistantMessage on
      // tool deltas. Read id/name from that pinned shape until upstream offers
      // them directly on delta events; remove this workaround when it does.
      switch (event.type) {
        case "start":
          yield { type: "start" };
          break;
        case "text_start":
          yield { type: "text_start" };
          break;
        case "text_delta":
          yield { delta: event.delta, type: "text_delta" };
          break;
        case "text_end":
          yield { type: "text_end" };
          break;
        case "thinking_start":
          yield { type: "thinking_start" };
          break;
        case "thinking_delta":
          yield { delta: event.delta, type: "thinking_delta" };
          break;
        case "thinking_end":
          yield { type: "thinking_end" };
          break;
        case "toolcall_start": {
          const call = toolCallAt(event.partial, event.contentIndex);
          yield {
            ...(call?.id === undefined ? {} : { callId: call.id }),
            contentIndex: event.contentIndex,
            ...(call?.name === undefined ? {} : { name: call.name }),
            type: "toolcall_start",
          };
          break;
        }
        case "toolcall_delta": {
          const call = toolCallAt(event.partial, event.contentIndex);
          yield {
            argumentsDelta: event.delta,
            ...(call?.id === undefined ? {} : { callId: call.id }),
            contentIndex: event.contentIndex,
            ...(call?.name === undefined ? {} : { name: call.name }),
            type: "toolcall_delta",
          };
          break;
        }
        case "toolcall_end":
          yield {
            arguments: event.toolCall.arguments,
            callId: event.toolCall.id,
            contentIndex: event.contentIndex,
            name: event.toolCall.name,
            type: "toolcall_end",
          };
          break;
        case "done": {
          const terminalUsage = usageFromMessage(event.message);
          yield {
            continuation: new ProductionContinuation(
              this.#owner,
              request,
              [...messages, event.message],
            ),
            ...(event.message.responseId === undefined
              ? {}
              : { providerRequestId: event.message.responseId }),
            reason: event.reason,
            type: "done",
            ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
          };
          return;
        }
        case "error":
          yield {
            error: errorFromMessage(event.error, event.reason),
            reason: event.reason,
            type: "error",
          };
          return;
        default:
          return assertNever(event);
      }
    }
  }

  #messages(request: PiRuntimeRequest): readonly PiSdkMessage[] {
    if (request.input.kind === "user_prompt") {
      return [
        {
          content: request.input.text,
          role: "user",
          timestamp: Date.now(),
        },
      ];
    }
    if (!(request.input.continuation instanceof ProductionContinuation)) {
      throw new TypeError("runtime continuation is invalid");
    }
    const previous = request.input.continuation.messages(this.#owner, request);
    const toolName = findToolName(previous, request.input.callId);
    if (toolName === undefined) {
      throw new TypeError("tool result does not match a prior pi tool call");
    }
    return [
      ...previous,
      {
        content: [{ text: request.input.output, type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: Date.now(),
        toolCallId: request.input.callId,
        toolName,
      },
    ];
  }
}
