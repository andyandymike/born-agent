import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import {
  reconstructMultiRunSession,
  SessionProjectionError,
} from "../../src/sessions/reconstruct-multi-run-session.js";
import {
  GOAL,
  GOAL_2,
  PLAN,
  RUN,
  RUN_2,
  SESSION,
  TIME,
  backendSelectedData,
  chatStartData,
  planContent,
  planIdentity,
  userOrigin,
  uuid,
} from "./phase16a-test-fixtures.js";

function bytesHash(values: readonly unknown[]): string {
  return createHash("sha256")
    .update(values.map((value) => JSON.stringify(value)).join("\n"), "utf8")
    .digest("hex");
}

function v1Start(): Record<string, unknown> {
  return {
    data: chatStartData(),
    event_id: uuid(18_001),
    run_id: RUN,
    schema_version: 1,
    seq: 1,
    session_id: SESSION,
    timestamp: TIME,
    type: "run.started",
  };
}

function v1Completed(seq = 2): Record<string, unknown> {
  return {
    data: { duration_ms: 1, output_chars: 0 },
    event_id: uuid(18_002),
    run_id: RUN,
    schema_version: 1,
    seq,
    session_id: SESSION,
    timestamp: TIME,
    type: "run.completed",
  };
}

function sessionEvent(
  sessionSeq: number,
  type: string,
  data: unknown,
): Record<string, unknown> {
  return {
    data,
    event_id: uuid(18_100 + sessionSeq),
    schema_version: 2,
    scope: "session",
    session_id: SESSION,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
  };
}

function run2Event(
  sessionSeq: number,
  runSeq: number,
  type: string,
  data: unknown,
): Record<string, unknown> {
  return {
    data,
    event_id: uuid(18_200 + sessionSeq),
    run_id: RUN_2,
    run_seq: runSeq,
    schema_version: 2,
    scope: "run",
    session_id: SESSION,
    session_seq: sessionSeq,
    timestamp: TIME,
    type,
  };
}

describe("Phase 16A multi-run task replay", () => {
  it("projects Phase 0-15 history as legacy_untracked without rewriting bytes", () => {
    const values = [v1Start(), v1Completed()];
    const before = bytesHash(values);
    const original = structuredClone(values);

    const session = reconstructMultiRunSession(decodeStoredEvents(values));

    expect(session.taskState).toEqual({
      activeGoalId: null,
      blockers: [],
      currentApprovedPlan: null,
      goals: [],
      lastSessionSeq: 2,
      pendingDraft: null,
      plans: [],
      readyForCompletion: false,
      trackingMode: "legacy_untracked",
    });
    expect(values).toEqual(original);
    expect(bytesHash(values)).toBe(before);
  });

  it("replays Phase 16 facts interleaved across multiple runs deterministically", () => {
    const content = planContent();
    const values = [
      v1Start(),
      sessionEvent(2, "goal.created", {
        goal_id: GOAL,
        objective: "Implement Phase 16A",
        origin: userOrigin,
        parent_goal_id: null,
        replaces_active_goal: null,
        revision: 1,
      }),
      sessionEvent(3, "session.resume.requested", {
        requested_mode: "exact",
        source_run_id: RUN,
      }),
      run2Event(
        4,
        1,
        "run.started",
        chatStartData({ resume_mode: "exact", resume_of_run_id: RUN }),
      ),
      run2Event(5, 2, "backend.selected", backendSelectedData()),
      sessionEvent(6, "plan.proposed", {
        content,
        origin: userOrigin,
        plan_sha256: planIdentity(content).sha256,
      }),
      run2Event(7, 3, "run.completed", {
        duration_ms: 1,
        output_chars: 0,
      }),
    ];
    const encoded = JSON.stringify(values);
    const live = reconstructMultiRunSession(decodeStoredEvents(values));
    const rereadValues = JSON.parse(encoded) as unknown[];
    const reread = reconstructMultiRunSession(
      decodeStoredEvents(rereadValues),
    );

    expect(reread.taskState).toEqual(live.taskState);
    expect(live).toMatchObject({
      lastRun: { runId: RUN_2, status: "completed" },
      taskState: {
        activeGoalId: GOAL,
        pendingDraft: { planId: PLAN, revision: 1 },
        trackingMode: "phase16",
      },
    });
    expect(live.runs).toHaveLength(2);
    expect(live.runs[0]?.status).toBe("interrupted");
    expect(live.taskState.lastSessionSeq).toBe(7);
  });

  it("wraps typed task corruption with bounded SessionProjectionError code/cause", () => {
    const values = [
      v1Start(),
      v1Completed(),
      sessionEvent(3, "goal.created", {
        goal_id: GOAL,
        objective: "First Goal",
        origin: userOrigin,
        parent_goal_id: null,
        replaces_active_goal: null,
        revision: 1,
      }),
      sessionEvent(4, "goal.created", {
        goal_id: GOAL_2,
        objective: "Conflicting Goal",
        origin: userOrigin,
        parent_goal_id: null,
        replaces_active_goal: null,
        revision: 1,
      }),
    ];
    let caught: unknown;
    try {
      reconstructMultiRunSession(decodeStoredEvents(values));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionProjectionError);
    expect(caught).toMatchObject({
      code: "active_goal_conflict",
      cause: { code: "active_goal_conflict", sessionSeq: 4 },
    });
    expect((caught as Error).message.length).toBeLessThan(700);
  });
});
