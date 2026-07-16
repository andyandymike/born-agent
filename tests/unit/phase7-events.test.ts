import { describe, expect, it } from "vitest";

import {
  createPersistedCompletionEvidence,
  type PersistedCompletionEvidence,
} from "../../src/completion/completion-evidence-schema.js";
import { hashVerificationSnapshot } from "../../src/completion/verification-snapshot.js";
import {
  EventPublisher,
  type RunEventRenderer,
} from "../../src/events/event-publisher.js";
import { runEventSchema } from "../../src/events/run-event-schema.js";
import { ConsoleEventRenderer } from "../../src/render/console-event-renderer.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  createMemoryIO,
  InMemorySessionWriter,
} from "../helpers.js";

const actionSha256 = "a".repeat(64);
const candidateSha256 = "c".repeat(64);
const planSha256 = "f".repeat(64);
const journalSha256 = "1".repeat(64);
const preSha256 = "2".repeat(64);
const postSha256 = "3".repeat(64);
const patchApprovalId = "00000000-0000-4000-8000-000000000701";
const commandExecutionId = "00000000-0000-4000-8000-000000000702";
const verificationId = "00000000-0000-4000-8000-000000000703";
const unknownCommandExecutionId = "00000000-0000-4000-8000-000000000704";

function verificationSnapshot() {
  return {
    changedFiles: [{ path: "src/a.ts", sha256: postSha256 }],
    commandInputs: [{ path: "fixture.mjs", sha256: "4".repeat(64) }],
    deletedFiles: [] as never[],
    generation: 1,
    gitHeadSha256: "5".repeat(64),
    gitIndexSha256: "6".repeat(64),
    journalSha256,
    sourceStateSha256: "7".repeat(64),
  };
}

const snapshotSha256 = hashVerificationSnapshot(verificationSnapshot());

function verifiedEvidence(summary: string): PersistedCompletionEvidence {
  const snapshot = verificationSnapshot();
  return createPersistedCompletionEvidence({
    changedByRun: [{
      addedLines: 1,
      kind: "modify",
      path: "src/a.ts",
      postimageSha256: postSha256,
      preimageSha256: preSha256,
      removedLines: 1,
    }],
    diffCheck: {
      checkedPaths: ["src/a.ts"],
      detail: "isolated diff passed",
      diffSha256: "8".repeat(64),
      status: "passed",
    },
    finalSnapshot: snapshot,
    modelEvidence: {
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    },
    modelNarrative: summary,
    preExistingDirtyPaths: [],
    runId: "00000000-0000-4000-8000-000000000002",
    sessionId: "00000000-0000-4000-8000-000000000001",
    verifications: [{
      actionSha256,
      afterSnapshot: snapshot,
      approved: true,
      argv: ["node", "fixture.mjs"],
      beforeSnapshot: snapshot,
      classification: "test",
      completedEventPersisted: true,
      cwd: ".",
      durationMs: 7,
      executionId: commandExecutionId,
      exitCode: 0,
      generationAtCompletion: 1,
      generationAtStart: 1,
      inputsKnown: true,
      output: {
        artifactRefs: [],
        eventRefs: [`command:${commandExecutionId}`],
        stderrSummary: "",
        stdoutSummary: "",
        totalBytes: 0,
        truncated: false,
      },
      purpose: "verify",
      stale: false,
      verificationId,
    }],
  });
}

function forgedVerifiedEvidence(summary: string): PersistedCompletionEvidence {
  const projection = verifiedEvidence(summary);
  if (projection.outcome !== "completed") throw new Error("expected completed evidence");
  return createPersistedCompletionEvidence({
    ...projection.evidence,
    verifications: projection.evidence.verifications.map((verification) => ({
      ...verification,
      argv: ["node", "forged-fixture.mjs"],
    })),
  });
}

function unknownInputsEvidence(summary: string): PersistedCompletionEvidence {
  const projection = verifiedEvidence(summary);
  if (projection.outcome !== "completed") throw new Error("expected completed evidence");
  return createPersistedCompletionEvidence({
    ...projection.evidence,
    reason: "verification_inputs_unknown",
    verifications: projection.evidence.verifications.map((verification) => ({
      ...verification,
      inputsKnown: false,
    })),
  });
}

function blockedEvidence(summary: string): PersistedCompletionEvidence {
  return createPersistedCompletionEvidence({
    changedByRun: [],
    diffCheck: {
      checkedPaths: [],
      detail: "no run-local changes",
      diffSha256: "0".repeat(64),
      status: "failed",
    },
    finalSnapshot: null,
    modelEvidence: {
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    },
    modelNarrative: summary,
    preExistingDirtyPaths: [],
    reason: "task_blocked",
    runId: "00000000-0000-4000-8000-000000000002",
    sessionId: "00000000-0000-4000-8000-000000000001",
    verifications: [],
  });
}

function createPublisher(
  renderer: RunEventRenderer = { render: () => undefined },
): { publisher: EventPublisher; writer: InMemorySessionWriter } {
  let id = 1_000;
  const writer = new InMemorySessionWriter();
  return {
    publisher: new EventPublisher({
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      renderer,
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      timestamp: () => "2026-07-17T00:00:00.000Z",
      writer,
    }),
    writer,
  };
}

async function startCoding(publisher: EventPublisher): Promise<void> {
  await publisher.publish({
    data: {
      command: "agent",
      command_approval: "ask",
      command_timeout_ms: 120_000,
      completion_policy: "verified",
      edit_approval: "ask",
      input: { role: "user", text: "fix and verify" },
      max_command_output_bytes: 131_072,
      max_duration_ms: 60_000,
      max_steps: 6,
      max_tokens: 6_000,
      max_tool_output_bytes: 131_072,
      model: "fake",
      provider: "ollama",
      report_format: "text",
      request_timeout_ms: 30_000,
      require_verification: "auto",
      task_profile: "coding",
      tools: ["apply_patch", "run_command", "finish_task"],
      tools_enabled: true,
      workspace: "D:\\Code\\bornagent",
    },
    type: "run.started",
  });
}

async function publishToolStep(
  publisher: EventPublisher,
  step: number,
  callId: string,
): Promise<void> {
  await publisher.publish({
    data: {
      input_kind: step === 1 ? "user_task" : "tool_result",
      max_steps: 6,
      remaining_duration_ms: 60_000,
      remaining_tokens: 6_000,
      remaining_tool_output_bytes: 131_072,
      step,
    },
    type: "agent.step.started",
  });
  await publisher.publish({
    data: {
      input_tokens: 1,
      output_tokens: 1,
      step,
      total_tokens: 2,
    },
    type: "model.usage",
  });
  await publisher.publish({
    data: {
      duration_ms: 1,
      outcome: "tool_call",
      step,
      text_chars: 0,
      tool_call_id: callId,
    },
    type: "agent.step.completed",
  });
}

async function publishPatch(publisher: EventPublisher): Promise<void> {
  await publishToolStep(publisher, 1, "call_patch");
  await publisher.publish({
    data: {
      arguments_json: '{"patch":"fixture"}',
      call_id: "call_patch",
      step: 1,
      tool_name: "apply_patch",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      call_id: "call_patch",
      patch_sha256: planSha256,
      paths: [{ kind: "modify", path: "src/a.ts" }],
      plan_id: planSha256,
      preview: "@@ -1 +1 @@",
      removed_lines: 1,
      step: 1,
      truncated: false,
    },
    type: "patch.plan.created",
  });
  await publisher.publish({
    data: {
      action: "apply_patch",
      action_kind: "apply_patch",
      action_sha256: planSha256,
      added_lines: 1,
      approval_request_id: patchApprovalId,
      call_id: "call_patch",
      paths: [{ kind: "modify", path: "src/a.ts" }],
      plan_id: planSha256,
      preview: "@@ -1 +1 @@",
      removed_lines: 1,
      step: 1,
      truncated: false,
    },
    type: "approval.requested",
  });
  await publisher.publish({
    data: {
      action: "apply_patch",
      action_kind: "apply_patch",
      action_sha256: planSha256,
      approval_request_id: patchApprovalId,
      call_id: "call_patch",
      decision: "approved",
      plan_id: planSha256,
      step: 1,
    },
    type: "approval.decided",
  });
  await publisher.publish({
    data: {
      approval_request_id: patchApprovalId,
      call_id: "call_patch",
      files: [
        { kind: "modify", path: "src/a.ts", pre_sha256: preSha256 },
      ],
      plan_id: planSha256,
      step: 1,
    },
    type: "patch.apply.started",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      approval_request_id: patchApprovalId,
      call_id: "call_patch",
      duration_ms: 2,
      files: [
        {
          kind: "modify",
          path: "src/a.ts",
          post_sha256: postSha256,
          pre_sha256: preSha256,
        },
      ],
      journal_sha256: journalSha256,
      plan_id: planSha256,
      removed_lines: 1,
      step: 1,
    },
    type: "patch.apply.completed",
  });
  await publisher.publish({
    data: {
      call_id: "call_patch",
      duration_ms: 3,
      output: '{"ok":true}',
      status: "success",
      step: 1,
      tool_name: "apply_patch",
      truncated: false,
    },
    type: "tool.call.completed",
  });
}

async function publishRestorePatch(publisher: EventPublisher): Promise<void> {
  const callId = "call_restore";
  const approvalId = "00000000-0000-4000-8000-000000000704";
  const restorePlanSha256 = "d".repeat(64);
  await publishToolStep(publisher, 2, callId);
  await publisher.publish({
    data: {
      arguments_json: '{"patch":"restore fixture"}',
      call_id: callId,
      step: 2,
      tool_name: "apply_patch",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      call_id: callId,
      patch_sha256: restorePlanSha256,
      paths: [{ kind: "modify", path: "src/a.ts" }],
      plan_id: restorePlanSha256,
      preview: "@@ -1 +1 @@",
      removed_lines: 1,
      step: 2,
      truncated: false,
    },
    type: "patch.plan.created",
  });
  await publisher.publish({
    data: {
      action: "apply_patch",
      action_kind: "apply_patch",
      action_sha256: restorePlanSha256,
      added_lines: 1,
      approval_request_id: approvalId,
      call_id: callId,
      paths: [{ kind: "modify", path: "src/a.ts" }],
      plan_id: restorePlanSha256,
      preview: "@@ -1 +1 @@",
      removed_lines: 1,
      step: 2,
      truncated: false,
    },
    type: "approval.requested",
  });
  await publisher.publish({
    data: {
      action: "apply_patch",
      action_kind: "apply_patch",
      action_sha256: restorePlanSha256,
      approval_request_id: approvalId,
      call_id: callId,
      decision: "approved",
      plan_id: restorePlanSha256,
      step: 2,
    },
    type: "approval.decided",
  });
  await publisher.publish({
    data: {
      approval_request_id: approvalId,
      call_id: callId,
      files: [{ kind: "modify", path: "src/a.ts", pre_sha256: postSha256 }],
      plan_id: restorePlanSha256,
      step: 2,
    },
    type: "patch.apply.started",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      approval_request_id: approvalId,
      call_id: callId,
      duration_ms: 2,
      files: [{
        kind: "modify",
        path: "src/a.ts",
        post_sha256: preSha256,
        pre_sha256: postSha256,
      }],
      journal_sha256: "e".repeat(64),
      plan_id: restorePlanSha256,
      removed_lines: 1,
      step: 2,
    },
    type: "patch.apply.completed",
  });
  await publisher.publish({
    data: {
      call_id: callId,
      duration_ms: 3,
      output: '{"ok":true}',
      status: "success",
      step: 2,
      tool_name: "apply_patch",
      truncated: false,
    },
    type: "tool.call.completed",
  });
}

async function publishVerification(
  publisher: EventPublisher,
  options: {
    readonly commandExitCode?: number;
    readonly termination?: "exit" | "timeout";
    readonly verificationExitCode?: number;
    readonly verificationStatus?: "failed" | "passed";
  } = {},
): Promise<void> {
  await publishToolStep(publisher, 2, "call_verify");
  await publisher.publish({
    data: {
      arguments_json: '{"executable":"node"}',
      call_id: "call_verify",
      step: 2,
      tool_name: "run_command",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      action_kind: "run_command",
      action_sha256: actionSha256,
      call_id: "call_verify",
      effect: "allow",
      policy_version: "local-free-v1",
      rule_id: "fixture-verify",
      step: 2,
    },
    type: "permission.evaluated",
  });
  await publisher.publish({
    data: {
      action_sha256: actionSha256,
      call_id: "call_verify",
      cwd: ".",
      executable: "node",
      execution_id: commandExecutionId,
      executor: "local",
      purpose: "verify",
      redacted_argv: ["node", "fixture.mjs"],
      step: 2,
    },
    type: "command.execution.requested",
  });
  await publisher.publish({
    data: {
      action_sha256: actionSha256,
      call_id: "call_verify",
      command_execution_id: commandExecutionId,
      generation: 1,
      kind: "test",
      snapshot_sha256: snapshotSha256,
      step: 2,
      verification_id: verificationId,
    },
    type: "verification.started",
  });
  await publisher.publish({
    data: {
      action_sha256: actionSha256,
      call_id: "call_verify",
      execution_id: commandExecutionId,
      executor: "local",
      process_identity: "pid:7",
      step: 2,
    },
    type: "command.started",
  });
  await publisher.publish({
    data: {
      action_sha256: actionSha256,
      call_id: "call_verify",
      cleanup_verified: true,
      duration_ms: 7,
      execution_id: commandExecutionId,
      executor: "local",
      exit_code: options.commandExitCode ?? 0,
      signal: null,
      stderr_bytes: 0,
      stdout_bytes: 0,
      step: 2,
      termination: options.termination ?? "exit",
      total_bytes: 0,
      truncated: false,
    },
    type: "command.completed",
  });
  await publisher.publish({
    data: {
      action_sha256: actionSha256,
      after_snapshot_sha256: snapshotSha256,
      before_snapshot_sha256: snapshotSha256,
      call_id: "call_verify",
      command_execution_id: commandExecutionId,
      completed_generation: 1,
      duration_ms: 7,
      exit_code: options.verificationExitCode ?? 0,
      stale: false,
      stale_reasons: [],
      started_generation: 1,
      status: options.verificationStatus ?? "passed",
      step: 2,
      verification_id: verificationId,
    },
    type: "verification.completed",
  });
  await publisher.publish({
    data: {
      call_id: "call_verify",
      duration_ms: 8,
      output: '{"ok":true,"exit_code":0}',
      status: "success",
      step: 2,
      tool_name: "run_command",
      truncated: false,
    },
    type: "tool.call.completed",
  });
}

async function publishUnclassifiedVerification(
  publisher: EventPublisher,
): Promise<void> {
  const action = "d".repeat(64);
  await publishToolStep(publisher, 3, "call_unknown_verify");
  await publisher.publish({
    data: {
      arguments_json: '{"executable":"node"}',
      call_id: "call_unknown_verify",
      step: 3,
      tool_name: "run_command",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      action_kind: "run_command",
      action_sha256: action,
      call_id: "call_unknown_verify",
      effect: "allow",
      policy_version: "local-free-v1",
      rule_id: "fixture-verify-unknown-inputs",
      step: 3,
    },
    type: "permission.evaluated",
  });
  await publisher.publish({
    data: {
      action_sha256: action,
      call_id: "call_unknown_verify",
      cwd: ".",
      executable: "node",
      execution_id: unknownCommandExecutionId,
      executor: "local",
      purpose: "verify",
      redacted_argv: ["node", "unknown-fixture.mjs"],
      step: 3,
    },
    type: "command.execution.requested",
  });
  await publisher.publish({
    data: {
      action_sha256: action,
      call_id: "call_unknown_verify",
      execution_id: unknownCommandExecutionId,
      executor: "local",
      process_identity: "pid:8",
      step: 3,
    },
    type: "command.started",
  });
  await publisher.publish({
    data: {
      action_sha256: action,
      call_id: "call_unknown_verify",
      cleanup_verified: true,
      duration_ms: 5,
      execution_id: unknownCommandExecutionId,
      executor: "local",
      exit_code: 0,
      signal: null,
      stderr_bytes: 0,
      stdout_bytes: 0,
      step: 3,
      termination: "exit",
      total_bytes: 0,
      truncated: false,
    },
    type: "command.completed",
  });
  await publisher.publish({
    data: {
      call_id: "call_unknown_verify",
      duration_ms: 6,
      output: '{"ok":true,"exit_code":0}',
      status: "success",
      step: 3,
      tool_name: "run_command",
      truncated: false,
    },
    type: "tool.call.completed",
  });
}

async function publishAcceptedFinish(
  publisher: EventPublisher,
  options: {
    readonly diffStat?: {
      readonly added_lines: number;
      readonly removed_lines: number;
    };
  } = {},
): Promise<PersistedCompletionEvidence> {
  await publishToolStep(publisher, 3, "call_finish");
  const summary = "fixed clamp and verified";
  await publisher.publish({
    data: {
      arguments_json: JSON.stringify({ status: "completed", summary }),
      call_id: "call_finish",
      step: 3,
      tool_name: "finish_task",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      call_id: "call_finish",
      candidate_sha256: candidateSha256,
      status: "completed",
      step: 3,
      summary,
    },
    type: "completion.candidate",
  });
  const projection = verifiedEvidence(summary);
  await publisher.publish({ data: projection, type: "completion.evidence" });
  await publisher.publish({
    data: {
      call_id: "call_finish",
      candidate_sha256: candidateSha256,
      changed_paths: ["src/a.ts"],
      diff_stat: options.diffStat ?? { added_lines: 1, removed_lines: 1 },
      effect: "accept",
      evidence_sha256: projection.evidence_sha256,
      reasons: [],
      report_sha256: projection.report_sha256,
      step: 3,
      verification_ids: [verificationId],
    },
    type: "completion.evaluated",
  });
  await publisher.publish({
    data: {
      call_id: "call_finish",
      duration_ms: 1,
      output: '{"effect":"accept"}',
      status: "success",
      step: 3,
      tool_name: "finish_task",
      truncated: false,
    },
    type: "tool.call.completed",
  });
  return projection;
}

async function publishUsage(publisher: EventPublisher, turns: number): Promise<void> {
  await publisher.publish({
    data: {
      input_tokens: turns,
      model_turns: turns,
      output_tokens: turns,
      total_tokens: turns * 2,
    },
    type: "usage",
  });
}

async function buildVerifiedRun(
  renderer?: RunEventRenderer,
): Promise<{ publisher: EventPublisher; writer: InMemorySessionWriter }> {
  const state = createPublisher(renderer);
  await startCoding(state.publisher);
  await publishPatch(state.publisher);
  await publishVerification(state.publisher);
  const projection = await publishAcceptedFinish(state.publisher);
  await publishUsage(state.publisher, 3);
  await state.publisher.publish({
    data: {
      completion_mode: "verified_finish_task",
      duration_ms: 20,
      evidence_sha256: projection.evidence_sha256,
      model_turns: 3,
      output_chars: 0,
      report_sha256: projection.report_sha256,
      steps: 3,
      tool_calls: 3,
    },
    type: "run.completed",
  });
  return state;
}

describe("Phase 7 verification and completion events", () => {
  it("reconstructs an approved current verification and accepted finish_task", async () => {
    const memory = createMemoryIO();
    const { writer } = await buildVerifiedRun(
      new ConsoleEventRenderer(memory.io, true),
    );

    const run = reconstructSession(writer.events);
    expect(run.verifications).toMatchObject([
      {
        completed: { status: "passed", stale: false },
        started: { generation: 1, kind: "test" },
      },
    ]);
    expect(run.completionCandidates).toMatchObject([
      { evaluated: { effect: "accept" } },
    ]);
    expect(run.terminal).toMatchObject({
      data: { completion_mode: "verified_finish_task" },
      type: "run.completed",
    });
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toContain("verification=");
    expect(memory.readStderr()).toContain("completion_mode=verified_finish_task");
  });

  it("rejects self-consistent forged verification evidence during publish and replay", async () => {
    const state = createPublisher();
    await startCoding(state.publisher);
    await publishPatch(state.publisher);
    await publishVerification(state.publisher);
    const forged = forgedVerifiedEvidence("fixed clamp and verified");

    await expect(
      state.publisher.publish({ data: forged, type: "completion.evidence" }),
    ).rejects.toThrow("completion verification evidence does not match events");

    const { writer } = await buildVerifiedRun();
    const forgedEvents = writer.events.map((event) =>
      event.type === "completion.evidence"
        ? runEventSchema.parse({ ...event, data: forged })
        : event,
    );
    expect(() => reconstructSession(forgedEvents)).toThrow(
      "completion verification evidence does not match events",
    );
  });

  it("reconstructs inputsKnown false from a completed unclassified verify command", async () => {
    const { publisher, writer } = createPublisher();
    await startCoding(publisher);
    await publishPatch(publisher);
    await publishVerification(publisher);
    await publishUnclassifiedVerification(publisher);
    await publishToolStep(publisher, 4, "call_finish_unknown");
    const summary = "verification inputs could not be classified";
    await publisher.publish({
      data: {
        arguments_json: JSON.stringify({ status: "completed", summary }),
        call_id: "call_finish_unknown",
        step: 4,
        tool_name: "finish_task",
      },
      type: "tool.call.requested",
    });
    await publisher.publish({
      data: {
        call_id: "call_finish_unknown",
        candidate_sha256: candidateSha256,
        status: "completed",
        step: 4,
        summary,
      },
      type: "completion.candidate",
    });
    const projection = unknownInputsEvidence(summary);
    await publisher.publish({ data: projection, type: "completion.evidence" });
    await publisher.publish({
      data: {
        call_id: "call_finish_unknown",
        candidate_sha256: candidateSha256,
        changed_paths: ["src/a.ts"],
        diff_stat: { added_lines: 1, removed_lines: 1 },
        effect: "incomplete",
        evidence_sha256: projection.evidence_sha256,
        reasons: ["verification_inputs_unknown"],
        report_sha256: projection.report_sha256,
        step: 4,
        verification_ids: [verificationId],
      },
      type: "completion.evaluated",
    });
    await publisher.publish({
      data: {
        call_id: "call_finish_unknown",
        duration_ms: 1,
        output: '{"effect":"incomplete"}',
        status: "success",
        step: 4,
        tool_name: "finish_task",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publishUsage(publisher, 4);
    await publisher.publish({
      data: {
        duration_ms: 25,
        evidence_sha256: projection.evidence_sha256,
        output_chars: 0,
        reason: "verification_inputs_unknown",
        report_sha256: projection.report_sha256,
        steps: 4,
        tool_calls: 4,
      },
      type: "run.incomplete",
    });

    expect(() => reconstructSession(writer.events)).not.toThrow();
  });

  it("binds completion diff stats to the persisted per-file evidence", async () => {
    const state = createPublisher();
    await startCoding(state.publisher);
    await publishPatch(state.publisher);
    await publishVerification(state.publisher);
    await expect(
      publishAcceptedFinish(state.publisher, {
        diffStat: { added_lines: 99, removed_lines: 1 },
      }),
    ).rejects.toThrow("completion diff stat does not match persisted evidence");

    const { writer } = await buildVerifiedRun();
    const forgedEvents = writer.events.map((event) =>
      event.type === "completion.evaluated"
        ? runEventSchema.parse({
            ...event,
            data: {
              ...event.data,
              diff_stat: { added_lines: 99, removed_lines: 1 },
            },
          })
        : event,
    );
    expect(() => reconstructSession(forgedEvents)).toThrow(
      "completion diff stat does not match persisted evidence",
    );
  });

  it("treats a later patch that restores the first preimage as no net change", async () => {
    const { publisher, writer } = createPublisher();
    await startCoding(publisher);
    await publishPatch(publisher);
    await publishRestorePatch(publisher);

    await publishToolStep(publisher, 3, "call_blocked");
    const summary = "the requested edit was restored to its original bytes";
    await publisher.publish({
      data: {
        arguments_json: JSON.stringify({ status: "blocked", summary }),
        call_id: "call_blocked",
        step: 3,
        tool_name: "finish_task",
      },
      type: "tool.call.requested",
    });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        candidate_sha256: candidateSha256,
        status: "blocked",
        step: 3,
        summary,
      },
      type: "completion.candidate",
    });
    const projection = blockedEvidence(summary);
    await publisher.publish({ data: projection, type: "completion.evidence" });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        candidate_sha256: candidateSha256,
        changed_paths: [],
        diff_stat: { added_lines: 0, removed_lines: 0 },
        effect: "incomplete",
        evidence_sha256: projection.evidence_sha256,
        reasons: ["task_blocked"],
        report_sha256: projection.report_sha256,
        step: 3,
        verification_ids: [],
      },
      type: "completion.evaluated",
    });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        duration_ms: 1,
        output: '{"effect":"incomplete","reason":"task_blocked"}',
        status: "success",
        step: 3,
        tool_name: "finish_task",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publishUsage(publisher, 3);
    await publisher.publish({
      data: {
        duration_ms: 20,
        evidence_sha256: projection.evidence_sha256,
        output_chars: 0,
        reason: "task_blocked",
        report_sha256: projection.report_sha256,
        steps: 3,
        tool_calls: 3,
      },
      type: "run.incomplete",
    });

    const reconstructed = reconstructSession(writer.events);
    expect(reconstructed.completionEvidence.at(-1)?.evidence.changedByRun).toEqual(
      [],
    );
    expect(reconstructed.completionCandidates.at(-1)?.evaluated).toMatchObject({
      changed_paths: [],
      diff_stat: { added_lines: 0, removed_lines: 0 },
    });
  });

  it("fails closed when accepted evidence references an unknown verification", async () => {
    const { publisher } = createPublisher();
    await startCoding(publisher);
    await publishPatch(publisher);
    await publishVerification(publisher);
    await publishToolStep(publisher, 3, "call_finish");
    const summary = "done";
    await publisher.publish({
      data: {
        arguments_json: JSON.stringify({ status: "completed", summary }),
        call_id: "call_finish",
        step: 3,
        tool_name: "finish_task",
      },
      type: "tool.call.requested",
    });
    await publisher.publish({
      data: {
        call_id: "call_finish",
        candidate_sha256: candidateSha256,
        status: "completed",
        step: 3,
        summary,
      },
      type: "completion.candidate",
    });
    const projection = verifiedEvidence(summary);
    await publisher.publish({ data: projection, type: "completion.evidence" });
    await expect(
      publisher.publish({
        data: {
          call_id: "call_finish",
          candidate_sha256: candidateSha256,
          changed_paths: ["src/a.ts"],
          diff_stat: { added_lines: 1, removed_lines: 1 },
          effect: "accept",
          evidence_sha256: projection.evidence_sha256,
          reasons: [],
          report_sha256: projection.report_sha256,
          step: 3,
          verification_ids: ["00000000-0000-4000-8000-000000000799"],
        },
        type: "completion.evaluated",
      }),
    ).rejects.toThrow("invalid verification evidence");
  });

  it("rejects passed verification evidence after a timeout first-cause termination", async () => {
    const { publisher } = createPublisher();
    await startCoding(publisher);
    await publishPatch(publisher);

    await expect(
      publishVerification(publisher, {
        commandExitCode: 0,
        termination: "timeout",
        verificationExitCode: 0,
        verificationStatus: "passed",
      }),
    ).rejects.toThrow(
      "verification completion does not match command and start evidence",
    );
  });

  it("persists coding prose internally and terminates a natural final as incomplete", async () => {
    const memory = createMemoryIO();
    const { publisher, writer } = createPublisher(
      new ConsoleEventRenderer(memory.io, false),
    );
    await startCoding(publisher);
    await publisher.publish({
      data: {
        input_kind: "user_task",
        max_steps: 6,
        remaining_duration_ms: 60_000,
        remaining_tokens: 6_000,
        remaining_tool_output_bytes: 131_072,
        step: 1,
      },
      type: "agent.step.started",
    });
    await publisher.publish({
      data: { delta: "I think this is complete", visibility: "internal_candidate" },
      type: "text.delta",
    });
    await publisher.publish({
      data: { input_tokens: 1, output_tokens: 1, step: 1, total_tokens: 2 },
      type: "model.usage",
    });
    await publisher.publish({
      data: {
        duration_ms: 1,
        outcome: "final",
        step: 1,
        text_chars: "I think this is complete".length,
      },
      type: "agent.step.completed",
    });
    await publishUsage(publisher, 1);
    await publisher.publish({
      data: {
        duration_ms: 2,
        output_chars: "I think this is complete".length,
        reason: "completion_signal_required",
        steps: 1,
        tool_calls: 0,
      },
      type: "run.incomplete",
    });

    expect(reconstructSession(writer.events).terminal.type).toBe("run.incomplete");
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe("Incomplete: completion_signal_required\n");
    await expect(
      publisher.publish({
        data: {
          category: "internal",
          code: "late_terminal",
          duration_ms: 3,
          message: "must not append",
          retryable: false,
        },
        type: "run.failed",
      }),
    ).rejects.toThrow("cannot publish after terminal");
  });

  it("requires candidate arguments and stale fields to match their evidence", async () => {
    const { publisher } = createPublisher();
    await startCoding(publisher);
    await publishToolStep(publisher, 1, "call_finish");
    await publisher.publish({
      data: {
        arguments_json: JSON.stringify({ status: "completed", summary: "real" }),
        call_id: "call_finish",
        step: 1,
        tool_name: "finish_task",
      },
      type: "tool.call.requested",
    });
    await expect(
      publisher.publish({
        data: {
          call_id: "call_finish",
          candidate_sha256: candidateSha256,
          status: "completed",
          step: 1,
          summary: "forged",
        },
        type: "completion.candidate",
      }),
    ).rejects.toThrow("pending finish_task");

    const base = {
      event_id: "00000000-0000-4000-8000-000000000801",
      run_id: "00000000-0000-4000-8000-000000000002",
      schema_version: 1 as const,
      seq: 1,
      session_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-17T00:00:00.000Z",
    };
    expect(() =>
      runEventSchema.parse({
        ...base,
        data: {
          action_sha256: actionSha256,
          after_snapshot_sha256: "9".repeat(64),
          before_snapshot_sha256: snapshotSha256,
          call_id: "call_verify",
          command_execution_id: commandExecutionId,
          completed_generation: 1,
          duration_ms: 1,
          exit_code: 0,
          stale: false,
          stale_reasons: ["source_state_changed"],
          started_generation: 1,
          status: "passed",
          step: 1,
          verification_id: verificationId,
        },
        type: "verification.completed",
      }),
    ).toThrow();
  });

  it("pairs a blocked candidate with a successful tool result before incomplete", async () => {
    const { publisher, writer } = createPublisher();
    await startCoding(publisher);
    await publishToolStep(publisher, 1, "call_blocked");
    const summary = "missing an expected input file";
    await publisher.publish({
      data: {
        arguments_json: JSON.stringify({ status: "blocked", summary }),
        call_id: "call_blocked",
        step: 1,
        tool_name: "finish_task",
      },
      type: "tool.call.requested",
    });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        candidate_sha256: candidateSha256,
        status: "blocked",
        step: 1,
        summary,
      },
      type: "completion.candidate",
    });
    const projection = blockedEvidence(summary);
    await publisher.publish({ data: projection, type: "completion.evidence" });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        candidate_sha256: candidateSha256,
        changed_paths: [],
        diff_stat: { added_lines: 0, removed_lines: 0 },
        effect: "incomplete",
        evidence_sha256: projection.evidence_sha256,
        reasons: ["task_blocked"],
        report_sha256: projection.report_sha256,
        step: 1,
        verification_ids: [],
      },
      type: "completion.evaluated",
    });
    await publisher.publish({
      data: {
        call_id: "call_blocked",
        duration_ms: 1,
        output: '{"effect":"incomplete","reason":"task_blocked"}',
        status: "success",
        step: 1,
        tool_name: "finish_task",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await publishUsage(publisher, 1);
    await publisher.publish({
      data: {
        duration_ms: 2,
        evidence_sha256: projection.evidence_sha256,
        output_chars: 0,
        reason: "task_blocked",
        report_sha256: projection.report_sha256,
        steps: 1,
        tool_calls: 1,
      },
      type: "run.incomplete",
    });

    expect(reconstructSession(writer.events).terminal).toMatchObject({
      data: { reason: "task_blocked" },
      type: "run.incomplete",
    });
  });

  it("rejects a coding run that attempts model-final success", async () => {
    const { publisher } = createPublisher();
    await startCoding(publisher);
    await publisher.publish({
      data: {
        input_kind: "user_task",
        max_steps: 6,
        remaining_duration_ms: 60_000,
        remaining_tokens: 6_000,
        remaining_tool_output_bytes: 131_072,
        step: 1,
      },
      type: "agent.step.started",
    });
    await publisher.publish({
      data: { delta: "done", visibility: "internal_candidate" },
      type: "text.delta",
    });
    await publisher.publish({
      data: { input_tokens: 1, output_tokens: 1, step: 1, total_tokens: 2 },
      type: "model.usage",
    });
    await publisher.publish({
      data: { duration_ms: 1, outcome: "final", step: 1, text_chars: 4 },
      type: "agent.step.completed",
    });
    await publishUsage(publisher, 1);
    await expect(
      publisher.publish({
        data: {
          completion_mode: "model_final",
          duration_ms: 2,
          model_turns: 1,
          output_chars: 4,
          steps: 1,
          tool_calls: 0,
        },
        type: "run.completed",
      }),
    ).rejects.toThrow("completion mode does not match task profile");
  });
});
