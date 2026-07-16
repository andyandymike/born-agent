import { describe, expect, it, vi } from "vitest";

import {
  EventPersistenceError,
  EventPublisher,
} from "../../src/events/event-publisher.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { InMemorySessionWriter } from "../helpers.js";

function createPublisher(
  writer = new InMemorySessionWriter(),
  render: (event: RunEvent) => void = () => undefined,
) {
  let uuid = 2;
  return {
    publisher: new EventPublisher({
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      renderer: { render },
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      timestamp: () => "2026-07-16T00:00:00.000Z",
      writer,
    }),
    writer,
  };
}

const started = {
  data: {
    command: "chat" as const,
    input: { role: "user" as const, text: "hello" },
    model: "gpt-test",
    provider: "openai" as const,
    timeout_ms: 120_000,
    workspace: "D:\\Code\\bornagent",
  },
  type: "run.started" as const,
};

describe("EventPublisher", () => {
  it("persists before rendering and assigns continuous sequence numbers", async () => {
    const order: string[] = [];
    const writer = new InMemorySessionWriter("memory://ordered", (event) => {
      order.push(`persist:${event.seq}`);
    });
    const { publisher } = createPublisher(writer, (event) => {
      order.push(`render:${event.seq}`);
    });

    await publisher.publish(started);
    await publisher.publish({ data: { delta: "hi" }, type: "text.delta" });
    await publisher.publish({
      data: { duration_ms: 10, output_chars: 2 },
      type: "run.completed",
    });

    expect(order).toEqual([
      "persist:1",
      "render:1",
      "persist:2",
      "render:2",
      "persist:3",
      "render:3",
    ]);
  });

  it("rejects missing start, duplicate usage, wrong output length, and double terminal", async () => {
    const first = createPublisher().publisher;
    await expect(
      first.publish({ data: { delta: "hi" }, type: "text.delta" }),
    ).rejects.toThrow("run.started");

    const second = createPublisher().publisher;
    await second.publish(started);
    await second.publish({
      data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      type: "usage",
    });
    await expect(
      second.publish({
        data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        type: "usage",
      }),
    ).rejects.toThrow("usage");
    await expect(
      second.publish({
        data: { duration_ms: 1, output_chars: 99 },
        type: "run.completed",
      }),
    ).rejects.toThrow("output_chars");
    await second.publish({
      data: {
        category: "internal",
        code: "internal_error",
        duration_ms: 1,
        message: "internal protocol error",
        retryable: false,
      },
      type: "run.failed",
    });
    await expect(
      second.publish({
        data: { duration_ms: 1, reason: "user" },
        type: "run.cancelled",
      }),
    ).rejects.toThrow("terminal");
  });

  it("does not render when persistence fails", async () => {
    const render = vi.fn();
    const writer = new InMemorySessionWriter("memory://failure", () => {
      throw new Error("disk full");
    });
    const { publisher } = createPublisher(writer, render);

    await expect(publisher.publish(started)).rejects.toBeInstanceOf(
      EventPersistenceError,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("pairs tool requests and results before allowing a completed run", async () => {
    const { publisher } = createPublisher();
    await publisher.publish(started);
    await publisher.publish({
      data: {
        arguments_json: "{}",
        call_id: "call_1",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    });
    await expect(
      publisher.publish({
        data: {
          duration_ms: 1,
          output_chars: 0,
          tool_calls: 0,
        },
        type: "run.completed",
      }),
    ).rejects.toThrow("interrupted");
    await expect(
      publisher.publish({
        data: {
          call_id: "other",
          duration_ms: 1,
          output: "{}",
          status: "success",
          step: 1,
          tool_name: "read_file",
          truncated: false,
        },
        type: "tool.call.completed",
      }),
    ).rejects.toThrow("pending");
    await publisher.publish({
      data: {
        call_id: "call_1",
        duration_ms: 1,
        output: '{"ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    expect(publisher.completedToolCalls).toBe(1);
    await publisher.publish({
      data: { duration_ms: 2, output_chars: 0, tool_calls: 1 },
      type: "run.completed",
    });
  });
});
