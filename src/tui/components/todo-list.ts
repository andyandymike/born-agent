import type {
  PlanRevisionProjection,
  TaskStateProjection,
} from "../../coordination/task-state-types.js";

function executionPlan(task: TaskStateProjection): PlanRevisionProjection | null {
  const ref = task.currentApprovedPlan;
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

export function renderTodoList(task: TaskStateProjection): readonly string[] {
  const plan = executionPlan(task);
  if (plan === null) return ["TODO | none"];
  const completed = plan.items.filter(
    (item) => item.status === "completed" || item.status === "skipped",
  ).length;
  return [
    `TODO | ${String(completed)}/${String(plan.items.length)} terminal`,
    ...plan.items.map(
      (item) =>
        `- [${item.status}] ${item.content.id} ${item.content.title}${item.note.length === 0 ? "" : ` — ${item.note}`}`,
    ),
  ];
}
