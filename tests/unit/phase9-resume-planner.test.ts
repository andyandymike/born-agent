import { beforeAll, describe, expect, it, vi } from "vitest";

import type { CheckpointStore } from "../../src/checkpoints/checkpoint-store.js";
import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import type { BackendCheckpointCodec } from "../../src/model/backend-resume.js";
import {
  BackendContinuation,
  type ModelBackend,
} from "../../src/model/model-backend.js";
import { BackendResumeProjectionBuilder } from "../../src/resume/backend-resume-projection-builder.js";
import { ResumePlanner, type ResumePlannerInput } from "../../src/resume/resume-planner.js";
import type {
  BackendResumeProjection,
  PendingEffectLedger,
  PendingToolCall,
  VerifiedCheckpointProjection,
} from "../../src/resume/resume-types.js";
import {
  createWorkspaceResumeFingerprint,
  type WorkspaceResumeFingerprint,
} from "../../src/resume/workspace-resume-fingerprint.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_RUN_ID = "20000000-0000-4000-8000-000000000001";
const NEW_RUN_ID = "20000000-0000-4000-8000-000000000002";

const identity = {
  adapter: "fake-adapter",
  adapterVersion: "1.0.0",
  configFingerprint: "a".repeat(64),
  model: "fake-model",
  provider: "ollama" as const,
};

class PlannerContinuation extends BackendContinuation {}

const checkpointCodec: BackendCheckpointCodec = {
  codecVersion: "fake-v1",
  async decode() {
    return new PlannerContinuation();
  },
  async encode() {
    return Buffer.from("fake", "utf8");
  },
  provider: "ollama",
};

const exactModelBackend: ModelBackend = {
  capabilities: {
    cancellation: "abort_signal",
    reasoning: "opaque_passthrough",
    streaming: true,
    tools: "strict",
    usage: "complete",
  },
  identity,
  resume: {
    capability: "exact_checkpoint",
    checkpointCodec,
    supportsCanonicalDegradedResume: true,
  },
  async *runTurn() {
    yield* [];
  },
};

let verifiedCheckpoint: VerifiedCheckpointProjection;

beforeAll(async () => {
  const events = decodeStoredEvents([
    {
      data: {
        command: "chat",
        input: { role: "user", text: "resume fixture" },
        model: identity.model,
        provider: identity.provider,
        timeout_ms: 1_000,
        tools: [],
        tools_enabled: false,
        workspace: "C:\\fixture",
      },
      event_id: "50000000-0000-4000-8000-000000000001",
      run_id: SOURCE_RUN_ID,
      run_seq: 1,
      schema_version: 2,
      scope: "run",
      session_id: SESSION_ID,
      session_seq: 1,
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "run.started",
    },
    {
      data: {
        adapter: identity.adapter,
        adapter_version: identity.adapterVersion,
        capabilities: exactModelBackend.capabilities,
        checkpoint_codec_version: checkpointCodec.codecVersion,
        config_fingerprint: identity.configFingerprint,
        model: identity.model,
        provider: identity.provider,
        resume_capability: "exact_checkpoint",
      },
      event_id: "50000000-0000-4000-8000-000000000002",
      run_id: SOURCE_RUN_ID,
      run_seq: 2,
      schema_version: 2,
      scope: "run",
      session_id: SESSION_ID,
      session_seq: 2,
      timestamp: "2026-07-17T00:00:01.000Z",
      type: "backend.selected",
    },
    {
      data: {
        adapter: identity.adapter,
        adapter_version: identity.adapterVersion,
        bytes: 4,
        checkpoint_id: "60000000-0000-4000-8000-000000000001",
        codec_version: checkpointCodec.codecVersion,
        model: identity.model,
        provider: identity.provider,
        ref: `.bornagent/checkpoints/${SESSION_ID}/60000000-0000-4000-8000-000000000001.bin`,
        sha256: "3".repeat(64),
        turn: 1,
      },
      event_id: "50000000-0000-4000-8000-000000000003",
      run_id: SOURCE_RUN_ID,
      run_seq: 3,
      schema_version: 2,
      scope: "run",
      session_id: SESSION_ID,
      session_seq: 3,
      timestamp: "2026-07-17T00:00:02.000Z",
      type: "backend.checkpoint.created",
    },
  ]).filter((event) => event.scope === "run");
  const store = {
    readExact: async () => new PlannerContinuation(),
  } as unknown as CheckpointStore;
  const result = await new BackendResumeProjectionBuilder(store).build({
    backend: exactModelBackend,
    events,
  });
  if (result.projection.checkpoint === null) {
    throw new Error("planner fixture did not produce a verified checkpoint");
  }
  verifiedCheckpoint = result.projection.checkpoint;
});

function fingerprint(
  override: Partial<WorkspaceResumeFingerprint> = {},
): WorkspaceResumeFingerprint {
  return createWorkspaceResumeFingerprint({
    backend: identity,
    canonicalRootIdentity: "workspace-identity",
    checkpointCodecVersion: "fake-v1",
    completionSchemaSha256: "b".repeat(64),
    policySha256: "c".repeat(64),
    sourceState: {
      gitHeadSha256: "d".repeat(64),
      gitIndexSha256: "e".repeat(64),
      sourceStateSha256: "f".repeat(64),
    },
    systemInstructionsSha256: "1".repeat(64),
    taskProfile: "coding",
    toolSchemaSha256: "2".repeat(64),
    ...override,
  });
}

function ledger(
  override: Partial<PendingEffectLedger> = {},
): PendingEffectLedger {
  return {
    approvalsToExpire: [],
    pendingPatches: [],
    pendingToolCalls: [],
    recoveredInnerEffects: [],
    unknownCommands: [],
    ...override,
  };
}

function exactBackend(
  override: Partial<BackendResumeProjection> = {},
): BackendResumeProjection {
  return {
    canonicalBoundaryClosed: true,
    capability: "exact_checkpoint",
    checkpoint: verifiedCheckpoint,
    checkpointPendingCall: null,
    exactCheckpointUsable: true,
    identity,
    supportsCanonicalDegradedResume: true,
    ...override,
  };
}

function input(
  override: Partial<ResumePlannerInput> = {},
): ResumePlannerInput {
  const saved = fingerprint();
  return {
    allowDegradedResume: false,
    backend: exactBackend(),
    currentFingerprint: saved,
    expectedFingerprint: saved,
    ledger: ledger(),
    patchReconciliations: [],
    sessionId: SESSION_ID,
    sourceRunId: SOURCE_RUN_ID,
    sourceRunState: "interrupted",
    ...override,
  };
}

const pendingRead: PendingToolCall = {
  argumentsJson: "{\"path\":\"README.md\"}",
  callId: "call-read",
  kind: "read_only",
  providerResponseId: "response-1",
  sourceRunId: SOURCE_RUN_ID,
  step: 2,
  toolName: "read_file",
};

describe("Phase 9 resume planner", () => {
  it("creates a distinct exact run and adopts one pending call", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const historicalApproval = {
      actionKind: "run_command" as const,
      actionSha256: "a".repeat(64),
      approvalRequestId: "30000000-0000-4000-8000-000000000001",
      callId: "old-call",
      decision: "approved" as const,
      sourceRunId: SOURCE_RUN_ID,
    };
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        ledger: ledger({
          approvalsToExpire: [historicalApproval],
          pendingToolCalls: [pendingRead],
        }),
      }),
    );

    expect(result).toMatchObject({
      approvalsToExpire: [historicalApproval],
      inheritedPendingCall: pendingRead,
      mode: "exact",
      newRunId: NEW_RUN_ID,
      resetRunBudgets: true,
      resumeOfRunId: SOURCE_RUN_ID,
      status: "ready",
    });
    expect(createRunId).toHaveBeenCalledOnce();
  });

  it("carries a durable inner observation so resume never repeats its effect", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const commandCall: PendingToolCall = {
      argumentsJson: '{"args":[],"cwd":null,"executable":"node","purpose":"inspect","timeout_ms":null}',
      callId: "call-command",
      kind: "run_command",
      providerResponseId: "response-1",
      sourceRunId: SOURCE_RUN_ID,
      step: 2,
      toolName: "run_command",
    };
    const recovered = {
      callId: commandCall.callId,
      effectId: "40000000-0000-4000-8000-000000000001",
      kind: "command" as const,
      observation: {
        output: '{"stdout":"done","ok":true}',
        status: "success" as const,
        truncated: false,
      },
      sourceRunId: SOURCE_RUN_ID,
      step: commandCall.step,
    };

    const result = new ResumePlanner({ createRunId }).plan(
      input({
        ledger: ledger({
          pendingToolCalls: [commandCall],
          recoveredInnerEffects: [recovered],
        }),
      }),
    );

    expect(result).toMatchObject({
      inheritedPendingCall: commandCall,
      recoveredInnerEffect: recovered,
      status: "ready",
    });
  });

  it("never allocates a run for an unknown command effect", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        ledger: ledger({
          unknownCommands: [
            {
              actionSha256: "a".repeat(64),
              callId: "call-command",
              executionId: "40000000-0000-4000-8000-000000000001",
              sourceRunId: SOURCE_RUN_ID,
              stage: "requested",
              step: 2,
            },
          ],
        }),
      }),
    );

    expect(result).toMatchObject({
      reasons: ["pending_command_effect_unknown"],
      status: "blocked",
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("does not silently degrade when an exact checkpoint is missing", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const planner = new ResumePlanner({ createRunId });
    const missing = input({ backend: exactBackend({ checkpoint: null }) });

    const denied = planner.plan(missing);
    const allowed = planner.plan({ ...missing, allowDegradedResume: true });

    expect(denied).toMatchObject({
      offeredMode: "canonical_degraded",
      reasons: expect.arrayContaining([
        "checkpoint_missing",
        "degraded_resume_requires_confirmation",
      ]),
      status: "blocked",
    });
    expect(allowed).toMatchObject({
      inheritedPendingCall: null,
      mode: "canonical_degraded",
      status: "ready",
    });
    expect(createRunId).toHaveBeenCalledOnce();
  });

  it("requires exact state for any inherited provider call", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        allowDegradedResume: true,
        backend: exactBackend({ checkpoint: null }),
        ledger: ledger({ pendingToolCalls: [pendingRead] }),
      }),
    );

    expect(result).toMatchObject({
      reasons: expect.arrayContaining([
        "checkpoint_missing",
        "pending_call_requires_exact_checkpoint",
      ]),
      status: "blocked",
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("requires explicit degradation for source or codec drift", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const expected = fingerprint();
    const current = fingerprint({
      checkpointCodecVersion: "fake-v2",
      sourceState: {
        ...expected.sourceState,
        sourceStateSha256: "9".repeat(64),
      },
    });
    const base = input({ currentFingerprint: current, expectedFingerprint: expected });

    const denied = new ResumePlanner({ createRunId }).plan(base);
    const allowed = new ResumePlanner({ createRunId }).plan({
      ...base,
      allowDegradedResume: true,
    });

    expect(denied).toMatchObject({
      offeredMode: "canonical_degraded",
      reasons: expect.arrayContaining([
        "checkpoint_incompatible",
        "degraded_resume_requires_confirmation",
      ]),
      status: "blocked",
    });
    expect(allowed).toMatchObject({
      fingerprintMismatches: expect.arrayContaining([
        "checkpoint_codec_version",
        "source_state",
      ]),
      mode: "canonical_degraded",
      status: "ready",
    });
  });

  it.each([
    ["root", fingerprint({ canonicalRootIdentity: "other" }), "workspace_root_mismatch"],
    [
      "provider",
      fingerprint({ backend: { ...identity, provider: "openai" } }),
      "backend_provider_mismatch",
    ],
    [
      "model",
      fingerprint({ backend: { ...identity, model: "other" } }),
      "backend_model_mismatch",
    ],
  ] as const)("blocks a hard %s mismatch", (_name, current, reason) => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const result = new ResumePlanner({ createRunId }).plan(
      input({ currentFingerprint: current }),
    );
    expect(result).toMatchObject({ reasons: [reason], status: "blocked" });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("blocks an ambiguous patch before creating a new run", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        ledger: ledger({
          pendingPatches: [
            {
              approvalRequestId: "30000000-0000-4000-8000-000000000001",
              callId: "call-patch",
              files: [],
              planId: "f".repeat(64),
              sourceRunId: SOURCE_RUN_ID,
              step: 1,
            },
          ],
        }),
        patchReconciliations: [
          {
            details: ["src/a.ts"],
            planId: "f".repeat(64),
            reason: "mixed_state",
            status: "blocked",
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      reasons: ["pending_patch_ambiguous"],
      status: "blocked",
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("blocks an all-post patch until a byte-complete journal can be recovered", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const planId = "8".repeat(64);
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        ledger: ledger({
          pendingPatches: [
            {
              approvalRequestId: "30000000-0000-4000-8000-000000000001",
              callId: "call-patch",
              files: [],
              planId,
              sourceRunId: SOURCE_RUN_ID,
              step: 1,
            },
          ],
        }),
        patchReconciliations: [
          {
            files: [],
            observed: "applied",
            planId,
            status: "reconciled",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      details: [`${planId}:applied_effect_requires_recovered_journal`],
      reasons: ["pending_patch_ambiguous"],
      status: "blocked",
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("does not use an exact checkpoint superseded by an open model turn", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const result = new ResumePlanner({ createRunId }).plan(
      input({
        backend: exactBackend({
          canonicalBoundaryClosed: false,
          exactCheckpointUsable: false,
        }),
      }),
    );

    expect(result).toMatchObject({
      reasons: ["canonical_boundary_open"],
      status: "blocked",
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it("requires a new message for a completed run", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const blocked = new ResumePlanner({ createRunId }).plan(
      input({ sourceRunState: "completed" }),
    );
    const approvedPlanContinuation = new ResumePlanner({ createRunId }).plan(
      input({
        approvedPlanContinuation: true,
        sourceRunState: "completed",
      }),
    );
    const ready = new ResumePlanner({ createRunId }).plan(
      input({ message: "new turn", sourceRunState: "completed" }),
    );
    expect(blocked).toMatchObject({
      reasons: ["completed_run_requires_message"],
      status: "blocked",
    });
    expect(approvedPlanContinuation).toMatchObject({
      mode: "exact",
      status: "ready",
    });
    expect(ready).toMatchObject({ mode: "exact", status: "ready" });
  });

  it("treats a durable tool result after a pending canonical boundary as closed", async () => {
    const canonicalBackend: ModelBackend = {
      capabilities: exactModelBackend.capabilities,
      identity,
      resume: {
        capability: "canonical_only",
        supportsCanonicalDegradedResume: true,
      },
      async *runTurn() {
        yield* [];
      },
    };
    const events = decodeStoredEvents([
      {
        data: {
          command: "chat",
          input: { role: "user", text: "canonical tool result" },
          model: identity.model,
          provider: identity.provider,
          timeout_ms: 1_000,
          tools: ["read_file"],
          tools_enabled: true,
          workspace: "C:\\fixture",
        },
        event_id: "52000000-0000-4000-8000-000000000001",
        run_id: SOURCE_RUN_ID,
        run_seq: 1,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 1,
        timestamp: "2026-07-17T00:00:00.000Z",
        type: "run.started",
      },
      {
        data: {
          adapter: identity.adapter,
          adapter_version: identity.adapterVersion,
          capabilities: canonicalBackend.capabilities,
          config_fingerprint: identity.configFingerprint,
          model: identity.model,
          provider: identity.provider,
          resume_capability: "canonical_only",
        },
        event_id: "52000000-0000-4000-8000-000000000002",
        run_id: SOURCE_RUN_ID,
        run_seq: 2,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 2,
        timestamp: "2026-07-17T00:00:01.000Z",
        type: "backend.selected",
      },
      {
        data: {
          input_kind: "user_task",
          max_steps: 8,
          remaining_duration_ms: 1_000,
          remaining_tokens: 1_000,
          remaining_tool_output_bytes: 1_000,
          step: 1,
        },
        event_id: "52000000-0000-4000-8000-000000000003",
        run_id: SOURCE_RUN_ID,
        run_seq: 3,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 3,
        timestamp: "2026-07-17T00:00:02.000Z",
        type: "agent.step.started",
      },
      {
        data: {
          duration_ms: 1,
          outcome: "tool_call",
          step: 1,
          text_chars: 0,
          tool_call_id: "call-read",
        },
        event_id: "52000000-0000-4000-8000-000000000004",
        run_id: SOURCE_RUN_ID,
        run_seq: 4,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 4,
        timestamp: "2026-07-17T00:00:03.000Z",
        type: "agent.step.completed",
      },
      {
        data: {
          arguments_json: '{"path":"README.md"}',
          call_id: "call-read",
          provider_response_id: "response-read",
          step: 1,
          tool_name: "read_file",
        },
        event_id: "52000000-0000-4000-8000-000000000005",
        run_id: SOURCE_RUN_ID,
        run_seq: 5,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 5,
        timestamp: "2026-07-17T00:00:04.000Z",
        type: "tool.call.requested",
      },
      {
        data: {
          pending_call: true,
          transcript_sha256: "b".repeat(64),
          turn: 1,
        },
        event_id: "52000000-0000-4000-8000-000000000006",
        run_id: SOURCE_RUN_ID,
        run_seq: 6,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 6,
        timestamp: "2026-07-17T00:00:05.000Z",
        type: "backend.canonical_boundary.created",
      },
      {
        data: {
          call_id: "call-read",
          duration_ms: 1,
          output: '{"ok":true}',
          status: "success",
          step: 1,
          tool_name: "read_file",
          truncated: false,
        },
        event_id: "52000000-0000-4000-8000-000000000007",
        run_id: SOURCE_RUN_ID,
        run_seq: 7,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 7,
        timestamp: "2026-07-17T00:00:06.000Z",
        type: "tool.call.completed",
      },
    ]).filter((event) => event.scope === "run");

    const built = await new BackendResumeProjectionBuilder(
      {} as CheckpointStore,
    ).build({ backend: canonicalBackend, events });

    expect(built.projection).toMatchObject({
      canonicalBoundaryClosed: true,
      capability: "canonical_only",
    });
  });

  it("uses a durable cancellation as a closed canonical turn but keeps the crash prefix open", async () => {
    const canonicalBackend: ModelBackend = {
      capabilities: exactModelBackend.capabilities,
      identity,
      resume: {
        capability: "canonical_only",
        supportsCanonicalDegradedResume: true,
      },
      async *runTurn() {
        yield* [];
      },
    };
    const prefix = [
      {
        data: {
          command: "chat",
          input: { role: "user", text: "cancel a partial turn" },
          model: identity.model,
          provider: identity.provider,
          timeout_ms: 1_000,
          tools: [],
          tools_enabled: false,
          workspace: "C:\\fixture",
        },
        event_id: "53000000-0000-4000-8000-000000000001",
        run_id: SOURCE_RUN_ID,
        run_seq: 1,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 1,
        timestamp: "2026-07-17T00:00:00.000Z",
        type: "run.started",
      },
      {
        data: {
          adapter: identity.adapter,
          adapter_version: identity.adapterVersion,
          capabilities: canonicalBackend.capabilities,
          config_fingerprint: identity.configFingerprint,
          model: identity.model,
          provider: identity.provider,
          resume_capability: "canonical_only",
        },
        event_id: "53000000-0000-4000-8000-000000000002",
        run_id: SOURCE_RUN_ID,
        run_seq: 2,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 2,
        timestamp: "2026-07-17T00:00:01.000Z",
        type: "backend.selected",
      },
      {
        data: {
          input_kind: "user_task",
          max_steps: 8,
          remaining_duration_ms: 1_000,
          remaining_tokens: 1_000,
          remaining_tool_output_bytes: 1_000,
          step: 1,
        },
        event_id: "53000000-0000-4000-8000-000000000003",
        run_id: SOURCE_RUN_ID,
        run_seq: 3,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 3,
        timestamp: "2026-07-17T00:00:02.000Z",
        type: "agent.step.started",
      },
      {
        data: { delta: "partial", visibility: "user" },
        event_id: "53000000-0000-4000-8000-000000000004",
        run_id: SOURCE_RUN_ID,
        run_seq: 4,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 4,
        timestamp: "2026-07-17T00:00:03.000Z",
        type: "text.delta",
      },
    ];
    const cancelled = {
      data: {
        duration_ms: 4,
        output_chars: 7,
        reason: "user",
        steps: 1,
        tool_calls: 0,
      },
      event_id: "53000000-0000-4000-8000-000000000005",
      run_id: SOURCE_RUN_ID,
      run_seq: 5,
      schema_version: 2,
      scope: "run",
      session_id: SESSION_ID,
      session_seq: 5,
      timestamp: "2026-07-17T00:00:04.000Z",
      type: "run.cancelled",
    };
    const builder = new BackendResumeProjectionBuilder({} as CheckpointStore);
    const crashPrefix = decodeStoredEvents(prefix).filter(
      (event) => event.scope === "run",
    );
    const durableCancellation = decodeStoredEvents([...prefix, cancelled]).filter(
      (event) => event.scope === "run",
    );

    await expect(
      builder.build({ backend: canonicalBackend, events: crashPrefix }),
    ).resolves.toMatchObject({
      projection: { canonicalBoundaryClosed: false },
    });
    await expect(
      builder.build({ backend: canonicalBackend, events: durableCancellation }),
    ).resolves.toMatchObject({
      projection: { canonicalBoundaryClosed: true },
    });
  });

  it("rejects canonical-only mid-turn state and accepts a closed boundary with a flag", () => {
    const createRunId = vi.fn(() => NEW_RUN_ID);
    const canonical: BackendResumeProjection = {
      canonicalBoundaryClosed: false,
      capability: "canonical_only",
      checkpoint: null,
      checkpointPendingCall: null,
      exactCheckpointUsable: false,
      identity,
      supportsCanonicalDegradedResume: true,
    };
    const planner = new ResumePlanner({ createRunId });

    expect(planner.plan(input({ backend: canonical }))).toMatchObject({
      reasons: ["canonical_boundary_open"],
      status: "blocked",
    });
    expect(
      planner.plan(
        input({
          allowDegradedResume: true,
          backend: { ...canonical, canonicalBoundaryClosed: true },
        }),
      ),
    ).toMatchObject({ mode: "canonical_degraded", status: "ready" });
  });

  it("keeps a tool decision open until its durable request and result exist", async () => {
    const events = decodeStoredEvents([
      {
        data: {
          command: "chat",
          input: { role: "user", text: "open tool decision" },
          model: identity.model,
          provider: identity.provider,
          timeout_ms: 1_000,
          tools: [],
          tools_enabled: false,
          workspace: "C:\\fixture",
        },
        event_id: "51000000-0000-4000-8000-000000000001",
        run_id: SOURCE_RUN_ID,
        run_seq: 1,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 1,
        timestamp: "2026-07-17T00:00:00.000Z",
        type: "run.started",
      },
      {
        data: {
          adapter: identity.adapter,
          adapter_version: identity.adapterVersion,
          capabilities: exactModelBackend.capabilities,
          checkpoint_codec_version: checkpointCodec.codecVersion,
          config_fingerprint: identity.configFingerprint,
          model: identity.model,
          provider: identity.provider,
          resume_capability: "exact_checkpoint",
        },
        event_id: "51000000-0000-4000-8000-000000000002",
        run_id: SOURCE_RUN_ID,
        run_seq: 2,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 2,
        timestamp: "2026-07-17T00:00:01.000Z",
        type: "backend.selected",
      },
      {
        data: {
          adapter: identity.adapter,
          adapter_version: identity.adapterVersion,
          bytes: 4,
          checkpoint_id: "61000000-0000-4000-8000-000000000001",
          codec_version: checkpointCodec.codecVersion,
          model: identity.model,
          provider: identity.provider,
          ref: `.bornagent/checkpoints/${SESSION_ID}/61000000-0000-4000-8000-000000000001.bin`,
          sha256: "4".repeat(64),
          turn: 1,
        },
        event_id: "51000000-0000-4000-8000-000000000003",
        run_id: SOURCE_RUN_ID,
        run_seq: 3,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 3,
        timestamp: "2026-07-17T00:00:02.000Z",
        type: "backend.checkpoint.created",
      },
      {
        data: {
          input_kind: "tool_result",
          max_steps: 8,
          remaining_duration_ms: 1_000,
          remaining_tokens: 1_000,
          remaining_tool_output_bytes: 1_000,
          step: 2,
        },
        event_id: "51000000-0000-4000-8000-000000000004",
        run_id: SOURCE_RUN_ID,
        run_seq: 4,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 4,
        timestamp: "2026-07-17T00:00:03.000Z",
        type: "agent.step.started",
      },
      {
        data: {
          duration_ms: 1,
          outcome: "tool_call",
          step: 2,
          text_chars: 0,
          tool_call_id: "not-yet-durable",
        },
        event_id: "51000000-0000-4000-8000-000000000005",
        run_id: SOURCE_RUN_ID,
        run_seq: 5,
        schema_version: 2,
        scope: "run",
        session_id: SESSION_ID,
        session_seq: 5,
        timestamp: "2026-07-17T00:00:04.000Z",
        type: "agent.step.completed",
      },
    ]).filter((event) => event.scope === "run");
    const store = {
      readExact: async () => new PlannerContinuation(),
    } as unknown as CheckpointStore;
    const built = await new BackendResumeProjectionBuilder(store).build({
      backend: exactModelBackend,
      events,
    });

    expect(built.projection).toMatchObject({
      canonicalBoundaryClosed: false,
      exactCheckpointUsable: false,
    });
  });
});
