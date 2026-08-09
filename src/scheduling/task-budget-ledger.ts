import type { TaskNodeSpecV1 } from "../task-graph/task-graph-schema.js";
import type { TaskBudgetCountersV1, TaskBudgetProjectionV1 } from "./task-execution-projector.js";

export function reservationForTaskNode(node: TaskNodeSpecV1): TaskBudgetCountersV1 {
  const readOnly = node.kind === "agent" && node.agent.mode === "plan";
  const verification = node.kind === "verification";
  return Object.freeze({
    artifactBytes: node.budget.maxArtifactBytes,
    attempts: 1,
    changedBytes: readOnly || verification ? 0 : node.budget.maxChangedBytes,
    changedFiles: readOnly || verification ? 0 : node.budget.maxChangedFiles,
    commandExecutions: readOnly ? 0 : verification ? 1 : node.budget.maxCommandExecutions,
    commandOutputBytes: readOnly ? 0 : node.budget.maxCommandOutputBytes,
    durationMs: node.budget.maxDurationMs,
    modelSteps: verification ? 0 : node.budget.maxModelSteps,
    reportedTokens: verification ? 0 : node.budget.maxReportedTokens,
  });
}

export function taskBudgetCanReserve(
  budget: TaskBudgetProjectionV1,
  reservation: TaskBudgetCountersV1,
): boolean {
  return (Object.keys(reservation) as (keyof TaskBudgetCountersV1)[]).every((counter) => {
    const remaining = budget.remaining[counter];
    const requested = reservation[counter];
    return remaining === null || (requested !== null && requested <= remaining);
  });
}

export function taskBudgetEventReservation(value: TaskBudgetCountersV1) {
  return {
    artifact_bytes: value.artifactBytes,
    attempts: value.attempts,
    changed_bytes: value.changedBytes,
    changed_files: value.changedFiles,
    command_executions: value.commandExecutions,
    command_output_bytes: value.commandOutputBytes,
    duration_ms: value.durationMs,
    model_steps: value.modelSteps,
    reported_tokens: value.reportedTokens,
  } as const;
}

export function taskBudgetTerminal(value: TaskBudgetCountersV1, completeness: "complete" | "none" | "partial") {
  return {
    ...taskBudgetEventReservation(value),
    usage_completeness: completeness,
  } as const;
}
