import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createPersistedCompletionEvidence,
  type PersistedCompletionEvidence,
} from "../src/completion/completion-evidence-schema.js";
import { canonicalJson, sha256Canonical } from "../src/completion/canonical-json.js";
import { hashVerificationSnapshot } from "../src/completion/verification-snapshot.js";
import { decodeStoredEvents } from "../src/events/event-decoder-registry.js";
import { EventPublisher } from "../src/events/event-publisher.js";
import type { RunEvent, RunEventDraft } from "../src/events/run-event.js";
import type { SessionWriter } from "../src/sessions/jsonl-session-writer.js";
import { reconstructMultiRunSession } from "../src/sessions/reconstruct-multi-run-session.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000101";
const RUN_ID = "00000000-0000-4000-8000-000000000102";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000103";
const TASK = "Update README and run pnpm check";
const TIMESTAMP = "2026-08-24T00:00:00.000Z";
const SHA = {
  action: "a".repeat(64),
  candidate: "c".repeat(64),
  canonicalRoot: "d".repeat(64),
  journal: "1".repeat(64),
  patchPlan: "f".repeat(64),
  postimage: "3".repeat(64),
  preimage: "2".repeat(64),
} as const;
const PATCH_APPROVAL_ID = "00000000-0000-4000-8000-000000000111";
const COMMAND_EXECUTION_ID = "00000000-0000-4000-8000-000000000112";
const VERIFICATION_ID = "00000000-0000-4000-8000-000000000113";

class RecordingWriter implements SessionWriter {
  readonly events: RunEvent[] = [];
  readonly path = "fixtures/agent-memory/ml1/session.jsonl";

  async close(): Promise<void> {}

  async write(event: RunEvent): Promise<void> {
    this.events.push(event);
  }
}

function verificationSnapshot() {
  return {
    changedFiles: [{ path: "README.md", sha256: SHA.postimage }],
    commandInputs: [{ path: "pnpm-lock.yaml", sha256: "4".repeat(64) }],
    deletedFiles: [] as never[],
    generation: 1,
    gitHeadSha256: "5".repeat(64),
    gitIndexSha256: "6".repeat(64),
    journalSha256: SHA.journal,
    sourceStateSha256: "7".repeat(64),
  };
}

function completionEvidence(summary: string): PersistedCompletionEvidence {
  const snapshot = verificationSnapshot();
  return createPersistedCompletionEvidence({
    changedByRun: [{
      addedLines: 1,
      kind: "modify",
      path: "README.md",
      postimageSha256: SHA.postimage,
      preimageSha256: SHA.preimage,
      removedLines: 1,
    }],
    diffCheck: {
      checkedPaths: ["README.md"],
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
    runId: RUN_ID,
    sessionId: SESSION_ID,
    verifications: [{
      actionSha256: SHA.action,
      afterSnapshot: snapshot,
      approved: true,
      argv: ["pnpm", "check"],
      beforeSnapshot: snapshot,
      classification: "test",
      completedEventPersisted: true,
      cwd: ".",
      durationMs: 7,
      executionId: COMMAND_EXECUTION_ID,
      exitCode: 0,
      generationAtCompletion: 1,
      generationAtStart: 1,
      inputsKnown: true,
      output: {
        artifactRefs: [],
        eventRefs: [`command:${COMMAND_EXECUTION_ID}`],
        stderrSummary: "",
        stdoutSummary: "",
        totalBytes: 0,
        truncated: false,
      },
      purpose: "verify",
      stale: false,
      verificationId: VERIFICATION_ID,
    }],
  });
}

function backendSelected(): Extract<RunEventDraft, { type: "backend.selected" }> {
  return {
    data: {
      adapter: "deterministic-test-adapter",
      adapter_version: "1.0.0-test",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "b".repeat(64),
      model: "fake",
      provider: "ollama",
    },
    type: "backend.selected",
  };
}

function modelUsage(step: number): Extract<RunEventDraft, { type: "model.usage" }> {
  return {
    data: {
      cache_read_tokens: null,
      cache_write_tokens: null,
      completeness: "complete",
      input_tokens: 1,
      output_tokens: 1,
      provider: "ollama",
      step,
      total_tokens: 2,
    },
    type: "model.usage",
  };
}

async function publishToolStep(publisher: EventPublisher, step: number, callId: string): Promise<void> {
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
  await publisher.publish(modelUsage(step));
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
    data: { arguments_json: '{"patch":"fixture"}', call_id: "call_patch", step: 1, tool_name: "apply_patch" },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      call_id: "call_patch",
      patch_sha256: SHA.patchPlan,
      paths: [{ kind: "modify", path: "README.md" }],
      plan_id: SHA.patchPlan,
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
      action_sha256: SHA.patchPlan,
      added_lines: 1,
      approval_request_id: PATCH_APPROVAL_ID,
      call_id: "call_patch",
      paths: [{ kind: "modify", path: "README.md" }],
      plan_id: SHA.patchPlan,
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
      action_sha256: SHA.patchPlan,
      approval_request_id: PATCH_APPROVAL_ID,
      call_id: "call_patch",
      decision: "approved",
      plan_id: SHA.patchPlan,
      step: 1,
    },
    type: "approval.decided",
  });
  await publisher.publish({
    data: {
      approval_request_id: PATCH_APPROVAL_ID,
      call_id: "call_patch",
      files: [{ kind: "modify", path: "README.md", pre_sha256: SHA.preimage }],
      plan_id: SHA.patchPlan,
      step: 1,
    },
    type: "patch.apply.started",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      approval_request_id: PATCH_APPROVAL_ID,
      call_id: "call_patch",
      duration_ms: 2,
      files: [{
        kind: "modify",
        path: "README.md",
        post_sha256: SHA.postimage,
        pre_sha256: SHA.preimage,
      }],
      journal_sha256: SHA.journal,
      plan_id: SHA.patchPlan,
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

async function publishVerification(publisher: EventPublisher): Promise<void> {
  const snapshotSha256 = hashVerificationSnapshot(verificationSnapshot());
  await publishToolStep(publisher, 2, "call_verify");
  await publisher.publish({
    data: { arguments_json: '{"executable":"pnpm"}', call_id: "call_verify", step: 2, tool_name: "run_command" },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      action_kind: "run_command",
      action_sha256: SHA.action,
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
      action_sha256: SHA.action,
      call_id: "call_verify",
      cwd: ".",
      executable: "pnpm",
      execution_id: COMMAND_EXECUTION_ID,
      executor: "local",
      purpose: "verify",
      redacted_argv: ["pnpm", "check"],
      step: 2,
    },
    type: "command.execution.requested",
  });
  await publisher.publish({
    data: {
      action_sha256: SHA.action,
      call_id: "call_verify",
      command_execution_id: COMMAND_EXECUTION_ID,
      generation: 1,
      kind: "test",
      snapshot_sha256: snapshotSha256,
      step: 2,
      verification_id: VERIFICATION_ID,
    },
    type: "verification.started",
  });
  await publisher.publish({
    data: {
      action_sha256: SHA.action,
      call_id: "call_verify",
      execution_id: COMMAND_EXECUTION_ID,
      executor: "local",
      process_identity: "pid:7",
      step: 2,
    },
    type: "command.started",
  });
  await publisher.publish({
    data: {
      action_sha256: SHA.action,
      call_id: "call_verify",
      cleanup_verified: true,
      duration_ms: 7,
      execution_id: COMMAND_EXECUTION_ID,
      executor: "local",
      exit_code: 0,
      signal: null,
      stderr_bytes: 0,
      stdout_bytes: 0,
      step: 2,
      termination: "exit",
      total_bytes: 0,
      truncated: false,
    },
    type: "command.completed",
  });
  await publisher.publish({
    data: {
      action_sha256: SHA.action,
      after_snapshot_sha256: snapshotSha256,
      before_snapshot_sha256: snapshotSha256,
      call_id: "call_verify",
      command_execution_id: COMMAND_EXECUTION_ID,
      completed_generation: 1,
      duration_ms: 7,
      exit_code: 0,
      stale: false,
      stale_reasons: [],
      started_generation: 1,
      status: "passed",
      step: 2,
      verification_id: VERIFICATION_ID,
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

async function publishFinish(publisher: EventPublisher): Promise<PersistedCompletionEvidence> {
  const summary = "Updated README and pnpm check passed";
  await publishToolStep(publisher, 3, "call_finish");
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
      candidate_sha256: SHA.candidate,
      status: "completed",
      step: 3,
      summary,
    },
    type: "completion.candidate",
  });
  const projection = completionEvidence(summary);
  await publisher.publish({ data: projection, type: "completion.evidence" });
  await publisher.publish({
    data: {
      call_id: "call_finish",
      candidate_sha256: SHA.candidate,
      changed_paths: ["README.md"],
      diff_stat: { added_lines: 1, removed_lines: 1 },
      effect: "accept",
      evidence_sha256: projection.evidence_sha256,
      reasons: [],
      report_sha256: projection.report_sha256,
      step: 3,
      verification_ids: [VERIFICATION_ID],
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const writer = new RecordingWriter();
  let eventId = 1_000;
  const publisher = new EventPublisher({
    randomUUID: () => `00000000-0000-4000-8000-${String(++eventId).padStart(12, "0")}`,
    renderer: { render: () => undefined },
    runId: RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => TIMESTAMP,
    writer,
  });
  await publisher.publish({
    data: {
      application_commit: {
        action_kind: "session.message.submit",
        authorization_decision_sha256: "9".repeat(64),
        operation_id: RUN_ID,
        prepared_action_sha256: "e".repeat(64),
        principal_id: "local_owner",
        schema_version: 1,
      },
      command: "agent",
      command_approval: "ask",
      command_timeout_ms: 120_000,
      completion_policy: "verified",
      edit_approval: "ask",
      input: { role: "user", text: TASK },
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
  await publisher.publish(backendSelected());
  await publishPatch(publisher);
  await publishVerification(publisher);
  const completion = await publishFinish(publisher);
  await publisher.publish({
    data: { input_tokens: 3, model_turns: 3, output_tokens: 3, total_tokens: 6 },
    type: "usage",
  });
  await publisher.publish({
    data: {
      completion_mode: "verified_finish_task",
      duration_ms: 20,
      evidence_sha256: completion.evidence_sha256,
      model_turns: 3,
      output_chars: 0,
      report_sha256: completion.report_sha256,
      steps: 3,
      tool_calls: 3,
    },
    type: "run.completed",
  });

  const lines = writer.events.map((event) => JSON.stringify(event));
  const decoded = decodeStoredEvents(writer.events);
  const reconstruction = reconstructMultiRunSession(decoded);
  if (reconstruction.status !== "completed" || reconstruction.lastRun?.runId !== RUN_ID) {
    throw new Error("golden run did not reconstruct as one completed run");
  }
  const rawLines = decoded.map((event, index) => ({
    eventId: event.eventId,
    rawSha256: sha256Text(lines[index]!),
    sessionSequence: event.sessionSeq,
  }));
  const start = decoded[0]!;
  const end = decoded.at(-1)!;
  const scope = {
    applicationRepositoryId: REPOSITORY_ID,
    canonicalRootIdentitySha256: SHA.canonicalRoot,
    ownerPrincipalId: "local_owner",
  };
  const source = {
    endEventId: end.eventId,
    endRawSha256: rawLines.at(-1)!.rawSha256,
    endSequence: end.sessionSeq,
    kind: "session_run_range" as const,
    rangeSha256: sha256Canonical({
      records: rawLines.map((line) => ({
        event_id: line.eventId,
        raw_sha256: line.rawSha256,
        sequence: line.sessionSequence,
      })),
      run_id: RUN_ID,
      schema_version: 1,
      session_id: SESSION_ID,
    }),
    runId: RUN_ID,
    sessionId: SESSION_ID,
    startEventId: start.eventId,
    startRawSha256: rawLines[0]!.rawSha256,
    startSequence: start.sessionSeq,
  };
  const episodeCompletion = {
    evidenceSha256: completion.evidence_sha256,
    mode: "verified_finish_task" as const,
    reportSha256: completion.report_sha256,
    steps: 3,
    toolCalls: 3,
  };
  const text = [
    `Task: ${TASK}`,
    "Outcome: completed",
    `Completion mode: ${episodeCompletion.mode}`,
    `Steps: ${String(episodeCompletion.steps)}`,
    `Tool calls: ${String(episodeCompletion.toolCalls)}`,
    `Evidence: ${episodeCompletion.evidenceSha256}`,
  ].join("\n");
  const content = {
    completion: episodeCompletion,
    kind: "episode" as const,
    occurredAt: TIMESTAMP,
    origin: "deterministic_episode" as const,
    recordId: `episode_${sha256Canonical({ schema_version: 1, scope, source })}`,
    schemaVersion: 1 as const,
    scope,
    source,
    taskInputSha256: sha256Text(TASK),
    taskPreview: TASK,
    text,
  };
  const expectedRecord = { ...content, recordSha256: sha256Canonical(content) };
  const manifest = {
    expectedCanonicalBytes: Buffer.byteLength(canonicalJson(expectedRecord), "utf8"),
    expectedCanonicalJson: canonicalJson(expectedRecord),
    expectedRecord,
    fixtureId: "agent-memory-ml1-golden-v1",
    mutations: [
      { expected: "already_present", id: "duplicate_ingest" },
      { expected: "not_visible", id: "wrong_scope" },
      { expected: "stale", id: "missing_line" },
      { expected: "stale", id: "changed_raw_byte" },
      { expected: "memory_store_corrupt", id: "future_schema" },
      { expected: "not_admitted", id: "incomplete_run" },
      { expected: "no_store", id: "mode_off" },
    ],
    rawLines,
    schemaVersion: 1,
  };
  const jsonlPath = resolve("fixtures/agent-memory/ml1/session.jsonl");
  const manifestPath = resolve("fixtures/agent-memory/ml1/manifest.json");
  if (!process.argv.includes("--force")) {
    for (const path of [jsonlPath, manifestPath]) {
      await access(path).then(
        () => { throw new Error(`refusing to overwrite frozen golden: ${path}`); },
        () => undefined,
      );
    }
  }
  await mkdir(dirname(jsonlPath), { recursive: true });
  await writeFile(jsonlPath, `${lines.join("\n")}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`ML1_GOLDEN_WRITTEN events=${String(lines.length)} record=${expectedRecord.recordId}\n`);
}

await main();
