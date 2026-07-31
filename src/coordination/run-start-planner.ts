import type { ResolvedAgentMode } from "../agent/agent-mode.js";
import type { Phase16RunBinding } from "../events/phase16-run-event-extension.js";
import { phase16RunBindingSchema } from "../events/phase16-run-event-extension.js";
import type {
  PlanRevisionRef,
  TaskStateProjection,
} from "./task-state-types.js";

export type RunStartDenialCode =
  | "active_goal_required"
  | "active_goal_invalid"
  | "goal_change_ledger_required"
  | "phase16_tracking_required"
  | "plan_approval_required"
  | "stale_approved_plan_confirmation";

export type RunStartDecision =
  | {
      readonly binding: Phase16RunBinding;
      readonly status: "ready";
    }
  | {
      readonly code: RunStartDenialCode;
      readonly exitCode: 2;
      readonly message: string;
      readonly status: "denied";
    };

export interface RunStartPlannerInput {
  readonly continueApprovedPlan?: PlanRevisionRef;
  readonly goalChangeLedgerSha256: string | null;
  readonly mode: ResolvedAgentMode;
  readonly modelQualificationSha256: string;
  readonly taskState: TaskStateProjection;
}

function denied(
  code: RunStartDenialCode,
  message: string,
): RunStartDecision {
  return Object.freeze({ code, exitCode: 2, message, status: "denied" });
}

function samePlan(
  left: PlanRevisionRef,
  right: PlanRevisionRef,
): boolean {
  return (
    left.goalId === right.goalId &&
    left.goalRevision === right.goalRevision &&
    left.planId === right.planId &&
    left.revision === right.revision &&
    left.planSha256 === right.planSha256
  );
}

export class RunStartPlanner {
  plan(input: RunStartPlannerInput): RunStartDecision {
    const { taskState } = input;
    if (taskState.trackingMode !== "phase16") {
      return denied(
        "phase16_tracking_required",
        "a Phase 16 run requires durable Goal tracking",
      );
    }
    if (taskState.activeGoalId === null) {
      return denied(
        "active_goal_required",
        "a Phase 16 run requires one active Goal",
      );
    }
    const activeGoal = taskState.goals.find(
      (goal) => goal.content.goalId === taskState.activeGoalId,
    );
    if (activeGoal?.status !== "active") {
      return denied(
        "active_goal_invalid",
        "the active Goal identity is missing or terminal",
      );
    }

    const current = taskState.currentApprovedPlan;
    const pending = taskState.pendingDraft;
    if (input.mode.mode === "build") {
      if (input.goalChangeLedgerSha256 === null) {
        return denied(
          "goal_change_ledger_required",
          "Build mode requires an exact Goal-change ledger hash",
        );
      }
      if (pending !== null && current === null) {
        return denied(
          "plan_approval_required",
          "the pending Plan must be approved or rejected before Build can start",
        );
      }
      if (pending !== null && current !== null) {
        if (
          input.continueApprovedPlan === undefined ||
          !samePlan(current, input.continueApprovedPlan)
        ) {
          return denied(
            "stale_approved_plan_confirmation",
            "continuing the current approved Plan while a draft is pending requires its exact identity",
          );
        }
      }
    }

    const plan = current;
    const binding = phase16RunBindingSchema.parse({
      agent_mode: input.mode.mode,
      agent_mode_source: input.mode.source,
      goal_change_ledger_sha256:
        input.mode.mode === "plan" ? null : input.goalChangeLedgerSha256,
      goal_id: activeGoal.content.goalId,
      goal_revision: activeGoal.content.revision,
      model_qualification_sha256: input.modelQualificationSha256,
      plan_id: plan?.planId ?? null,
      plan_revision: plan?.revision ?? null,
      plan_sha256: plan?.planSha256 ?? null,
    });
    return Object.freeze({ binding: Object.freeze(binding), status: "ready" });
  }
}
