import { describe, expect, it } from "vitest";

import { BornAgentViewComponent } from "../../src/tui/components/bornagent-view.js";
import { Phase16TuiProjector } from "../../src/tui/phase16-tui-projector.js";
import { createInitialTuiEphemeralState } from "../../src/tui/tui-ephemeral-state.js";
import {
  reducePersistedEvent,
  replayPersistedEvents,
} from "../../src/tui/tui-event-reducer.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";
import {
  GOAL,
  Phase16EventBuilder,
  planContent,
  planIdentity,
  userOrigin,
} from "./phase16a-test-fixtures.js";

function taskEvents() {
  const builder = new Phase16EventBuilder();
  const content = planContent();
  const identity = planIdentity(content);
  builder.session("goal.created", {
    goal_id: GOAL,
    objective: "Deliver continuous Phase 16 collaboration",
    origin: { ...userOrigin, input_surface: "tui" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  builder.session("plan.proposed", {
    content,
    origin: { ...userOrigin, input_surface: "tui" },
    plan_sha256: identity.sha256,
  });
  builder.session("plan.approved", {
    goal_id: GOAL,
    goal_revision: 1,
    origin: { ...userOrigin, input_surface: "tui" },
    plan_id: content.planId,
    plan_sha256: identity.sha256,
    revision: 1,
  });
  return builder.decode();
}

describe("Phase 16F durable TUI projection", () => {
  it("keeps task events on the supported reducer path", () => {
    const events = taskEvents();
    const live = events.reduce(reducePersistedEvent, createInitialTuiViewState());
    const replay = replayPersistedEvents(events, createInitialTuiViewState());

    expect(live.session.fatalReason).toBeNull();
    expect(replay).toEqual(live);
  });

  it("projects identical live/replay TaskState and OutcomeReport hashes", () => {
    const events = taskEvents();
    const liveProjector = new Phase16TuiProjector();
    const replayProjector = new Phase16TuiProjector();
    let live = null;
    let replay = null;
    for (const event of events) live = liveProjector.accept(event);
    for (const event of events) replay = replayProjector.accept(event);

    expect(live).not.toBeNull();
    expect(replay).toEqual(live);
    expect(live?.taskState.currentApprovedPlan).not.toBeNull();
    expect(live?.outcomeReport.outcome).toBe("idle");
    expect(replay?.outcomeReport.reportSha256).toBe(
      live?.outcomeReport.reportSha256,
    );
  });

  it("renders Goal, approved Plan, durable Todo, and the canonical outcome card", () => {
    const projector = new Phase16TuiProjector();
    let projection = null;
    for (const event of taskEvents()) projection = projector.accept(event);
    expect(projection).not.toBeNull();
    if (projection === null) return;
    const view = {
      ...createInitialTuiViewState(),
      outcomeReport: projection.outcomeReport,
      taskState: projection.taskState,
    };
    const text = new BornAgentViewComponent(
      view,
      createInitialTuiEphemeralState(),
    )
      .render(160)
      .join("\n");

    expect(text).toContain("MODE | PLAN (read-only)");
    expect(text).toContain("GOAL | active");
    expect(text).toContain("PLAN EXECUTING");
    expect(text).toContain("[pending] implement");
    expect(text).toContain(
      `OUTCOME HASH | ${projection.outcomeReport.reportSha256}`,
    );
  });
});
