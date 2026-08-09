import { describe, expect, it } from "vitest";

import {
  decodeStoredEvents,
  StoredEventDecodeError,
} from "../../src/events/event-decoder-registry.js";
import { phase16TaskSessionEventDataSchemas } from "../../src/coordination/task-event-schema.js";
import {
  GOAL,
  PLAN,
  Phase16EventBuilder,
  agentOrigin,
  hostOrigin,
  planContent,
  planIdentity,
  userOrigin,
  uuid,
} from "./phase16a-test-fixtures.js";

describe("Phase 16A task event decoder", () => {
  it("registers exactly the nine strict Phase 16 session event payloads", () => {
    const first = planContent();
    const second = planContent({ revision: 2, title: "Phase 16A revised" });
    const firstHash = planIdentity(first).sha256;
    const secondHash = planIdentity(second).sha256;
    const builder = new Phase16EventBuilder();

    builder.session("goal.created", {
      goal_id: GOAL,
      objective: "Implement 16A",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    builder.session("goal.revised", {
      base_revision: 1,
      goal_id: GOAL,
      objective: "Implement the complete 16A kernel",
      origin: userOrigin,
      revision: 2,
    });
    builder.session("goal.status.changed", {
      from: "active",
      goal_id: GOAL,
      origin: userOrigin,
      reason: "superseded by another task",
      revision: 2,
      to: "abandoned",
    });
    builder.session("plan.proposed", {
      content: first,
      origin: userOrigin,
      plan_sha256: firstHash,
    });
    builder.session("plan.revised", {
      base_revision: 1,
      base_sha256: firstHash,
      content: second,
      origin: agentOrigin("call-revise"),
      plan_sha256: secondHash,
    });
    builder.session("plan.approved", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: PLAN,
      plan_sha256: secondHash,
      revision: 2,
    });
    builder.session("plan.rejected", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: PLAN,
      plan_sha256: secondHash,
      reason: "needs more detail",
      revision: 2,
    });
    builder.session("plan.item.status_changed", {
      evidence_event_ids: [uuid(16_800)],
      from: "in_progress",
      goal_id: GOAL,
      goal_revision: 1,
      item_id: "implement",
      note: "verified",
      origin: agentOrigin("call-progress"),
      plan_id: PLAN,
      plan_sha256: secondHash,
      revision: 2,
      to: "completed",
    });
    builder.session("plan.completed", {
      completion_evaluated_event_id: uuid(16_801),
      finish_task_call_id: "call-finish",
      goal_id: GOAL,
      goal_revision: 1,
      origin: hostOrigin,
      plan_id: PLAN,
      plan_sha256: secondHash,
      revision: 2,
    });

    expect(builder.decode().map((event) => event.type)).toEqual([
      "goal.created",
      "goal.revised",
      "goal.status.changed",
      "plan.proposed",
      "plan.revised",
      "plan.approved",
      "plan.rejected",
      "plan.item.status_changed",
      "plan.completed",
    ]);
    expect(
      Object.keys(phase16TaskSessionEventDataSchemas).filter(
        (type) => type.startsWith("goal.") || type.startsWith("plan."),
      ),
    ).toHaveLength(9);
  });

  it("rejects extra fields, wrong scope, malformed hashes, and noncanonical stored text", () => {
    const content = planContent();
    const builder = new Phase16EventBuilder();
    builder.session("goal.created", {
      extra: true,
      goal_id: GOAL,
      objective: "bad\r\nobjective",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    expect(() => builder.decode()).toThrow(StoredEventDecodeError);

    const wrongScope = new Phase16EventBuilder();
    wrongScope.run("plan.proposed", {
      content,
      origin: userOrigin,
      plan_sha256: "not-a-hash",
    });
    expect(() => wrongScope.decode()).toThrow(StoredEventDecodeError);

    const malformed = new Phase16EventBuilder();
    malformed.session("plan.proposed", {
      content,
      origin: userOrigin,
      plan_sha256: "A".repeat(64),
    });
    expect(() => decodeStoredEvents(malformed.values)).toThrow(
      StoredEventDecodeError,
    );
  });

  it("rejects duplicate evidence ids and non-user Goal authority", () => {
    const builder = new Phase16EventBuilder();
    builder.session("plan.item.status_changed", {
      evidence_event_ids: [uuid(16_802), uuid(16_802)],
      from: "in_progress",
      goal_id: GOAL,
      goal_revision: 1,
      item_id: "implement",
      note: "done",
      origin: agentOrigin("call-progress"),
      plan_id: PLAN,
      plan_sha256: "a".repeat(64),
      revision: 1,
      to: "completed",
    });
    expect(() => builder.decode()).toThrow(StoredEventDecodeError);

    const forgedGoal = new Phase16EventBuilder();
    forgedGoal.session("goal.created", {
      goal_id: GOAL,
      objective: "forged",
      origin: agentOrigin("call-forged"),
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    expect(() => forgedGoal.decode()).toThrow(StoredEventDecodeError);
  });
});
