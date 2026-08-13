import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeTaskActionThroughApplicationService,
  registerTaskPreparedActionReviewer,
} from "../../src/control-plane/adapters/task-cli-adapter.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

async function fixture() {
  const stateRoot = await directory("bornagent-phase21a-tui-prepare-state-");
  const repositoryRoot = await directory("bornagent-phase21a-tui-prepare-repo-");
  const sessionId = crypto.randomUUID();
  const writer = await V2SessionWriter.createNew(repositoryRoot, sessionId);
  const goalId = crypto.randomUUID();
  await writer.appendTaskEvent("goal.created", {
    goal_id: goalId,
    objective: "Original Goal before TUI review",
    origin: { input_surface: "tui", kind: "user" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  await writer.close();
  const runtime = createRuntime({
    controlPlaneStateRoot: stateRoot,
    cwd: repositoryRoot,
    timestamp: () => new Date().toISOString(),
  });
  const io = createMemoryIO();
  // Trigger the same typed repository registration + legacy-session adoption
  // path used by production before installing the interactive reviewer.
  const materialized = await executeTaskActionThroughApplicationService({
    actionKind: "goal.propose",
    expectedSessionSeq: 1,
    io: io.io,
    payload: {
      baseRevision: 1,
      goalId,
      objective: "Materialize the formally adopted legacy session",
      operation: "revise",
    },
    runtime,
    sessionId,
    surface: "cli",
  });
  if (materialized.exitCode !== 0) {
    throw new Error(`fixture adoption failed: ${io.readStderr()}`);
  }
  const plane = await createPhase21ALocalControlPlane({
    launcher: {
      launch: async () => {
        throw new Error("TUI prepared-action fixture must not launch a run");
      },
    },
    stateRoot,
  });
  return {
    plane,
    goalId,
    runtime,
    sessionId,
    sessionPath: writer.path,
  };
}

function createGoalInput(test: Awaited<ReturnType<typeof fixture>>, io: ReturnType<typeof createMemoryIO>["io"]) {
  return {
    actionKind: "goal.propose" as const,
    expectedSessionSeq: 2,
    io,
    payload: {
      objective: "Commit only after the Host display is confirmed",
      baseRevision: 2,
      goalId: test.goalId,
      operation: "revise",
    },
    runtime: test.runtime,
    sessionId: test.sessionId,
    surface: "tui" as const,
  };
}

describe("Phase 21A TUI prepare-before-confirm integration", () => {
  it("does not create a domain operation until the rendered prepared identity is confirmed", async () => {
    const test = await fixture();
    const output = createMemoryIO();
    const order: string[] = [];
    const unregister = registerTaskPreparedActionReviewer(test.runtime, async (review) => {
      order.push("displayed");
      expect(review.preparedActionId).toMatch(/^[0-9a-f-]{36}$/u);
      if (review.actionKind === "goal.propose") {
        expect(review.summary).toContain("Goal");
        expect(await readStoredSession(test.sessionPath)).toHaveLength(2);
        expect((await test.plane.operations.list()).filter((operation) =>
          operation.actionKind === "goal.propose"
        )).toHaveLength(1);
      }
      return "confirmed";
    });
    try {
      const result = await executeTaskActionThroughApplicationService(
        createGoalInput(test, output.io),
      );
      order.push("committed");
      expect(result.exitCode, output.readStderr()).toBe(0);
    } finally {
      unregister();
    }

    expect(order.at(-2)).toBe("displayed");
    expect(order.at(-1)).toBe("committed");
    expect((await readStoredSession(test.sessionPath)).map((event) => event.type)).toEqual([
      "goal.created",
      "goal.revised",
      "goal.revised",
    ]);
    expect((await test.plane.operations.list()).filter((operation) =>
      operation.actionKind === "goal.propose"
    )).toHaveLength(2);
  });

  it("discards cancelled/stale reviews and prepares a fresh identity on retry", async () => {
    const test = await fixture();
    const preparedIds: string[] = [];
    const decisions = ["cancelled", "stale"] as const;
    const unregister = registerTaskPreparedActionReviewer(test.runtime, async (review) => {
      preparedIds.push(review.preparedActionId);
      return decisions[preparedIds.length - 1]!;
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const output = createMemoryIO();
        const result = await executeTaskActionThroughApplicationService(
          createGoalInput(test, output.io),
        );
        expect(result.exitCode, output.readStderr()).not.toBe(0);
      }
    } finally {
      unregister();
    }

    expect(preparedIds).toHaveLength(2);
    expect(preparedIds[1]).not.toBe(preparedIds[0]);
    expect(await readStoredSession(test.sessionPath)).toHaveLength(2);
    expect((await test.plane.operations.list()).filter((operation) =>
      operation.actionKind === "goal.propose"
    )).toHaveLength(1);
  });
});
