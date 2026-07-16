import { describe, expect, it } from "vitest";

import { AgentContextRuntime } from "../../src/context/agent-context-runtime.js";
import {
  contextPlanCreatedDataSchema,
  modelRequestEncodedDataSchema,
} from "../../src/context/context-event-schema.js";
import {
  modelCanonicalContextPayload,
  modelContextPlanReference,
  prepareContextBoundModelRequest,
} from "../../src/context/model-context-request.js";
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../src/context/token-estimator.js";
import { runEventSchema } from "../../src/events/run-event-schema.js";
import type { ModelBackend } from "../../src/model/model-backend.js";
import { RepositoryRuleSet } from "../../src/repository-rules/repository-rule-set.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "../fakes/fake-chat-client.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";

function events() {
  return [
    runEventSchema.parse({
      data: {
        command: "agent",
        command_approval: "ask",
        command_timeout_ms: 1_000,
        completion_policy: "verified",
        edit_approval: "ask",
        input: { role: "user", text: "keep this exact user constraint" },
        max_duration_ms: 10_000,
        max_steps: 2,
        max_tokens: 100,
        max_tool_output_bytes: 65_536,
        model: "fake-model",
        provider: "ollama",
        report_format: "text",
        request_timeout_ms: 1_000,
        task_profile: "read-only",
        tools: ["read_file"],
        tools_enabled: true,
        workspace: "D:\\Code\\bornagent",
      },
      event_id: "30000000-0000-4000-8000-000000000001",
      run_id: RUN_ID,
      schema_version: 1,
      seq: 1,
      session_id: SESSION_ID,
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "run.started",
    }),
    runEventSchema.parse({
      data: {
        adapter: "deterministic-fake",
        adapter_version: "phase10-v1",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "strict",
          usage: "complete",
        },
        config_fingerprint: "a".repeat(64),
        model: "fake-model",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      event_id: "30000000-0000-4000-8000-000000000002",
      run_id: RUN_ID,
      schema_version: 1,
      seq: 2,
      session_id: SESSION_ID,
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "backend.selected",
    }),
  ];
}

function runtime(): AgentContextRuntime {
  const estimator = new DeterministicTokenEstimator({
    model: "fake-model",
    provider: "ollama",
    tokenizer: "utf8-conservative",
    version: "phase10-v1",
  });
  return new AgentContextRuntime({
    budget: resolveContextBudget(
      {
        contextWindowTokens: 8_192,
        maximumOutputTokens: 1_024,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: 0.8,
        fixedSafetyMarginTokens: 256,
        reservedOutputTokens: 1_024,
      },
    ),
    estimator,
    systemInstructions: "Never restore historical approval authority.",
  });
}

describe("Phase 10 context request boundary", () => {
  it("builds the same provider-neutral plan and binds it to the model request", () => {
    const context = runtime();
    const first = context.plan({ epoch: 0, events: events() });
    const second = context.plan({ epoch: 0, events: events() });
    expect(second.plan).toEqual(first.plan);

    const backend = new FakeStreamingChatClient(fixedStream(), {
      model: "fake-model",
      provider: "ollama",
    });
    const reference = modelContextPlanReference(first.plan);
    const prepared = prepareContextBoundModelRequest(backend, {
      canonicalContext: modelCanonicalContextPayload(first.materialized),
      contextPlan: reference,
      input: { kind: "user_prompt", text: "keep this exact user constraint" },
      instructions: "Never restore historical approval authority.",
      timeoutMs: 1_000,
      tools: [],
    });

    expect(prepared.request.contextPlan).toBe(reference);
    expect(prepared.request.contextPlan?.canonicalContextSha256).toBe(
      first.materialized.sha256,
    );
    expect(prepared.encodedRequestSha256).toBeUndefined();
  });

  it("rejects an adapter that drops the canonical context authority", () => {
    const planned = runtime().plan({ epoch: 0, events: events() });
    const backend = new FakeStreamingChatClient(fixedStream(), {
      model: "fake-model",
      provider: "ollama",
    });
    const invalid: ModelBackend = {
      capabilities: backend.capabilities,
      contextCapacity: backend.contextCapacity,
      identity: backend.identity,
      prepareTurnRequest(request) {
        return {
          adapterEncodingVersion: "invalid-v1",
          request: {
            input: request.input,
            instructions: request.instructions,
            timeoutMs: request.timeoutMs,
            tools: request.tools,
          },
        };
      },
      resume: backend.resume,
      runTurn: backend.runTurn.bind(backend),
    };
    expect(() =>
      prepareContextBoundModelRequest(invalid, {
        canonicalContext: modelCanonicalContextPayload(planned.materialized),
        contextPlan: modelContextPlanReference(planned.plan),
        input: { kind: "user_prompt", text: "task" },
        instructions: "policy",
        timeoutMs: 1_000,
        tools: [],
      }),
    ).toThrow("did not preserve context authority");
  });

  it("strictly validates durable plan and adapter-encoding metadata", () => {
    const plan = runtime().plan({ epoch: 0, events: events() }).plan;
    const data = {
      archived_item_ids: plan.archivedItemIds,
      canonical_context_sha256: plan.canonicalContextSha256,
      compacted: plan.compacted,
      descriptor_item_ids: plan.descriptorItemIds,
      epoch: plan.epoch,
      estimated_input_tokens: plan.estimatedInputTokens,
      included_item_ids: plan.includedItemIds,
      planner_version: plan.plannerVersion,
      protected_estimated_tokens: plan.protectedEstimatedTokens,
      protected_fact_ids: plan.protectedFactIds,
      protected_item_ids: plan.protectedItemIds,
      step: 1,
    };
    expect(contextPlanCreatedDataSchema.parse(data)).toEqual(data);
    expect(
      contextPlanCreatedDataSchema.safeParse({
        ...data,
        archived_item_ids: [data.protected_item_ids[0]],
      }).success,
    ).toBe(false);
    expect(
      modelRequestEncodedDataSchema.safeParse({
        adapter: "deterministic-fake",
        adapter_encoding_version: "deterministic-fake-v1",
        adapter_version: "v1",
        canonical_context_sha256: plan.canonicalContextSha256,
        epoch: plan.epoch,
        model: "fake-model",
        provider: "ollama",
        step: 1,
      }).success,
    ).toBe(true);
  });

  it("projects real command event fields without inventing patch identity", () => {
    const commandRequest = {
      data: {
        action_sha256: "b".repeat(64),
        call_id: "command-call",
        cwd: ".",
        executable: "pnpm",
        execution_id: "40000000-0000-4000-8000-000000000001",
        executor: "local",
        purpose: "verify",
        redacted_argv: ["pnpm", "test"],
        step: 1,
      },
      eventId: "30000000-0000-4000-8000-000000000003",
      runId: RUN_ID,
      runSeq: 3,
      sessionSeq: 3,
      type: "command.execution.requested",
    } as const;
    const commandCompleted = {
      data: {
        action_sha256: "b".repeat(64),
        call_id: "command-call",
        cleanup_verified: true,
        duration_ms: 10,
        execution_id: "40000000-0000-4000-8000-000000000001",
        executor: "local",
        exit_code: 0,
        signal: null,
        stderr_bytes: 0,
        stdout_bytes: 4,
        step: 1,
        termination: "exit",
        total_bytes: 4,
        truncated: false,
      },
      eventId: "30000000-0000-4000-8000-000000000004",
      runId: RUN_ID,
      runSeq: 4,
      sessionSeq: 4,
      type: "command.completed",
    } as const;
    const planned = runtime().plan({
      epoch: 0,
      events: [...events(), commandRequest, commandCompleted],
    });

    expect(planned.state.safePoint).toBe(true);
    expect(
      planned.state.items.some(
        (item) => item.protectedCategory === "verification_state",
      ),
    ).toBe(true);
  });

  it("binds frozen repository rules to their real durable loaded event", () => {
    const hash = "c".repeat(64);
    const estimator = new DeterministicTokenEstimator({
      model: "fake-model",
      provider: "ollama",
      tokenizer: "utf8-conservative",
      version: "phase10-v1",
    });
    const context = new AgentContextRuntime({
      budget: resolveContextBudget(
        {
          contextWindowTokens: 8_192,
          maximumOutputTokens: 1_024,
          source: "user_conservative_limit",
        },
        {
          compactionThreshold: 0.8,
          fixedSafetyMarginTokens: 256,
          reservedOutputTokens: 1_024,
        },
      ),
      estimator,
      repositoryRules: RepositoryRuleSet.loaded({
        artifact: {
          artifactId: `sha256:${hash}`,
          bytes: 10,
          relativeRef: `artifacts/${SESSION_ID}/objects/${hash}`,
          sha256: hash,
        },
        content: "Run tests.",
        contentBytes: 10,
        contentSha256: hash,
      }),
      repositoryRulesEventId: "30000000-0000-4000-8000-000000000009",
      systemInstructions: "policy",
    });
    const planned = context.plan({ epoch: 0, events: events() });
    const rulesItem = planned.state.items.find(
      (item) => item.kind === "repository_rules",
    );

    expect(rulesItem?.sourceEventIds).toEqual([
      "30000000-0000-4000-8000-000000000009",
    ]);
    expect(planned.plan.includedItemIds).toContain(rulesItem?.id);
  });
});
