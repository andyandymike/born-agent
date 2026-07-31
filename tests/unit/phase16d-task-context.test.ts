import { describe, expect, it } from "vitest";

import {
  projectTaskContext,
  taskContextSourceEventIds,
} from "../../src/coordination/task-context-projection.js";
import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import { AgentContextRuntime } from "../../src/context/agent-context-runtime.js";
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../src/context/token-estimator.js";
import {
  GOAL,
  Phase16EventBuilder,
  PLAN,
  planIdentity,
  userOrigin,
} from "./phase16a-test-fixtures.js";

describe("Phase 16D protected task context", () => {
  it("projects only the active Goal, current Plan authority, and bounded change summary", () => {
    const builder = new Phase16EventBuilder();
    const identity = planIdentity();
    builder.session("goal.created", {
      goal_id: GOAL,
      objective: "Ship one reliable Agent workflow",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    builder.session("plan.proposed", {
      content: identity.content,
      origin: userOrigin,
      plan_sha256: identity.sha256,
    });
    builder.session("plan.approved", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: PLAN,
      plan_sha256: identity.sha256,
      revision: 1,
    });
    const state = TaskStateMachine.project(builder.decode());
    const projected = projectTaskContext({
      agentMode: "build",
      goalChanges: {
        changedPaths: ["src/z.ts", "src/a.ts", "src/a.ts"],
        ledgerSha256: "a".repeat(64),
      },
      taskState: state,
    });

    expect(projected.goal).toEqual({
      id: GOAL,
      objective: "Ship one reliable Agent workflow",
      revision: 1,
    });
    expect(projected.currentPlan).toMatchObject({
      planId: PLAN,
      revision: 1,
      sha256: identity.sha256,
    });
    expect(projected.goalChanges).toEqual({
      changedPathCount: 2,
      changedPaths: ["src/a.ts", "src/z.ts"],
      ledgerSha256: "a".repeat(64),
      pathsTruncated: false,
    });
    expect(taskContextSourceEventIds(state)).toEqual([
      state.goals[0]!.createdEventId,
      state.plans[0]!.createdEventId,
      state.plans[0]!.decisionEventId,
    ].sort());

    const estimator = new DeterministicTokenEstimator({
      model: "fixture",
      provider: "ollama",
      tokenizer: "utf8-conservative",
      version: "phase16d-v1",
    });
    const context = new AgentContextRuntime({
      budget: resolveContextBudget(
        {
          contextWindowTokens: 8_192,
          maximumOutputTokens: 1_024,
          source: "user_conservative_limit",
        },
        { compactionThreshold: 0.8, reservedOutputTokens: 1_024 },
      ),
      estimator,
      systemInstructions: "Plan safely.",
      taskContext: () => ({
        projection: projected,
        recency: state.lastSessionSeq,
        sourceEventIds: taskContextSourceEventIds(state),
      }),
    });
    const planned = context.plan({ epoch: 0, events: builder.decode() });
    const taskItem = planned.state.items.find((item) =>
      item.content.startsWith("BORNAGENT_TASK_CONTEXT_V1"),
    );
    expect(taskItem).toMatchObject({
      authority: "authoritative",
      kind: "state_fact",
      protectedCategory: "user_instruction",
      role: "system",
    });
    expect(taskItem?.content).toContain("Ship one reliable Agent workflow");
    expect(taskItem?.content).toContain(identity.sha256);
  });
});
