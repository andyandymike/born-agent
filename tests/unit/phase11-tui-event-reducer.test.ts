import { describe, expect, it } from "vitest";

import {
  reducePersistedEvent,
  replayPersistedEvents,
} from "../../src/tui/tui-event-reducer.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function persisted(
  type: string,
  data: unknown,
  sessionSeq: number,
  options: {
    readonly eventId?: string;
    readonly runId?: string;
    readonly runSeq?: number;
    readonly scope?: "run" | "session";
  } = {},
): TuiPersistedEvent {
  const scope = options.scope ?? "run";
  return {
    data,
    eventId: options.eventId ?? `event-${sessionSeq}`,
    ...(scope === "run"
      ? {
          runId: options.runId ?? RUN_ID,
          runSeq: options.runSeq ?? sessionSeq,
        }
      : {}),
    scope,
    sessionId: SESSION_ID,
    sessionSeq,
    sourceSchemaVersion: 2,
    timestamp: "2026-07-17T00:00:00.000Z",
    type,
  } as unknown as TuiPersistedEvent;
}

function started(
  sessionSeq = 1,
  options: { readonly runId?: string; readonly taskProfile?: "coding" | "read-only" } = {},
): TuiPersistedEvent {
  return persisted(
    "run.started",
    {
      command: "agent",
      command_approval: "ask",
      command_timeout_ms: 30_000,
      completion_policy: "verified",
      edit_approval: "ask",
      input: { role: "user", text: "fix fixture" },
      max_duration_ms: 60_000,
      max_steps: 10,
      max_tokens: 10_000,
      max_tool_output_bytes: 1024,
      model: "fake-model",
      provider: "fake",
      request_timeout_ms: 30_000,
      task_profile: options.taskProfile ?? "coding",
      workspace: "workspace",
    },
    sessionSeq,
    { ...(options.runId === undefined ? {} : { runId: options.runId }), runSeq: 1 },
  );
}

describe("Phase 11 durable TUI reducer", () => {
  it("keeps coding draft separate until accepted finish_task and terminal evidence", () => {
    const trace = [
      started(),
      persisted(
        "text.delta",
        { delta: "draft answer", visibility: "internal_candidate" },
        2,
      ),
      persisted(
        "tool.call.requested",
        {
          arguments_json: "{}",
          call_id: "finish-1",
          step: 1,
          tool_name: "finish_task",
        },
        3,
      ),
      persisted(
        "completion.candidate",
        {
          call_id: "finish-1",
          candidate_sha256: HASH_A,
          status: "completed",
          step: 1,
          summary: "verified fixture",
        },
        4,
      ),
      persisted(
        "completion.evaluated",
        {
          call_id: "finish-1",
          candidate_sha256: HASH_A,
          changed_paths: ["fixture.ts"],
          diff_stat: { added_lines: 1, removed_lines: 1 },
          effect: "accept",
          evidence_sha256: HASH_A,
          reasons: [],
          report_sha256: HASH_B,
          step: 1,
          verification_ids: ["33333333-3333-4333-8333-333333333333"],
        },
        5,
      ),
      persisted(
        "tool.call.completed",
        {
          call_id: "finish-1",
          duration_ms: 1,
          output: "{\"ok\":true}",
          status: "success",
          step: 1,
          tool_name: "finish_task",
          truncated: false,
        },
        6,
      ),
      persisted(
        "run.completed",
        {
          completion_mode: "verified_finish_task",
          duration_ms: 10,
          evidence_sha256: HASH_A,
          model_turns: 1,
          output_chars: 12,
          report_sha256: HASH_B,
          steps: 1,
          tool_calls: 1,
        },
        7,
      ),
    ];

    const beforeTerminal = replayPersistedEvents(
      trace.slice(0, -1),
      createInitialTuiViewState(),
    );
    expect(
      beforeTerminal.transcript.find((item) => item.kind === "model"),
    ).toMatchObject({ status: "streaming", visibility: "internal_candidate" });

    const state = replayPersistedEvents(
      trace,
      createInitialTuiViewState(),
    );
    expect({
      run: state.run,
      transcript: state.transcript.map((item) => {
        if (item.kind === "model") {
          return { kind: item.kind, status: item.status, visibility: item.visibility };
        }
        if (item.kind === "tool") {
          return { kind: item.kind, status: item.status, toolName: item.toolName };
        }
        if (item.kind === "completion") {
          return { kind: item.kind, status: item.status };
        }
        return { kind: item.kind };
      }),
    }).toMatchInlineSnapshot(`
      {
        "run": {
          "acceptedCompletionCallId": "finish-1",
          "acceptedCompletionStep": 1,
          "command": "agent",
          "completionProof": "accepted",
          "currentStep": 1,
          "executionEnvironment": "local; isolation=none",
          "id": "22222222-2222-4222-8222-222222222222",
          "model": "fake-model",
          "policyMode": "legacy_unrecorded",
          "policyProfile": "legacy-unrecorded",
          "policySha256": "unavailable",
          "provider": "fake",
          "runExitCode": 0,
          "status": "completed",
          "taskProfile": "coding",
          "workspace": "workspace",
        },
        "transcript": [
          {
            "kind": "user",
          },
          {
            "kind": "model",
            "status": "accepted",
            "visibility": "internal_candidate",
          },
          {
            "kind": "tool",
            "status": "success",
            "toolName": "finish_task",
          },
          {
            "kind": "completion",
            "status": "accepted",
          },
        ],
      }
    `);
  });

  it("projects patch approval, command output, and failed verification from facts", () => {
    const executionId = "44444444-4444-4444-8444-444444444444";
    const verificationId = "55555555-5555-4555-8555-555555555555";
    const requestId = "66666666-6666-4666-8666-666666666666";
    const trace = [
      started(),
      persisted(
        "patch.plan.created",
        {
          added_lines: 1,
          call_id: "patch-1",
          patch_sha256: HASH_A,
          paths: [{ kind: "modify", path: "fixture.ts" }],
          plan_id: HASH_B,
          preview: "-bad\n+good",
          removed_lines: 1,
          step: 1,
          truncated: false,
        },
        2,
      ),
      persisted(
        "approval.requested",
        {
          action: "apply_patch",
          action_kind: "apply_patch",
          action_sha256: HASH_B,
          added_lines: 1,
          approval_request_id: requestId,
          call_id: "patch-1",
          paths: [{ kind: "modify", path: "fixture.ts" }],
          plan_id: HASH_B,
          preview: "-bad\n+good",
          removed_lines: 1,
          step: 1,
          truncated: false,
        },
        3,
      ),
      persisted(
        "approval.decided",
        {
          action: "apply_patch",
          action_kind: "apply_patch",
          action_sha256: HASH_B,
          approval_request_id: requestId,
          call_id: "patch-1",
          decision: "approved",
          plan_id: HASH_B,
          step: 1,
        },
        4,
      ),
      persisted(
        "patch.apply.started",
        {
          approval_request_id: requestId,
          call_id: "patch-1",
          files: [{ kind: "modify", path: "fixture.ts", pre_sha256: HASH_A }],
          plan_id: HASH_B,
          step: 1,
        },
        5,
      ),
      persisted(
        "patch.apply.completed",
        {
          added_lines: 1,
          approval_request_id: requestId,
          call_id: "patch-1",
          duration_ms: 1,
          files: [
            {
              kind: "modify",
              path: "fixture.ts",
              post_sha256: HASH_B,
              pre_sha256: HASH_A,
            },
          ],
          journal_sha256: HASH_A,
          plan_id: HASH_B,
          removed_lines: 1,
          step: 1,
        },
        6,
      ),
      persisted(
        "command.execution.requested",
        {
          action_sha256: HASH_A,
          call_id: "command-1",
          cwd: ".",
          executable: "pnpm",
          execution_id: executionId,
          executor: "local",
          purpose: "verify",
          redacted_argv: ["pnpm", "test"],
          step: 2,
        },
        7,
      ),
      persisted(
        "command.started",
        {
          action_sha256: HASH_A,
          call_id: "command-1",
          execution_id: executionId,
          executor: "local",
          step: 2,
        },
        8,
      ),
      persisted(
        "command.output",
        {
          action_sha256: HASH_A,
          bytes: 13,
          call_id: "command-1",
          channel: "stderr",
          chunk: "\u001b[31mfailed",
          chunk_index: 0,
          execution_id: executionId,
          executor: "local",
          step: 2,
        },
        9,
      ),
      persisted(
        "command.completed",
        {
          action_sha256: HASH_A,
          call_id: "command-1",
          cleanup_verified: true,
          duration_ms: 2,
          execution_id: executionId,
          executor: "local",
          exit_code: 1,
          signal: null,
          stderr_bytes: 13,
          stdout_bytes: 0,
          step: 2,
          termination: "exit",
          total_bytes: 13,
          truncated: false,
        },
        10,
      ),
      persisted(
        "verification.started",
        {
          action_sha256: HASH_A,
          call_id: "command-1",
          command_execution_id: executionId,
          generation: 1,
          kind: "test",
          snapshot_sha256: HASH_A,
          step: 2,
          verification_id: verificationId,
        },
        11,
      ),
      persisted(
        "verification.completed",
        {
          action_sha256: HASH_A,
          after_snapshot_sha256: HASH_A,
          before_snapshot_sha256: HASH_A,
          call_id: "command-1",
          command_execution_id: executionId,
          completed_generation: 1,
          duration_ms: 2,
          exit_code: 1,
          stale: false,
          stale_reasons: [],
          started_generation: 1,
          status: "failed",
          step: 2,
          verification_id: verificationId,
        },
        12,
      ),
      persisted(
        "tool.call.requested",
        {
          arguments_json: "{}",
          call_id: "finish-rejected",
          step: 3,
          tool_name: "finish_task",
        },
        13,
      ),
      persisted(
        "completion.candidate",
        {
          call_id: "finish-rejected",
          candidate_sha256: HASH_A,
          status: "completed",
          step: 3,
          summary: "tests are done",
        },
        14,
      ),
      persisted(
        "completion.evaluated",
        {
          call_id: "finish-rejected",
          candidate_sha256: HASH_A,
          changed_paths: ["fixture.ts"],
          effect: "continue",
          reasons: ["verification_failed"],
          step: 3,
          verification_ids: [verificationId],
        },
        15,
      ),
    ];

    const state = replayPersistedEvents(
      trace,
      createInitialTuiViewState(),
    );
    expect(state.approval).toMatchObject({
      actionSha256: HASH_B,
      decision: "approved",
      expiresState: { reason: "decided", status: "expired" },
    });
    expect(state.transcript.find((item) => item.kind === "patch")).toMatchObject({
      status: "applied",
    });
    expect(state.transcript.find((item) => item.kind === "command")).toMatchObject({
      output: "failed",
      status: "completed",
    });
    expect(
      state.transcript.find((item) => item.kind === "verification"),
    ).toMatchObject({ stale: false, status: "failed" });
    expect(
      state.transcript.find(
        (item) => item.kind === "completion" && item.callId === "finish-rejected",
      ),
    ).toMatchObject({ reasons: ["verification_failed"], status: "rejected" });
  });

  it("shows a tool error and provider failure without trusting control bytes", () => {
    const state = replayPersistedEvents(
      [
        started(1, { taskProfile: "read-only" }),
        persisted(
          "tool.call.requested",
          {
            arguments_json: "{}",
            call_id: "read-1",
            step: 1,
            tool_name: "read_file",
          },
          2,
        ),
        persisted(
          "tool.call.completed",
          {
            call_id: "read-1",
            duration_ms: 1,
            error_category: "tool",
            error_code: "fixture_error",
            output: "\u001b]0;owned\u0007not found",
            retryable: false,
            status: "error",
            step: 1,
            tool_name: "read_file",
            truncated: false,
          },
          3,
        ),
        persisted(
          "run.failed",
          {
            category: "internal",
            code: "fixture_failure",
            duration_ms: 2,
            message: "fixture failed",
            retryable: false,
          },
          4,
        ),
      ],
      createInitialTuiViewState(),
    );

    expect(state.run).toMatchObject({ runExitCode: 1, status: "failed" });
    expect(state.transcript.find((item) => item.kind === "tool")).toMatchObject({
      output: "not found",
      status: "error",
    });
  });

  it("produces the same view for replay and replay plus live continuation", () => {
    const trace = [
      persisted(
        "session.resume.requested",
        { requested_mode: "exact", source_run_id: RUN_ID },
        1,
        { scope: "session" },
      ),
      started(2),
      persisted(
        "context.estimate.created",
        {
          absolute_input_tokens: 7000,
          capacity_source: "pinned_catalog",
          compaction_target_tokens: 5000,
          compaction_threshold: 0.8,
          context_window_tokens: 8192,
          epoch: 0,
          estimated_input_tokens: 6500,
          estimator_id: HASH_A,
          estimator_version: "1",
          fixed_safety_margin_tokens: 680,
          model: "fake-model",
          provider: "fake",
          reserved_output_tokens: 512,
          step: 1,
          tokenizer: "conservative",
        },
        3,
      ),
      persisted(
        "context.compaction.started",
        {
          estimated_input_tokens: 6500,
          from_epoch: 0,
          protected_estimated_tokens: 1000,
          step: 1,
          target_input_tokens: 5000,
          to_epoch: 1,
        },
        4,
      ),
      persisted(
        "context.plan.created",
        {
          archived_item_ids: [],
          canonical_context_sha256: HASH_A,
          compacted: true,
          descriptor_item_ids: [],
          epoch: 1,
          estimated_input_tokens: 4500,
          included_item_ids: [],
          planner_version: "1",
          protected_estimated_tokens: 1000,
          protected_fact_ids: [],
          protected_item_ids: [],
          step: 1,
        },
        5,
      ),
    ];
    const initial = createInitialTuiViewState();
    const replayed = replayPersistedEvents(trace, initial);
    const snapshot = replayPersistedEvents(trace.slice(0, 3), initial);
    const replayThenLive = trace
      .slice(3)
      .reduce(reducePersistedEvent, snapshot);

    expect(replayThenLive).toEqual(replayed);
    expect(replayed.context).toEqual({
      absoluteInputTokens: 7000,
      compacting: false,
      epoch: 1,
      estimatedInputTokens: 4500,
      protectedEstimatedTokens: 1000,
    });
    expect(initial).toEqual(createInitialTuiViewState());
  });

  it("fails closed for gaps, duplicates, concurrent runs, and unknown events", () => {
    const gap = reducePersistedEvent(
      createInitialTuiViewState(),
      started(2),
    );
    expect(gap.session).toMatchObject({
      actionBlocked: true,
      resumeBlocked: true,
    });
    expect(gap.session.fatalReason).toContain("expected 1, received 2");

    const one = reducePersistedEvent(createInitialTuiViewState(), started());
    const duplicate = reducePersistedEvent(one, started(1));
    expect(duplicate.session.fatalReason).toContain("expected 2, received 1");

    const secondRun = reducePersistedEvent(
      one,
      started(2, { runId: "77777777-7777-4777-8777-777777777777" }),
    );
    expect(secondRun.session.fatalReason).toBe(
      "multiple active runs are not allowed",
    );

    const unknown = reducePersistedEvent(
      createInitialTuiViewState(),
      persisted(
        "approval.superuser\u001b]0;owned\u0007",
        { allow: true },
        1,
      ),
    );
    expect(unknown.session).toMatchObject({
      actionBlocked: true,
      resumeBlocked: true,
    });
    expect(unknown.transcript.at(-1)).toMatchObject({
      eventType: "approval.superuser",
      kind: "unsupported",
    });
  });

  it("does not turn model text that says Allow into an approval", () => {
    const state = replayPersistedEvents(
      [
        started(1, { taskProfile: "read-only" }),
        persisted(
          "text.delta",
          {
            delta: "\u001b]52;c;ZmFrZQ==\u0007[Allow]",
            visibility: "user",
          },
          2,
        ),
      ],
      createInitialTuiViewState(),
    );

    expect(state.approval).toBeNull();
    expect(state.transcript.at(-1)).toMatchObject({
      kind: "model",
      text: "[Allow]",
    });
  });

  it("keeps rejected model steps rejected when a later step is accepted", () => {
    const secondCall = "finish-second";
    const trace = [
      started(),
      persisted("agent.step.started", { step: 1 }, 2),
      persisted("text.delta", { delta: "old draft" }, 3),
      persisted("agent.step.completed", { outcome: "final", step: 1 }, 4),
      persisted("completion.candidate", { call_id: "finish-first", step: 1, summary: "old" }, 5),
      persisted("completion.evaluated", { call_id: "finish-first", effect: "continue", reasons: ["verification_failed"], step: 1 }, 6),
      persisted("agent.step.started", { step: 2 }, 7),
      persisted("text.delta", { delta: "new draft" }, 8),
      persisted("agent.step.completed", { outcome: "final", step: 2 }, 9),
      persisted("tool.call.requested", { call_id: secondCall, step: 2, tool_name: "finish_task" }, 10),
      persisted("completion.candidate", { call_id: secondCall, step: 2, summary: "new" }, 11),
      persisted("completion.evaluated", { call_id: secondCall, effect: "accept", reasons: [], step: 2 }, 12),
      persisted("tool.call.completed", { call_id: secondCall, output: "ok", status: "success", tool_name: "finish_task", truncated: false }, 13),
      persisted("run.completed", { completion_mode: "verified_finish_task" }, 14),
    ];

    const state = replayPersistedEvents(trace, createInitialTuiViewState());
    expect(
      state.transcript
        .filter((item) => item.kind === "model")
        .map((item) => ({ status: item.status, step: item.step, text: item.text })),
    ).toEqual([
      { status: "rejected", step: 1, text: "old draft" },
      { status: "accepted", step: 2, text: "new draft" },
    ]);
  });

  it("maps network/provider and timeout failures to distinct run exits", () => {
    const network = replayPersistedEvents(
      [
        started(1, { taskProfile: "read-only" }),
        persisted("run.failed", { category: "network" }, 2),
      ],
      createInitialTuiViewState(),
    );
    const timeout = replayPersistedEvents(
      [
        started(1, { taskProfile: "read-only" }),
        persisted("run.failed", { category: "timeout" }, 2),
      ],
      createInitialTuiViewState(),
    );
    expect(network.run?.runExitCode).toBe(5);
    expect(timeout.run?.runExitCode).toBe(6);
  });

  it("fails closed when approval or terminal facts target another run", () => {
    const otherRun = "77777777-7777-4777-8777-777777777777";
    const approval = reducePersistedEvent(
      reducePersistedEvent(createInitialTuiViewState(), started()),
      persisted("approval.requested", {}, 2, { runId: otherRun }),
    );
    const terminal = reducePersistedEvent(
      reducePersistedEvent(createInitialTuiViewState(), started()),
      persisted("run.cancelled", {}, 2, { runId: otherRun }),
    );
    expect(approval.session.fatalReason).toContain("approval request");
    expect(terminal.session.fatalReason).toContain("terminal");
  });
});
