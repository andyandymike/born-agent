import type { GoalProjection } from "./goal-schema.js";
import {
  allocateTaskUuid,
  TaskControlPlaneError,
  taskUserOrigin,
  type TaskMutationContext,
  type TaskMutationWriterFactory,
  withTaskMutation,
} from "../coordination/task-control-plane.js";

function activeGoal(
  goals: readonly GoalProjection[],
  activeGoalId: string | null,
): GoalProjection | null {
  if (activeGoalId === null) return null;
  return goals.find((goal) => goal.content.goalId === activeGoalId) ?? null;
}

function selectedGoal(
  goals: readonly GoalProjection[],
  goalId: string,
): GoalProjection {
  const goal = goals.find((candidate) => candidate.content.goalId === goalId);
  if (goal === undefined) {
    throw new TaskControlPlaneError("goal_not_found", "Goal was not found");
  }
  return goal;
}

export class GoalManager {
  constructor(private readonly writerFactory?: TaskMutationWriterFactory) {}

  async createInitialGoal(input: {
    readonly context: TaskMutationContext;
    readonly objective: string;
  }): Promise<GoalProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        if (
          state.trackingMode !== "legacy_untracked" ||
          state.goals.length !== 0 ||
          state.activeGoalId !== null
        ) {
          throw new TaskControlPlaneError(
            "legacy_goal_required",
            "initial Goal creation requires a legacy untracked session",
          );
        }
        const goalId = allocateTaskUuid(input.context, new Set());
        const result = await append("goal.created", {
          goal_id: goalId,
          objective: input.objective,
          origin: taskUserOrigin(input.context),
          parent_goal_id: null,
          replaces_active_goal: null,
          revision: 1,
        });
        return selectedGoal(result.state.goals, goalId);
      },
      this.writerFactory,
    );
  }

  async reviseActiveGoal(input: {
    readonly baseRevision: number;
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly objective: string;
  }): Promise<GoalProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        const goal = activeGoal(state.goals, state.activeGoalId);
        if (goal === null || goal.content.goalId !== input.goalId) {
          throw new TaskControlPlaneError(
            "goal_stale",
            "Goal id does not match the active Goal",
          );
        }
        if (goal.status !== "active") {
          throw new TaskControlPlaneError(
            "goal_terminal",
            "terminal Goal cannot be revised",
          );
        }
        if (goal.content.revision !== input.baseRevision) {
          throw new TaskControlPlaneError(
            "goal_stale",
            "Goal base revision is stale",
          );
        }
        const revision = goal.content.revision + 1;
        const result = await append("goal.revised", {
          base_revision: goal.content.revision,
          goal_id: goal.content.goalId,
          objective: input.objective,
          origin: taskUserOrigin(input.context),
          revision,
        });
        return selectedGoal(result.state.goals, goal.content.goalId);
      },
      this.writerFactory,
    );
  }

  async abandonActiveGoal(input: {
    readonly context: TaskMutationContext;
    readonly goalId: string;
    readonly reason: string;
    readonly revision: number;
  }): Promise<GoalProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        const goal = activeGoal(state.goals, state.activeGoalId);
        if (
          goal === null ||
          goal.content.goalId !== input.goalId ||
          goal.content.revision !== input.revision
        ) {
          throw new TaskControlPlaneError(
            "goal_stale",
            "Goal abandonment binding is stale",
          );
        }
        const result = await append("goal.status.changed", {
          from: "active",
          goal_id: input.goalId,
          origin: taskUserOrigin(input.context),
          reason: input.reason,
          revision: input.revision,
          to: "abandoned",
        });
        return selectedGoal(result.state.goals, input.goalId);
      },
      this.writerFactory,
    );
  }

  async startNewGoal(input: {
    readonly context: TaskMutationContext;
    readonly objective: string;
    readonly parentGoalId: string | null;
    readonly replaceActive: null | {
      readonly confirmedAbandon: true;
      readonly goalId: string;
      readonly revision: number;
    };
  }): Promise<GoalProjection> {
    return withTaskMutation(
      input.context,
      async ({ append, state }) => {
        const active = activeGoal(state.goals, state.activeGoalId);
        if (active === null && input.replaceActive !== null) {
          throw new TaskControlPlaneError(
            "active_goal_conflict",
            "replacement binding was provided but there is no active Goal",
          );
        }
        if (active !== null) {
          if (
            input.replaceActive === null ||
            !input.replaceActive.confirmedAbandon ||
            input.replaceActive.goalId !== active.content.goalId ||
            input.replaceActive.revision !== active.content.revision
          ) {
            throw new TaskControlPlaneError(
              "active_goal_conflict",
              "new Goal requires an exact confirmed active-Goal replacement",
            );
          }
        }

        if (input.parentGoalId !== null) {
          const parent = state.goals.find(
            (goal) => goal.content.goalId === input.parentGoalId,
          );
          if (parent === undefined) {
            throw new TaskControlPlaneError(
              "parent_goal_invalid",
              "parent Goal must be an earlier Goal in this session",
            );
          }
          if (
            parent.status === "active" &&
            (active === null || parent.content.goalId !== active.content.goalId)
          ) {
            throw new TaskControlPlaneError(
              "parent_goal_invalid",
              "an active parent must be the exact Goal replaced by this mutation",
            );
          }
        }

        const used = new Set(state.goals.map((goal) => goal.content.goalId));
        const goalId = allocateTaskUuid(input.context, used);
        const result = await append("goal.created", {
          goal_id: goalId,
          objective: input.objective,
          origin: taskUserOrigin(input.context),
          parent_goal_id: input.parentGoalId,
          replaces_active_goal:
            active === null
              ? null
              : {
                  disposition: "abandoned",
                  goal_id: active.content.goalId,
                  revision: active.content.revision,
                },
          revision: 1,
        });
        return selectedGoal(result.state.goals, goalId);
      },
      this.writerFactory,
    );
  }
}
