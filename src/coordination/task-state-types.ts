import type {
  EventId,
  GoalId,
  GoalProjection,
  Revision,
} from "../goals/goal-schema.js";
import type {
  PlanItemContent,
  PlanItemId,
  PlanItemStatus,
  PlanRevisionContent,
  PlanRevisionStatus,
  Sha256,
} from "../plans/plan-schema.js";

export type TaskTrackingMode = "legacy_untracked" | "phase16";

export interface PlanRevisionRef {
  readonly goalId: GoalId;
  readonly goalRevision: Revision;
  readonly planId: string;
  readonly planSha256: Sha256;
  readonly revision: Revision;
}

export interface PlanItemTransitionProjection {
  readonly eventId: EventId;
  readonly evidenceEventIds: readonly EventId[];
  readonly from: PlanItemStatus;
  readonly note: string;
  readonly to: PlanItemStatus;
}

export interface PlanItemProjection {
  readonly carriedFromRevision: Revision | null;
  readonly content: PlanItemContent;
  readonly evidenceEventIds: readonly EventId[];
  readonly lastTransitionEventId: EventId | null;
  readonly note: string;
  readonly status: PlanItemStatus;
  readonly transitions: readonly PlanItemTransitionProjection[];
}

export interface PlanCompletionProjection {
  readonly completionEvaluatedEventId: EventId;
  readonly eventId: EventId;
  readonly finishTaskCallId: string;
}

export interface PlanStatusTransitionProjection {
  readonly eventId: EventId;
  readonly from: PlanRevisionStatus;
  readonly to: PlanRevisionStatus;
}

export interface PlanRevisionProjection {
  readonly completed: PlanCompletionProjection | null;
  readonly content: PlanRevisionContent;
  readonly createdEventId: EventId;
  readonly decisionEventId: EventId | null;
  readonly itemStatuses: Readonly<Record<PlanItemId, PlanItemStatus>>;
  readonly items: readonly PlanItemProjection[];
  readonly planSha256: Sha256;
  readonly status: PlanRevisionStatus;
  readonly statusTransitions: readonly PlanStatusTransitionProjection[];
}

export interface PlanBlockerProjection {
  readonly evidenceEventIds: readonly EventId[];
  readonly itemId: PlanItemId;
  readonly note: string;
  readonly plan: PlanRevisionRef;
}

export interface TaskStateProjection {
  readonly activeGoalId: GoalId | null;
  readonly blockers: readonly PlanBlockerProjection[];
  readonly currentApprovedPlan: PlanRevisionRef | null;
  readonly goals: readonly GoalProjection[];
  readonly lastSessionSeq: number;
  readonly pendingDraft: PlanRevisionRef | null;
  readonly plans: readonly PlanRevisionProjection[];
  readonly readyForCompletion: boolean;
  readonly trackingMode: TaskTrackingMode;
}
