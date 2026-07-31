import type { AgentMode } from "../agent/agent-mode.js";
import type { PlanRevisionProjection, TaskStateProjection } from "./task-state-types.js";

const MAX_CHANGED_PATH_BYTES = 8 * 1024;

export interface TaskContextGoalChanges {
  readonly changedPathCount: number;
  readonly changedPaths: readonly string[];
  readonly ledgerSha256: string;
  readonly pathsTruncated: boolean;
}

export interface TaskContextProjection {
  readonly agentMode: AgentMode;
  readonly currentPlan: null | {
    readonly items: readonly {
      readonly acceptance: string;
      readonly blocker: string | null;
      readonly id: string;
      readonly required: boolean;
      readonly status: string;
      readonly title: string;
    }[];
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
    readonly title: string;
  };
  readonly goal: {
    readonly id: string;
    readonly objective: string;
    readonly revision: number;
  };
  readonly goalChanges: TaskContextGoalChanges | null;
  readonly pendingDraft: null | {
    readonly revision: number;
    readonly sha256: string;
  };
}

function exactPlan(
  state: TaskStateProjection,
  ref: TaskStateProjection["currentApprovedPlan"],
): PlanRevisionProjection | null {
  if (ref === null) return null;
  return (
    state.plans.find(
      (plan) =>
        plan.content.goalId === ref.goalId &&
        plan.content.goalRevision === ref.goalRevision &&
        plan.content.planId === ref.planId &&
        plan.content.revision === ref.revision &&
        plan.planSha256 === ref.planSha256,
    ) ?? null
  );
}

function boundedChangedPaths(paths: readonly string[]): {
  readonly paths: readonly string[];
  readonly truncated: boolean;
} {
  const sorted = [...new Set(paths)].sort();
  const selected: string[] = [];
  let bytes = 2;
  for (const path of sorted) {
    const nextBytes = Buffer.byteLength(JSON.stringify(path), "utf8") +
      (selected.length === 0 ? 0 : 1);
    if (bytes + nextBytes > MAX_CHANGED_PATH_BYTES) {
      return { paths: Object.freeze(selected), truncated: true };
    }
    selected.push(path);
    bytes += nextBytes;
  }
  return { paths: Object.freeze(selected), truncated: false };
}

export function projectTaskContext(input: {
  readonly agentMode: AgentMode;
  readonly goalChanges?: {
    readonly changedPaths: readonly string[];
    readonly ledgerSha256: string;
  };
  readonly taskState: TaskStateProjection;
}): TaskContextProjection {
  const activeGoal = input.taskState.goals.find(
    (goal) => goal.content.goalId === input.taskState.activeGoalId,
  );
  if (activeGoal?.status !== "active") {
    throw new Error("task context requires one exact active Goal");
  }
  const plan = exactPlan(input.taskState, input.taskState.currentApprovedPlan);
  if (input.taskState.currentApprovedPlan !== null && plan === null) {
    throw new Error("current approved Plan projection is missing");
  }
  const blockers = new Map(
    input.taskState.blockers.map((blocker) => [blocker.itemId, blocker.note]),
  );
  const bounded = input.goalChanges === undefined
    ? undefined
    : boundedChangedPaths(input.goalChanges.changedPaths);
  return Object.freeze({
    agentMode: input.agentMode,
    currentPlan:
      plan === null
        ? null
        : Object.freeze({
            items: Object.freeze(
              plan.items.map((item) =>
                Object.freeze({
                  acceptance: item.content.acceptance,
                  blocker: blockers.get(item.content.id) ?? null,
                  id: item.content.id,
                  required: item.content.required,
                  status: item.status,
                  title: item.content.title,
                }),
              ),
            ),
            planId: plan.content.planId,
            revision: plan.content.revision,
            sha256: plan.planSha256,
            title: plan.content.title,
          }),
    goal: Object.freeze({
      id: activeGoal.content.goalId,
      objective: activeGoal.content.objective,
      revision: activeGoal.content.revision,
    }),
    goalChanges:
      input.goalChanges === undefined || bounded === undefined
        ? null
        : Object.freeze({
            changedPathCount: new Set(input.goalChanges.changedPaths).size,
            changedPaths: bounded.paths,
            ledgerSha256: input.goalChanges.ledgerSha256,
            pathsTruncated: bounded.truncated,
          }),
    pendingDraft:
      input.taskState.pendingDraft === null
        ? null
        : Object.freeze({
            revision: input.taskState.pendingDraft.revision,
            sha256: input.taskState.pendingDraft.planSha256,
          }),
  });
}

export function taskContextSourceEventIds(
  state: TaskStateProjection,
): readonly string[] {
  const ids = new Set<string>();
  const activeGoal = state.goals.find(
    (goal) => goal.content.goalId === state.activeGoalId,
  );
  if (activeGoal !== undefined) {
    ids.add(activeGoal.createdEventId);
    if (activeGoal.lastStatusEventId !== null) ids.add(activeGoal.lastStatusEventId);
  }
  const refs = [state.currentApprovedPlan, state.pendingDraft].filter(
    (ref): ref is NonNullable<typeof ref> => ref !== null,
  );
  for (const ref of refs) {
    const plan = exactPlan(state, ref);
    if (plan === null) continue;
    ids.add(plan.createdEventId);
    if (plan.decisionEventId !== null) ids.add(plan.decisionEventId);
    for (const transition of plan.statusTransitions) ids.add(transition.eventId);
    for (const item of plan.items) {
      if (item.lastTransitionEventId !== null) ids.add(item.lastTransitionEventId);
      for (const transition of item.transitions) ids.add(transition.eventId);
    }
  }
  return Object.freeze([...ids].sort((left, right) => left.localeCompare(right)));
}
