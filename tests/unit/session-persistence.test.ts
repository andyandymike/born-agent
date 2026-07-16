import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { JsonlSessionWriter } from "../../src/sessions/jsonl-session-writer.js";
import { readSession } from "../../src/sessions/read-session.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase2-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("JSONL session persistence", () => {
  it("writes UTF-8 JSONL and reconstructs prompt, deltas, usage, and terminal", async () => {
    const workspace = await temporaryWorkspace();
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const writer = await JsonlSessionWriter.create(workspace, sessionId);
    let eventId = 2;
    const publisher = new EventPublisher({
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++eventId).padStart(12, "0")}`,
      renderer: { render: () => undefined },
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId,
      timestamp: () => "2026-07-16T00:00:00.000Z",
      writer,
    });

    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: "原样保存这个提示" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 120_000,
        workspace,
      },
      type: "run.started",
    });
    await publisher.publish({ data: { delta: "你" }, type: "text.delta" });
    await publisher.publish({ data: { delta: "好" }, type: "text.delta" });
    await publisher.publish({
      data: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      type: "usage",
    });
    await publisher.publish({
      data: { duration_ms: 25, output_chars: 2 },
      type: "run.completed",
    });
    await writer.close();

    expect(writer.path).toBe(
      join(workspace, ".bornagent", "sessions", `${sessionId}.jsonl`),
    );
    expect(writer.path).not.toContain("原样保存");
    const raw = await readFile(writer.path);
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    expect(raw.toString("utf8").endsWith("\n")).toBe(true);
    const events = await readSession(writer.path);
    expect(reconstructSession(events)).toMatchObject({
      output: "你好",
      started: { input: { text: "原样保存这个提示" } },
      terminal: { type: "run.completed" },
      usage: { total_tokens: 6 },
    });
  });

  it("reports line numbers and rejects unknown versions or truncated tails", async () => {
    const workspace = await temporaryWorkspace();
    const invalid = join(workspace, "invalid.jsonl");
    const unknown = join(workspace, "unknown.jsonl");
    const truncated = join(workspace, "truncated.jsonl");
    await writeFile(invalid, "{}\nnot-json\n", "utf8");
    await writeFile(unknown, '{"schema_version":2}\n', "utf8");
    await writeFile(truncated, "{}", "utf8");

    await expect(readSession(invalid)).rejects.toThrow("line 1");
    await expect(readSession(unknown)).rejects.toThrow(
      "unsupported schema_version 2 at line 1",
    );
    await expect(readSession(truncated)).rejects.toThrow("complete JSONL line");
  });

  it("rejects broken sequence, missing start or terminal, and output mismatch", () => {
    const common = {
      run_id: "00000000-0000-4000-8000-000000000002",
      schema_version: 1 as const,
      session_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const valid: RunEvent[] = [
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000003",
        seq: 1,
        data: {
          command: "chat",
          input: { role: "user", text: "hello" },
          model: "gpt-test",
          provider: "openai",
          timeout_ms: 120_000,
          workspace: "D:\\Code\\bornagent",
        },
        type: "run.started",
      },
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000004",
        seq: 2,
        data: { delta: "hi" },
        type: "text.delta",
      },
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000005",
        seq: 3,
        data: { duration_ms: 10, output_chars: 2 },
        type: "run.completed",
      },
    ];

    expect(() => reconstructSession(valid)).not.toThrow();
    expect(() =>
      reconstructSession([
        valid[0] as RunEvent,
        { ...(valid[1] as RunEvent), seq: 3 },
        valid[2] as RunEvent,
      ]),
    ).toThrow("expected seq 2");
    expect(() => reconstructSession(valid.slice(1))).toThrow("run.started");
    expect(() => reconstructSession(valid.slice(0, 2))).toThrow("terminal");
    expect(() =>
      reconstructSession([
        valid[0] as RunEvent,
        valid[1] as RunEvent,
        {
          ...(valid[2] as Extract<RunEvent, { type: "run.completed" }>),
          data: { duration_ms: 10, output_chars: 99 },
        },
      ]),
    ).toThrow("output_chars");
  });

  it("reconstructs paired tools and allows interrupted tools only for failure", () => {
    const common = {
      run_id: "00000000-0000-4000-8000-000000000002",
      schema_version: 1 as const,
      session_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const started: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000003",
      seq: 1,
      data: {
        command: "chat",
        input: { role: "user", text: "inspect" },
        model: "gpt-test",
        provider: "openai",
        timeout_ms: 120_000,
        workspace: "D:\\Code\\bornagent",
      },
      type: "run.started",
    };
    const requested: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000004",
      seq: 2,
      data: {
        arguments_json: "{}",
        call_id: "call_1",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    };
    const completed: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000005",
      seq: 3,
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
    };
    const succeeded: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000006",
      seq: 4,
      data: { duration_ms: 2, output_chars: 0, tool_calls: 1 },
      type: "run.completed",
    };
    expect(reconstructSession([started, requested, completed, succeeded])).toMatchObject({
      toolCalls: [
        {
          completed: { call_id: "call_1" },
          interrupted: false,
          requested: { call_id: "call_1" },
        },
      ],
    });

    const failed: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000007",
      seq: 3,
      data: {
        category: "internal",
        code: "internal_error",
        duration_ms: 2,
        message: "failed",
        retryable: false,
      },
      type: "run.failed",
    };
    expect(reconstructSession([started, requested, failed])).toMatchObject({
      toolCalls: [{ interrupted: true }],
    });
    expect(() =>
      reconstructSession([
        started,
        requested,
        { ...succeeded, seq: 3, data: { ...succeeded.data, tool_calls: 0 } },
      ]),
    ).toThrow("interrupted");
  });
});

const phase5Common = {
  run_id: "00000000-0000-4000-8000-000000000202",
  schema_version: 1 as const,
  session_id: "00000000-0000-4000-8000-000000000201",
  timestamp: "2026-07-16T00:00:00.000Z",
};
const phase5PlanId = "a".repeat(64);
const phase5ApprovalId = "00000000-0000-4000-8000-000000000210";
const phase5Path = { kind: "modify" as const, path: "src/math.ts" };

function phase5Event(
  seq: number,
  draft: { readonly data: unknown; readonly type: RunEvent["type"] },
): RunEvent {
  return {
    ...phase5Common,
    ...draft,
    event_id: `00000000-0000-4000-8000-${String(300 + seq).padStart(12, "0")}`,
    seq,
  } as unknown as RunEvent;
}

function phase5TraceThroughDecision(
  decision: "approved" | "denied" = "approved",
): RunEvent[] {
  return [
    phase5Event(1, {
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
    }),
    phase5Event(2, {
      data: {
        input_kind: "user_task",
        max_steps: 4,
        remaining_duration_ms: 60_000,
        remaining_tokens: 4_000,
        remaining_tool_output_bytes: 64 * 1024,
        step: 1,
      },
      type: "agent.step.started",
    }),
    phase5Event(3, {
      data: {
        duration_ms: 2,
        outcome: "tool_call",
        step: 1,
        text_chars: 0,
        tool_call_id: "call_patch",
      },
      type: "agent.step.completed",
    }),
    phase5Event(4, {
      data: {
        arguments_json: '{"patch":"diff --git a/src/math.ts b/src/math.ts"}',
        call_id: "call_patch",
        step: 1,
        tool_name: "apply_patch",
      },
      type: "tool.call.requested",
    }),
    phase5Event(5, {
      data: {
        added_lines: 1,
        call_id: "call_patch",
        patch_sha256: "b".repeat(64),
        paths: [phase5Path],
        plan_id: phase5PlanId,
        preview: "+return 2;",
        removed_lines: 1,
        step: 1,
        truncated: false,
      },
      type: "patch.plan.created",
    }),
    phase5Event(6, {
      data: {
        action: "apply_patch",
        added_lines: 1,
        approval_request_id: phase5ApprovalId,
        call_id: "call_patch",
        paths: [phase5Path],
        plan_id: phase5PlanId,
        preview: "+return 2;",
        removed_lines: 1,
        step: 1,
        truncated: false,
      },
      type: "approval.requested",
    }),
    phase5Event(7, {
      data: {
        action: "apply_patch",
        approval_request_id: phase5ApprovalId,
        call_id: "call_patch",
        decision,
        plan_id: phase5PlanId,
        step: 1,
      },
      type: "approval.decided",
    }),
  ];
}

function phase5ApplyStarted(seq = 8): RunEvent {
  return phase5Event(seq, {
    data: {
      approval_request_id: phase5ApprovalId,
      call_id: "call_patch",
      files: [{ ...phase5Path, pre_sha256: "c".repeat(64) }],
      plan_id: phase5PlanId,
      step: 1,
    },
    type: "patch.apply.started",
  });
}

function phase5ApplyCompleted(
  seq = 9,
): Extract<RunEvent, { type: "patch.apply.completed" }> {
  return phase5Event(seq, {
    data: {
      added_lines: 1,
      approval_request_id: phase5ApprovalId,
      call_id: "call_patch",
      duration_ms: 4,
      files: [
        {
          ...phase5Path,
          post_sha256: "d".repeat(64),
          pre_sha256: "c".repeat(64),
        },
      ],
      journal_sha256: "e".repeat(64),
      plan_id: phase5PlanId,
      removed_lines: 1,
      step: 1,
    },
    type: "patch.apply.completed",
  }) as Extract<RunEvent, { type: "patch.apply.completed" }>;
}

describe("Phase 5 session reconstruction", () => {
  it("reconstructs none, completed, and unknown apply states conservatively", () => {
    const denied = phase5TraceThroughDecision("denied");
    denied.push(
      phase5Event(8, {
        data: {
          call_id: "call_patch",
          duration_ms: 1,
          error_category: "permission",
          error_code: "edit_denied",
          output: '{"ok":false}',
          retryable: false,
          status: "error",
          step: 1,
          tool_name: "apply_patch",
          truncated: false,
        },
        type: "tool.call.completed",
      }),
      phase5Event(9, {
        data: {
          category: "internal",
          code: "stopped_after_test",
          duration_ms: 5,
          message: "test terminal",
          retryable: false,
          steps: 1,
          tool_calls: 1,
        },
        type: "run.failed",
      }),
    );
    expect(reconstructSession(denied).patchAttempts).toMatchObject([
      { applyState: "none", approvalDecided: { decision: "denied" } },
    ]);

    const completed = phase5TraceThroughDecision();
    completed.push(
      phase5ApplyStarted(),
      phase5ApplyCompleted(),
      phase5Event(10, {
        data: {
          call_id: "call_patch",
          duration_ms: 5,
          output: '{"ok":true}',
          status: "success",
          step: 1,
          tool_name: "apply_patch",
          truncated: false,
        },
        type: "tool.call.completed",
      }),
      phase5Event(11, {
        data: {
          category: "internal",
          code: "stopped_after_test",
          duration_ms: 6,
          message: "test terminal",
          retryable: false,
          steps: 1,
          tool_calls: 1,
        },
        type: "run.failed",
      }),
    );
    expect(reconstructSession(completed).patchAttempts).toMatchObject([
      {
        applyCompleted: { journal_sha256: "e".repeat(64) },
        applyState: "completed",
        applyStarted: { call_id: "call_patch" },
      },
    ]);

    const interrupted = phase5TraceThroughDecision();
    interrupted.push(
      phase5ApplyStarted(),
      phase5Event(9, {
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
      }),
    );
    expect(reconstructSession(interrupted).patchAttempts).toMatchObject([
      { applyState: "unknown", applyStarted: { call_id: "call_patch" } },
    ]);
  });

  it("rejects mismatched approval and patch completion evidence", () => {
    const wrongApproval = phase5TraceThroughDecision();
    const decision = wrongApproval[6] as Extract<
      RunEvent,
      { type: "approval.decided" }
    >;
    wrongApproval[6] = {
      ...decision,
      data: {
        ...decision.data,
        approval_request_id: "00000000-0000-4000-8000-000000000299",
      },
    };
    wrongApproval.push(
      phase5Event(8, {
        data: {
          category: "internal",
          code: "stopped_after_test",
          duration_ms: 5,
          message: "test terminal",
          retryable: false,
          steps: 1,
          tool_calls: 0,
        },
        type: "run.failed",
      }),
    );
    expect(() => reconstructSession(wrongApproval)).toThrow(
      "approval decision",
    );

    const wrongCompletion = phase5TraceThroughDecision();
    const completed = phase5ApplyCompleted();
    const completedFile = completed.data.files[0];
    if (completedFile === undefined) throw new Error("test fixture is invalid");
    wrongCompletion.push(
      phase5ApplyStarted(),
      {
        ...completed,
        data: {
          ...completed.data,
          files: [
            {
              ...completedFile,
              path: "src/other.ts",
            },
          ],
        },
      },
      phase5Event(10, {
        data: {
          category: "internal",
          code: "stopped_after_test",
          duration_ms: 5,
          message: "test terminal",
          retryable: false,
          steps: 1,
          tool_calls: 0,
        },
        type: "run.failed",
      }),
    );
    expect(() => reconstructSession(wrongCompletion)).toThrow(
      "patch completion",
    );
  });
});
