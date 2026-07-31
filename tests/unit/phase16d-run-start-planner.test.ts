import { describe, expect, it } from "vitest";

import { RunStartPlanner } from "../../src/coordination/run-start-planner.js";
import { TaskStateMachine } from "../../src/coordination/task-state-machine.js";
import {
  GOAL,
  Phase16EventBuilder,
  PLAN,
  planIdentity,
  userOrigin,
} from "./phase16a-test-fixtures.js";

const QUALIFICATION = "e".repeat(64);
const LEDGER = "f".repeat(64);

function state(options: { approve?: boolean; draft?: boolean } = {}) {
  const builder = new Phase16EventBuilder();
  builder.session("goal.created", {
    goal_id: GOAL,
    objective: "Implement the Phase 16 runtime",
    origin: userOrigin,
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  if (options.draft === true || options.approve === true) {
    const identity = planIdentity();
    builder.session("plan.proposed", {
      content: identity.content,
      origin: userOrigin,
      plan_sha256: identity.sha256,
    });
    if (options.approve === true) {
      builder.session("plan.approved", {
        goal_id: GOAL,
        goal_revision: 1,
        origin: userOrigin,
        plan_id: PLAN,
        plan_sha256: identity.sha256,
        revision: 1,
      });
    }
  }
  return TaskStateMachine.project(builder.decode());
}

describe("Phase 16D RunStartPlanner", () => {
  it("binds the exact active Goal and current approved Plan", () => {
    const taskState = state({ approve: true });
    const decision = new RunStartPlanner().plan({
      goalChangeLedgerSha256: LEDGER,
      mode: { mode: "build", source: "explicit_cli" },
      modelQualificationSha256: QUALIFICATION,
      taskState,
    });

    expect(decision).toEqual({
      binding: {
        agent_mode: "build",
        agent_mode_source: "explicit_cli",
        goal_change_ledger_sha256: LEDGER,
        goal_id: GOAL,
        goal_revision: 1,
        model_qualification_sha256: QUALIFICATION,
        plan_id: PLAN,
        plan_revision: 1,
        plan_sha256: taskState.currentApprovedPlan!.planSha256,
      },
      status: "ready",
    });
  });

  it("blocks Build when an unapproved draft is the only Plan", () => {
    expect(
      new RunStartPlanner().plan({
        goalChangeLedgerSha256: LEDGER,
        mode: { mode: "build", source: "explicit_cli" },
        modelQualificationSha256: QUALIFICATION,
        taskState: state({ draft: true }),
      }),
    ).toMatchObject({
      code: "plan_approval_required",
      exitCode: 2,
      status: "denied",
    });
  });

  it("allows Plan mode with a null change ledger and no approved Plan", () => {
    expect(
      new RunStartPlanner().plan({
        goalChangeLedgerSha256: null,
        mode: { mode: "plan", source: "explicit_cli" },
        modelQualificationSha256: QUALIFICATION,
        taskState: state(),
      }),
    ).toMatchObject({
      binding: {
        agent_mode: "plan",
        goal_change_ledger_sha256: null,
        plan_id: null,
      },
      status: "ready",
    });
  });
});
