import type {
  PlanRevisionProjection,
  PlanRevisionRef,
  TaskStateProjection,
} from "../../coordination/task-state-types.js";

function exactPlan(
  task: TaskStateProjection,
  ref: PlanRevisionRef | null,
): PlanRevisionProjection | null {
  if (ref === null) return null;
  return (
    task.plans.find(
      (plan) =>
        plan.content.planId === ref.planId &&
        plan.content.revision === ref.revision &&
        plan.planSha256 === ref.planSha256,
    ) ?? null
  );
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function renderPlanPanel(task: TaskStateProjection): readonly string[] {
  const execution = exactPlan(task, task.currentApprovedPlan);
  const pending = exactPlan(task, task.pendingDraft);
  if (execution === null && pending === null) return ["PLAN | none"];
  return [
    ...(execution === null
      ? []
      : [
          `PLAN EXECUTING | ${execution.content.title} | rev ${String(execution.content.revision)} | ${shortHash(execution.planSha256)}`,
        ]),
    ...(pending === null
      ? []
      : [
          `PLAN AWAITING REVIEW | ${pending.content.title} | rev ${String(pending.content.revision)} | ${shortHash(pending.planSha256)}`,
        ]),
  ];
}
