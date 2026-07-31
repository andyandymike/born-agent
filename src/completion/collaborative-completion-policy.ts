import { sha256Canonical } from "./canonical-json.js";
import type {
  CompletionDecision,
  CompletionPolicy,
  CompletionState,
  FinishTaskInput,
} from "./completion-types.js";
import type { GoalChangeLedgerProjection } from "../coordination/goal-change-ledger.js";
import { goalChangeAttributionScope } from "../coordination/goal-change-seed.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import type { Phase16RunBinding } from "../events/phase16-run-event-extension.js";

export interface CollaborativeCompletionPolicyOptions {
  readonly base: CompletionPolicy;
  readonly goalChanges: () => Promise<GoalChangeLedgerProjection>;
  readonly runBinding: Phase16RunBinding;
  readonly taskState: () => TaskStateProjection;
}

export class CollaborativeCompletionPolicy implements CompletionPolicy {
  constructor(private readonly options: CollaborativeCompletionPolicyOptions) {}

  async evaluate(
    candidate: FinishTaskInput,
    state: CompletionState,
  ): Promise<CompletionDecision> {
    const goalChanges = await this.options.goalChanges();
    const expectedScope = goalChangeAttributionScope(goalChanges);
    if (
      state.attributionScope === undefined ||
      sha256Canonical(state.attributionScope) !== sha256Canonical(expectedScope)
    ) {
      return { effect: "incomplete", reason: "change_journal_inconsistent" };
    }
    const base = await this.options.base.evaluate(candidate, state);
    if (base.effect !== "accept") return base;

    const task = this.options.taskState();
    const activeGoal = task.goals.find(
      (goal) => goal.content.goalId === task.activeGoalId,
    );
    if (
      activeGoal?.status !== "active" ||
      activeGoal.content.goalId !== this.options.runBinding.goal_id ||
      activeGoal.content.revision !== this.options.runBinding.goal_revision
    ) {
      return { effect: "incomplete", reason: "plan_incomplete" };
    }
    if (task.currentApprovedPlan === null) return base;
    const current = task.currentApprovedPlan;
    const exactPlan = task.plans.find(
      (plan) =>
        plan.content.goalId === current.goalId &&
        plan.content.goalRevision === current.goalRevision &&
        plan.content.planId === current.planId &&
        plan.content.revision === current.revision &&
        plan.planSha256 === current.planSha256,
    );
    if (
      this.options.runBinding.plan_id !== current.planId ||
      this.options.runBinding.plan_revision !== current.revision ||
      this.options.runBinding.plan_sha256 !== current.planSha256 ||
      exactPlan?.status !== "active" ||
      !task.readyForCompletion
    ) {
      return { effect: "incomplete", reason: "plan_incomplete" };
    }
    return base;
  }
}
