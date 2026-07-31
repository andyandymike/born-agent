export type TaskStateErrorCode =
  | "active_goal_conflict"
  | "goal_binding_mismatch"
  | "goal_revision_invalid"
  | "goal_terminal_mutation"
  | "plan_binding_mismatch"
  | "plan_hash_mismatch"
  | "plan_revision_invalid"
  | "plan_draft_conflict"
  | "plan_decision_stale"
  | "plan_item_transition_invalid"
  | "plan_multiple_in_progress"
  | "plan_required_item_skipped"
  | "plan_completion_invalid"
  | "evidence_reference_invalid"
  | "origin_invalid";

const MAX_ERROR_MESSAGE_SCALARS = 500;

function boundedMessage(message: string): string {
  return Array.from(message).slice(0, MAX_ERROR_MESSAGE_SCALARS).join("");
}

export class TaskStateProjectionError extends Error {
  public readonly code: TaskStateErrorCode;
  public readonly eventId: string;
  public readonly eventType: string;
  public readonly sessionSeq: number;

  public constructor(input: {
    readonly code: TaskStateErrorCode;
    readonly eventId: string;
    readonly eventType: string;
    readonly message: string;
    readonly sessionSeq: number;
  }) {
    super(boundedMessage(input.message));
    this.name = "TaskStateProjectionError";
    this.code = input.code;
    this.eventId = input.eventId;
    this.eventType = input.eventType;
    this.sessionSeq = input.sessionSeq;
  }
}
