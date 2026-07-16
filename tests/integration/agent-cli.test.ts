import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { RunEvent } from "../../src/events/run-event.js";
import type {
  ModelTurnRequest,
  ModelTurnSignal,
} from "../../src/model/model-turn-types.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";
import type {
  ToolExecution,
  ToolInvocation,
  ToolRegistryLike,
} from "../../src/tools/tool-types.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  InMemorySessionWriter,
} from "../helpers.js";

const definitions = ["apply_patch", "list_files", "read_file", "search"].map((name) => ({
  description: `fake ${name}`,
  name,
  parameters: {
    additionalProperties: false,
    properties: {},
    required: [],
    type: "object",
  },
  strict: true as const,
}));

class RecordingRegistry implements ToolRegistryLike {
  readonly calls: ToolInvocation[] = [];
  readonly modelDefinitions = definitions;

  constructor(
    private readonly result: (
      invocation: ToolInvocation,
      callIndex: number,
      signal: AbortSignal,
    ) => ToolExecution = () => ({
      ok: true,
      output: '{"ok":true,"content":"fixture evidence"}',
      truncated: false,
    }),
  ) {}

  async execute(
    invocation: ToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    this.calls.push(invocation);
    return this.result(invocation, this.calls.length - 1, signal);
  }
}

function toolTurn(
  name: string,
  callId: string,
  argumentsJson = "{}",
  totalTokens = 5,
): readonly ModelTurnSignal[] {
  return [
    {
      call: { argumentsJson, callId, name },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: {
        inputTokens: totalTokens - 1,
        outputTokens: 1,
        totalTokens,
      },
    },
    {
      continuation: new FakeContinuation(callId),
      providerResponseId: `resp_${callId}`,
      type: "turn_completed",
    },
  ];
}

function finalTurn(
  text = "Evidence-based final answer.",
  totalTokens = 5,
): readonly ModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    {
      type: "usage",
      usage: {
        inputTokens: totalTokens - 1,
        outputTokens: 1,
        totalTokens,
      },
    },
    {
      continuation: new FakeContinuation("final"),
      providerResponseId: "resp_final",
      type: "turn_completed",
    },
  ];
}

function scriptedClient(
  turns: readonly (readonly ModelTurnSignal[])[],
  inspect?: (request: ModelTurnRequest, index: number) => void,
): FakeStreamingChatClient {
  let index = 0;
  return new FakeStreamingChatClient(async function* (request) {
    const current = index++;
    inspect?.(request, current);
    const signals = turns[current];
    if (signals === undefined) throw new Error("unexpected model turn");
    yield* signals;
  });
}

async function runAgentScenario(options: {
  readonly args?: readonly string[];
  readonly client: FakeStreamingChatClient;
  readonly registry?: RecordingRegistry;
  readonly runtime?: Parameters<typeof createRuntime>[0];
  readonly writer?: InMemorySessionWriter;
}) {
  const memory = createMemoryIO();
  const writer = options.writer ?? new InMemorySessionWriter();
  const registry = options.registry ?? new RecordingRegistry();
  const exitCode = await runCli(
    ["agent", "inspect the fixture", ...(options.args ?? [])],
    memory.io,
    createRuntime({
      createModelTurnClient: () => options.client,
      createSessionWriter: async () => writer,
      createAgentToolRegistry: async () => registry,
      ...options.runtime,
    }),
  );
  return { exitCode, memory, registry, writer };
}

describe("born agent Phase 4 integration", () => {
  it("rejects invalid budgets before creating a session", async () => {
    const createSessionWriter = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["agent", "inspect", "--max-steps", "0"],
      memory.io,
      createRuntime({ createSessionWriter }),
    );
    expect(exitCode).toBe(2);
    expect(createSessionWriter).not.toHaveBeenCalled();
    expect(memory.readStderr()).toContain("usage/config error");
  });

  it("runs multiple tool steps, persists observations first, and completes", async () => {
    const writer = new InMemorySessionWriter();
    const registry = new RecordingRegistry((invocation) => ({
      ok: true,
      output: JSON.stringify({ evidence: invocation.name, ok: true }),
      truncated: false,
    }));
    const client = scriptedClient(
      [
        toolTurn("search", "call_search", '{"query":"DEFAULT"}'),
        toolTurn("read_file", "call_read", '{"path":"src/config.ts"}'),
        finalTurn("Defaults flow from config.ts through loader.ts to output.ts."),
      ],
      (request, index) => {
        expect(request.tools.map((tool) => tool.name)).toEqual([
          "apply_patch",
          "list_files",
          "read_file",
          "search",
        ]);
        if (index > 0) {
          expect(request.input.kind).toBe("tool_result");
          expect(writer.events.map((event) => event.type)).toContain(
            "tool.call.completed",
          );
        }
      },
    );

    const result = await runAgentScenario({
      args: ["--verbose"],
      client,
      registry,
      writer,
    });

    expect(
      result.exitCode,
      `${result.memory.readStderr()}\n${JSON.stringify(writer.events)}`,
    ).toBe(0);
    expect(client.calls).toHaveLength(3);
    expect(registry.calls.map((call) => call.name)).toEqual([
      "search",
      "read_file",
    ]);
    expect(result.memory.readStdout()).toBe(
      "Defaults flow from config.ts through loader.ts to output.ts.\n",
    );
    expect(result.memory.readStderr()).not.toContain("fixture evidence");
    expect(writer.events.map((event) => event.type)).toEqual([
      "run.started",
      "agent.step.started",
      "model.usage",
      "agent.step.completed",
      "tool.call.requested",
      "tool.call.completed",
      "agent.step.started",
      "model.usage",
      "agent.step.completed",
      "tool.call.requested",
      "tool.call.completed",
      "agent.step.started",
      "text.delta",
      "model.usage",
      "agent.step.completed",
      "usage",
      "run.completed",
    ]);
    const reconstructed = reconstructSession(writer.events);
    expect(reconstructed.agentSteps.map((step) => step.started.step)).toEqual([
      1, 2, 3,
    ]);
    expect(reconstructed.toolCalls.map((call) => call.consumedByModel)).toEqual([
      true,
      true,
    ]);
    expect(reconstructed.usage?.total_tokens).toBe(15);
    expect(reconstructed.terminal).toMatchObject({
      data: { steps: 3, tool_calls: 2 },
      type: "run.completed",
    });

    const whitespaceFinal = writer.events.map((event): RunEvent =>
      event.type === "text.delta"
        ? {
            ...event,
            data: { delta: " ".repeat(event.data.delta.length) },
          }
        : event,
    );
    expect(() => reconstructSession(whitespaceFinal)).toThrow(
      "completed agent run lacks a final step",
    );
  });

  it("feeds permission errors back to the model and lets it recover", async () => {
    const error: ToolExecution = {
      error: {
        category: "permission",
        code: "path_outside_workspace",
        message: "path is outside the workspace",
        retryable: false,
      },
      ok: false,
      output:
        '{"error":{"category":"permission","code":"path_outside_workspace","message":"path is outside the workspace","retryable":false},"ok":false}',
      truncated: false,
    };
    const registry = new RecordingRegistry(() => error);
    const client = scriptedClient(
      [toolTurn("read_file", "call_denied", '{"path":"../secret"}'), finalTurn("Access was denied; no outside evidence was used.")],
      (request, index) => {
        if (index === 1 && request.input.kind === "tool_result") {
          expect(request.input.output).toContain("path_outside_workspace");
        }
      },
    );
    const { exitCode, writer } = await runAgentScenario({ client, registry });
    expect(exitCode).toBe(0);
    expect(writer.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { error_category: "permission", status: "error" },
    });
  });

  it("recovers from the versioned missing-file fixture with the real registry", async () => {
    const workspace = resolve(".");
    const registry = await createReadonlyToolRegistry(workspace);
    const writer = new InMemorySessionWriter();
    const memory = createMemoryIO();
    const client = scriptedClient(
      [
        toolTurn(
          "read_file",
          "call_missing",
          JSON.stringify({
            end_line: null,
            path: "fixtures/phase-04-tool-errors/src/missing-reference.ts",
            start_line: null,
          }),
        ),
        toolTurn(
          "search",
          "call_recover",
          JSON.stringify({
            glob: null,
            mode: "literal",
            path: "fixtures/phase-04-tool-errors",
            query: "RECOVERY_ANCHOR",
          }),
        ),
        finalTurn(
          "RECOVERY_ANCHOR is in fixtures/phase-04-tool-errors/src/reference.ts.",
        ),
      ],
      (request, index) => {
        if (index === 1 && request.input.kind === "tool_result") {
          expect(request.input.output).toContain("path_not_found");
        }
        if (index === 2 && request.input.kind === "tool_result") {
          expect(request.input.output).toContain("COMET-HARBOR-908");
          expect(request.input.output).toContain(
            "fixtures/phase-04-tool-errors/src/reference.ts",
          );
        }
      },
    );
    const exitCode = await runCli(
      ["agent", "recover from the missing reference"],
      memory.io,
      createRuntime({
        createModelTurnClient: () => client,
        createSessionWriter: async () => writer,
        createAgentToolRegistry: async () => registry,
        cwd: workspace,
      }),
    );
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toContain(
      "fixtures/phase-04-tool-errors/src/reference.ts",
    );
    expect(
      writer.events.filter((event) => event.type === "tool.call.completed"),
    ).toHaveLength(2);
  });

  it("records a system tool error and fails without another model request", async () => {
    const registry = new RecordingRegistry(() => ({
      error: {
        category: "system",
        code: "rg_not_found",
        message: "ripgrep is not available",
        retryable: false,
      },
      ok: false,
      output:
        '{"error":{"category":"system","code":"rg_not_found","message":"ripgrep is not available","retryable":false},"ok":false}',
      truncated: false,
    }));
    const client = scriptedClient([toolTurn("search", "call_system")]);
    const { exitCode, writer } = await runAgentScenario({ client, registry });
    expect(exitCode).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(writer.events.at(-1)).toMatchObject({
      data: { category: "internal", code: "rg_not_found" },
      type: "run.failed",
    });
    expect(writer.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { error_category: "system", status: "error" },
    });
  });

  it("fails closed when a completed turn omits usage", async () => {
    const client = scriptedClient([
      [
        { delta: "unbudgeted output", type: "text_delta" },
        {
          continuation: new FakeContinuation("missing-usage"),
          type: "turn_completed",
        },
      ],
    ]);
    const { exitCode, writer } = await runAgentScenario({ client });
    expect(exitCode).toBe(1);
    expect(writer.events.at(-1)).toMatchObject({
      data: { code: "usage_required_for_budget" },
      type: "run.failed",
    });
    expect(writer.events.some((event) => event.type === "usage")).toBe(false);
  });

  it("treats multiple tool calls in one response as protocol failure", async () => {
    const registry = new RecordingRegistry();
    const client = scriptedClient([
      [
        {
          call: { argumentsJson: "{}", callId: "call_a", name: "search" },
          type: "tool_call",
        },
        {
          call: { argumentsJson: "{}", callId: "call_b", name: "read_file" },
          type: "tool_call",
        },
      ],
    ]);
    const { exitCode, writer } = await runAgentScenario({ client, registry });
    expect(exitCode).toBe(1);
    expect(registry.calls).toHaveLength(0);
    expect(writer.events.at(-1)).toMatchObject({
      data: { category: "protocol", code: "multiple_tool_calls" },
      type: "run.failed",
    });
    expect(reconstructSession(writer.events).agentSteps[0]?.interrupted).toBe(true);
  });

  it("blocks the third consecutive identical call before registry execution", async () => {
    const registry = new RecordingRegistry();
    const repeatedArgs = '{"path":"same-file.ts"}';
    const client = scriptedClient([
      toolTurn("read_file", "call_1", repeatedArgs),
      toolTurn("read_file", "call_2", repeatedArgs),
      toolTurn("read_file", "call_3", repeatedArgs),
    ]);
    const { exitCode, writer } = await runAgentScenario({ client, registry });

    expect(exitCode).toBe(7);
    expect(client.calls).toHaveLength(3);
    expect(registry.calls).toHaveLength(2);
    expect(writer.events.at(-1)).toMatchObject({
      data: {
        limit: 3,
        observed: 3,
        reason: "repeated_tool_call",
        tool_calls: 3,
      },
      type: "run.budget_exceeded",
    });
    const requested = writer.events.filter(
      (event): event is Extract<RunEvent, { type: "tool.call.requested" }> =>
        event.type === "tool.call.requested",
    );
    expect(new Set(requested.map((event) => event.data.fingerprint)).size).toBe(1);
    expect(requested[0]?.data.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(reconstructSession(writer.events).toolCalls.at(-1)).toMatchObject({
      completed: { error_code: "repeated_call_blocked" },
      consumedByModel: false,
      interrupted: false,
    });
  });

  it("executes the last allowed step's tool but does not make an extra model call", async () => {
    const registry = new RecordingRegistry();
    const client = scriptedClient([toolTurn("search", "call_last")]);
    const { exitCode, writer } = await runAgentScenario({
      args: ["--max-steps", "1"],
      client,
      registry,
    });
    expect(exitCode).toBe(7);
    expect(client.calls).toHaveLength(1);
    expect(registry.calls).toHaveLength(1);
    expect(writer.events.at(-1)).toMatchObject({
      data: { limit: 1, observed: 1, reason: "max_steps" },
      type: "run.budget_exceeded",
    });
    expect(reconstructSession(writer.events).toolCalls[0]).toMatchObject({
      consumedByModel: false,
      interrupted: false,
    });

    const earlyMaxSteps = writer.events.map((event): RunEvent => {
      if (event.type === "run.started" && event.data.command === "agent") {
        return { ...event, data: { ...event.data, max_steps: 2 } };
      }
      if (event.type === "agent.step.started") {
        return { ...event, data: { ...event.data, max_steps: 2 } };
      }
      if (
        event.type === "run.budget_exceeded" &&
        event.data.reason === "max_steps"
      ) {
        return { ...event, data: { ...event.data, limit: 2 } };
      }
      return event;
    });
    expect(() => reconstructSession(earlyMaxSteps)).toThrow(
      "max_steps terminal does not match event history",
    );
  });

  it("stops before tool execution when reported tokens reach the limit", async () => {
    const registry = new RecordingRegistry();
    const client = scriptedClient([toolTurn("search", "call_token", "{}", 5)]);
    const { exitCode, writer } = await runAgentScenario({
      args: ["--max-tokens", "5"],
      client,
      registry,
    });
    expect(exitCode).toBe(7);
    expect(registry.calls).toHaveLength(0);
    expect(writer.events.at(-1)).toMatchObject({
      data: { limit: 5, observed: 5, reason: "max_tokens" },
      type: "run.budget_exceeded",
    });
    expect(
      writer.events.some((event) => event.type === "tool.call.requested"),
    ).toBe(false);
    expect(reconstructSession(writer.events).toolCalls).toEqual([]);
  });

  it("stops before recording a tool request when duration reaches the limit", async () => {
    let now = 0;
    const registry = new RecordingRegistry();
    const client = new FakeStreamingChatClient(async function* () {
      now = 1_000;
      yield* toolTurn("search", "call_duration");
    });
    const { exitCode, writer } = await runAgentScenario({
      args: [
        "--max-duration-ms",
        "1000",
        "--request-timeout-ms",
        "5000",
      ],
      client,
      registry,
      runtime: { now: () => now },
    });

    expect(exitCode).toBe(7);
    expect(registry.calls).toHaveLength(0);
    expect(writer.events.at(-1)).toMatchObject({
      data: { limit: 1_000, observed: 1_000, reason: "max_duration" },
      type: "run.budget_exceeded",
    });
    expect(
      writer.events.some((event) => event.type === "tool.call.requested"),
    ).toBe(false);
    expect(reconstructSession(writer.events).toolCalls).toEqual([]);
  });

  it("allows a final response to complete after a one-response token jump", async () => {
    const client = scriptedClient([finalTurn("final despite token jump", 6)]);
    const { exitCode, writer } = await runAgentScenario({
      args: ["--max-tokens", "5"],
      client,
    });
    expect(exitCode).toBe(0);
    expect(writer.events.at(-1)?.type).toBe("run.completed");
  });

  it("enforces cumulative tool output using UTF-8 bytes", async () => {
    const registry = new RecordingRegistry(() => ({
      ok: true,
      output: "x".repeat(65_536),
      truncated: false,
    }));
    const client = scriptedClient([toolTurn("read_file", "call_large")]);
    const { exitCode, writer } = await runAgentScenario({
      args: ["--max-tool-output-bytes", "65536"],
      client,
      registry,
    });
    expect(exitCode).toBe(7);
    expect(writer.events.at(-1)).toMatchObject({
      data: {
        limit: 65_536,
        observed: 65_536,
        reason: "max_tool_output",
      },
      type: "run.budget_exceeded",
    });
    expect(() => reconstructSession(writer.events)).not.toThrow();
  });

  it("distinguishes request timeout, global duration, and user cancellation", async () => {
    const scenarios = ["request", "duration", "user"] as const;
    for (const scenario of scenarios) {
      let now = 0;
      let cancelListener: (() => void) | undefined;
      const client = new FakeStreamingChatClient(
        scenario === "user"
          ? async function* (_request, signal) {
              queueMicrotask(() => cancelListener?.());
              yield* waitForAbort()(_request, signal);
            }
          : waitForAbort(),
      );
      const clearTimer = vi.fn();
      const runtime = {
        clearTimer,
        now: () => now,
        onCancel: (listener: () => void) => {
          if (scenario === "user") cancelListener = listener;
          return () => undefined;
        },
        setTimer: (listener: () => void, delayMs: number) => {
          const shouldFire =
            (scenario === "request" && delayMs === 1_000) ||
            (scenario === "duration" && delayMs === 1_000);
          if (shouldFire) {
            queueMicrotask(() => {
              if (scenario === "duration") now = 1_000;
              listener();
            });
          }
          return { delayMs };
        },
      };
      const args =
        scenario === "request"
          ? ["--request-timeout-ms", "1000"]
          : scenario === "duration"
            ? [
                "--max-duration-ms",
                "1000",
                "--request-timeout-ms",
                "5000",
              ]
            : [];
      const { exitCode, writer } = await runAgentScenario({
        args,
        client,
        runtime,
      });
      expect(exitCode, scenario).toBe(
        scenario === "request" ? 6 : scenario === "duration" ? 7 : 130,
      );
      expect(client.calls[0]?.signal.aborted, scenario).toBe(true);
      expect(writer.events.at(-1), scenario).toMatchObject(
        scenario === "request"
          ? { data: { category: "timeout" }, type: "run.failed" }
          : scenario === "duration"
            ? {
                data: { reason: "max_duration" },
                type: "run.budget_exceeded",
              }
            : { data: { reason: "user" }, type: "run.cancelled" },
      );
      expect(clearTimer).toHaveBeenCalled();
    }
  });

  it("aborts an active tool at the global deadline without persisting its result", async () => {
    let now = 0;
    let globalDeadline: (() => void) | undefined;
    const registry = new RecordingRegistry((_invocation, _index, signal) => {
      now = 1_000;
      globalDeadline?.();
      expect(signal.aborted).toBe(true);
      return {
        error: {
          category: "cancelled",
          code: "tool_cancelled",
          message: "tool execution was cancelled",
          retryable: false,
        },
        ok: false,
        output: '{"ok":false}',
        truncated: false,
      };
    });
    const client = scriptedClient([toolTurn("search", "call_deadline")]);
    const { exitCode, writer } = await runAgentScenario({
      args: [
        "--max-duration-ms",
        "1000",
        "--request-timeout-ms",
        "5000",
      ],
      client,
      registry,
      runtime: {
        now: () => now,
        setTimer: (listener, delayMs) => {
          if (delayMs === 1_000) globalDeadline = listener;
          return { delayMs };
        },
      },
    });
    expect(exitCode).toBe(7);
    expect(writer.events.at(-1)).toMatchObject({
      data: { reason: "max_duration" },
      type: "run.budget_exceeded",
    });
    expect(
      writer.events.some((event) => event.type === "tool.call.completed"),
    ).toBe(false);
    expect(reconstructSession(writer.events).toolCalls[0]?.interrupted).toBe(true);
  });

  it("records a completed tool result before a between-step global deadline", async () => {
    let now = 0;
    let globalDeadline: (() => void) | undefined;
    const writer = new InMemorySessionWriter("memory://between-steps", (event) => {
      if (event.type === "tool.call.completed") {
        now = 1_000;
        globalDeadline?.();
      }
    });
    const client = scriptedClient([toolTurn("read_file", "call_between")]);
    const { exitCode } = await runAgentScenario({
      args: [
        "--max-duration-ms",
        "1000",
        "--request-timeout-ms",
        "5000",
      ],
      client,
      runtime: {
        now: () => now,
        setTimer: (listener, delayMs) => {
          if (delayMs === 1_000) globalDeadline = listener;
          return { delayMs };
        },
      },
      writer,
    });
    expect(exitCode).toBe(7);
    expect(client.calls).toHaveLength(1);
    expect(writer.events.at(-1)).toMatchObject({
      data: { reason: "max_duration", tool_calls: 1 },
      type: "run.budget_exceeded",
    });
    expect(reconstructSession(writer.events).toolCalls[0]).toMatchObject({
      consumedByModel: false,
      interrupted: false,
    });
  });

  it("does not call the model when step-start persistence fails", async () => {
    const writer = new InMemorySessionWriter("memory://failure", (event) => {
      if (event.type === "agent.step.started") throw new Error("disk full");
    });
    const client = scriptedClient([finalTurn()]);
    const { exitCode, memory } = await runAgentScenario({ client, writer });
    expect(exitCode).toBe(1);
    expect(client.calls).toHaveLength(0);
    expect(writer.events.map((event) => event.type)).toEqual(["run.started"]);
    expect(memory.readStderr()).toContain("session storage failed");
  });

  it("does not start another model step when tool-result persistence fails", async () => {
    const writer = new InMemorySessionWriter("memory://tool-result-failure", (event) => {
      if (event.type === "tool.call.completed") throw new Error("disk full");
    });
    const registry = new RecordingRegistry();
    const client = scriptedClient([
      toolTurn("read_file", "call_persist"),
      finalTurn("must not be reached"),
    ]);
    const { exitCode, memory } = await runAgentScenario({
      client,
      registry,
      writer,
    });
    expect(exitCode).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(registry.calls).toHaveLength(1);
    expect(writer.events.at(-1)?.type).toBe("tool.call.requested");
    expect(memory.readStderr()).toContain("session storage failed");
  });
});
