import {
  allocateTaskUuid,
  TaskControlPlaneError,
  type TaskMutationContext,
  type TaskMutationWriterFactory,
  withTaskMutation,
} from "../coordination/task-control-plane.js";
import type {
  PlanRevisionProjection,
  PlanRevisionRef,
  TaskStateProjection,
} from "../coordination/task-state-types.js";
import { canonicalPlanIdentity } from "./plan-identity.js";
import {
  userEditablePlanSchema,
  type UserEditablePlan,
} from "./plan-file-loader.js";

export interface PlanBaseIdentity {
  readonly planId: string;
  readonly revision: number;
  readonly sha256: string;
}

export interface UserPlanStore {
  approveDraft(input: {
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<PlanRevisionProjection>;

  rejectDraft(input: {
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly reason: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<PlanRevisionProjection>;

  replaceDraft(input: {
    readonly base: PlanBaseIdentity | null;
    readonly context: TaskMutationContext;
    readonly editablePlan: UserEditablePlan;
    readonly goalId: string;
    readonly goalRevision: number;
  }): Promise<PlanRevisionProjection>;
}

function exactRef(
  ref: PlanRevisionRef | null,
  identity: PlanBaseIdentity,
): boolean {
  return (
    ref !== null &&
    ref.planId === identity.planId &&
    ref.revision === identity.revision &&
    ref.planSha256 === identity.sha256
  );
}

function assertActiveGoal(
  state: TaskStateProjection,
  goalId: string,
  goalRevision: number,
): void {
  const active = state.goals.find(
    (goal) => goal.content.goalId === state.activeGoalId,
  );
  if (
    active === undefined ||
    active.status !== "active" ||
    active.content.goalId !== goalId ||
    active.content.revision !== goalRevision
  ) {
    throw new TaskControlPlaneError(
      "goal_stale",
      "Plan Goal binding does not match the active Goal revision",
    );
  }
}

function findPlan(
  state: TaskStateProjection,
  planId: string,
  revision: number,
): PlanRevisionProjection {
  const plan = state.plans.find(
    (candidate) =>
      candidate.content.planId === planId &&
      candidate.content.revision === revision,
  );
  if (plan === undefined) {
    throw new TaskControlPlaneError("plan_not_found", "Plan was not found");
  }
  return plan;
}

function assertPendingDraft(
  state: TaskStateProjection,
  input: {
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
  },
): void {
  const draft = state.pendingDraft;
  if (
    draft === null ||
    draft.goalId !== input.goalId ||
    draft.goalRevision !== input.goalRevision ||
    draft.planId !== input.planId ||
    draft.revision !== input.revision ||
    draft.planSha256 !== input.sha256
  ) {
    throw new TaskControlPlaneError(
      "plan_stale",
      "Plan decision does not exact-match the pending draft",
    );
  }
}

export class PlanStore implements UserPlanStore {
  constructor(private readonly writerFactory?: TaskMutationWriterFactory) {}

  async replaceDraft(input: {
    readonly base: PlanBaseIdentity | null;
    readonly context: TaskMutationContext;
    readonly editablePlan: UserEditablePlan;
    readonly goalId: string;
    readonly goalRevision: number;
  }): Promise<PlanRevisionProjection> {
    const editable = userEditablePlanSchema.parse(input.editablePlan);
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        assertActiveGoal(state, input.goalId, input.goalRevision);

        let planId: string;
        let revision: number;
        let base: PlanRevisionRef | null;
        if (input.base === null) {
          if (
            state.pendingDraft !== null ||
            state.currentApprovedPlan !== null
          ) {
            throw new TaskControlPlaneError(
              "plan_draft_conflict",
              "a new Plan requires no pending or current approved Plan",
            );
          }
          const used = new Set(
            state.plans.map((plan) => plan.content.planId),
          );
          planId = allocateTaskUuid(input.context, used);
          revision = 1;
          base = null;
        } else {
          base = state.pendingDraft ?? state.currentApprovedPlan;
          if (!exactRef(base, input.base)) {
            throw new TaskControlPlaneError(
              "plan_stale",
              state.pendingDraft === null
                ? "Plan base does not match the current approved revision"
                : "Plan base must match the pending draft",
            );
          }
          if (
            base === null ||
            base.goalId !== input.goalId ||
            base.goalRevision !== input.goalRevision
          ) {
            throw new TaskControlPlaneError(
              "plan_stale",
              "Plan base belongs to a different Goal revision",
            );
          }
          planId = base.planId;
          revision =
            Math.max(
              ...state.plans
                .filter((plan) => plan.content.planId === planId)
                .map((plan) => plan.content.revision),
            ) + 1;
        }

        const identity = canonicalPlanIdentity({
          goalId: input.goalId,
          goalRevision: input.goalRevision,
          items: editable.items,
          planId,
          revision,
          schemaVersion: 1,
          title: editable.title,
        });
        const eventContent = {
          ...identity.content,
          items: identity.content.items.map((item) => ({ ...item })),
        };
        const result =
          base === null
            ? await append("plan.proposed", {
                content: eventContent,
                origin: {
                  input_surface: input.context.inputSurface,
                  kind: "user",
                },
                plan_sha256: identity.sha256,
              })
            : await append("plan.revised", {
                base_revision: base.revision,
                base_sha256: base.planSha256,
                content: eventContent,
                origin: {
                  input_surface: input.context.inputSurface,
                  kind: "user",
                },
                plan_sha256: identity.sha256,
              });
        return findPlan(result.state, planId, revision);
      },
      this.writerFactory,
    );
  }

  async approveDraft(input: {
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<PlanRevisionProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        assertActiveGoal(state, input.goalId, input.goalRevision);
        assertPendingDraft(state, input);
        const result = await append("plan.approved", {
          goal_id: input.goalId,
          goal_revision: input.goalRevision,
          origin: {
            input_surface: input.context.inputSurface,
            kind: "user",
          },
          plan_id: input.planId,
          plan_sha256: input.sha256,
          revision: input.revision,
        });
        return findPlan(result.state, input.planId, input.revision);
      },
      this.writerFactory,
    );
  }

  async rejectDraft(input: {
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly reason: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<PlanRevisionProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        assertActiveGoal(state, input.goalId, input.goalRevision);
        assertPendingDraft(state, input);
        const result = await append("plan.rejected", {
          goal_id: input.goalId,
          goal_revision: input.goalRevision,
          origin: {
            input_surface: input.context.inputSurface,
            kind: "user",
          },
          plan_id: input.planId,
          plan_sha256: input.sha256,
          reason: input.reason,
          revision: input.revision,
        });
        return findPlan(result.state, input.planId, input.revision);
      },
      this.writerFactory,
    );
  }
}
