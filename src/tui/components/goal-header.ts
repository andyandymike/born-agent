import type { TaskStateProjection } from "../../coordination/task-state-types.js";

export function renderGoalHeader(
  task: TaskStateProjection,
  selectedMode: "build" | "plan",
): readonly string[] {
  const goal =
    task.goals.find(
      (candidate) => candidate.content.goalId === task.activeGoalId,
    ) ??
    task.goals.at(-1) ??
    null;
  const mode =
    selectedMode === "plan" ? "PLAN (read-only)" : "BUILD (coding)";
  if (goal === null) return [`MODE | ${mode}`, "GOAL | none"];
  return [
    `MODE | ${mode}`,
    `GOAL | ${goal.status} | ${goal.content.goalId} rev ${String(goal.content.revision)}`,
    `OBJECTIVE | ${goal.content.objective}`,
  ];
}
