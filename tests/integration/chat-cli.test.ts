import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { CliIO } from "../../src/cli/types.js";
import type { RunEvent } from "../../src/events/run-event.js";
import {
  createControlledStream,
  FakeContinuation,
  FakeStreamingChatClient,
  fixedStream,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  InMemorySessionWriter,
} from "../helpers.js";

function orderedIO(order: string[]): {
  io: CliIO;
  readStderr(): string;
  readStdout(): string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stderr: {
        write: (value) => {
          order.push(`stderr:${value}`);
          stderr += value;
        },
      },
      stdout: {
        write: (value) => {
          order.push(`stdout:${value}`);
          stdout += value;
        },
      },
    },
    readStderr: () => stderr,
    readStdout: () => stdout,
  };
}

describe("born chat streaming", () => {
  it("persists each delayed delta before rendering it", async () => {
    const order: string[] = [];
    const memory = orderedIO(order);
    const controlled = createControlledStream();
    const writer = new InMemorySessionWriter("memory://ordered", (event) => {
      order.push(`persist:${event.type}`);
    });
    const promise = runCli(
      ["chat", "stream this"],
      memory.io,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () =>
          new FakeStreamingChatClient(controlled.behavior),
      }),
    );

    await controlled.waitUntilStarted();
    controlled.push({ delta: "first", type: "text_delta" });
    await vi.waitFor(() => expect(memory.readStdout()).toBe("first"));
    expect(writer.events.at(-1)).toMatchObject({
      data: { delta: "first" },
      type: "text.delta",
    });
    expect(order.indexOf("persist:text.delta")).toBeLessThan(
      order.indexOf("stdout:first"),
    );

    controlled.push({ delta: " second", type: "text_delta" });
    controlled.push({
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    controlled.push({
      continuation: new FakeContinuation(),
      providerResponseId: "resp_delayed",
      type: "turn_completed",
    });
    controlled.end();

    await expect(promise).resolves.toBe(0);
    expect(memory.readStdout()).toBe("first second\n");
    expect(writer.events.at(-1)?.type).toBe("run.completed");
  });

  it("supports Ollama without an API key and prints verbose metadata to stderr", async () => {
    const writer = new InMemorySessionWriter();
    const memory = createMemoryIO();
    let configuration: unknown;
    const exitCode = await runCli(
      ["chat", "hello", "--provider", "ollama", "--verbose"],
      memory.io,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: (selected) => {
          configuration = selected;
          return new FakeStreamingChatClient(fixedStream(["local answer"]));
        },
        env: {},
      }),
    );

    expect(exitCode).toBe(0);
    expect(configuration).toEqual({
      baseURL: "http://localhost:11434/v1",
      provider: "ollama",
    });
    expect(memory.readStdout()).toBe("local answer\n");
    expect(memory.readStderr()).toContain("provider=ollama");
    expect(memory.readStderr()).toContain("total_tokens=5");
    expect(memory.readStderr()).toContain("response_id=resp_fake");
  });

  it("keeps partial text and puts a provider failure on a separate stderr line", async () => {
    const memory = createMemoryIO();
    const writer = new InMemorySessionWriter();
    const client = new FakeStreamingChatClient(async function* () {
      yield { delta: "partial", type: "text_delta" };
      yield {
        error: {
          category: "rate_limit" as const,
          code: "rate_limit_exceeded",
          message: "OpenAI rate limit exceeded",
          retryable: true,
        },
        type: "failed" as const,
      };
    });
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () => client,
      }),
    );

    expect(exitCode).toBe(5);
    expect(memory.readStdout()).toBe("partial\n");
    expect(memory.readStderr()).toBe("OpenAI rate limit exceeded\n");
    expect(writer.events.at(-1)?.type).toBe("run.failed");
  });

  it("does not create a session for missing credentials or invalid timeout", async () => {
    const createSessionWriter = vi.fn();
    for (const [argv, env, expected] of [
      [["chat", "hello"], {}, 4],
      [["chat", "hello", "--timeout-ms", "999"], { OPENAI_API_KEY: "key" }, 2],
    ] as const) {
      const memory = createMemoryIO();
      await expect(
        runCli(
          argv,
          memory.io,
          createRuntime({ createSessionWriter, env }),
        ),
      ).resolves.toBe(expected);
      expect(memory.readStdout()).toBe("");
    }
    expect(createSessionWriter).not.toHaveBeenCalled();
  });

  it("writes the correct terminal event for timeout and Ctrl+C", async () => {
    for (const scenario of ["timeout", "cancelled"] as const) {
      const memory = createMemoryIO();
      const writer = new InMemorySessionWriter();
      const client = new FakeStreamingChatClient(waitForAbort());
      const exitCode = await runCli(
        ["chat", "hello", "--timeout-ms", "1000"],
        memory.io,
        createRuntime({
          createSessionWriter: async () => writer,
          createModelTurnClient: () => client,
          onCancel: (listener) => {
            if (scenario === "cancelled") {
              queueMicrotask(listener);
            }
            return () => undefined;
          },
          setTimer: (listener) => {
            if (scenario === "timeout") {
              queueMicrotask(listener);
            }
            return "timer";
          },
        }),
      );

      expect(exitCode).toBe(scenario === "timeout" ? 6 : 130);
      expect(writer.events.at(-1)?.type).toBe(
        scenario === "timeout" ? "run.failed" : "run.cancelled",
      );
      expect(memory.readStderr()).toContain(
        scenario === "timeout" ? "timed out" : "Cancelled",
      );
    }
  });

  it("does not render an unpersisted delta after storage failure", async () => {
    const memory = createMemoryIO();
    const persisted: RunEvent[] = [];
    const writer = new InMemorySessionWriter("memory://full", (event) => {
      if (event.type === "text.delta") {
        throw new Error("disk full");
      }
      persisted.push(event);
    });
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () =>
          new FakeStreamingChatClient(fixedStream(["must not render"])),
      }),
    );

    expect(exitCode).toBe(1);
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe("session storage failed\n");
    expect(persisted.map((event) => event.type)).toEqual(["run.started"]);
  });
});
