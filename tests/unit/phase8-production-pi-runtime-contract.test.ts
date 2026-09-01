import { describe, expect, it } from "vitest";

import type {
  BackendIdentity,
  ModelTurnRequest,
  ProviderId,
} from "../../src/model/model-backend.js";
import type { ModelCapabilities } from "../../src/model/model-capabilities.js";
import type { ModelEvent } from "../../src/model/model-events.js";
import { PiModelBackend } from "../../src/providers/pi/pi-model-backend.js";
import {
  loadProductionPiRuntimeDriver,
  ProductionPiRuntimePort,
  type PiRuntimeDriver,
  type PiSdkAssistantMessage,
  type PiSdkAssistantMessageEvent,
  type PiSdkContext,
  type PiSdkDiagnostic,
  type PiSdkModel,
  type PiSdkStreamOptions,
  type PiSdkToolCall,
} from "../../src/providers/pi/production-pi-runtime-port.js";
import type { NetworkGuardReport } from "../../src/providers/pi/provider-network-guard.js";
import type { PiRuntimeRequest } from "../../src/providers/pi/pi-runtime-port.js";
import {
  assertNoForbiddenRemoteActivity,
  phase8NetworkActivityReport,
} from "../setup-network-tripwire.js";

type ProviderCase = {
  readonly api: string;
  readonly fingerprintCharacter: string;
  readonly model: string;
  readonly provider: ProviderId;
  readonly reasoning: ModelCapabilities["reasoning"];
  readonly tools: ModelCapabilities["tools"];
};

const PROVIDERS = [
  {
    api: "openai-responses",
    fingerprintCharacter: "1",
    model: "gpt-5.6-terra",
    provider: "openai",
    reasoning: "opaque_passthrough",
    tools: "strict",
  },
  {
    api: "anthropic-messages",
    fingerprintCharacter: "2",
    model: "claude-sonnet-5",
    provider: "anthropic",
    reasoning: "opaque_passthrough",
    tools: "best_effort",
  },
  {
    api: "openai-completions",
    fingerprintCharacter: "4",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    reasoning: "opaque_passthrough",
    tools: "best_effort",
  },
  {
    api: "openai-completions",
    fingerprintCharacter: "3",
    model: "qwen3:1.7b",
    provider: "ollama",
    reasoning: "none",
    tools: "best_effort",
  },
] as const satisfies readonly ProviderCase[];

const request: ModelTurnRequest = {
  input: { kind: "user_prompt", text: "inspect the local fixture" },
  instructions: "use the provided tool",
  timeoutMs: 2_000,
  tools: [
    {
      description: "Read a fixture",
      name: "read_file",
      parameters: {
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      strict: true,
    },
  ],
};

const completeUsage = {
  cacheRead: 2,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 7,
  output: 3,
  totalTokens: 12,
} as const;

const zeroUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

function identityFor(entry: ProviderCase): BackendIdentity {
  return {
    adapter: "pi-ai",
    adapterVersion: "0.80.7",
    configFingerprint: entry.fingerprintCharacter.repeat(64),
    model: entry.model,
    provider: entry.provider,
  };
}

function capabilitiesFor(entry: ProviderCase): ModelCapabilities {
  return {
    cancellation: "abort_signal",
    reasoning: entry.reasoning,
    streaming: true,
    tools: entry.tools,
    usage: "complete",
  };
}

function modelFor(entry: ProviderCase): PiSdkModel {
  return {
    api: entry.api,
    baseUrl:
      entry.provider === "ollama"
        ? "http://127.0.0.1:11434/v1"
        : `https://${entry.provider}.example.invalid`,
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: entry.model,
    input: ["text"],
    maxTokens: 8_192,
    name: entry.model,
    provider: entry.provider,
    reasoning: entry.reasoning === "opaque_passthrough",
  };
}

function assistant(
  entry: ProviderCase,
  input: {
    readonly content: PiSdkAssistantMessage["content"];
    readonly diagnostics?: readonly PiSdkDiagnostic[];
    readonly errorMessage?: string;
    readonly responseId?: string;
    readonly stopReason: PiSdkAssistantMessage["stopReason"];
    readonly usage?: PiSdkAssistantMessage["usage"];
  },
): PiSdkAssistantMessage {
  return {
    api: entry.api,
    content: input.content,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    model: entry.model,
    provider: entry.provider,
    ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
    role: "assistant",
    stopReason: input.stopReason,
    timestamp: 1,
    usage: input.usage ?? zeroUsage,
  };
}

type RawTurn = (
  context: PiSdkContext,
  options: PiSdkStreamOptions,
) => readonly PiSdkAssistantMessageEvent[];

function productionHarness(entry: ProviderCase, turns: readonly RawTurn[]): {
  readonly backend: PiModelBackend;
  readonly contexts: PiSdkContext[];
  readonly loaderCalls: () => number;
  readonly networkEvidence: NetworkGuardReport;
  readonly options: PiSdkStreamOptions[];
} {
  const contexts: PiSdkContext[] = [];
  const streamOptions: PiSdkStreamOptions[] = [];
  let loaderCalls = 0;
  let turnIndex = 0;
  const driver: PiRuntimeDriver = {
    model: modelFor(entry),
    stream: async function* (context, options) {
      contexts.push(context);
      streamOptions.push(options);
      const turn = turns[turnIndex];
      turnIndex += 1;
      if (turn === undefined) throw new Error("unexpected synthetic driver turn");
      for (const event of turn(context, options)) yield event;
    },
  };
  const runtime = new ProductionPiRuntimePort(
    {
      ...(entry.provider === "ollama"
        ? { baseUrl: "http://127.0.0.1:11434" }
        : { credential: `contract-sentinel-${entry.provider}` }),
      model: entry.model,
      provider: entry.provider,
    },
    async () => {
      loaderCalls += 1;
      return driver;
    },
  );
  return {
    backend: new PiModelBackend({
      capabilities: capabilitiesFor(entry),
      identity: identityFor(entry),
      runtime,
    }),
    contexts,
    loaderCalls: () => loaderCalls,
    get networkEvidence() {
      return phase8NetworkActivityReport();
    },
    options: streamOptions,
  };
}

async function collect(
  backend: PiModelBackend,
  turnRequest: ModelTurnRequest = request,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of backend.runTurn(
    turnRequest,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

function runtimeRequestFor(
  provider: ProviderId,
  model: string,
): PiRuntimeRequest {
  return {
    identity: {
      adapter: "pi-ai",
      adapterVersion: "0.80.7",
      configFingerprint: "a".repeat(64),
      model,
      provider,
    },
    input: { kind: "user_prompt", text: "provider loader contract" },
    instructions: "return without transport",
    timeoutMs: 2_000,
    tools: [],
  };
}

describe("Phase 8 production Pi provider loader", () => {
  it("binds DeepSeek max_tokens compatibility before payload creation", async () => {
    const driver = await loadProductionPiRuntimeDriver({
      baseUrl: "https://api.deepseek.com",
      credential: "deepseek-payload-contract-sentinel",
      maximumOutputTokens: 256,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
    let capturedPayload: unknown;
    const events: PiSdkAssistantMessageEvent[] = [];
    for await (const event of driver.stream(
      {
        messages: [
          {
            content: "use the fixture tool",
            role: "user",
            timestamp: 1,
          },
        ],
        tools: [
          {
            description: "Read a fixture",
            name: "read_file",
            parameters: {
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            },
          },
        ],
      },
      {
        apiKey: "deepseek-payload-contract-sentinel",
        cacheRetention: "none",
        env: {},
        maxRetries: 0,
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("payload captured before transport");
        },
        reasoning: "off",
        signal: new AbortController().signal,
        temperature: 0,
        timeoutMs: 2_000,
        toolChoice: "auto",
      },
    )) {
      events.push(event);
    }

    expect(driver.model).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      compat: { maxTokensField: "max_tokens" },
      id: "deepseek-v4-flash",
      maxTokens: 256,
      provider: "deepseek",
    });
    expect(capturedPayload).toMatchObject({
      max_tokens: 256,
      temperature: 0,
      tool_choice: "auto",
    });
    expect(capturedPayload).not.toHaveProperty("max_completion_tokens");
    expect(events.at(-1)).toMatchObject({
      reason: "error",
      type: "error",
    });
    assertNoForbiddenRemoteActivity();
  });

  it("omits tool_choice and tools from the actual DeepSeek text-only payload", async () => {
    const driver = await loadProductionPiRuntimeDriver({
      baseUrl: "https://api.deepseek.com",
      credential: "deepseek-text-payload-contract-sentinel",
      maximumOutputTokens: 256,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
    let capturedPayload: unknown;
    for await (const _event of driver.stream(
      {
        messages: [{ content: "return strict JSON", role: "user", timestamp: 1 }],
      },
      {
        apiKey: "deepseek-text-payload-contract-sentinel",
        cacheRetention: "none",
        env: {},
        maxRetries: 0,
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("payload captured before transport");
        },
        reasoning: "off",
        signal: new AbortController().signal,
        temperature: 0,
        timeoutMs: 2_000,
      },
    )) {
      void _event;
    }

    expect(capturedPayload).toMatchObject({ max_tokens: 256, temperature: 0 });
    expect(capturedPayload).not.toHaveProperty("tool_choice");
    expect(capturedPayload).not.toHaveProperty("tools");
    assertNoForbiddenRemoteActivity();
  });

  it("loads the explicit DeepSeek provider/model before an aborted send", async () => {
    const runtime = new ProductionPiRuntimePort({
      baseUrl: "https://api.deepseek.com",
      credential: "deepseek-loader-contract-sentinel",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
    const controller = new AbortController();
    const iterator = runtime.runTurn(
      runtimeRequestFor("deepseek", "deepseek-v4-flash"),
      controller.signal,
    )[Symbol.asyncIterator]();
    const first = iterator.next();
    queueMicrotask(() => controller.abort());

    await expect(first).resolves.toMatchObject({
      done: false,
      value: {
        error: { code: "request_cancelled" },
        reason: "aborted",
        type: "error",
      },
    });
    assertNoForbiddenRemoteActivity();
  });

  it("rejects an unknown remote provider instead of falling through to Anthropic", async () => {
    const unknown = "unregistered" as ProviderId;
    const runtime = new ProductionPiRuntimePort({
      credential: "unknown-provider-contract-sentinel",
      model: "unknown-model",
      provider: unknown,
    });
    const iterator = runtime.runTurn(
      runtimeRequestFor(unknown, "unknown-model"),
      new AbortController().signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrowError(
      "unsupported remote pi provider",
    );
    assertNoForbiddenRemoteActivity();
  });
});

describe.each(PROVIDERS)(
  "Phase 8 production Pi runtime contract: $provider",
  (entry) => {
    it("maps raw tool chunks, opaque thinking, usage, and tool-result continuation", async () => {
      const privateThought = `${entry.provider}-private-chain-of-thought`;
      const privateSignature = `${entry.provider}-private-signature`;
      const toolCall: PiSdkToolCall = {
        arguments: { path: "fixture.txt" },
        id: `${entry.provider}-call-1`,
        name: "read_file",
        type: "toolCall",
      };
      const toolMessage = assistant(entry, {
        content: [
          {
            thinking: privateThought,
            thinkingSignature: privateSignature,
            type: "thinking",
          },
          toolCall,
        ],
        responseId: `${entry.provider}_raw_response_1`,
        stopReason: "toolUse",
        usage: completeUsage,
      });
      const textMessage = assistant(entry, {
        content: [{ text: `${entry.provider} final`, type: "text" }],
        responseId: `${entry.provider}_raw_response_2`,
        stopReason: "stop",
        usage: completeUsage,
      });
      const harness = productionHarness(entry, [
        () => [
          { partial: assistant(entry, { content: [], stopReason: "stop" }), type: "start" },
          { contentIndex: 0, partial: toolMessage, type: "thinking_start" },
          {
            contentIndex: 0,
            delta: privateThought,
            partial: toolMessage,
            type: "thinking_delta",
          },
          { content: privateThought, contentIndex: 0, partial: toolMessage, type: "thinking_end" },
          { contentIndex: 1, partial: toolMessage, type: "toolcall_start" },
          {
            contentIndex: 1,
            delta: '{"path":',
            partial: toolMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 1,
            delta: '"fixture.txt"}',
            partial: toolMessage,
            type: "toolcall_delta",
          },
          {
            contentIndex: 1,
            partial: toolMessage,
            toolCall,
            type: "toolcall_end",
          },
          { message: toolMessage, reason: "toolUse", type: "done" },
        ],
        (context) => {
          expect(context.messages.at(-1)).toMatchObject({
            content: [{ text: "fixture contents", type: "text" }],
            isError: false,
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          expect(context.messages.at(-2)).toBe(toolMessage);
          return [
            { partial: assistant(entry, { content: [], stopReason: "stop" }), type: "start" },
            { contentIndex: 0, partial: textMessage, type: "text_start" },
            {
              contentIndex: 0,
              delta: `${entry.provider} final`,
              partial: textMessage,
              type: "text_delta",
            },
            {
              content: `${entry.provider} final`,
              contentIndex: 0,
              partial: textMessage,
              type: "text_end",
            },
            { message: textMessage, reason: "stop", type: "done" },
          ];
        },
      ]);
      expect(harness.loaderCalls()).toBe(0);

      const first = await collect(harness.backend);
      expect(harness.loaderCalls()).toBe(1);
      expect(first.filter((event) => event.type === "text_delta")).toEqual([]);
      expect(first.filter((event) => event.type === "tool_call_delta")).toEqual([
        {
          argumentsDelta: '{"path":',
          callId: toolCall.id,
          name: toolCall.name,
          type: "tool_call_delta",
        },
        {
          argumentsDelta: '"fixture.txt"}',
          callId: toolCall.id,
          name: toolCall.name,
          type: "tool_call_delta",
        },
      ]);
      expect(first.filter((event) => event.type === "usage")).toEqual([
        {
          type: "usage",
          usage: {
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
            completeness: "complete",
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 12,
          },
        },
      ]);
      const firstTerminal = first.at(-1);
      if (firstTerminal?.type !== "turn_completed") {
        throw new Error("missing first terminal");
      }
      expect(firstTerminal).toMatchObject({
        outcome: "tool_calls",
        providerRequestId: `${entry.provider}_raw_response_1`,
      });
      expect(
        JSON.stringify(first.filter((event) => event.type !== "turn_completed")),
      ).not.toMatch(/private-chain-of-thought|private-signature/u);
      expect(() => JSON.stringify(firstTerminal.continuation)).toThrow(/opaque/u);

      const second = await collect(harness.backend, {
        ...request,
        input: {
          callId: toolCall.id,
          continuation: firstTerminal.continuation,
          kind: "tool_result",
          output: "fixture contents",
        },
      });
      expect(second).toContainEqual({
        text: `${entry.provider} final`,
        type: "text_delta",
      });
      expect(second.at(-1)).toMatchObject({ outcome: "text", type: "turn_completed" });
      expect(harness.contexts).toHaveLength(2);
      expect(harness.options).toHaveLength(2);
      expect(harness.options[0]).toMatchObject({
        apiKey:
          entry.provider === "ollama"
            ? "ollama-local-no-credential"
            : `contract-sentinel-${entry.provider}`,
        cacheRetention: "none",
        env: {},
        maxRetries: 0,
      });
      if (entry.provider === "deepseek") {
        expect(harness.options[0]).toMatchObject({
          reasoning: "off",
          temperature: 0,
          toolChoice: "auto",
        });
      } else {
        expect(harness.options[0]).not.toHaveProperty("reasoning");
        expect(harness.options[0]).not.toHaveProperty("temperature");
        expect(harness.options[0]).not.toHaveProperty("toolChoice");
      }
      assertNoForbiddenRemoteActivity(harness.networkEvidence);
    });

    it("maps raw error diagnostics without leaking messages and handles cancellation", async () => {
      const diagnostic: PiSdkDiagnostic | undefined =
        entry.provider === "anthropic"
          ? {
              details: { requestId: "msg_diag_anthropic", status: 429 },
              error: {
                code: "rate_limit_error",
                message: "anthropic raw diagnostic secret",
                name: "APIError",
              },
              timestamp: 1,
              type: "provider_failure",
            }
          : undefined;
      const failure = assistant(entry, {
        content: [],
        ...(diagnostic === undefined ? {} : { diagnostics: [diagnostic] }),
        errorMessage:
          entry.provider === "openai"
            ? "401 invalid_api_key openai-raw-secret"
            : entry.provider === "deepseek"
              ? "401 invalid_api_key deepseek-raw-secret"
            : entry.provider === "anthropic"
              ? "Anthropic API error (429): anthropic-raw-secret"
              : "ECONNREFUSED ollama-raw-secret",
        ...(entry.provider === "anthropic"
          ? {}
          : { responseId: `${entry.provider}_error_request` }),
        stopReason: "error",
      });
      const errorHarness = productionHarness(entry, [
        () => [{ error: failure, reason: "error", type: "error" }],
      ]);
      const failed = await collect(errorHarness.backend);
      expect(failed).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({
            category:
              entry.provider === "openai" || entry.provider === "deepseek"
                ? "authentication"
                : entry.provider === "anthropic"
                  ? "rate_limit"
                  : "network",
            code:
              entry.provider === "openai" || entry.provider === "deepseek"
                ? "provider_authentication"
                : entry.provider === "anthropic"
                  ? "provider_rate_limit"
                  : "provider_network",
            providerRequestId:
              entry.provider === "anthropic"
                ? "msg_diag_anthropic"
                : `${entry.provider}_error_request`,
            ...(entry.provider === "openai" || entry.provider === "deepseek"
              ? { status: 401 }
              : entry.provider === "anthropic"
                ? { status: 429 }
                : {}),
          }),
          type: "failed",
        }),
      ]);
      expect(JSON.stringify(failed)).not.toMatch(/raw-secret|diagnostic secret/u);
      assertNoForbiddenRemoteActivity(errorHarness.networkEvidence);

      const cancelledMessage = assistant(entry, {
        content: [],
        errorMessage: `${entry.provider} abort raw-secret`,
        responseId: `${entry.provider}_cancel_request`,
        stopReason: "aborted",
      });
      const cancelHarness = productionHarness(entry, [
        () => [
          { error: cancelledMessage, reason: "aborted", type: "error" },
        ],
      ]);
      const cancelled = await collect(cancelHarness.backend);
      expect(cancelled).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({
            category: "cancelled",
            code: "request_cancelled",
            providerRequestId: `${entry.provider}_cancel_request`,
          }),
          type: "failed",
        }),
      ]);
      expect(JSON.stringify(cancelled)).not.toContain("abort raw-secret");
      assertNoForbiddenRemoteActivity(cancelHarness.networkEvidence);
    });
  },
);

describe("Phase 8 production Pi single-tool Host bridge", () => {
  it("omits DeepSeek tool choice when a text-only request exposes no tools", async () => {
    const entry = PROVIDERS[2];
    const textMessage = assistant(entry, {
      content: [{ text: "direct text result", type: "text" }],
      responseId: "deepseek_text_only_response",
      stopReason: "stop",
      usage: completeUsage,
    });
    const harness = productionHarness(entry, [
      () => [
        { partial: assistant(entry, { content: [], stopReason: "stop" }), type: "start" },
        { contentIndex: 0, partial: textMessage, type: "text_start" },
        {
          contentIndex: 0,
          delta: "direct text result",
          partial: textMessage,
          type: "text_delta",
        },
        {
          content: "direct text result",
          contentIndex: 0,
          partial: textMessage,
          type: "text_end",
        },
        { message: textMessage, reason: "stop", type: "done" },
      ],
    ]);

    await collect(harness.backend, { ...request, tools: [] });

    expect(harness.contexts[0]).not.toHaveProperty("tools");
    expect(harness.options[0]).toMatchObject({ reasoning: "off", temperature: 0 });
    expect(harness.options[0]).not.toHaveProperty("toolChoice");
    assertNoForbiddenRemoteActivity(harness.networkEvidence);
  });

  it("retains only the first streamed call and removes later calls from continuation history", async () => {
    const entry = PROVIDERS[2];
    const firstCall: PiSdkToolCall = {
      arguments: { path: "first.txt" },
      id: "deepseek-parallel-call-1",
      name: "read_file",
      type: "toolCall",
    };
    const secondCall: PiSdkToolCall = {
      arguments: { path: "second.txt" },
      id: "deepseek-parallel-call-2",
      name: "read_file",
      type: "toolCall",
    };
    const parallelMessage = assistant(entry, {
      content: [firstCall, secondCall],
      responseId: "deepseek_parallel_response",
      stopReason: "toolUse",
      usage: completeUsage,
    });
    const finalMessage = assistant(entry, {
      content: [{ text: "serialized continuation", type: "text" }],
      responseId: "deepseek_serialized_response",
      stopReason: "stop",
      usage: completeUsage,
    });
    const harness = productionHarness(entry, [
      () => [
        {
          partial: assistant(entry, { content: [], stopReason: "stop" }),
          type: "start",
        },
        { contentIndex: 0, partial: parallelMessage, type: "toolcall_start" },
        {
          contentIndex: 0,
          delta: '{"path":"first.txt"}',
          partial: parallelMessage,
          type: "toolcall_delta",
        },
        {
          contentIndex: 0,
          partial: parallelMessage,
          toolCall: firstCall,
          type: "toolcall_end",
        },
        { contentIndex: 1, partial: parallelMessage, type: "toolcall_start" },
        {
          contentIndex: 1,
          delta: '{"path":"second.txt"}',
          partial: parallelMessage,
          type: "toolcall_delta",
        },
        {
          contentIndex: 1,
          partial: parallelMessage,
          toolCall: secondCall,
          type: "toolcall_end",
        },
        { message: parallelMessage, reason: "toolUse", type: "done" },
      ],
      (context) => {
        const retainedAssistant = context.messages.at(-2);
        expect(retainedAssistant).not.toBe(parallelMessage);
        expect(retainedAssistant).toMatchObject({
          content: [firstCall],
          role: "assistant",
        });
        expect(JSON.stringify(context.messages)).not.toContain(secondCall.id);
        expect(context.messages.at(-1)).toMatchObject({
          role: "toolResult",
          toolCallId: firstCall.id,
          toolName: firstCall.name,
        });
        return [
          {
            partial: assistant(entry, { content: [], stopReason: "stop" }),
            type: "start",
          },
          { contentIndex: 0, partial: finalMessage, type: "text_start" },
          {
            contentIndex: 0,
            delta: "serialized continuation",
            partial: finalMessage,
            type: "text_delta",
          },
          {
            content: "serialized continuation",
            contentIndex: 0,
            partial: finalMessage,
            type: "text_end",
          },
          { message: finalMessage, reason: "stop", type: "done" },
        ];
      },
    ]);

    const first = await collect(harness.backend);
    expect(first.filter((event) => event.type === "tool_call_delta")).toEqual([
      {
        argumentsDelta: '{"path":"first.txt"}',
        callId: firstCall.id,
        name: firstCall.name,
        type: "tool_call_delta",
      },
    ]);
    const terminal = first.at(-1);
    if (terminal?.type !== "turn_completed") {
      throw new Error("missing serialized first terminal");
    }

    const second = await collect(harness.backend, {
      ...request,
      input: {
        callId: firstCall.id,
        continuation: terminal.continuation,
        kind: "tool_result",
        output: "first fixture contents",
      },
    });
    expect(second).toContainEqual({
      text: "serialized continuation",
      type: "text_delta",
    });
    expect(harness.contexts).toHaveLength(2);
    assertNoForbiddenRemoteActivity(harness.networkEvidence);
  });
});
