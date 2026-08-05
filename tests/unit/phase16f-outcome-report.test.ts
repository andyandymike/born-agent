import { describe, expect, it } from "vitest";

import {
  OutcomeReportBuilder,
  outcomeReportSchema,
} from "../../src/coordination/outcome-report.js";
import { renderOutcomeReport } from "../../src/coordination/outcome-report-renderer.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import {
  GOAL,
  GOAL_2,
  Phase16EventBuilder,
  backendSelectedData,
  chatStartData,
  planContent,
  planIdentity,
  userOrigin,
} from "./phase16a-test-fixtures.js";

function idleGoalSession() {
  const builder = new Phase16EventBuilder();
  builder.session("goal.created", {
    goal_id: GOAL,
    objective: "Produce a canonical report",
    origin: userOrigin,
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  return reconstructMultiRunSession(builder.decode());
}

describe("Phase 16F OutcomeReport", () => {
  it("is canonical, hash-bound, and renderer-neutral", () => {
    const report = new OutcomeReportBuilder().build(idleGoalSession());
    expect(report).toMatchObject({
      changeAttribution: null,
      changes: [],
      outcome: "idle",
      outcomeReasons: [],
      usage: {
        billedCost: null,
        estimatedCost: null,
        inputTokens: null,
        outputTokens: null,
      },
    });
    expect(JSON.parse(renderOutcomeReport(report, "json"))).toEqual(report);
    expect(renderOutcomeReport(report, "text")).toContain(
      `Outcome report: ${report.reportSha256}`,
    );
  });

  it("rejects a report whose facts changed without recomputing its hash", () => {
    const report = new OutcomeReportBuilder().build(idleGoalSession());
    expect(() =>
      outcomeReportSchema.parse({ ...report, outcome: "completed" }),
    ).toThrow(/hash does not match/u);
  });

  it("keeps the executing Plan and a pending replacement revision separate", () => {
    const builder = new Phase16EventBuilder();
    const first = planContent();
    const firstIdentity = planIdentity(first);
    builder.session("goal.created", {
      goal_id: GOAL,
      objective: "Keep execution and review state distinct",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    builder.session("plan.proposed", {
      content: first,
      origin: userOrigin,
      plan_sha256: firstIdentity.sha256,
    });
    builder.session("plan.approved", {
      goal_id: GOAL,
      goal_revision: 1,
      origin: userOrigin,
      plan_id: first.planId,
      plan_sha256: firstIdentity.sha256,
      revision: 1,
    });
    const replacement = planContent({
      items: [
        ...first.items,
        {
          acceptance: "The replacement remains pending user review.",
          id: "review-replacement",
          required: true,
          title: "Review the replacement revision",
        },
      ],
      revision: 2,
      title: "Phase 16 replacement",
    });
    const replacementIdentity = planIdentity(replacement);
    builder.session("plan.revised", {
      base_revision: 1,
      base_sha256: firstIdentity.sha256,
      content: replacement,
      origin: userOrigin,
      plan_sha256: replacementIdentity.sha256,
    });

    const report = new OutcomeReportBuilder().build(
      reconstructMultiRunSession(builder.decode()),
    );
    expect(report.plan).toMatchObject({
      execution: {
        id: first.planId,
        revision: 1,
        sha256: firstIdentity.sha256,
        totalItems: 1,
      },
      pendingDraft: {
        id: first.planId,
        revision: 2,
        sha256: replacementIdentity.sha256,
        totalItems: 2,
      },
    });
    expect(report.outcome).toBe("idle");
  });

  it("does not attribute the previous Goal run to a newly-created idle Goal", () => {
    const builder = new Phase16EventBuilder();
    builder.session("goal.created", {
      goal_id: GOAL,
      objective: "Old Goal",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    builder.run(
      "run.started",
      chatStartData({
        agent_mode: "plan",
        agent_mode_source: "explicit_cli",
        goal_change_ledger_sha256: null,
        goal_id: GOAL,
        goal_revision: 1,
        model_qualification_sha256: "e".repeat(64),
        plan_id: null,
        plan_revision: null,
        plan_sha256: null,
      }),
    );
    builder.run("backend.selected", backendSelectedData());
    builder.run("run.cancelled", { duration_ms: 1, reason: "user" });
    builder.session("goal.status.changed", {
      from: "active",
      goal_id: GOAL,
      origin: userOrigin,
      reason: "Move to a distinct task",
      revision: 1,
      to: "abandoned",
    });
    builder.session("goal.created", {
      goal_id: GOAL_2,
      objective: "New idle Goal",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });

    const report = new OutcomeReportBuilder().build(
      reconstructMultiRunSession(builder.decode()),
    );
    expect(report).toMatchObject({
      goal: { id: GOAL_2, status: "active" },
      outcome: "idle",
      run: null,
    });
  });

  it("does not attribute an untracked legacy run to a newly-tracked Goal", () => {
    const builder = new Phase16EventBuilder();
    builder.run("run.started", chatStartData());
    builder.run("backend.selected", backendSelectedData());
    builder.run("run.cancelled", {
      duration_ms: 1,
      output_chars: 0,
      reason: "user",
      steps: 1,
      tool_calls: 0,
    });
    builder.session("goal.created", {
      goal_id: GOAL,
      objective: "Track work after a legacy run",
      origin: userOrigin,
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });

    const report = new OutcomeReportBuilder().build(
      reconstructMultiRunSession(builder.decode()),
    );
    expect(report).toMatchObject({
      goal: { id: GOAL, status: "active" },
      outcome: "idle",
      run: null,
    });
  });
});
