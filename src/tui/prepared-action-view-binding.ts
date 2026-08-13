import type { TaskPreparedActionReviewV1 } from "../control-plane/adapters/task-cli-adapter.js";

export interface PreparedActionSessionViewBindingV1 {
  readonly sessionId: string | null;
  readonly sessionBusy: boolean;
  readonly sessionSeq: number;
}

/**
 * PHASE21: the TUI's projection check is an early stale-action guard, not the
 * domain authority. A first message legitimately targets the zero head of the
 * session that the Host just catalogued while the empty TUI still has no
 * session projection; the ApplicationService revalidates that exact head
 * again after the human decision and before commit.
 */
export function preparedActionMatchesSessionView(
  review: TaskPreparedActionReviewV1,
  view: PreparedActionSessionViewBindingV1,
): boolean {
  const target = review.target;
  if (
    target.kind !== "existing_resource" ||
    target.resourceScope.kind !== "session" ||
    target.expectedVersion.kind !== "session_ledger_head"
  ) return true;
  if (view.sessionBusy) return false;
  if (
    view.sessionId === target.resourceScope.sessionId &&
    view.sessionSeq === target.expectedVersion.head.sequence
  ) return true;
  return review.actionKind === "session.message.submit" &&
    target.expectedVersion.head.sequence === 0 &&
    view.sessionId === null &&
    view.sessionSeq === 0;
}
