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
import type { DelegationProjectionV1 } from "../delegation/delegation-projector.js";

export interface CollaborativeCompletionPolicyOptions {
  readonly base: CompletionPolicy;
  readonly delegations?: () => DelegationProjectionV1;
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
    const delegations = this.options.delegations?.();
    if (delegations !== undefined) {
      const required = delegations.revisions.filter((revision) =>
        revision.status !== "superseded" &&
        revision.status !== "rejected" &&
        revision.binding.goalId === this.options.runBinding.goal_id &&
        revision.binding.goalRevision === this.options.runBinding.goal_revision &&
        revision.binding.planId === this.options.runBinding.plan_id &&
        revision.binding.planRevision === this.options.runBinding.plan_revision &&
        revision.binding.planSha256 === this.options.runBinding.plan_sha256 &&
        (revision.envelope !== null || revision.attempts.length > 0 || [
          "queued",
          "active",
          "waiting_approval",
          "cancelling",
          "reconciling",
          "receipt_ready",
          "accepted",
          "failed",
          "blocked",
          "cancelled",
          "stale",
        ].includes(revision.status)));
      const unresolved = required.some((revision) =>
        revision.status !== "accepted" ||
        revision.receipt?.status !== "succeeded" ||
        revision.receipt.acceptedEventId === null ||
        revision.receipt.claimStatuses.some((claim) => claim.status !== "verified"));
      const heldBudget = Object.values(delegations.budget.held).some((value) =>
        typeof value === "number" && value > 0);
      if (unresolved || heldBudget || delegations.activeActorSlots.length > 0) {
        return { effect: "incomplete", reason: "plan_incomplete" };
      }
    }
    return base;
  }
}
