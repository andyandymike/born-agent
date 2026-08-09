export type TaskGraphErrorCode =
  | "task_graph_agent_origin_invalid"
  | "task_graph_artifact_invalid"
  | "task_graph_binding_stale"
  | "task_graph_bounds_exceeded"
  | "task_graph_busy"
  | "task_graph_cycle"
  | "task_graph_decision_conflict"
  | "task_graph_invalid"
  | "task_graph_json_invalid"
  | "task_graph_not_approved"
  | "task_graph_not_found"
  | "task_graph_plan_item_unknown"
  | "task_graph_revision_conflict"
  | "task_graph_schema_invalid"
  | "task_graph_write_lineage_invalid"
  | "task_background_unavailable"
  | "task_budget_exhausted"
  | "task_effect_reconciliation_required"
  | "task_scheduler_busy"
  | "task_waiting_for_user"
  | "task_workspace_mode_unavailable";

const EXIT_CODES: Readonly<Record<TaskGraphErrorCode, 1 | 2 | 7 | 8>> = Object.freeze({
  task_graph_agent_origin_invalid: 1,
  task_graph_artifact_invalid: 1,
  task_graph_binding_stale: 8,
  task_graph_bounds_exceeded: 2,
  task_graph_busy: 8,
  task_graph_cycle: 2,
  task_graph_decision_conflict: 8,
  task_graph_invalid: 2,
  task_graph_json_invalid: 2,
  task_graph_not_approved: 8,
  task_graph_not_found: 8,
  task_graph_plan_item_unknown: 2,
  task_graph_revision_conflict: 8,
  task_graph_schema_invalid: 2,
  task_graph_write_lineage_invalid: 2,
  task_background_unavailable: 8,
  task_budget_exhausted: 7,
  task_effect_reconciliation_required: 8,
  task_scheduler_busy: 8,
  task_waiting_for_user: 8,
  task_workspace_mode_unavailable: 8,
});

export class TaskGraphError extends Error {
  override readonly name = "TaskGraphError";
  readonly exitCode: 1 | 2 | 7 | 8;

  constructor(
    readonly code: TaskGraphErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.exitCode = EXIT_CODES[code];
  }
}
