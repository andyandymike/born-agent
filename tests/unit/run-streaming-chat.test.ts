import { describe, expect, it, vi } from "vitest";

import {
  runStreamingChat,
  type StreamingRunRenderer,
} from "../../src/chat/run-streaming-chat.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  failedStream,
  FakeStreamingChatClient,
  fixedStream,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import { createRuntime, InMemorySessionWriter } from "../helpers.js";

const options = {
  model: undefined,
  prompt: "hello",
  provider: undefined,
  timeoutMs: undefined,
  verbose: false,
};

class RecordingRenderer implements StreamingRunRenderer {
  readonly diagnostics: string[] = [];
  readonly events: RunEvent[] = [];
  storageErrors = 0;

  render(event: RunEvent): void {
    this.events.push(event);
  }

  renderDiagnostic(message: string): void {
    this.diagnostics.push(message);
  }

  renderStorageError(): void {
    this.storageErrors += 1;
  }
}

describe("runStreamingChat", () => {
  it("publishes a reconstructable successful run", async () => {
    const writer = new InMemorySessionWriter();
    const renderer = new RecordingRenderer();
    const times = [100, 142];
    const exitCode = await runStreamingChat(
      options,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () =>
          new FakeStreamingChatClient(fixedStream(["hel", "lo"])),
        now: () => times.shift() ?? 142,
      }),
      renderer,
    );

    expect(exitCode).toBe(0);
    expect(writer.closed).toBe(true);
    expect(renderer.events).toEqual(writer.events);
    expect(writer.events.map((event) => event.type)).toEqual([
      "run.started",
      "text.delta",
      "text.delta",
      "usage",
      "run.completed",
    ]);
    expect(writer.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(reconstructSession(writer.events)).toMatchObject({
      output: "hello",
      terminal: {
        data: { duration_ms: 42, output_chars: 5 },
        type: "run.completed",
      },
    });
  });

  it("creates an Ollama stream without an OpenAI API key", async () => {
    const writer = new InMemorySessionWriter();
    const renderer = new RecordingRenderer();
    let configuration: unknown;
    const exitCode = await runStreamingChat(
      { ...options, provider: "ollama" },
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: (selected) => {
          configuration = selected;
          return new FakeStreamingChatClient(fixedStream());
        },
        env: {},
      }),
      renderer,
    );

    expect(exitCode).toBe(0);
    expect(configuration).toEqual({
      baseURL: "http://localhost:11434/v1",
      provider: "ollama",
    });
    expect(writer.events[0]).toMatchObject({
      data: { model: "qwen3:1.7b", provider: "ollama" },
      type: "run.started",
    });
  });

  it("returns before creating a session for invalid config or credentials", async () => {
    const createSessionWriter = vi.fn();
    const missingRenderer = new RecordingRenderer();
    const invalidRenderer = new RecordingRenderer();

    await expect(
      runStreamingChat(
        options,
        createRuntime({ createSessionWriter, env: {} }),
        missingRenderer,
      ),
    ).resolves.toBe(4);
    await expect(
      runStreamingChat(
        { ...options, timeoutMs: "999" },
        createRuntime({ createSessionWriter }),
        invalidRenderer,
      ),
    ).resolves.toBe(2);
    expect(createSessionWriter).not.toHaveBeenCalled();
    expect(missingRenderer.diagnostics).toEqual([
      "OPENAI_API_KEY is not configured",
    ]);
    expect(invalidRenderer.diagnostics[0]).toContain("usage/config error");
  });

  it("maps provider failures to a unique failed terminal", async () => {
    const writer = new InMemorySessionWriter();
    const renderer = new RecordingRenderer();
    const exitCode = await runStreamingChat(
      options,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () =>
          new FakeStreamingChatClient(
            failedStream({
              category: "rate_limit",
              code: "rate_limit_exceeded",
              message: "OpenAI rate limit exceeded",
              providerRequestId: "req_rate",
              retryable: true,
              status: 429,
            }),
          ),
      }),
      renderer,
    );

    expect(exitCode).toBe(5);
    expect(writer.events.at(-1)).toMatchObject({
      data: {
        category: "rate_limit",
        provider_request_id: "req_rate",
        retryable: true,
      },
      type: "run.failed",
    });
    expect(
      writer.events.filter((event) => event.type.startsWith("run.")),
    ).toHaveLength(2);
  });

  it("records timeout as failed and user cancellation as cancelled", async () => {
    for (const scenario of ["timeout", "cancelled"] as const) {
      const writer = new InMemorySessionWriter();
      const renderer = new RecordingRenderer();
      const client = new FakeStreamingChatClient(waitForAbort());
      const clearTimer = vi.fn();
      const stopListening = vi.fn();
      const exitCode = await runStreamingChat(
        { ...options, timeoutMs: "1000" },
        createRuntime({
          clearTimer,
          createSessionWriter: async () => writer,
          createModelTurnClient: () => client,
          onCancel: (listener) => {
            if (scenario === "cancelled") {
              queueMicrotask(listener);
            }
            return stopListening;
          },
          setTimer: (listener) => {
            if (scenario === "timeout") {
              queueMicrotask(listener);
            }
            return "timer";
          },
        }),
        renderer,
      );

      expect(exitCode).toBe(scenario === "timeout" ? 6 : 130);
      expect(client.calls[0]?.signal.aborted).toBe(true);
      expect(clearTimer).toHaveBeenCalledWith("timer");
      expect(stopListening).toHaveBeenCalledOnce();
      expect(writer.closed).toBe(true);
      expect(writer.events.at(-1)?.type).toBe(
        scenario === "timeout" ? "run.failed" : "run.cancelled",
      );
    }
  });

  it("aborts and stops rendering immediately after persistence failure", async () => {
    const rendered: RunEvent[] = [];
    const writer = new InMemorySessionWriter("memory://failure", (event) => {
      if (event.type === "text.delta") {
        throw new Error("disk full Authorization: Bearer sk-secret-value");
      }
    });
    const renderer = new RecordingRenderer();
    renderer.render = (event) => void rendered.push(event);
    const client = new FakeStreamingChatClient(fixedStream(["first", "second"]));

    const exitCode = await runStreamingChat(
      options,
      createRuntime({
        createSessionWriter: async () => writer,
        createModelTurnClient: () => client,
      }),
      renderer,
    );

    expect(exitCode).toBe(1);
    expect(client.calls[0]?.signal.aborted).toBe(true);
    expect(writer.events.map((event) => event.type)).toEqual(["run.started"]);
    expect(rendered.map((event) => event.type)).toEqual(["run.started"]);
    expect(renderer.storageErrors).toBe(1);
    expect(writer.closed).toBe(true);
  });
});
