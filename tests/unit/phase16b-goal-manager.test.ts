import { afterEach, describe, expect, it } from "vitest";

import { GoalManager } from "../../src/goals/goal-manager.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import {
  cleanupTemporaryWorkspaces,
  context,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "./phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

describe("Phase 16B GoalManager", () => {
  it("adopts a legacy session, exact-revises it, and performs an atomic replacement", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    const mutationContext = context(workspace);
    const manager = new GoalManager();

    const initial = await manager.createInitialGoal({
      context: mutationContext,
      objective: "Build a reviewable control plane",
    });
    const revised = await manager.reviseActiveGoal({
      baseRevision: 1,
      context: mutationContext,
      goalId: initial.content.goalId,
      objective: "Build and verify a reviewable control plane",
    });
    const replacement = await manager.startNewGoal({
      context: mutationContext,
      objective: "Continue with agent plan mutations",
      parentGoalId: initial.content.goalId,
      replaceActive: {
        confirmedAbandon: true,
        goalId: initial.content.goalId,
        revision: revised.content.revision,
      },
    });

    const replay = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(replay.taskState).toMatchObject({
      activeGoalId: replacement.content.goalId,
      trackingMode: "phase16",
    });
    expect(replay.taskState.goals).toEqual([
      expect.objectContaining({
        content: expect.objectContaining({ revision: 2 }),
        status: "abandoned",
      }),
      expect.objectContaining({ status: "active" }),
    ]);
  });

  it("rejects stale revisions without appending another task event", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    const mutationContext = context(workspace);
    const manager = new GoalManager();
    const initial = await manager.createInitialGoal({
      context: mutationContext,
      objective: "Initial objective",
    });
    const before = await new SessionCatalog(workspace).read(SESSION_ID);

    await expect(
      manager.reviseActiveGoal({
        baseRevision: 99,
        context: mutationContext,
        goalId: initial.content.goalId,
        objective: "Stale objective",
      }),
    ).rejects.toMatchObject({ code: "goal_stale" });

    const after = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(after.events).toHaveLength(before.events.length);
  });

  it("rechecks the TUI session sequence after acquiring the writer lock", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    const mutationContext = context(workspace);
    const manager = new GoalManager();
    const initial = await manager.createInitialGoal({
      context: mutationContext,
      objective: "Sequence-bound objective",
    });
    const before = await new SessionCatalog(workspace).read(SESSION_ID);

    await expect(
      manager.reviseActiveGoal({
        baseRevision: 1,
        context: {
          ...mutationContext,
          expectedSessionSeq: before.taskState.lastSessionSeq - 1,
          inputSurface: "tui",
        },
        goalId: initial.content.goalId,
        objective: "This stale TUI edit must not commit",
      }),
    ).rejects.toMatchObject({ code: "stale_snapshot" });

    const after = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(after.events).toHaveLength(before.events.length);
  });
});
