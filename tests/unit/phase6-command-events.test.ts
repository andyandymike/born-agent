import { describe, expect, it } from "vitest";

import {
  EventPublisher,
  type RunEventRenderer,
} from "../../src/events/event-publisher.js";
import { ConsoleEventRenderer } from "../../src/render/console-event-renderer.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  createMemoryIO,
  InMemorySessionWriter,
} from "../helpers.js";
import { testBackendSelected } from "../phase8-event-helpers.js";

const actionSha256 = "a".repeat(64);
const approvalRequestId = "00000000-0000-4000-8000-000000000090";
const executionId = "00000000-0000-4000-8000-000000000091";

function createPublisher(
  renderer: RunEventRenderer = { render: () => undefined },
) {
  let id = 100;
  const writer = new InMemorySessionWriter();
  return {
    publisher: new EventPublisher({
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      renderer,
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      timestamp: () => "2026-07-16T00:00:00.000Z",
      writer,
    }),
    writer,
  };
}

async function startPendingCommand(publisher: EventPublisher): Promise<void> {
  await publisher.publish({
    data: {
      command: "agent",
      command_approval: "ask",
      command_timeout_ms: 120_000,
      input: { role: "user", text: "verify locally" },
      max_command_output_bytes: 131_072,
      max_duration_ms: 60_000,
      max_steps: 4,
      max_tokens: 4_000,
      max_tool_output_bytes: 131_072,
      model: "qwen3:1.7b",
      provider: "ollama",
      request_timeout_ms: 30_000,
      tools: ["run_command"],
      tools_enabled: true,
      workspace: "D:\\Code\\bornagent",
    },
    type: "run.started",
  });
  await publisher.publish(testBackendSelected("ollama", "qwen3:1.7b"));
  await publisher.publish({
    data: {
      input_kind: "user_task",
      max_steps: 4,
      remaining_duration_ms: 60_000,
      remaining_tokens: 4_000,
      remaining_tool_output_bytes: 131_072,
      step: 1,
    },
    type: "agent.step.started",
  });
  await publisher.publish({
    data: {
      duration_ms: 1,
      outcome: "tool_call",
      step: 1,
      text_chars: 0,
      tool_call_id: "call_command",
    },
    type: "agent.step.completed",
  });
  await publisher.publish({
    data: {
      arguments_json: '{"executable":"corepack"}',
      call_id: "call_command",
      step: 1,
      tool_name: "run_command",
    },
    type: "tool.call.requested",
  });
}

const permission = {
  data: {
    action_kind: "run_command" as const,
    action_sha256: actionSha256,
    call_id: "call_command",
    effect: "ask" as const,
    policy_version: "local-free-v1",
    reason_code: "verification_requires_approval",
    rule_id: "registered-verification",
    step: 1,
  },
  type: "permission.evaluated" as const,
};

const executionRequested = {
  data: {
    action_sha256: actionSha256,
    approval_request_id: approvalRequestId,
    call_id: "call_command",
    cwd: ".",
    executable: "corepack",
    execution_id: executionId,
    executor: "local" as const,
    purpose: "verify" as const,
    redacted_argv: ["corepack", "pnpm", "test"],
    step: 1,
  },
  type: "command.execution.requested" as const,
};

async function approveCommand(publisher: EventPublisher): Promise<void> {
  await publisher.publish(permission);
  await publisher.publish({
    data: {
      action: "run_command",
      action_kind: "run_command",
      action_sha256: actionSha256,
      approval_request_id: approvalRequestId,
      call_id: "call_command",
      cwd: ".",
      executable: "corepack",
      preview: "corepack pnpm test",
      purpose: "verify",
      redacted_argv: ["corepack", "pnpm", "test"],
      step: 1,
      truncated: false,
    },
    type: "approval.requested",
  });
  await publisher.publish({
    data: {
      action: "run_command",
      action_kind: "run_command",
      action_sha256: actionSha256,
      approval_request_id: approvalRequestId,
      call_id: "call_command",
      decision: "approved",
      step: 1,
    },
    type: "approval.decided",
  });
}

describe("Phase 6 command events", () => {
  it("closes a spawn failure without inventing a command.started event", async () => {
    const { publisher, writer } = createPublisher();
    await startPendingCommand(publisher);
    await approveCommand(publisher);
    await publisher.publish(executionRequested);
    await publisher.publish({
      data: {
        action_sha256: actionSha256,
        call_id: "call_command",
        cleanup_verified: true,
        duration_ms: 1,
        error_code: "enoent",
        execution_id: executionId,
        executor: "local",
        exit_code: null,
        signal: null,
        stderr_bytes: 0,
        stdout_bytes: 0,
        step: 1,
        termination: "spawn_error",
        total_bytes: 0,
        truncated: false,
      },
      type: "command.completed",
    });
    await publisher.publish({
      data: {
        call_id: "call_command",
        duration_ms: 1,
        error_category: "tool",
        error_code: "command_spawn_failed",
        output: '{"ok":false}',
        retryable: false,
        status: "error",
        step: 1,
        tool_name: "run_command",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publisher.publish({
      data: {
        duration_ms: 2,
        output_chars: 0,
        reason: "user",
        steps: 1,
        tool_calls: 1,
      },
      type: "run.cancelled",
    });

    const attempt = reconstructSession(writer.events).commandAttempts[0];
    expect(attempt).toMatchObject({
      completed: { termination: "spawn_error" },
      effectState: "completed",
    });
    expect(attempt?.started).toBeUndefined();
  });

  it("pairs permission, approval, execution, per-channel output, completion, and rendering", async () => {
    const memory = createMemoryIO();
    const { publisher, writer } = createPublisher(
      new ConsoleEventRenderer(memory.io, true),
    );
    await startPendingCommand(publisher);
    await approveCommand(publisher);
    await publisher.publish(executionRequested);
    await publisher.publish({
      data: {
        action_sha256: actionSha256,
        call_id: "call_command",
        execution_id: executionId,
        executor: "local",
        process_identity: "pid:42",
        step: 1,
      },
      type: "command.started",
    });
    await publisher.publish({
      data: {
        action_sha256: actionSha256,
        bytes: 2,
        call_id: "call_command",
        channel: "stdout",
        chunk: "ok",
        chunk_index: 0,
        execution_id: executionId,
        executor: "local",
        step: 1,
      },
      type: "command.output",
    });
    await publisher.publish({
      data: {
        action_sha256: actionSha256,
        bytes: 3,
        call_id: "call_command",
        channel: "stderr",
        chunk: "bad",
        chunk_index: 0,
        execution_id: executionId,
        executor: "local",
        step: 1,
      },
      type: "command.output",
    });
    await publisher.publish({
      data: {
        action_sha256: actionSha256,
        call_id: "call_command",
        cleanup_verified: true,
        duration_ms: 8,
        execution_id: executionId,
        executor: "local",
        exit_code: 1,
        signal: null,
        stderr_bytes: 3,
        stdout_bytes: 2,
        step: 1,
        termination: "exit",
        total_bytes: 5,
        truncated: false,
      },
      type: "command.completed",
    });
    await publisher.publish({
      data: {
        call_id: "call_command",
        duration_ms: 9,
        output: '{"ok":true,"exit_code":1}',
        status: "success",
        step: 1,
        tool_name: "run_command",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publisher.publish({
      data: {
        category: "internal",
        code: "test_stop",
        duration_ms: 10,
        message: "test terminal",
        retryable: false,
        steps: 1,
        tool_calls: 1,
      },
      type: "run.failed",
    });

    expect(reconstructSession(writer.events).commandAttempts).toMatchObject([
      {
        completed: { total_bytes: 5 },
        effectState: "completed",
        output: [{ channel: "stdout", chunk_index: 0 }, { channel: "stderr", chunk_index: 0 }],
        permission: { effect: "ask" },
      },
    ]);
    expect(memory.readStderr()).toContain("rule=registered-verification");
    expect(memory.readStderr()).toContain('command="corepack" "pnpm" "test"');
    expect(memory.readStderr()).toContain("termination=exit");
  });

  it("rejects denied execution and non-contiguous output", async () => {
    const denied = createPublisher().publisher;
    await startPendingCommand(denied);
    await denied.publish({
      data: { ...permission.data, effect: "deny", reason_code: "policy_deny" },
      type: "permission.evaluated",
    });
    await expect(denied.publish(executionRequested)).rejects.toThrow(
      "matching permission",
    );

    const active = createPublisher().publisher;
    await startPendingCommand(active);
    await approveCommand(active);
    await active.publish(executionRequested);
    await active.publish({
      data: {
        action_sha256: actionSha256,
        call_id: "call_command",
        execution_id: executionId,
        executor: "local",
        step: 1,
      },
      type: "command.started",
    });
    await expect(
      active.publish({
        data: {
          action_sha256: actionSha256,
          bytes: 1,
          call_id: "call_command",
          channel: "stdout",
          chunk: "x",
          chunk_index: 1,
          execution_id: executionId,
          executor: "local",
          step: 1,
        },
        type: "command.output",
      }),
    ).rejects.toThrow("contiguous");
  });

  it("marks a persisted execution without completion as effect unknown", async () => {
    const { publisher, writer } = createPublisher();
    await startPendingCommand(publisher);
    await approveCommand(publisher);
    await publisher.publish(executionRequested);
    await publisher.publish({
      data: {
        category: "storage",
        code: "session_write_failed",
        duration_ms: 5,
        message: "test terminal",
        retryable: false,
        steps: 1,
        tool_calls: 0,
      },
      type: "run.failed",
    });
    expect(reconstructSession(writer.events).commandAttempts).toMatchObject([
      { effectState: "unknown" },
    ]);
  });

  it("allows Registry pre-execution errors to close without permission evidence", async () => {
    const { publisher, writer } = createPublisher();
    await startPendingCommand(publisher);
    await publisher.publish({
      data: {
        call_id: "call_command",
        duration_ms: 1,
        error_category: "invalid_arguments",
        error_code: "arguments_schema_mismatch",
        output: '{"ok":false}',
        retryable: false,
        status: "error",
        step: 1,
        tool_name: "run_command",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publisher.publish({
      data: {
        category: "internal",
        code: "test_stop",
        duration_ms: 2,
        message: "test terminal",
        retryable: false,
        steps: 1,
        tool_calls: 1,
      },
      type: "run.failed",
    });
    expect(reconstructSession(writer.events).commandAttempts).toEqual([]);
  });
});
