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

async function startPendingPatchCall(publisher: EventPublisher): Promise<void> {
  await publisher.publish({
    data: {
      command: "agent",
      edit_approval: "ask",
      input: { role: "user", text: "change math" },
      max_duration_ms: 60_000,
      max_steps: 4,
      max_tokens: 4_000,
      max_tool_output_bytes: 64 * 1024,
      model: "qwen3:1.7b",
      provider: "ollama",
      request_timeout_ms: 30_000,
      tools: ["apply_patch"],
      tools_enabled: true,
      workspace: "D:\\Code\\bornagent",
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      input_kind: "user_task",
      max_steps: 4,
      remaining_duration_ms: 60_000,
      remaining_tokens: 4_000,
      remaining_tool_output_bytes: 64 * 1024,
      step: 1,
    },
    type: "agent.step.started",
  });
  await publisher.publish({
    data: {
      duration_ms: 2,
      outcome: "tool_call",
      step: 1,
      text_chars: 0,
      tool_call_id: "call_patch",
    },
    type: "agent.step.completed",
  });
  await publisher.publish({
    data: {
      arguments_json: '{"patch":"diff --git a/src/math.ts b/src/math.ts"}',
      call_id: "call_patch",
      step: 1,
      tool_name: "apply_patch",
    },
    type: "tool.call.requested",
  });
}

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

  it("persists a matching approval chain before accepting apply evidence", async () => {
    const { publisher, writer } = createPublisher();
    const planId = "a".repeat(64);
    const approvalRequestId = "00000000-0000-4000-8000-000000000010";
    const path = { kind: "modify" as const, path: "src/math.ts" };
    const approvalRequest = {
      data: {
        action: "apply_patch" as const,
        added_lines: 1,
        approval_request_id: approvalRequestId,
        call_id: "call_patch",
        paths: [path],
        plan_id: planId,
        preview: "+return 2;",
        removed_lines: 1,
        step: 1,
        truncated: false,
      },
      type: "approval.requested" as const,
    };

    await startPendingPatchCall(publisher);
    await expect(publisher.publish(approvalRequest)).rejects.toThrow(
      "patch plan",
    );
    await publisher.publish({
      data: {
        added_lines: 1,
        call_id: "call_patch",
        patch_sha256: "b".repeat(64),
        paths: [path],
        plan_id: planId,
        preview: "+return 2;",
        removed_lines: 1,
        step: 1,
        truncated: false,
      },
      type: "patch.plan.created",
    });
    await publisher.publish(approvalRequest);
    const applyStarted = {
      data: {
        approval_request_id: approvalRequestId,
        call_id: "call_patch",
        files: [{ ...path, pre_sha256: "c".repeat(64) }],
        plan_id: planId,
        step: 1,
      },
      type: "patch.apply.started" as const,
    };
    await expect(publisher.publish(applyStarted)).rejects.toThrow("approved");
    await publisher.publish({
      data: {
        action: "apply_patch",
        approval_request_id: approvalRequestId,
        call_id: "call_patch",
        decision: "approved",
        plan_id: planId,
        step: 1,
      },
      type: "approval.decided",
    });
    await publisher.publish(applyStarted);
    const toolCompleted = {
      data: {
        call_id: "call_patch",
        duration_ms: 5,
        output: '{"ok":true}',
        status: "success" as const,
        step: 1,
        tool_name: "apply_patch",
        truncated: false,
      },
      type: "tool.call.completed" as const,
    };
    await expect(publisher.publish(toolCompleted)).rejects.toThrow(
      "completed apply evidence",
    );
    await publisher.publish({
      data: {
        added_lines: 1,
        approval_request_id: approvalRequestId,
        call_id: "call_patch",
        duration_ms: 4,
        files: [
          {
            ...path,
            post_sha256: "d".repeat(64),
            pre_sha256: "c".repeat(64),
          },
        ],
        journal_sha256: "e".repeat(64),
        plan_id: planId,
        removed_lines: 1,
        step: 1,
      },
      type: "patch.apply.completed",
    });
    await publisher.publish(toolCompleted);

    expect(writer.events.map((event) => event.type).slice(-6)).toEqual([
      "patch.plan.created",
      "approval.requested",
      "approval.decided",
      "patch.apply.started",
      "patch.apply.completed",
      "tool.call.completed",
    ]);
  });
});
