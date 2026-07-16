import { describe, expect, it } from "vitest";

import type {
  BackendIdentity,
  ModelTurnRequest,
} from "../../src/model/model-backend.js";
import type { ModelCapabilities } from "../../src/model/model-capabilities.js";
import type { ModelEvent } from "../../src/model/model-events.js";
import { PiModelBackend } from "../../src/providers/pi/pi-model-backend.js";
import {
  ProductionPiRuntimePort,
  type PiRuntimeDriver,
  type PiSdkAssistantMessage,
  type PiSdkAssistantMessageEvent,
  type PiSdkContext,
  type PiSdkModel,
  type PiSdkStreamOptions,
} from "../../src/providers/pi/production-pi-runtime-port.js";
import type {
  PiRuntimeEvent,
  PiRuntimePort,
  PiRuntimeRequest,
} from "../../src/providers/pi/pi-runtime-port.js";
import {
  assertNoForbiddenRemoteActivity,
  phase8NetworkActivityReport,
} from "../setup-network-tripwire.js";

const identity: BackendIdentity = {
  adapter: "pi-ai",
  adapterVersion: "0.80.7",
  configFingerprint: "a".repeat(64),
  model: "synthetic-tool-model",
  provider: "openai",
};

const completeCapabilities: ModelCapabilities = {
  cancellation: "abort_signal",
  reasoning: "opaque_passthrough",
  streaming: true,
  tools: "strict",
  usage: "complete",
};

const initialRequest: ModelTurnRequest = {
  input: { kind: "user_prompt", text: "inspect the fixture" },
  instructions: "use tools",
  timeoutMs: 1_000,
  tools: [
    {
      description: "Read a file",
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

const usage = {
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  inputTokens: 5,
  outputTokens: 2,
  totalTokens: 8,
} as const;

class FakePiRuntime implements PiRuntimePort {
  readonly calls: PiRuntimeRequest[] = [];
  readonly #turns: readonly (readonly PiRuntimeEvent[])[];

  get networkEvidence() {
    return phase8NetworkActivityReport();
  }

  constructor(...turns: readonly PiRuntimeEvent[][]) {
    this.#turns = turns;
  }

  async *runTurn(request: PiRuntimeRequest): AsyncIterable<PiRuntimeEvent> {
    this.calls.push(request);
    for (const event of this.#turns[this.calls.length - 1] ?? []) yield event;
  }
}

async function collect(
  backend: PiModelBackend,
  request: ModelTurnRequest = initialRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of backend.runTurn(request, signal)) events.push(event);
  return events;
}

function backend(
  runtime: PiRuntimePort,
  capabilities: ModelCapabilities = completeCapabilities,
  selectedIdentity: BackendIdentity = identity,
): PiModelBackend {
  return new PiModelBackend({ capabilities, identity: selectedIdentity, runtime });
}

describe("Phase 8 PiModelBackend", () => {
  it("maps text, multiple aggregated tool calls, one usage fact, and an opaque continuation", async () => {
    const runtimeContinuation = Object.freeze({ providerState: "opaque" });
    const runtime = new FakePiRuntime([
      { type: "start" },
      { delta: "checking ", type: "text_delta" },
      { delta: "fixture", type: "text_delta" },
      { callId: "call-a", contentIndex: 1, name: "read_file", type: "toolcall_start" },
      { argumentsDelta: '{"pa', contentIndex: 1, type: "toolcall_delta" },
      { argumentsDelta: 'th":"a.txt"}', contentIndex: 1, type: "toolcall_delta" },
      {
        arguments: { path: "a.txt" },
        callId: "call-a",
        contentIndex: 1,
        name: "read_file",
        type: "toolcall_end",
      },
      { callId: "call-b", contentIndex: 2, name: "read_file", type: "toolcall_start" },
      {
        arguments: { path: "b.txt" },
        callId: "call-b",
        contentIndex: 2,
        name: "read_file",
        type: "toolcall_end",
      },
      { type: "usage_snapshot", usage },
      {
        continuation: runtimeContinuation,
        providerRequestId: "req_contract_1",
        reason: "toolUse",
        type: "done",
        usage,
      },
    ]);

    const events = await collect(backend(runtime));
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { completeness: "complete", ...usage } },
    ]);
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      { argumentsDelta: '{"pa', callId: "call-a", name: "read_file", type: "tool_call_delta" },
      { argumentsDelta: 'th":"a.txt"}', callId: "call-a", name: "read_file", type: "tool_call_delta" },
      { argumentsDelta: '{"path":"b.txt"}', callId: "call-b", name: "read_file", type: "tool_call_delta" },
    ]);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      outcome: "tool_calls",
      providerRequestId: "req_contract_1",
      type: "turn_completed",
    });
    if (terminal?.type !== "turn_completed") throw new Error("missing terminal");
    expect(() => JSON.stringify(terminal.continuation)).toThrow(/opaque/u);

    const secondRuntime = new FakePiRuntime([
      { type: "start" },
      { delta: "done", type: "text_delta" },
      { continuation: Object.freeze({ turn: 2 }), reason: "stop", type: "done", usage },
    ]);
    const sameBackend = backend(secondRuntime);
    const crossBackend = await collect(sameBackend, {
      ...initialRequest,
      input: {
        callId: "call-a",
        continuation: terminal.continuation,
        kind: "tool_result",
        output: "A",
      },
    });
    expect(crossBackend).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "invalid_backend_continuation" }),
        type: "failed",
      }),
    ]);
    expect(secondRuntime.calls).toHaveLength(0);
  });

  it("passes the unwrapped continuation back only to the same runtime instance", async () => {
    const opaque = Object.freeze({ providerState: "same-instance" });
    const runtime = new FakePiRuntime(
      [
        { type: "start" },
        { callId: "call-a", contentIndex: 0, name: "read_file", type: "toolcall_start" },
        {
          arguments: { path: "a.txt" },
          callId: "call-a",
          contentIndex: 0,
          name: "read_file",
          type: "toolcall_end",
        },
        { continuation: opaque, reason: "toolUse", type: "done", usage },
      ],
      [
        { type: "start" },
        { delta: "finished", type: "text_delta" },
        { continuation: Object.freeze({ turn: 2 }), reason: "stop", type: "done", usage },
      ],
    );
    const selected = backend(runtime);
    const first = await collect(selected);
    const terminal = first.at(-1);
    if (terminal?.type !== "turn_completed") throw new Error("missing terminal");

    const second = await collect(selected, {
      ...initialRequest,
      input: {
        callId: "call-a",
        continuation: terminal.continuation,
        kind: "tool_result",
        output: "A",
      },
    });
    expect(second.at(-1)).toMatchObject({ outcome: "text", type: "turn_completed" });
    expect(runtime.calls[1]?.input).toEqual({
      callId: "call-a",
      continuation: opaque,
      kind: "tool_result",
      output: "A",
    });
  });

  it("preserves partial unknown usage as null and emits no usage for usage=none", async () => {
    const partialUsage = {
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputTokens: 3,
      outputTokens: null,
      totalTokens: null,
    } as const;
    const partial = await collect(
      backend(
        new FakePiRuntime([
          { type: "start" },
          { delta: "ok", type: "text_delta" },
          { continuation: {}, reason: "stop", type: "done", usage: partialUsage },
        ]),
        { ...completeCapabilities, usage: "partial" },
      ),
    );
    expect(partial).toContainEqual({
      type: "usage",
      usage: { completeness: "partial", ...partialUsage },
    });

    const none = await collect(
      backend(
        new FakePiRuntime([
          { type: "start" },
          { delta: "ok", type: "text_delta" },
          { continuation: {}, reason: "stop", type: "done", usage },
        ]),
        { ...completeCapabilities, usage: "none" },
      ),
    );
    expect(none.some((event) => event.type === "usage")).toBe(false);
    expect(none.at(-1)?.type).toBe("turn_completed");
  });

  it.each([
    ["missing_authoritative_usage", []],
    [
      "conflicting_usage_snapshots",
      [{ type: "usage_snapshot", usage: { ...usage, outputTokens: 3, totalTokens: 9 } }],
    ],
  ] as const)("fails closed for %s", async (code, extra) => {
    const runtime = new FakePiRuntime([
      { type: "start" },
      { delta: "ok", type: "text_delta" },
      ...extra,
      {
        continuation: {},
        reason: "stop",
        type: "done",
        ...(code === "missing_authoritative_usage" ? {} : { usage }),
      },
    ]);
    const events = await collect(backend(runtime));
    expect(events.at(-1)).toMatchObject({
      error: { category: "protocol", code },
      type: "failed",
    });
    expect(events.some((event) => event.type === "turn_completed")).toBe(false);
  });

  it.each([
    [401, "bad secret sentinel", "authentication"],
    [403, "forbidden", "permission"],
    [404, "missing", "model_not_found"],
    [408, "slow", "timeout"],
    [429, "slow down", "rate_limit"],
    [503, "socket failed", "network"],
  ] as const)("maps status %i to %s without exposing raw messages", async (status, raw, category) => {
    const events = await collect(
      backend(
        new FakePiRuntime([
          { type: "start" },
          { error: { message: raw, status }, reason: "error", type: "error" },
        ]),
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ category, status }),
        type: "failed",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(raw);
  });

  it("maps quota separately from rate limiting", async () => {
    const events = await collect(
      backend(
        new FakePiRuntime([
          { type: "start" },
          {
            error: { code: "insufficient_credits", message: "billing secret" },
            reason: "error",
            type: "error",
          },
        ]),
      ),
    );
    expect(events.at(-1)).toMatchObject({ error: { category: "quota" }, type: "failed" });
  });

  it("fails before calling the runtime when already aborted", async () => {
    const runtime = new FakePiRuntime([]);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(backend(runtime), initialRequest, controller.signal);
    expect(events).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ category: "cancelled" }), type: "failed" }),
    ]);
    expect(runtime.calls).toHaveLength(0);
  });

  it("verifies the Anthropic pi contract without exposing thinking or opening network", async () => {
    const anthropicIdentity: BackendIdentity = {
      ...identity,
      configFingerprint: "b".repeat(64),
      model: "claude-sonnet-5",
      provider: "anthropic",
    };
    const opaqueAnthropic = Object.freeze({
      assistantBlock: "provider-private",
      thinkingSignature: "anthropic-secret-signature",
    });
    const runtime = new FakePiRuntime(
      [
        { type: "start" },
        { type: "thinking_start" },
        { delta: "private chain of thought", type: "thinking_delta" },
        { type: "thinking_end" },
        {
          callId: "anthropic-call-1",
          contentIndex: 1,
          name: "read_file",
          type: "toolcall_start",
        },
        {
          argumentsDelta: '{"path":"fixture.txt"}',
          contentIndex: 1,
          type: "toolcall_delta",
        },
        {
          arguments: { path: "fixture.txt" },
          callId: "anthropic-call-1",
          contentIndex: 1,
          name: "read_file",
          type: "toolcall_end",
        },
        {
          continuation: opaqueAnthropic,
          providerRequestId: "msg_synthetic_anthropic",
          reason: "toolUse",
          type: "done",
          usage,
        },
      ],
      [
        { type: "start" },
        { type: "thinking_start" },
        { delta: "another private thought", type: "thinking_delta" },
        { type: "thinking_end" },
        { delta: "fixture explained", type: "text_delta" },
        {
          continuation: Object.freeze({ anthropicTurn: 2 }),
          reason: "stop",
          type: "done",
          usage,
        },
      ],
    );
    const selected = backend(
      runtime,
      { ...completeCapabilities, tools: "best_effort" },
      anthropicIdentity,
    );

    const first = await collect(selected);
    expect(first.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(first).toContainEqual({
      argumentsDelta: '{"path":"fixture.txt"}',
      callId: "anthropic-call-1",
      name: "read_file",
      type: "tool_call_delta",
    });
    expect(first.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { completeness: "complete", ...usage } },
    ]);
    expect(JSON.stringify(first.filter((event) => event.type !== "turn_completed"))).not.toMatch(
      /private chain|anthropic-secret/u,
    );
    const firstTerminal = first.at(-1);
    if (firstTerminal?.type !== "turn_completed") throw new Error("missing terminal");

    const second = await collect(selected, {
      ...initialRequest,
      input: {
        callId: "anthropic-call-1",
        continuation: firstTerminal.continuation,
        kind: "tool_result",
        output: "fixture contents",
      },
    });
    expect(second).toContainEqual({ text: "fixture explained", type: "text_delta" });
    expect(second.at(-1)).toMatchObject({ outcome: "text", type: "turn_completed" });
    expect(runtime.calls[1]?.input).toEqual({
      callId: "anthropic-call-1",
      continuation: opaqueAnthropic,
      kind: "tool_result",
      output: "fixture contents",
    });
    assertNoForbiddenRemoteActivity(runtime.networkEvidence);
  });

  it.each([
    [
      "anthropic",
      { message: "anthropic raw auth body", status: 401 },
      "error",
      "authentication",
    ],
    [
      "anthropic",
      { message: "aborted with provider-private state" },
      "aborted",
      "cancelled",
    ],
    ["ollama", { code: "ECONNREFUSED", message: "local socket" }, "error", "network"],
    ["ollama", { message: "request aborted" }, "aborted", "cancelled"],
  ] as const)(
    "maps %s synthetic error/cancellation through the production adapter contract",
    async (provider, error, reason, category) => {
      const runtime = new FakePiRuntime([
        { type: "start" },
        { error, reason, type: "error" },
      ]);
      const selectedIdentity: BackendIdentity = {
        ...identity,
        configFingerprint: provider === "anthropic" ? "c".repeat(64) : "d".repeat(64),
        model: provider === "anthropic" ? "claude-sonnet-5" : "qwen3:1.7b",
        provider,
      };
      const events = await collect(
        backend(
          runtime,
          {
            ...completeCapabilities,
            reasoning: provider === "ollama" ? "none" : "opaque_passthrough",
            tools: "best_effort",
          },
          selectedIdentity,
        ),
      );
      expect(events.at(-1)).toMatchObject({ error: { category }, type: "failed" });
      expect(JSON.stringify(events)).not.toContain(error.message);
      assertNoForbiddenRemoteActivity(runtime.networkEvidence);
    },
  );

  it("verifies the Ollama pi contract and tool continuation with zero remote counters", async () => {
    const ollamaIdentity: BackendIdentity = {
      ...identity,
      configFingerprint: "e".repeat(64),
      model: "qwen3:1.7b",
      provider: "ollama",
    };
    const opaqueOllama = Object.freeze({ localHistory: "turn-1" });
    const ollamaUsage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
    } as const;
    const runtime = new FakePiRuntime(
      [
        { type: "start" },
        { delta: "reading", type: "text_delta" },
        {
          callId: "ollama-call-1",
          contentIndex: 1,
          name: "read_file",
          type: "toolcall_start",
        },
        {
          argumentsDelta: '{"path":"local.txt"}',
          contentIndex: 1,
          type: "toolcall_delta",
        },
        {
          arguments: { path: "local.txt" },
          callId: "ollama-call-1",
          contentIndex: 1,
          name: "read_file",
          type: "toolcall_end",
        },
        {
          continuation: opaqueOllama,
          reason: "toolUse",
          type: "done",
          usage: ollamaUsage,
        },
      ],
      [
        { type: "start" },
        { delta: "local answer", type: "text_delta" },
        {
          continuation: Object.freeze({ localHistory: "turn-2" }),
          reason: "stop",
          type: "done",
          usage: ollamaUsage,
        },
      ],
    );
    const selected = backend(
      runtime,
      {
        ...completeCapabilities,
        reasoning: "none",
        tools: "best_effort",
      },
      ollamaIdentity,
    );
    const first = await collect(selected);
    expect(first).toContainEqual({
      type: "usage",
      usage: { completeness: "complete", ...ollamaUsage },
    });
    const terminal = first.at(-1);
    if (terminal?.type !== "turn_completed") throw new Error("missing terminal");
    const second = await collect(selected, {
      ...initialRequest,
      input: {
        callId: "ollama-call-1",
        continuation: terminal.continuation,
        kind: "tool_result",
        output: "local fixture",
      },
    });
    expect(second).toContainEqual({ text: "local answer", type: "text_delta" });
    expect(runtime.calls[1]?.input).toEqual({
      callId: "ollama-call-1",
      continuation: opaqueOllama,
      kind: "tool_result",
      output: "local fixture",
    });
    assertNoForbiddenRemoteActivity(runtime.networkEvidence);
  });

  it.each([
    ["stream_missing_terminal", [{ type: "start" }]],
    [
      "malformed_tool_arguments",
      [
        { type: "start" },
        { callId: "call-a", contentIndex: 0, name: "read_file", type: "toolcall_start" },
        { argumentsDelta: "{bad", contentIndex: 0, type: "toolcall_delta" },
        {
          arguments: { path: "a.txt" },
          callId: "call-a",
          contentIndex: 0,
          name: "read_file",
          type: "toolcall_end",
        },
      ],
    ],
    [
      "protocol_capability_mismatch",
      [
        { type: "start" },
        { callId: "call-a", contentIndex: 0, name: "read_file", type: "toolcall_start" },
        {
          arguments: { path: "a.txt" },
          callId: "call-a",
          contentIndex: 0,
          name: "read_file",
          type: "toolcall_end",
        },
        { continuation: {}, reason: "stop", type: "done", usage },
      ],
    ],
  ] as const)("rejects protocol drift: %s", async (code, rawEvents) => {
    const events = await collect(
      backend(new FakePiRuntime(rawEvents as unknown as PiRuntimeEvent[])),
    );
    expect(events.at(-1)).toMatchObject({ error: { code }, type: "failed" });
    expect(events.some((event) => event.type === "turn_completed")).toBe(false);
  });
});

describe("Phase 8 production pi runtime seam", () => {
  it("loads pi lazily and maps the pinned raw event contract without network", async () => {
    let loaderCalls = 0;
    let observedContext: PiSdkContext | undefined;
    let observedOptions: PiSdkStreamOptions | undefined;
    const message: PiSdkAssistantMessage = {
      api: "openai-responses",
      content: [{ text: "local synthetic", type: "text" }],
      model: identity.model,
      provider: identity.provider,
      responseId: "req_synthetic",
      role: "assistant",
      stopReason: "stop",
      timestamp: 1,
      usage: {
        cacheRead: 1,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 5,
        output: 2,
        totalTokens: 8,
      },
    };
    const model: PiSdkModel = {
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 1_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: identity.model,
      input: ["text"],
      maxTokens: 100,
      name: identity.model,
      provider: "openai",
      reasoning: false,
    };
    const driver: PiRuntimeDriver = {
      model,
      stream: async function* (
        context: PiSdkContext,
        options: PiSdkStreamOptions,
      ): AsyncIterable<PiSdkAssistantMessageEvent> {
        observedContext = context;
        observedOptions = options;
        yield { partial: { ...message, content: [] }, type: "start" };
        yield {
          contentIndex: 0,
          delta: "local synthetic",
          partial: message,
          type: "text_delta",
        };
        yield { message, reason: "stop", type: "done" };
      },
    };
    const port = new ProductionPiRuntimePort(
      {
        credential: "sentinel-never-in-env",
        model: identity.model,
        provider: "openai",
      },
      async () => {
        loaderCalls += 1;
        return driver;
      },
    );
    expect(loaderCalls).toBe(0);

    const events = await collect(backend(port));
    expect(loaderCalls).toBe(1);
    expect(events).toContainEqual({ text: "local synthetic", type: "text_delta" });
    expect(events.at(-1)).toMatchObject({ outcome: "text", type: "turn_completed" });
    expect(observedContext?.systemPrompt).toBe(initialRequest.instructions);
    expect(observedOptions).toMatchObject({
      apiKey: "sentinel-never-in-env",
      cacheRetention: "none",
      env: {},
      maxRetries: 0,
      timeoutMs: initialRequest.timeoutMs,
    });
  });
});
