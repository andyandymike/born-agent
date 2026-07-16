import { describe, expect, it } from "vitest";

import type { ChatClientError } from "../../src/chat/errors.js";
import {
  OpenAIChatClient,
  type OpenAISdkFactory,
  type OpenAISdkOptions,
} from "../../src/providers/openai/openai-chat-client.js";

const request = {
  instructions: "system instructions",
  model: "gpt-5.6-terra",
  prompt: "hello",
  timeoutMs: 12_345,
};

describe("OpenAIChatClient", () => {
  it("uses Responses API with stateless request and forwards AbortSignal", async () => {
    let factoryOptions: OpenAISdkOptions | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const factory: OpenAISdkFactory = (options) => {
      factoryOptions = options;
      return {
        responses: {
          create: async (body, requestOptions) => {
            capturedBody = body;
            capturedOptions = requestOptions;
            return {
              id: "resp_contract",
              model: request.model,
              output_text: "contract response",
              usage: {
                input_tokens: 4,
                output_tokens: 5,
                total_tokens: 9,
              },
            };
          },
        },
      };
    };
    const controller = new AbortController();
    const client = new OpenAIChatClient({ apiKey: "test-key" }, factory);
    const response = await client.complete(request, controller.signal);

    expect(factoryOptions).toEqual({ apiKey: "test-key", maxRetries: 0 });
    expect(capturedBody).toEqual({
      input: request.prompt,
      instructions: request.instructions,
      model: request.model,
      store: false,
    });
    expect(Object.keys(capturedBody ?? {}).sort()).toEqual([
      "input",
      "instructions",
      "model",
      "store",
    ]);
    expect(capturedOptions).toEqual({
      signal: controller.signal,
    });
    expect(response).toEqual({
      model: request.model,
      providerResponseId: "resp_contract",
      text: "contract response",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    });
  });

  it("configures an Ollama-compatible base URL without OpenAI store", async () => {
    let factoryOptions: OpenAISdkOptions | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const factory: OpenAISdkFactory = (options) => {
      factoryOptions = options;
      return {
        responses: {
          create: async (body) => {
            capturedBody = body;
            return {
              id: "resp_ollama",
              model: "qwen3:1.7b",
              output_text: "local response",
            };
          },
        },
      };
    };
    const client = new OpenAIChatClient(
      {
        apiKey: "ollama",
        baseURL: "http://localhost:11434/v1",
        includeStore: false,
      },
      factory,
    );

    await client.complete(
      { ...request, model: "qwen3:1.7b" },
      new AbortController().signal,
    );

    expect(factoryOptions).toEqual({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      maxRetries: 0,
    });
    expect(capturedBody).not.toHaveProperty("store");
  });

  it("rejects an empty successful SDK response as protocol error", async () => {
    const factory: OpenAISdkFactory = () => ({
      responses: {
        create: async () => ({
          id: "resp_empty",
          model: request.model,
          output_text: " ",
        }),
      },
    });
    const client = new OpenAIChatClient({ apiKey: "test-key" }, factory);
    await expect(
      client.complete(request, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "protocol" } satisfies Partial<ChatClientError>);
  });
});
