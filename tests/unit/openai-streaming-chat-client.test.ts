import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import {
  mapOpenAIStreamEvent,
  OpenAIStreamingChatClient,
  type OpenAIStreamingRequestBody,
  type OpenAIStreamingSdkFactory,
  type OpenAIStreamingSdkOptions,
} from "../../src/providers/openai/openai-streaming-chat-client.js";

const request = {
  instructions: "system instructions",
  model: "gpt-test",
  prompt: "hello",
  timeoutMs: 12_345,
};

function sdkEvent(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

async function collect(client: OpenAIStreamingChatClient) {
  const signals = [];
  for await (const signal of client.stream(
    request,
    new AbortController().signal,
  )) {
    signals.push(signal);
  }
  return signals;
}

describe("OpenAIStreamingChatClient", () => {
  it("maps typed text events and ignores created", () => {
    expect(
      mapOpenAIStreamEvent(
        sdkEvent({ type: "response.created", response: {} }),
      ),
    ).toEqual([]);
    expect(
      mapOpenAIStreamEvent(
        sdkEvent({ type: "response.output_text.delta", delta: "first" }),
      ),
    ).toEqual([{ delta: "first", type: "text_delta" }]);
    expect(
      mapOpenAIStreamEvent(
        sdkEvent({ type: "response.output_text.delta", delta: "" }),
      ),
    ).toEqual([]);
  });

  it("extracts usage before the completed response id", () => {
    const mapped = mapOpenAIStreamEvent(
      sdkEvent({
        type: "response.completed",
        response: {
          id: "resp_done",
          status: "completed",
          usage: {
            input_tokens: 7,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens: 5,
            total_tokens: 12,
          },
        },
      }),
    );
    expect(mapped).toEqual([
      {
        type: "usage",
        usage: {
          cachedInputTokens: 2,
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
        },
      },
      { providerResponseId: "resp_done", type: "completed" },
    ]);
  });

  it("rejects failed, incomplete, and non-success completed events", () => {
    const events = [
      sdkEvent({
        type: "response.failed",
        response: { error: { code: "server_error" } },
      }),
      sdkEvent({ type: "response.incomplete", response: {} }),
      sdkEvent({
        type: "response.completed",
        response: { id: "resp_bad", status: "failed" },
      }),
    ];
    for (const event of events) {
      expect(mapOpenAIStreamEvent(event)[0]).toMatchObject({ type: "failed" });
    }
  });

  it("sends a stateless streaming request and preserves delta order", async () => {
    let factoryOptions: OpenAIStreamingSdkOptions | undefined;
    let body: OpenAIStreamingRequestBody | undefined;
    let forwardedSignal: AbortSignal | undefined;
    const factory: OpenAIStreamingSdkFactory = (options) => {
      factoryOptions = options;
      return {
        responses: {
          create: async (requestBody, requestOptions) => {
            body = requestBody;
            forwardedSignal = requestOptions.signal;
            return (async function* () {
              yield sdkEvent({
                type: "response.output_text.delta",
                delta: "one",
              });
              yield sdkEvent({
                type: "response.output_text.delta",
                delta: "two",
              });
              yield sdkEvent({
                type: "response.completed",
                response: { id: "resp_order", status: "completed" },
              });
            })();
          },
        },
      };
    };
    const client = new OpenAIStreamingChatClient(
      { apiKey: "test-key" },
      factory,
    );

    await expect(collect(client)).resolves.toEqual([
      { delta: "one", type: "text_delta" },
      { delta: "two", type: "text_delta" },
      { providerResponseId: "resp_order", type: "completed" },
    ]);
    expect(factoryOptions).toEqual({ apiKey: "test-key", maxRetries: 0 });
    expect(body).toEqual({
      input: request.prompt,
      instructions: request.instructions,
      model: request.model,
      store: false,
      stream: true,
    });
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "input",
      "instructions",
      "model",
      "store",
      "stream",
    ]);
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
  });

  it("supports Ollama base URL without sending store", async () => {
    let body: OpenAIStreamingRequestBody | undefined;
    let factoryOptions: OpenAIStreamingSdkOptions | undefined;
    const factory: OpenAIStreamingSdkFactory = (options) => {
      factoryOptions = options;
      return {
        responses: {
          create: async (requestBody) => {
            body = requestBody;
            return (async function* () {
              yield sdkEvent({
                type: "response.completed",
                response: { id: "resp_local", status: "completed" },
              });
            })();
          },
        },
      };
    };
    const client = new OpenAIStreamingChatClient(
      {
        apiKey: "ollama",
        baseURL: "http://localhost:11434/v1",
        includeStore: false,
        providerName: "Ollama",
      },
      factory,
    );

    await collect(client);
    expect(factoryOptions).toEqual({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      maxRetries: 0,
    });
    expect(body).not.toHaveProperty("store");
  });

  it("stops iteration after AbortSignal and does not emit a provider failure", async () => {
    const controller = new AbortController();
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({
              type: "response.output_text.delta",
              delta: "visible",
            });
            controller.abort();
            yield sdkEvent({
              type: "response.output_text.delta",
              delta: "hidden",
            });
          })(),
      },
    });
    const client = new OpenAIStreamingChatClient(
      { apiKey: "test-key" },
      factory,
    );
    const signals = [];
    for await (const signal of client.stream(request, controller.signal)) {
      signals.push(signal);
    }
    expect(signals).toEqual([{ delta: "visible", type: "text_delta" }]);
  });

  it("fails closed for an unknown runtime stream event", async () => {
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({
              type: "response.output_text.future_delta",
              delta: "must not be ignored",
            });
          })(),
      },
    });
    const client = new OpenAIStreamingChatClient(
      { apiKey: "test-key" },
      factory,
    );

    await expect(collect(client)).resolves.toEqual([
      {
        error: expect.objectContaining({ category: "protocol" }),
        type: "failed",
      },
    ]);
  });
});
