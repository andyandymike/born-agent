import { describe, expect, it } from "vitest";

import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import { createTaskPromotionGoalChangeRecordedData } from "../../src/worktrees/task-promotion-goal-change.js";

const sha = "b".repeat(64);

function data() {
  return createTaskPromotionGoalChangeRecordedData({
    files: [{ bytes: 4, kind: "modify", mode: "100644", path: "src/a.ts", post_sha256: sha, pre_sha256: "a".repeat(64) }],
    goal_id: "94000000-0000-4000-8000-000000000031",
    goal_revision: 1,
    source: {
      approval_event_id: "94000000-0000-4000-8000-000000000032",
      attempt_id: "94000000-0000-4000-8000-000000000033",
      bundle_sha256: sha,
      graph_id: "94000000-0000-4000-8000-000000000034",
      graph_revision: 1,
      graph_sha256: sha,
      kind: "task_promotion",
      node_id: "build",
      operation_id: "94000000-0000-4000-8000-000000000035",
      proposal_event_id: "94000000-0000-4000-8000-000000000036",
      request_event_id: "94000000-0000-4000-8000-000000000037",
      workspace_id: "94000000-0000-4000-8000-000000000038",
    },
  });
}

describe("Phase 19 task promotion Goal change", () => {
  it("routes the shared goal.change.recorded type by session scope and rejects hash tampering", () => {
    const valid = data();
    const [decoded] = decodeStoredEvents([{
      data: valid,
      event_id: "94000000-0000-4000-8000-000000000039",
      schema_version: 2,
      scope: "session",
      session_id: "94000000-0000-4000-8000-000000000040",
      session_seq: 1,
      timestamp: "2026-08-09T00:00:00.000Z",
      type: "goal.change.recorded",
    }]);
    expect(decoded?.scope).toBe("session");
    expect(() => decodeStoredEvents([{
      data: { ...valid, goal_revision: 2 },
      event_id: "94000000-0000-4000-8000-000000000039",
      schema_version: 2,
      scope: "session",
      session_id: "94000000-0000-4000-8000-000000000040",
      session_seq: 1,
      timestamp: "2026-08-09T00:00:00.000Z",
      type: "goal.change.recorded",
    }])).toThrow();
  });
});
