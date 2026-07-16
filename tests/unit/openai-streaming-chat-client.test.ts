import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import type {
  ModelContinuation,
  ModelTurnRequest,
  ModelTurnSignal,
} from "../../src/model/model-turn-types.js";
import {
  OpenAIStreamingChatClient,
  type OpenAIStreamingRequestBody,
  type OpenAIStreamingSdkFactory,
  type OpenAIStreamingSdkOptions,
} from "../../src/providers/openai/openai-streaming-chat-client.js";

const baseRequest: ModelTurnRequest = {
  input: { kind: "user_prompt", text: "hello" },
  instructions: "system instructions",
  model: "gpt-test",
  timeoutMs: 12_345,
  tools: [],
};

const tool = {
  description: "Read one file",
  name: "read_file",
  parameters: {
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
    type: "object",
  },
  strict: true as const,
};

function sdkEvent(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

async function collect(
  client: OpenAIStreamingChatClient,
  request: ModelTurnRequest = baseRequest,
  signal = new AbortController().signal,
): Promise<ModelTurnSignal[]> {
  const signals: ModelTurnSignal[] = [];
  for await (const item of client.streamTurn(request, signal)) {
    signals.push(item);
  }
  return signals;
}

function completedEvent(
  output: readonly unknown[] = [],
  id = "resp_done",
): ResponseStreamEvent {
  return sdkEvent({
    type: "response.completed",
    response: {
      id,
      output,
      status: "completed",
      usage: {
        input_tokens: 7,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 5,
        total_tokens: 12,
      },
    },
  });
}

describe("OpenAIStreamingChatClient model turns", () => {
  it("maps text, usage, response id, and an opaque continuation", async () => {
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({ type: "response.created", response: {} });
            yield sdkEvent({
              type: "response.output_text.delta",
              delta: "first",
            });
            yield completedEvent();
          })(),
      },
    });
    const signals = await collect(
      new OpenAIStreamingChatClient({ apiKey: "test-key" }, factory),
    );

    expect(signals.slice(0, 2)).toEqual([
      { delta: "first", type: "text_delta" },
      {
        type: "usage",
        usage: {
          cachedInputTokens: 2,
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
        },
      },
    ]);
    expect(signals[2]).toMatchObject({
      providerResponseId: "resp_done",
      type: "turn_completed",
    });
    expect(JSON.stringify((signals[2] as { continuation: ModelContinuation }).continuation)).toBe("{}");
  });

  it("maps one completed function call and verifies argument deltas", async () => {
    const call = {
      arguments: '{"path":"README.md"}',
      call_id: "call_1",
      id: "fc_1",
      name: "read_file",
      status: "completed",
      type: "function_call",
    };
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({
              delta: '{"path":"README.md"}',
              item_id: "fc_1",
              type: "response.function_call_arguments.delta",
            });
            yield sdkEvent({
              arguments: call.arguments,
              item_id: "fc_1",
              name: call.name,
              type: "response.function_call_arguments.done",
            });
            yield sdkEvent({
              item: call,
              type: "response.output_item.done",
            });
            yield completedEvent([call]);
          })(),
      },
    });

    const signals = await collect(
      new OpenAIStreamingChatClient({ apiKey: "test-key" }, factory),
      { ...baseRequest, tools: [tool] },
    );
    expect(signals[0]).toEqual({
      call: {
        argumentsJson: call.arguments,
        callId: "call_1",
        name: "read_file",
      },
      type: "tool_call",
    });
    expect(signals.at(-1)).toMatchObject({ type: "turn_completed" });
  });

  it("accepts Ollama's argument-done event without its redundant tool name", async () => {
    const call = {
      arguments: '{"query":"PROJECT_CODE"}',
      call_id: "call_ollama",
      id: "fc_ollama_0",
      name: "search",
      status: "completed",
      type: "function_call",
    };
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({
              delta: call.arguments,
              item_id: call.id,
              type: "response.function_call_arguments.delta",
            });
            yield sdkEvent({
              arguments: call.arguments,
              item_id: call.id,
              type: "response.function_call_arguments.done",
            });
            yield sdkEvent({
              item: call,
              type: "response.output_item.done",
            });
            yield completedEvent([call]);
          })(),
      },
    });

    const signals = await collect(
      new OpenAIStreamingChatClient(
        {
          apiKey: "ollama",
          includeEncryptedReasoning: false,
          includeStore: false,
          providerName: "Ollama",
        },
        factory,
      ),
      { ...baseRequest, tools: [tool] },
    );

    expect(signals[0]).toMatchObject({
      call: { callId: "call_ollama", name: "search" },
      type: "tool_call",
    });
    expect(signals.at(-1)).toMatchObject({ type: "turn_completed" });
  });

  it("fails closed for mismatched arguments and multiple calls", async () => {
    for (const events of [
      [
        sdkEvent({
          delta: "{}",
          item_id: "fc_1",
          type: "response.function_call_arguments.delta",
        }),
        sdkEvent({
          item: {
            arguments: '{"path":"README.md"}',
            call_id: "call_1",
            id: "fc_1",
            name: "read_file",
            type: "function_call",
          },
          type: "response.output_item.done",
        }),
      ],
      [
        sdkEvent({
          item: {
            arguments: "{}",
            call_id: "call_1",
            id: "fc_1",
            name: "read_file",
            type: "function_call",
          },
          type: "response.output_item.done",
        }),
        sdkEvent({
          item: {
            arguments: "{}",
            call_id: "call_2",
            id: "fc_2",
            name: "search",
            type: "function_call",
          },
          type: "response.output_item.done",
        }),
      ],
    ]) {
      const factory: OpenAIStreamingSdkFactory = () => ({
        responses: {
          create: async () =>
            (async function* () {
              yield* events;
            })(),
        },
      });
      await expect(
        collect(new OpenAIStreamingChatClient({ apiKey: "key" }, factory)),
      ).resolves.toContainEqual({
        error: expect.objectContaining({ category: "protocol" }),
        type: "failed",
      });
    }
  });

  it("sends strict stateless tools and preserves reasoning in tool continuation", async () => {
    const bodies: OpenAIStreamingRequestBody[] = [];
    let factoryOptions: OpenAIStreamingSdkOptions | undefined;
    const reasoning = {
      encrypted_content: "encrypted",
      id: "rs_1",
      summary: [],
      type: "reasoning",
    };
    const call = {
      arguments: '{"path":"README.md"}',
      call_id: "call_1",
      id: "fc_1",
      name: "read_file",
      status: "completed",
      type: "function_call",
    };
    let requestNumber = 0;
    const factory: OpenAIStreamingSdkFactory = (options) => {
      factoryOptions = options;
      return {
        responses: {
          create: async (body) => {
            bodies.push(body);
            requestNumber += 1;
            return (async function* () {
              if (requestNumber === 1) {
                yield completedEvent([reasoning, call], "resp_tool");
              } else {
                yield completedEvent([], "resp_final");
              }
            })();
          },
        },
      };
    };
    const client = new OpenAIStreamingChatClient(
      { apiKey: "test-key" },
      factory,
    );
    const first = await collect(client, { ...baseRequest, tools: [tool] });
    const continuation = (
      first.find((signal) => signal.type === "turn_completed") as Extract<
        ModelTurnSignal,
        { type: "turn_completed" }
      >
    ).continuation;
    await collect(client, {
      ...baseRequest,
      input: {
        callId: "call_1",
        continuation,
        kind: "tool_result",
        output: '{"ok":true}',
      },
    });

    expect(factoryOptions).toEqual({ apiKey: "test-key", maxRetries: 0 });
    expect(bodies[0]).toMatchObject({
      include: ["reasoning.encrypted_content"],
      input: "hello",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters,
          strict: true,
          type: "function",
        },
      ],
    });
    expect(bodies[1]).not.toHaveProperty("tools");
    expect(bodies[1]?.input).toEqual([
      { content: "hello", role: "user", type: "message" },
      reasoning,
      call,
      {
        call_id: "call_1",
        output: '{"ok":true}',
        type: "function_call_output",
      },
    ]);
  });

  it("supports Ollama without OpenAI-only store or encrypted reasoning fields", async () => {
    let body: OpenAIStreamingRequestBody | undefined;
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async (requestBody) => {
          body = requestBody;
          return (async function* () {
            yield completedEvent();
          })();
        },
      },
    });
    const client = new OpenAIStreamingChatClient(
      {
        apiKey: "ollama",
        baseURL: "http://localhost:11434/v1",
        includeEncryptedReasoning: false,
        includeStore: false,
        providerName: "Ollama",
      },
      factory,
    );
    await collect(client, { ...baseRequest, tools: [tool] });
    expect(body).not.toHaveProperty("store");
    expect(body).not.toHaveProperty("include");
    expect(body).toMatchObject({ parallel_tool_calls: false, tools: [expect.any(Object)] });
  });

  it("stops after abort and fails closed for unknown runtime events", async () => {
    const controller = new AbortController();
    const abortFactory: OpenAIStreamingSdkFactory = () => ({
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
    await expect(
      collect(
        new OpenAIStreamingChatClient({ apiKey: "key" }, abortFactory),
        baseRequest,
        controller.signal,
      ),
    ).resolves.toEqual([{ delta: "visible", type: "text_delta" }]);

    const unknownFactory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () =>
          (async function* () {
            yield sdkEvent({ type: "response.output_text.future_delta" });
          })(),
      },
    });
    await expect(
      collect(new OpenAIStreamingChatClient({ apiKey: "key" }, unknownFactory)),
    ).resolves.toEqual([
      {
        error: expect.objectContaining({ category: "protocol" }),
        type: "failed",
      },
    ]);
  });
});
