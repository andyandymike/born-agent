import { afterEach, describe, expect, it } from "vitest";

import { GoalManager } from "../../src/goals/goal-manager.js";
import { PlanStore } from "../../src/plans/plan-store.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import {
  cleanupTemporaryWorkspaces,
  context,
  editablePlan,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "./phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

describe("Phase 16B user PlanStore", () => {
  it("proposes, exact-approves, revises, and rejects without side-effect approvals", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    const mutationContext = context(workspace);
    const goal = await new GoalManager().createInitialGoal({
      context: mutationContext,
      objective: "Implement Phase 16B",
    });
    const store = new PlanStore();
    const first = await store.replaceDraft({
      base: null,
      context: mutationContext,
      editablePlan,
      goalId: goal.content.goalId,
      goalRevision: 1,
    });

    await expect(
      store.approveDraft({
        context: mutationContext,
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: first.content.planId,
        revision: 1,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "plan_stale" });

    const approved = await store.approveDraft({
      context: mutationContext,
      goalId: goal.content.goalId,
      goalRevision: 1,
      planId: first.content.planId,
      revision: 1,
      sha256: first.planSha256,
    });
    const second = await store.replaceDraft({
      base: {
        planId: approved.content.planId,
        revision: approved.content.revision,
        sha256: approved.planSha256,
      },
      context: mutationContext,
      editablePlan: { ...editablePlan, title: "Phase 16B revised" },
      goalId: goal.content.goalId,
      goalRevision: 1,
    });
    const rejected = await store.rejectDraft({
      context: mutationContext,
      goalId: goal.content.goalId,
      goalRevision: 1,
      planId: second.content.planId,
      reason: "Acceptance needs another explicit check.",
      revision: second.content.revision,
      sha256: second.planSha256,
    });

    const replay = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(rejected.status).toBe("rejected");
    expect(replay.taskState.currentApprovedPlan).toMatchObject({ revision: 1 });
    expect(replay.events.filter((event) => event.type === "approval.decided")).toHaveLength(0);
  });

  it("invalidates old Plan authority when the Goal revision changes", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    const mutationContext = context(workspace);
    const goals = new GoalManager();
    const goal = await goals.createInitialGoal({
      context: mutationContext,
      objective: "Initial",
    });
    const store = new PlanStore();
    const old = await store.replaceDraft({
      base: null,
      context: mutationContext,
      editablePlan,
      goalId: goal.content.goalId,
      goalRevision: 1,
    });
    await goals.reviseActiveGoal({
      baseRevision: 1,
      context: mutationContext,
      goalId: goal.content.goalId,
      objective: "Revised",
    });

    await expect(
      store.approveDraft({
        context: mutationContext,
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: old.content.planId,
        revision: old.content.revision,
        sha256: old.planSha256,
      }),
    ).rejects.toMatchObject({ code: "goal_stale" });

    const replacement = await store.replaceDraft({
      base: null,
      context: mutationContext,
      editablePlan,
      goalId: goal.content.goalId,
      goalRevision: 2,
    });
    expect(replacement.content.planId).not.toBe(old.content.planId);
    expect(replacement.content.revision).toBe(1);
  });
});
