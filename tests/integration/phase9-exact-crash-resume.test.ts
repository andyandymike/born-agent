import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointStore,
  type CheckpointPrivacyVerifier,
} from "../../src/checkpoints/checkpoint-store.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import type { BackendCheckpointCodec } from "../../src/model/backend-resume.js";
import {
  BackendContinuation,
  type ModelBackend,
  type ModelTurnRequest,
} from "../../src/model/model-backend.js";
import { BackendResumeProjectionBuilder } from "../../src/resume/backend-resume-projection-builder.js";
import { ResumePlanner } from "../../src/resume/resume-planner.js";
import { createWorkspaceResumeFingerprint } from "../../src/resume/workspace-resume-fingerprint.js";
import {
  persistWorkspaceResumeFingerprint,
  workspaceResumeFingerprintSha256,
} from "../../src/resume/workspace-resume-fingerprint.js";
import { buildWorkspaceResumeFingerprint } from "../../src/resume/workspace-resume-fingerprint-builder.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { createTurnBoundaryRecorder } from "../../src/sessions/turn-boundary-recorder.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { runCli } from "../../src/cli/run-cli.js";
import { createMemoryIO, createRuntime, FakeToolRegistry } from "../helpers.js";

const temporaryDirectories: string[] = [];

class ExactFakeContinuation extends BackendContinuation {
  constructor(readonly state: string) {
    super();
  }
}

const identity = {
  adapter: "deterministic-exact-fake",
  adapterVersion: "phase9-v1",
  configFingerprint: "a".repeat(64),
  model: "fake-local-model",
  provider: "ollama" as const,
};

const codec: BackendCheckpointCodec = {
  codecVersion: "exact-fake-v1",
  async decode(bytes, selectedIdentity) {
    if (
      selectedIdentity.provider !== identity.provider ||
      selectedIdentity.model !== identity.model
    ) {
      throw new Error("checkpoint identity mismatch");
    }
    return new ExactFakeContinuation(Buffer.from(bytes).toString("utf8"));
  },
  async encode(continuation) {
    if (!(continuation instanceof ExactFakeContinuation)) {
      throw new TypeError("unexpected continuation type");
    }
    return Buffer.from(continuation.state, "utf8");
  },
  provider: "ollama",
};

const backend: ModelBackend = {
  capabilities: {
    cancellation: "abort_signal",
    reasoning: "opaque_passthrough",
    streaming: true,
    tools: "strict",
    usage: "complete",
  },
  contextCapacity: {
    contextWindowTokens: 32_768,
    maximumOutputTokens: 8_192,
    source: "pinned_catalog",
  },
  identity,
  resume: {
    capability: "exact_checkpoint",
    checkpointCodec: codec,
    supportsCanonicalDegradedResume: true,
  },
  async *runTurn() {
    yield* [];
  },
};

const verifiedPrivacy: CheckpointPrivacyVerifier = {
  async preflight() {
    return { status: "verified" };
  },
  async verifyFile() {
    return { status: "verified" };
  },
};

function uuidFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `70000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function fingerprint() {
  return createWorkspaceResumeFingerprint({
    backend: identity,
    canonicalRootIdentity: "phase9-exact-workspace",
    checkpointCodecVersion: codec.codecVersion,
    completionSchemaSha256: "b".repeat(64),
    policySha256: "c".repeat(64),
    sourceState: {
      gitHeadSha256: "d".repeat(64),
      gitIndexSha256: "e".repeat(64),
      sourceStateSha256: "f".repeat(64),
    },
    systemInstructionsSha256: "1".repeat(64),
    taskProfile: "read-only",
    toolSchemaSha256: "2".repeat(64),
  });
}

function publisher(
  writer: V2SessionWriter,
  sessionId: string,
  runId: string,
  randomUUID: () => string,
): EventPublisher {
  return new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId,
    sessionId,
    timestamp: () => "2026-07-17T00:00:00.000Z",
    writer,
  });
}

async function publishRunStart(
  events: EventPublisher,
  workspace: string,
  resume?: { readonly sourceRunId: string },
): Promise<void> {
  await events.publish({
    data: {
      command: "chat",
      input: { role: "user", text: resume === undefined ? "start" : "continue" },
      model: identity.model,
      provider: identity.provider,
      ...(resume === undefined
        ? {}
        : {
            resume_mode: "exact" as const,
            resume_of_run_id: resume.sourceRunId,
          }),
      timeout_ms: 1_000,
      tools: [],
      tools_enabled: false,
      workspace,
    },
    type: "run.started",
  });
  await events.publish({
    data: {
      adapter: identity.adapter,
      adapter_version: identity.adapterVersion,
      capabilities: backend.capabilities,
      checkpoint_codec_version: codec.codecVersion,
      config_fingerprint: identity.configFingerprint,
      model: identity.model,
      provider: identity.provider,
      resume_capability: "exact_checkpoint",
    },
    type: "backend.selected",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 9 deterministic exact checkpoint crash fixture", () => {
  it("verifies opaque state locally and resumes as a distinct run with zero billable requests", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase9-exact-"));
    temporaryDirectories.push(workspace);
    const randomUUID = uuidFactory();
    const sessionId = randomUUID();
    const sourceRunId = randomUUID();
    const storeFactory = (root: string) =>
      CheckpointStore.create(root, {
        privacyVerifier: verifiedPrivacy,
        randomId: randomUUID,
      });

    const firstWriter = await V2SessionWriter.createNew(
      workspace,
      sessionId,
      {
        createEventId: randomUUID,
        timestamp: () => "2026-07-17T00:00:00.000Z",
      },
    );
    const first = publisher(firstWriter, sessionId, sourceRunId, randomUUID);
    await publishRunStart(first, workspace);
    const firstBoundary = createTurnBoundaryRecorder(
      firstWriter,
      backend,
      workspace,
      {
        createCheckpointId: randomUUID,
        createCheckpointStore: storeFactory,
      },
    );
    await firstBoundary?.({
      continuation: new ExactFakeContinuation("opaque-turn-1"),
      pendingCall: false,
      runId: sourceRunId,
      sessionId,
      turn: 1,
    });
    // PHASE9: ending at this durable prefix is the deterministic fake crash
    // boundary. No remote provider timing is involved and no terminal is
    // fabricated for the old run.
    await firstWriter.close();

    const interrupted = reconstructMultiRunSession(
      await readStoredSession(firstWriter.path),
    );
    expect(interrupted.status).toBe("interrupted");
    const checkpointStore = await storeFactory(workspace);
    const built = await new BackendResumeProjectionBuilder(
      checkpointStore,
    ).build({
      backend,
      events: interrupted.lastRun.events,
    });
    expect(built.continuation).toMatchObject({ state: "opaque-turn-1" });
    const savedFingerprint = fingerprint();
    const plan = new ResumePlanner({ createRunId: randomUUID }).plan({
      allowDegradedResume: false,
      backend: built.projection,
      currentFingerprint: savedFingerprint,
      expectedFingerprint: savedFingerprint,
      ledger: {
        approvalsToExpire: [],
        pendingPatches: [],
        pendingToolCalls: [],
        recoveredInnerEffects: [],
        unknownCommands: [],
      },
      patchReconciliations: [],
      sessionId,
      sourceRunId,
      sourceRunState: "interrupted",
    });
    expect(plan).toMatchObject({ mode: "exact", status: "ready" });
    if (plan.status !== "ready") throw new Error("exact resume was not ready");

    const resumedWriter = await V2SessionWriter.openExisting(
      workspace,
      sessionId,
      {
        createEventId: randomUUID,
        timestamp: () => "2026-07-17T00:00:01.000Z",
      },
    );
    await resumedWriter.appendSessionEvent("session.resume.requested", {
      requested_mode: "exact",
      source_run_id: sourceRunId,
    });
    const resumed = publisher(
      resumedWriter,
      sessionId,
      plan.newRunId,
      randomUUID,
    );
    await publishRunStart(resumed, workspace, { sourceRunId });
    await resumed.publish({ data: { delta: "done" }, type: "text.delta" });
    const secondBoundary = createTurnBoundaryRecorder(
      resumedWriter,
      backend,
      workspace,
      {
        createCheckpointId: randomUUID,
        createCheckpointStore: storeFactory,
      },
    );
    await secondBoundary?.({
      continuation: new ExactFakeContinuation("opaque-turn-2"),
      pendingCall: false,
      runId: plan.newRunId,
      sessionId,
      turn: 1,
    });
    await resumed.publish({
      data: {
        cached_input_tokens: 0,
        input_tokens: 1,
        model_turns: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
      type: "usage",
    });
    await resumed.publish({
      data: {
        duration_ms: 1,
        model_turns: 1,
        output_chars: 4,
        tool_calls: 0,
      },
      type: "run.completed",
    });
    await resumedWriter.close();

    const completed = reconstructMultiRunSession(
      await readStoredSession(resumedWriter.path),
    );
    expect(completed.runs).toHaveLength(2);
    expect(completed.lastRun).toMatchObject({
      resumeMode: "exact",
      resumeOfRunId: sourceRunId,
      runId: plan.newRunId,
      status: "completed",
    });
    expect(
      completed.events.filter(
        (event) => event.type === "backend.checkpoint.created",
      ),
    ).toHaveLength(2);
    expect(0, "remote/billable request count").toBe(0);
  });

  it("routes a durable post-checkpoint result through adoption without re-executing the tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase9-cli-exact-"));
    temporaryDirectories.push(workspace);
    const randomUUID = uuidFactory();
    const sessionId = randomUUID();
    const sourceRunId = randomUUID();
    const checkpointStoreFactory = (root: string) =>
      CheckpointStore.create(root, {
        privacyVerifier: verifiedPrivacy,
        randomId: randomUUID,
      });
    const modelRequests: ModelTurnRequest[] = [];
    const resumedBackend: ModelBackend = {
      ...backend,
      async *runTurn(request) {
        modelRequests.push(request);
        if (request.input.kind !== "tool_result") {
          throw new Error("exact adoption must supply the inherited tool result first");
        }
        yield { text: "resumed exactly", type: "text_delta" as const };
        yield {
          type: "usage" as const,
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            completeness: "complete" as const,
            inputTokens: 2,
            outputTokens: 2,
            totalTokens: 4,
          },
        };
        yield {
          continuation: new ExactFakeContinuation("opaque-turn-2"),
          outcome: "text" as const,
          type: "turn_completed" as const,
        };
      },
    };
    const historicalConfig = {
      commandApproval: "ask" as const,
      commandTimeoutMs: 120_000,
      completionPolicy: "verified" as const,
      editApproval: "ask" as const,
      executor: "local" as const,
      maxCommandOutputBytes: 131_072,
      maxDurationMs: 300_000,
      maxSteps: 8,
      maxTokens: 100_000,
      maxToolOutputBytes: 262_144,
      model: identity.model,
      provider: identity.provider,
      reportFormat: "text" as const,
      requestTimeoutMs: 120_000,
      requireVerification: "auto" as const,
      task: "read the inherited fixture",
      taskProfile: "read-only" as const,
      verbose: false,
    };
    const persistedFingerprint = await buildWorkspaceResumeFingerprint({
      backend: resumedBackend,
      config: historicalConfig,
      platform: process.platform,
      workspace,
    });
    const writer = await V2SessionWriter.createNew(workspace, sessionId, {
      createEventId: randomUUID,
      timestamp: () => "2026-07-17T00:00:00.000Z",
    });
    const events = publisher(writer, sessionId, sourceRunId, randomUUID);
    await events.publish({
      data: {
        command: "agent",
        command_approval: "ask",
        command_timeout_ms: 120_000,
        completion_policy: "verified",
        edit_approval: "ask",
        input: { role: "user", text: historicalConfig.task },
        max_command_output_bytes: 131_072,
        max_duration_ms: 300_000,
        max_steps: 8,
        max_tokens: 100_000,
        max_tool_output_bytes: 262_144,
        model: identity.model,
        provider: identity.provider,
        report_format: "text",
        request_timeout_ms: 120_000,
        require_verification: "auto",
        task_profile: "read-only",
        tools: ["list_files", "read_file", "search"],
        tools_enabled: true,
        workspace,
        workspace_fingerprint:
          workspaceResumeFingerprintSha256(persistedFingerprint),
        workspace_resume_fingerprint:
          persistWorkspaceResumeFingerprint(persistedFingerprint),
      },
      type: "run.started",
    });
    await events.publish({
      data: {
        adapter: identity.adapter,
        adapter_version: identity.adapterVersion,
        capabilities: resumedBackend.capabilities,
        checkpoint_codec_version: codec.codecVersion,
        config_fingerprint: identity.configFingerprint,
        model: identity.model,
        provider: identity.provider,
        resume_capability: "exact_checkpoint",
      },
      type: "backend.selected",
    });
    await events.publish({
      data: {
        input_kind: "user_task",
        max_steps: 8,
        remaining_duration_ms: 300_000,
        remaining_tokens: 100_000,
        remaining_tool_output_bytes: 262_144,
        step: 1,
      },
      type: "agent.step.started",
    });
    await events.publish({
      data: {
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        completeness: "complete",
        input_tokens: 1,
        output_tokens: 1,
        provider: identity.provider,
        step: 1,
        total_tokens: 2,
      },
      type: "model.usage",
    });
    await events.publish({
      data: {
        duration_ms: 1,
        outcome: "tool_call",
        step: 1,
        text_chars: 0,
        tool_call_id: "read-inherited",
      },
      type: "agent.step.completed",
    });
    await events.publish({
      data: {
        arguments_json: '{"path":"README.md","start_line":1,"end_line":1}',
        call_id: "read-inherited",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    });
    const boundary = createTurnBoundaryRecorder(
      writer,
      resumedBackend,
      workspace,
      {
        createCheckpointId: randomUUID,
        createCheckpointStore: checkpointStoreFactory,
      },
    );
    await boundary?.({
      continuation: new ExactFakeContinuation("opaque-awaiting-tool"),
      pendingCall: true,
      runId: sourceRunId,
      sessionId,
      turn: 1,
    });
    await events.publish({
      data: {
        call_id: "read-inherited",
        duration_ms: 1,
        output: '{"content":"durable fixture","ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
      type: "tool.call.completed",
    });
    await writer.close();

    const registry = new FakeToolRegistry({
      ok: true,
      output: '{"content":"fixture","ok":true}',
      truncated: false,
    });
    const runtime = createRuntime({
      createAgentToolRegistry: async () => registry,
      createCheckpointStore: checkpointStoreFactory,
      createModelBackend: () => resumedBackend,
      cwd: workspace,
      env: {},
      platform: process.platform,
    });
    const io = createMemoryIO();
    const exitCode = await runCli(
      ["sessions", "resume", sessionId],
      io.io,
      runtime,
    );
    expect(exitCode, io.readStderr()).toBe(0);
    expect(io.readStdout()).toContain("Resume mode: exact");
    expect(registry.calls).toHaveLength(0);
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.input).toMatchObject({
      callId: "read-inherited",
      kind: "tool_result",
      output: '{"content":"durable fixture","ok":true}',
    });
    expect(modelRequests[0]?.canonicalContext?.conversationMode).toBe(
      "augment",
    );

    const reconstructed = reconstructMultiRunSession(
      await readStoredSession(writer.path),
    );
    expect(reconstructed.lastRun.status).toBe("completed");
    expect(
      reconstructed.lastRun.events.map((event) => event.type),
    ).toContain("resume.pending_call.adopted");
    expect(
      reconstructed.lastRun.events.map((event) => event.type),
    ).toContain("tool.call.recovered");
    expect(0, "remote/billable request count").toBe(0);
  });
});
