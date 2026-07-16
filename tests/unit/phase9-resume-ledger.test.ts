import { describe, expect, it } from "vitest";

import { runEventSchema } from "../../src/events/run-event-schema.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { reconstructPendingEffectLedger } from "../../src/resume/pending-effect-ledger.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const APPROVAL_ID = "30000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "40000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function event(type: RunEvent["type"], data: unknown, seq: number): RunEvent {
  return runEventSchema.parse({
    data,
    event_id: `50000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    run_id: RUN_ID,
    schema_version: 1,
    seq,
    session_id: SESSION_ID,
    timestamp: "2026-07-17T00:00:00.000Z",
    type,
  });
}

function commandIdentity() {
  return {
    action_sha256: HASH_A,
    call_id: "call-command",
    execution_id: EXECUTION_ID,
    executor: "local" as const,
    step: 1,
  };
}

function commandRequested(seq: number): RunEvent {
  return event(
    "command.execution.requested",
    {
      ...commandIdentity(),
      approval_request_id: APPROVAL_ID,
      cwd: ".",
      executable: "node",
      purpose: "inspect",
      redacted_argv: ["node"],
    },
    seq,
  );
}

function commandStarted(seq: number): RunEvent {
  return event("command.started", commandIdentity(), seq);
}

function commandCompleted(seq: number): RunEvent {
  return event(
    "command.completed",
    {
      ...commandIdentity(),
      cleanup_verified: true,
      duration_ms: 2,
      exit_code: 0,
      signal: null,
      stderr_bytes: 0,
      stdout_bytes: 0,
      termination: "exit",
      total_bytes: 0,
      truncated: false,
    },
    seq,
  );
}

function toolRequested(toolName: string, callId: string, seq: number): RunEvent {
  return event(
    "tool.call.requested",
    {
      arguments_json: "{}",
      call_id: callId,
      provider_response_id: "response-1",
      step: 1,
      tool_name: toolName,
    },
    seq,
  );
}

function toolCompleted(toolName: string, callId: string, seq: number): RunEvent {
  return event(
    "tool.call.completed",
    {
      call_id: callId,
      duration_ms: 1,
      output: "{}",
      status: "success",
      step: 1,
      tool_name: toolName,
      truncated: false,
    },
    seq,
  );
}

describe("Phase 9 pending effect ledger", () => {
  it("blocks requested-without-completed commands as unknown effects", () => {
    const requested = reconstructPendingEffectLedger([commandRequested(1)]);
    const started = reconstructPendingEffectLedger([
      commandRequested(1),
      commandStarted(2),
    ]);
    const completed = reconstructPendingEffectLedger([
      commandRequested(1),
      commandStarted(2),
      commandCompleted(3),
    ]);

    expect(requested.unknownCommands).toEqual([
      expect.objectContaining({ executionId: EXECUTION_ID, stage: "requested" }),
    ]);
    expect(started.unknownCommands).toEqual([
      expect.objectContaining({ executionId: EXECUTION_ID, stage: "started" }),
    ]);
    expect(completed.unknownCommands).toEqual([]);
  });

  it("expires every historical approval including an approved digest", () => {
    const ledger = reconstructPendingEffectLedger([
      event(
        "approval.requested",
        {
          action: "run_command",
          action_kind: "run_command",
          action_sha256: HASH_A,
          approval_request_id: APPROVAL_ID,
          call_id: "call-command",
          cwd: ".",
          executable: "node",
          preview: "node",
          purpose: "inspect",
          redacted_argv: ["node"],
          step: 1,
          truncated: false,
        },
        1,
      ),
      event(
        "approval.decided",
        {
          action: "run_command",
          action_kind: "run_command",
          action_sha256: HASH_A,
          approval_request_id: APPROVAL_ID,
          call_id: "call-command",
          decision: "approved",
          step: 1,
        },
        2,
      ),
    ]);

    expect(ledger.approvalsToExpire).toEqual([
      {
        actionKind: "run_command",
        actionSha256: HASH_A,
        approvalRequestId: APPROVAL_ID,
        callId: "call-command",
        decision: "approved",
        sourceRunId: RUN_ID,
      },
    ]);
  });

  it("projects predicted patch hashes and one inherited pending call", () => {
    const ledger = reconstructPendingEffectLedger([
      toolRequested("apply_patch", "call-patch", 1),
      event(
        "patch.apply.started",
        {
          approval_request_id: APPROVAL_ID,
          call_id: "call-patch",
          files: [
            {
              kind: "modify",
              path: "src/a.ts",
              post_sha256: HASH_B,
              pre_sha256: HASH_A,
            },
          ],
          plan_id: HASH_C,
          step: 1,
        },
        2,
      ),
    ]);

    expect(ledger.pendingPatches).toEqual([
      expect.objectContaining({
        callId: "call-patch",
        files: [
          expect.objectContaining({
            path: "src/a.ts",
            postSha256: HASH_B,
            preSha256: HASH_A,
          }),
        ],
      }),
    ]);
    expect(ledger.pendingToolCalls).toEqual([
      expect.objectContaining({ callId: "call-patch", kind: "apply_patch" }),
    ]);
  });

  it("recovers completed inner effects without redoing them", () => {
    const events = [
      toolRequested("run_command", "call-command", 1),
      commandRequested(2),
      commandStarted(3),
      commandCompleted(4),
    ];
    const missingOuter = reconstructPendingEffectLedger(events);
    const closedOuter = reconstructPendingEffectLedger([
      ...events,
      toolCompleted("run_command", "call-command", 5),
    ]);

    expect(missingOuter.recoveredInnerEffects).toEqual([
      expect.objectContaining({
        callId: "call-command",
        effectId: EXECUTION_ID,
        kind: "command",
        observation: {
          output:
            '{"cleanup_verified":true,"duration_ms":2,"exit_code":0,"signal":null,"stderr":"","stdout":"","termination":"exit","truncated":false,"ok":true}',
          status: "success",
          truncated: false,
        },
      }),
    ]);
    expect(missingOuter.pendingToolCalls).toHaveLength(1);
    expect(closedOuter.recoveredInnerEffects).toEqual([]);
    expect(closedOuter.pendingToolCalls).toEqual([]);
  });
});
