import { describe, expect, it } from "vitest";

import {
  createContextItem,
  type ContextArtifactReference,
} from "../../src/context/context-item.js";
import {
  ContextProjector,
  type ContextProjectionInput,
  type ProjectableContextEvent,
} from "../../src/context/context-projector.js";
import {
  ContextCompactionError,
} from "../../src/context/deterministic-compactor.js";
import { contextPlanSchema } from "../../src/context/context-plan-schema.js";
import { ContextPlanner } from "../../src/context/context-planner.js";
import { ProtectedFactLedger } from "../../src/context/protected-fact-ledger.js";
import {
  ContextBudgetError,
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../src/context/token-estimator.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const ARTIFACT: ContextArtifactReference = Object.freeze({
  artifactId: `sha256:${HASH_A}`,
  bytes: 12_000,
  mediaType: "text/plain; charset=utf-8",
  relativeRef: `.bornagent/artifacts/session/objects/${HASH_A}`,
  sha256: HASH_A,
});

const estimator = new DeterministicTokenEstimator({
  bytesPerToken: 1,
  itemOverheadTokens: 0,
  model: "deterministic-test-model",
  provider: "fake",
  tokenizer: "utf8-byte-upper-bound",
  version: "phase10-test-v1",
});

const budget = resolveContextBudget(
  {
    contextWindowTokens: 32_768,
    maximumOutputTokens: 4_096,
    source: "user_conservative_limit",
  },
  {
    compactionThreshold: 0.5,
    fixedSafetyMarginTokens: 0,
    reservedOutputTokens: 4_096,
  },
);

function event(
  sessionSeq: number,
  type: string,
  data: unknown,
): ProjectableContextEvent {
  return {
    data,
    eventId: `event-${String(sessionSeq).padStart(3, "0")}`,
    runId: "run-1",
    runSeq: sessionSeq,
    sessionSeq,
    type,
  };
}

function sessionEvent(
  sessionSeq: number,
  type: string,
  data: unknown,
): ProjectableContextEvent {
  return {
    data,
    eventId: `event-${String(sessionSeq).padStart(3, "0")}`,
    sessionSeq,
    type,
  };
}

function longClosedEvents(): readonly ProjectableContextEvent[] {
  return [
    event(1, "run.started", {
      command: "agent",
      input: { role: "user", text: "Implement the requested context core." },
    }),
    event(2, "patch.plan.created", {
      call_id: "call-patch",
      paths: [{ kind: "modify", path: "src/context/a.ts" }],
      plan_id: HASH_B,
      preview: "small deterministic patch",
    }),
    event(3, "approval.requested", {
      action: "apply_patch",
      approval_request_id: "approval-1",
      call_id: "call-patch",
      plan_id: HASH_B,
    }),
    event(4, "approval.decided", {
      action: "apply_patch",
      approval_request_id: "approval-1",
      call_id: "call-patch",
      decision: "approved",
      plan_id: HASH_B,
    }),
    event(5, "patch.apply.started", {
      approval_request_id: "approval-1",
      call_id: "call-patch",
      files: [{ kind: "modify", path: "src/context/a.ts" }],
      plan_id: HASH_B,
    }),
    event(6, "patch.apply.completed", {
      approval_request_id: "approval-1",
      call_id: "call-patch",
      files: [
        {
          kind: "modify",
          path: "src/context/a.ts",
          post_sha256: HASH_C,
          pre_sha256: HASH_A,
        },
      ],
      journal_sha256: HASH_C,
      plan_id: HASH_B,
    }),
    event(7, "completion.candidate", {
      call_id: "finish-1",
      candidate_sha256: HASH_C,
      status: "completed",
      summary: "candidate must remain internal until evaluated",
    }),
    event(8, "completion.evaluated", {
      call_id: "finish-1",
      candidate_sha256: HASH_C,
      effect: "continue",
      reasons: ["verification_required"],
    }),
    event(9, "tool.call.requested", {
      arguments_json: '{"query":"large result"}',
      call_id: "call-search",
      tool_name: "search",
    }),
    event(10, "tool.call.completed", {
      call_id: "call-search",
      output: "x".repeat(12_000),
      status: "success",
      tool_name: "search",
      truncated: true,
    }),
    event(11, "text.delta", {
      delta: "n".repeat(12_000),
      visibility: "internal_candidate",
    }),
  ];
}

function projectionInput(
  override: Partial<ContextProjectionInput> = {},
): ContextProjectionInput {
  return {
    artifactRefsByEventId: { "event-010": [ARTIFACT] },
    epoch: 0,
    events: longClosedEvents(),
    repositoryRules: {
      artifactRef: { ...ARTIFACT, artifactId: `sha256:${HASH_B}`, sha256: HASH_B },
      content: "Run typecheck and preserve all user constraints.",
      eventId: "rules-loaded",
      priorityExplanation: "below current user instructions",
      sha256: HASH_B,
    },
    systemInstructions: [
      {
        id: "security-policy",
        text: "Never exceed granted permissions.",
        version: "v1",
      },
    ],
    ...override,
  };
}

function planner(): ContextPlanner {
  return new ContextPlanner(estimator, {
    largeToolObservationTokens: 64,
    plannerVersion: "phase10-test-v1",
    recentGroupCount: 0,
  });
}

describe("Phase 10 deterministic context core", () => {
  it("produces stable IDs/order/hash and changes the canonical hash for facts, rules, or config", () => {
    const projector = new ContextProjector(estimator);
    const input = projectionInput();
    const forward = projector.project(input);
    const reverse = projector.project({
      ...input,
      events: [...input.events].reverse(),
    });
    const first = planner().plan(forward, budget);
    const second = planner().plan(reverse, budget);

    expect(second).toEqual(first);
    expect(first.canonicalContextSha256).toMatch(/^[0-9a-f]{64}$/u);

    const changedRules = projector.project(
      projectionInput({
        repositoryRules: {
          ...input.repositoryRules!,
          artifactRef: {
            ...input.repositoryRules!.artifactRef,
            artifactId: `sha256:${HASH_C}`,
            sha256: HASH_C,
          },
          content: "Run typecheck, lint, and preserve all user constraints.",
          sha256: HASH_C,
        },
      }),
    );
    const changedBudget = resolveContextBudget(
      {
        contextWindowTokens: 32_768,
        maximumOutputTokens: 4_096,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: 0.6,
        fixedSafetyMarginTokens: 0,
        reservedOutputTokens: 4_096,
      },
    );
    expect(planner().plan(changedRules, budget).canonicalContextSha256).not.toBe(
      first.canonicalContextSha256,
    );
    expect(planner().plan(forward, changedBudget).canonicalContextSha256).not.toBe(
      first.canonicalContextSha256,
    );
  });

  it("compacts deterministically without breaking tool, mutation, or completion pairing", () => {
    const state = new ContextProjector(estimator).project(projectionInput());
    const contextPlanner = planner();
    const plan = contextPlanner.plan(state, budget);
    const materialized = contextPlanner.materialize(state, budget, plan);

    expect(plan.compacted).toBe(true);
    expect(plan.epoch).toBe(1);
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(
      budget.absoluteInputTokens,
    );
    expect(plan.descriptorItemIds).toHaveLength(1);
    expect(materialized.sha256).toBe(plan.canonicalContextSha256);
    expect(estimator.estimateText(materialized.text).estimatedTokens).toBe(
      plan.estimatedInputTokens,
    );

    const originalObservation = state.items.find(
      (item) => item.kind === "tool_observation" && item.pairing?.id.includes("call-search"),
    );
    expect(plan.archivedItemIds).toContain(originalObservation?.id);
    const toolPair = materialized.items.filter((item) =>
      item.pairing?.id.includes("call-search"),
    );
    expect(toolPair.map(({ kind }) => kind).sort()).toEqual([
      "archived_tool_observation",
      "tool_call",
    ]);

    const mutation = state.items.filter(
      (item) => item.pairing?.kind === "mutation",
    );
    expect(mutation.every((item) => plan.includedItemIds.includes(item.id))).toBe(
      true,
    );
    const completion = state.items.filter(
      (item) => item.pairing?.kind === "completion",
    );
    expect(completion.every((item) => plan.includedItemIds.includes(item.id))).toBe(
      true,
    );
    expect(
      completion.find((item) => item.kind === "completion_candidate")?.visibility,
    ).toBe("internal_candidate");

    const protectedIds = new Set(plan.protectedItemIds);
    expect(plan.archivedItemIds.some((id) => protectedIds.has(id))).toBe(false);
    expect(
      state.items
        .filter((item) =>
          ["system_instruction", "user_message", "repository_rules"].includes(
            item.kind,
          ),
        )
        .every((item) => plan.includedItemIds.includes(item.id)),
    ).toBe(true);
  });

  it("increments one epoch per changed projected state and remains pure for identical input", () => {
    const projector = new ContextProjector(estimator);
    const initialState = projector.project(projectionInput());
    const first = planner().plan(initialState, budget);
    const nextState = projector.project(
      projectionInput({
        epoch: first.epoch,
        events: [
          ...longClosedEvents(),
          event(12, "text.delta", {
            delta: "new history ".repeat(1_000),
            visibility: "internal_candidate",
          }),
        ],
      }),
    );
    const second = planner().plan(nextState, budget);
    const repeated = planner().plan(nextState, budget);

    expect(first.epoch).toBe(1);
    expect(second.epoch).toBe(2);
    expect(repeated).toEqual(second);
  });

  it("refuses compaction while a tool/effect is active", () => {
    const activeEvents = [
      event(1, "run.started", {
        command: "agent",
        input: { role: "user", text: "keep the pending call" },
      }),
      event(2, "tool.call.requested", {
        arguments_json: JSON.stringify({ query: "x".repeat(20_000) }),
        call_id: "pending-call",
        tool_name: "search",
      }),
    ];
    const state = new ContextProjector(estimator).project(
      projectionInput({ events: activeEvents, repositoryRules: null }),
    );

    expect(state.safePoint).toBe(false);
    expect(() => planner().plan(state, budget)).toThrowError(
      expect.objectContaining({ code: "context_unsafe_compaction", exitCode: 7 }),
    );
  });

  it("closes a source-run pending call only through durable adoption and recovery facts", () => {
    const resumed = [
      event(1, "run.started", {
        command: "agent",
        input: { role: "user", text: "preserve the original constraint" },
      }),
      event(2, "tool.call.requested", {
        arguments_json: JSON.stringify({ query: "x".repeat(18_000) }),
        call_id: "source-call",
        tool_name: "search",
      }),
      sessionEvent(3, "session.resume.requested", {
          message: "also keep the resumed constraint",
          requested_mode: "exact",
          source_run_id: "run-1",
      }),
      {
        ...event(4, "run.started", {
          command: "agent",
          input: { role: "user", text: "Continue the original task." },
        }),
        runId: "run-2",
      },
      {
        ...event(5, "resume.pending_call.adopted", {
          call_id: "adopted-call",
          checkpoint_id: "checkpoint-1",
          source_call_id: "source-call",
          source_run_id: "run-1",
          step: 1,
          tool_name: "search",
        }),
        runId: "run-2",
      },
      {
        ...event(6, "tool.call.recovered", {
          call_id: "adopted-call",
          duration_ms: 0,
          output: "recovered result",
          source_run_id: "run-1",
          status: "success",
          step: 1,
          tool_name: "search",
          truncated: false,
        }),
        runId: "run-2",
      },
    ];
    const state = new ContextProjector(estimator).project(
      projectionInput({ events: resumed, repositoryRules: null }),
    );
    const plan = planner().plan(state, budget);

    expect(state.safePoint).toBe(true);
    expect(state.activeEffectIds).toEqual([]);
    expect(
      state.items.some(
        (item) =>
          item.kind === "user_message" &&
          item.content === "also keep the resumed constraint",
      ),
    ).toBe(true);
    expect(
      state.items
        .filter((item) => item.pairing?.id === "tool:run-1:source-call")
        .map((item) => item.pairing?.role)
        .sort(),
    ).toEqual(["call", "observation"]);
    expect(plan.protectedFactIds).not.toHaveLength(0);
  });

  it("turns durable patch reconciliation into protected state and a safe point", () => {
    const pendingPatch = [
      event(1, "run.started", {
        command: "agent",
        input: { role: "user", text: "reconcile the patch" },
      }),
      event(2, "patch.apply.started", {
        approval_request_id: "approval-1",
        call_id: "patch-call",
        files: [{ kind: "modify", path: "src/a.ts" }],
        plan_id: "plan-1",
      }),
      sessionEvent(3, "side_effect.reconciled", {
          effect_id: "plan-1",
          effect_kind: "patch",
          evidence_sha256: HASH_A,
          observed: "applied",
          source_run_id: "run-1",
      }),
    ];
    const state = new ContextProjector(estimator).project(
      projectionInput({ events: pendingPatch, repositoryRules: null }),
    );

    expect(state.safePoint).toBe(true);
    expect(
      state.items.some(
        (item) => item.protectedCategory === "change_journal",
      ),
    ).toBe(true);
  });

  it("fails closed with category occupancy when protected facts exceed absolute capacity", () => {
    const state = new ContextProjector(estimator).project({
      epoch: 0,
      events: [
        event(1, "run.started", {
          command: "agent",
          input: { role: "user", text: "u".repeat(20_000) },
        }),
      ],
      systemInstructions: [
        { id: "policy", text: "p".repeat(20_000), version: "v1" },
      ],
    });
    const tiny = resolveContextBudget(
      {
        contextWindowTokens: 2_048,
        maximumOutputTokens: 512,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: 0.5,
        fixedSafetyMarginTokens: 0,
        reservedOutputTokens: 512,
      },
    );

    try {
      planner().plan(state, tiny);
      throw new Error("expected protected overflow");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCompactionError);
      expect(error).toMatchObject({
        code: "context_protected_overflow",
        exitCode: 7,
      });
      const typed = error as ContextCompactionError;
      expect(typed.details.categoryEstimatedTokens).toMatchObject({
        system_policy: expect.any(Number),
        user_instruction: expect.any(Number),
      });
      expect(typed.details.estimatedTokens).toBeGreaterThan(
        typed.details.limitTokens,
      );
    }
  });

  it("keeps approval history non-authoritative and rejects invalid protected/archive plans", () => {
    const state = new ContextProjector(estimator).project(projectionInput());
    const approvals = state.items.filter(
      (item) => item.kind === "approval_history",
    );
    expect(approvals).not.toHaveLength(0);
    expect(approvals.every((item) => item.authority === "historical_only")).toBe(
      true,
    );
    const ledger = new ProtectedFactLedger().project({
      activeEffectIds: state.activeEffectIds,
      items: state.items,
    });
    expect(
      ledger.facts.some(({ category }) => category === "approval_history"),
    ).toBe(true);

    const valid = planner().plan(state, budget);
    const protectedId = valid.protectedItemIds[0]!;
    expect(
      contextPlanSchema.safeParse({
        ...valid,
        archivedItemIds: [...valid.archivedItemIds, protectedId],
      }).success,
    ).toBe(false);
  });

  it("separates deterministic estimates from capacity validation and stable item identity", () => {
    const seed = {
      authority: "narrative" as const,
      content: "same fact",
      kind: "assistant_message" as const,
      priority: "low" as const,
      recency: 1,
      role: "assistant" as const,
      sourceEventIds: ["event-stable"],
      visibility: "internal_candidate" as const,
    };
    const first = createContextItem(seed, estimator);
    const moved = createContextItem(
      { ...seed, priority: "normal", recency: 999 },
      estimator,
    );
    expect(moved.id).toBe(first.id);
    expect(first.estimatorId).toBe(estimator.estimatorId);
    expect(estimator.metadata).toMatchObject({ provider: "fake" });

    expect(() =>
      resolveContextBudget(
        {
          contextWindowTokens: null,
          maximumOutputTokens: null,
          source: "pinned_catalog",
        },
        { compactionThreshold: 0.8, reservedOutputTokens: 512 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "context_capacity_unknown" }),
    );
    expect(() =>
      resolveContextBudget(
        {
          contextWindowTokens: 2_048,
          maximumOutputTokens: 512,
          source: "user_conservative_limit",
        },
        { compactionThreshold: 0.49, reservedOutputTokens: 512 },
      ),
    ).toThrow(ContextBudgetError);
  });
});
