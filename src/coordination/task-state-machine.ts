import {
  assertDecodedStoredEventInvariants,
  type DecodedRunEvent,
  type DecodedSessionEvent,
  type DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import type {
  AgentOrigin,
  Phase16TaskSessionEventType,
} from "./task-event-schema.js";
import type {
  EventId,
  GoalProjection,
  GoalRevisionContent,
  GoalStatus,
} from "../goals/goal-schema.js";
import { canonicalPlanIdentity } from "../plans/plan-identity.js";
import {
  classifyPlanItemEvidence,
  type EvidenceRunBinding,
} from "../plans/plan-item-evidence.js";
import type {
  PlanItemContent,
  PlanItemStatus,
  PlanRevisionContent,
  PlanRevisionStatus,
} from "../plans/plan-schema.js";
import { isNonblankCanonicalText } from "./task-text-schema.js";
import {
  TaskStateProjectionError,
  type TaskStateErrorCode,
} from "./task-state-error.js";
import type {
  PlanBlockerProjection,
  PlanCompletionProjection,
  PlanItemProjection,
  PlanItemTransitionProjection,
  PlanRevisionProjection,
  PlanRevisionRef,
  PlanStatusTransitionProjection,
  TaskStateProjection,
} from "./task-state-types.js";

const PHASE16_EVENT_TYPES = new Set<Phase16TaskSessionEventType>([
  "goal.created",
  "goal.revised",
  "goal.status.changed",
  "plan.approved",
  "plan.completed",
  "plan.item.status_changed",
  "plan.proposed",
  "plan.rejected",
  "plan.revised",
]);

interface MutableGoal {
  content: GoalRevisionContent;
  readonly createdEventId: EventId;
  lastStatusEventId: EventId | null;
  status: GoalStatus;
}

interface MutablePlanItem {
  carriedFromRevision: number | null;
  readonly content: PlanItemContent;
  evidenceEventIds: EventId[];
  lastTransitionEventId: EventId | null;
  note: string;
  status: PlanItemStatus;
  readonly transitions: PlanItemTransitionProjection[];
}

interface MutablePlan {
  completed: PlanCompletionProjection | null;
  readonly content: PlanRevisionContent;
  readonly createdEventId: EventId;
  decisionEventId: EventId | null;
  readonly items: MutablePlanItem[];
  readonly planSha256: string;
  status: PlanRevisionStatus;
  readonly statusTransitions: PlanStatusTransitionProjection[];
}

interface PlanChainBinding {
  readonly goalId: string;
  readonly goalRevision: number;
  latestRevision: number;
}

interface OpenUpdatePlanRequest {
  readonly event: Extract<
    DecodedRunEvent,
    { type: "resume.pending_call.adopted" | "tool.call.requested" }
  >;
  used: boolean;
}

function requestKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

function planKey(planId: string, revision: number): string {
  return `${planId}\u0000${revision}`;
}

function samePlanItemContent(
  left: PlanItemContent,
  right: PlanItemContent,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.acceptance === right.acceptance &&
    left.required === right.required
  );
}

function clonePlanItemContent(content: PlanItemContent): PlanItemContent {
  return {
    acceptance: content.acceptance,
    id: content.id,
    required: content.required,
    title: content.title,
  };
}

function clonePlanContent(content: PlanRevisionContent): PlanRevisionContent {
  return {
    goalId: content.goalId,
    goalRevision: content.goalRevision,
    items: content.items.map((item) => clonePlanItemContent(item)),
    planId: content.planId,
    revision: content.revision,
    schemaVersion: 1,
    title: content.title,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

class TaskProjector {
  private activeGoalId: string | null = null;
  private currentApprovedPlan: MutablePlan | null = null;
  private readonly eventsById = new Map<string, DecodedStoredEvent>();
  private readonly goals: MutableGoal[] = [];
  private readonly goalsById = new Map<string, MutableGoal>();
  private readonly openUpdatePlanRequests = new Map<
    string,
    OpenUpdatePlanRequest
  >();
  private readonly planBindings = new Map<string, PlanChainBinding>();
  private readonly plans: MutablePlan[] = [];
  private readonly plansByRef = new Map<string, MutablePlan>();
  private pendingDraft: MutablePlan | null = null;
  private readonly runBindings = new Map<string, EvidenceRunBinding>();
  private readonly terminalRuns = new Set<string>();
  private trackingMode: "legacy_untracked" | "phase16" = "legacy_untracked";
  private readonly usedMutationIds = new Set<string>();

  public project(events: readonly DecodedStoredEvent[]): TaskStateProjection {
    for (const event of events) {
      if (event.scope === "run") this.processRunEvent(event);
      else this.processSessionEvent(event);
      if (this.shouldIndexReferenceTarget(event)) {
        this.eventsById.set(event.eventId, event);
      }
    }
    return this.snapshot(events.at(-1)?.sessionSeq ?? 0);
  }

  private shouldIndexReferenceTarget(event: DecodedStoredEvent): boolean {
    switch (event.type) {
      case "artifact.stored":
      case "command.completed":
      case "completion.evaluated":
      case "mcp.tool.call.completed":
      case "mcp.tool.call.effect_unknown":
      case "patch.apply.completed":
      case "resume.pending_call.adopted":
      case "side_effect.reconciled":
      case "tool.call.completed":
      case "tool.call.recovered":
      case "tool.call.requested":
      case "verification.completed":
        return true;
      default:
        return false;
    }
  }

  private fail(
    event: DecodedStoredEvent,
    code: TaskStateErrorCode,
    message: string,
  ): never {
    throw new TaskStateProjectionError({
      code,
      eventId: event.eventId,
      eventType: event.type,
      message,
      sessionSeq: event.sessionSeq,
    });
  }

  private processRunEvent(event: DecodedRunEvent): void {
    if (event.type === "run.started") {
      this.bindFuturePhase16RunStart(event);
      return;
    }
    if (
      (event.type === "tool.call.requested" ||
        event.type === "resume.pending_call.adopted") &&
      event.data.tool_name === "update_plan"
    ) {
      const key = requestKey(event.runId, event.data.call_id);
      if (this.openUpdatePlanRequests.has(key)) {
        this.fail(event, "origin_invalid", "duplicate update_plan request identity");
      }
      this.openUpdatePlanRequests.set(key, { event, used: false });
      return;
    }
    if (
      (event.type === "tool.call.completed" ||
        event.type === "tool.call.recovered") &&
      event.data.tool_name === "update_plan"
    ) {
      this.openUpdatePlanRequests.delete(
        requestKey(event.runId, event.data.call_id),
      );
      return;
    }
    if (
      event.type === "run.budget_exceeded" ||
      event.type === "run.cancelled" ||
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.incomplete"
    ) {
      this.terminalRuns.add(event.runId);
    }
  }

  private bindFuturePhase16RunStart(event: DecodedRunEvent): void {
    if (event.type !== "run.started") return;
    const data = event.data as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    const record = data as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(record, "agent_mode")) return;
    if (
      typeof record.goal_id !== "string" ||
      !Number.isInteger(record.goal_revision) ||
      (record.agent_mode !== "plan" && record.agent_mode !== "build")
    ) {
      this.fail(event, "goal_binding_mismatch", "Phase 16 run binding is invalid");
    }
    const goal = this.goalsById.get(record.goal_id);
    if (
      goal === undefined ||
      goal.status !== "active" ||
      this.activeGoalId !== record.goal_id ||
      goal.content.revision !== record.goal_revision
    ) {
      this.fail(
        event,
        "goal_binding_mismatch",
        "run.started does not bind the exact active Goal revision",
      );
    }
    const current = this.currentApprovedPlan;
    if (current === null) {
      if (
        record.plan_id !== null ||
        record.plan_revision !== null ||
        record.plan_sha256 !== null
      ) {
        this.fail(
          event,
          "plan_binding_mismatch",
          "run.started binds a Plan when no approved Plan is current",
        );
      }
    } else if (
      record.plan_id !== current.content.planId ||
      record.plan_revision !== current.content.revision ||
      record.plan_sha256 !== current.planSha256
    ) {
      this.fail(
        event,
        "plan_binding_mismatch",
        "run.started does not bind the exact current approved Plan",
      );
    }
    this.bindRun(
      event,
      event.runId,
      record.goal_id,
      record.goal_revision as number,
      record.agent_mode === "build" ? "build" : "unknown",
    );
  }

  private processSessionEvent(event: DecodedSessionEvent): void {
    if (!PHASE16_EVENT_TYPES.has(event.type as Phase16TaskSessionEventType)) {
      return;
    }
    this.trackingMode = "phase16";

    switch (event.type) {
      case "goal.created":
        this.createGoal(event);
        return;
      case "goal.revised":
        this.reviseGoal(event);
        return;
      case "goal.status.changed":
        this.changeGoalStatus(event);
        return;
      case "plan.proposed":
        this.proposePlan(event);
        return;
      case "plan.revised":
        this.revisePlan(event);
        return;
      case "plan.approved":
        this.approvePlan(event);
        return;
      case "plan.rejected":
        this.rejectPlan(event);
        return;
      case "plan.item.status_changed":
        this.changePlanItemStatus(event);
        return;
      case "plan.completed":
        this.completePlan(event);
        return;
      default:
        return;
    }
  }

  private bindRun(
    event: DecodedStoredEvent,
    runId: string,
    goalId: string,
    goalRevision: number,
    mode: "build" | "unknown",
  ): void {
    const existing = this.runBindings.get(runId);
    if (existing === undefined) {
      this.runBindings.set(runId, { goalId, goalRevision, mode });
      return;
    }
    if (
      existing.goalId !== goalId ||
      existing.goalRevision !== goalRevision
    ) {
      this.fail(
        event,
        "goal_binding_mismatch",
        "one run cannot bind multiple Goal revisions",
      );
    }
    if (mode === "build" && existing.mode !== "build") {
      this.runBindings.set(runId, { goalId, goalRevision, mode: "build" });
    }
  }

  private assertAgentOrigin(
    event: DecodedSessionEvent,
    origin: AgentOrigin,
    goalId: string,
    goalRevision: number,
    mode: "build" | "unknown",
  ): void {
    const key = requestKey(origin.run_id, origin.call_id);
    const request = this.openUpdatePlanRequests.get(key);
    if (
      request === undefined ||
      request.used ||
      request.event.sessionId !== event.sessionId ||
      request.event.sessionSeq >= event.sessionSeq ||
      this.terminalRuns.has(origin.run_id)
    ) {
      this.fail(
        event,
        "origin_invalid",
        "agent mutation has no earlier open update_plan request",
      );
    }
    if (this.usedMutationIds.has(origin.mutation_id)) {
      this.fail(event, "origin_invalid", "agent mutation identity is not unique");
    }
    this.bindRun(event, origin.run_id, goalId, goalRevision, mode);
    request.used = true;
    this.usedMutationIds.add(origin.mutation_id);
  }

  private createGoal(
    event: Extract<DecodedSessionEvent, { type: "goal.created" }>,
  ): void {
    // PHASE16: Goal events decode only trusted user/host origin variants. Model
    // text never becomes Goal authority merely by resembling this payload.
    const data = event.data;
    if (this.goalsById.has(data.goal_id)) {
      this.fail(event, "goal_binding_mismatch", "Goal id already exists");
    }
    const parent =
      data.parent_goal_id === null
        ? undefined
        : this.goalsById.get(data.parent_goal_id);
    if (data.parent_goal_id !== null && parent === undefined) {
      this.fail(
        event,
        "goal_binding_mismatch",
        "parent Goal must be an earlier Goal in this session",
      );
    }

    const active =
      this.activeGoalId === null
        ? undefined
        : this.goalsById.get(this.activeGoalId);
    if (active === undefined) {
      if (data.replaces_active_goal !== null) {
        this.fail(
          event,
          "active_goal_conflict",
          "replacement requires an active Goal",
        );
      }
      if (parent?.status === "active") {
        this.fail(
          event,
          "active_goal_conflict",
          "an active parent requires an exact composite replacement",
        );
      }
    } else {
      const replacement = data.replaces_active_goal;
      if (
        replacement === null ||
        replacement.goal_id !== active.content.goalId ||
        replacement.revision !== active.content.revision
      ) {
        this.fail(
          event,
          "active_goal_conflict",
          "new Goal does not exact-match the active Goal replacement",
        );
      }
    }

    if (active !== undefined) {
      this.supersedeGoalPlans(
        active.content.goalId,
        active.content.revision,
        event.eventId,
      );
      active.status = "abandoned";
      active.lastStatusEventId = event.eventId;
    }

    const goal: MutableGoal = {
      content: {
        goalId: data.goal_id,
        objective: data.objective,
        parentGoalId: data.parent_goal_id,
        revision: 1,
      },
      createdEventId: event.eventId,
      lastStatusEventId: null,
      status: "active",
    };
    this.goals.push(goal);
    this.goalsById.set(data.goal_id, goal);
    this.activeGoalId = data.goal_id;
  }

  private reviseGoal(
    event: Extract<DecodedSessionEvent, { type: "goal.revised" }>,
  ): void {
    const goal = this.goalsById.get(event.data.goal_id);
    if (goal === undefined) {
      this.fail(event, "goal_binding_mismatch", "Goal revision is not active");
    }
    if (goal.status !== "active") {
      this.fail(event, "goal_terminal_mutation", "terminal Goal cannot be revised");
    }
    if (this.activeGoalId !== event.data.goal_id) {
      this.fail(event, "goal_binding_mismatch", "Goal revision is not active");
    }
    if (
      event.data.base_revision !== goal.content.revision ||
      event.data.revision !== goal.content.revision + 1
    ) {
      this.fail(
        event,
        "goal_revision_invalid",
        "Goal revision must exact-match current revision plus one",
      );
    }

    this.supersedeGoalPlans(
      goal.content.goalId,
      goal.content.revision,
      event.eventId,
    );
    goal.content = {
      goalId: goal.content.goalId,
      objective: event.data.objective,
      parentGoalId: goal.content.parentGoalId,
      revision: event.data.revision,
    };
  }

  private changeGoalStatus(
    event: Extract<DecodedSessionEvent, { type: "goal.status.changed" }>,
  ): void {
    const goal = this.goalsById.get(event.data.goal_id);
    if (goal === undefined) {
      this.fail(event, "goal_binding_mismatch", "Goal status target is not active");
    }
    if (goal.status !== "active") {
      this.fail(event, "goal_terminal_mutation", "terminal Goal cannot change status");
    }
    if (this.activeGoalId !== event.data.goal_id) {
      this.fail(event, "goal_binding_mismatch", "Goal status target is not active");
    }
    if (event.data.revision !== goal.content.revision) {
      this.fail(event, "goal_revision_invalid", "Goal status revision is stale");
    }

    if (event.data.to === "completed") {
      this.assertAcceptedCompletion(
        event,
        event.data.completion_evaluated_event_id,
        event.data.finish_task_call_id,
        goal.content.goalId,
        goal.content.revision,
      );
      if (this.currentApprovedPlan !== null) {
        const completion = this.currentApprovedPlan.completed;
        if (
          this.currentApprovedPlan.status !== "completed" ||
          completion === null ||
          completion.completionEvaluatedEventId !==
            event.data.completion_evaluated_event_id ||
          completion.finishTaskCallId !== event.data.finish_task_call_id
        ) {
          this.fail(
            event,
            "plan_completion_invalid",
            "Goal completion does not match completed current Plan",
          );
        }
      } else if (this.pendingDraft !== null) {
        this.fail(
          event,
          "plan_completion_invalid",
          "Goal with only a pending draft cannot complete",
        );
      }
    }

    this.supersedeGoalPlans(
      goal.content.goalId,
      goal.content.revision,
      event.eventId,
    );
    goal.status = event.data.to;
    goal.lastStatusEventId = event.eventId;
    this.activeGoalId = null;
  }

  private activeGoalForPlan(
    event: DecodedSessionEvent,
    content: PlanRevisionContent,
  ): MutableGoal {
    const goal = this.goalsById.get(content.goalId);
    if (
      goal === undefined ||
      goal.status !== "active" ||
      this.activeGoalId !== content.goalId ||
      goal.content.revision !== content.goalRevision
    ) {
      this.fail(
        event,
        "plan_binding_mismatch",
        "Plan must bind the exact current active Goal revision",
      );
    }
    return goal;
  }

  private assertPlanHash(
    event: DecodedSessionEvent,
    content: PlanRevisionContent,
    expected: string,
  ): void {
    const actual = canonicalPlanIdentity(content).sha256;
    if (actual !== expected) {
      this.fail(event, "plan_hash_mismatch", "Plan content hash does not match");
    }
  }

  private newPlan(
    event: DecodedSessionEvent,
    content: PlanRevisionContent,
    planSha256: string,
  ): MutablePlan {
    const immutableContent = clonePlanContent(content);
    const plan: MutablePlan = {
      completed: null,
      content: immutableContent,
      createdEventId: event.eventId,
      decisionEventId: null,
      items: immutableContent.items.map((item) => ({
        carriedFromRevision: null,
        content: item,
        evidenceEventIds: [],
        lastTransitionEventId: null,
        note: "",
        status: "pending",
        transitions: [],
      })),
      planSha256,
      status: "draft",
      statusTransitions: [],
    };
    this.plans.push(plan);
    this.plansByRef.set(
      planKey(immutableContent.planId, immutableContent.revision),
      plan,
    );
    return plan;
  }

  private proposePlan(
    event: Extract<DecodedSessionEvent, { type: "plan.proposed" }>,
  ): void {
    const content = event.data.content as PlanRevisionContent;
    this.activeGoalForPlan(event, content);
    this.assertPlanHash(event, content, event.data.plan_sha256);
    if (content.revision !== 1) {
      this.fail(event, "plan_revision_invalid", "proposed Plan must start at revision 1");
    }
    if (this.planBindings.has(content.planId)) {
      this.fail(event, "plan_binding_mismatch", "Plan id already has a revision chain");
    }
    if (this.pendingDraft !== null || this.currentApprovedPlan !== null) {
      this.fail(
        event,
        "plan_draft_conflict",
        "new Plan proposal requires no pending or current Plan",
      );
    }
    if (event.data.origin.kind === "agent") {
      this.assertAgentOrigin(
        event,
        event.data.origin,
        content.goalId,
        content.goalRevision,
        "unknown",
      );
    }
    this.planBindings.set(content.planId, {
      goalId: content.goalId,
      goalRevision: content.goalRevision,
      latestRevision: 1,
    });
    this.pendingDraft = this.newPlan(event, content, event.data.plan_sha256);
  }

  private revisePlan(
    event: Extract<DecodedSessionEvent, { type: "plan.revised" }>,
  ): void {
    const content = event.data.content as PlanRevisionContent;
    this.activeGoalForPlan(event, content);
    this.assertPlanHash(event, content, event.data.plan_sha256);
    const base = this.pendingDraft ?? this.currentApprovedPlan;
    if (base === null) {
      this.fail(event, "plan_draft_conflict", "Plan revision has no current base");
    }
    if (
      base.content.planId !== content.planId ||
      base.content.revision !== event.data.base_revision ||
      base.planSha256 !== event.data.base_sha256
    ) {
      this.fail(event, "plan_decision_stale", "Plan revision base is stale");
    }
    const binding = this.planBindings.get(content.planId);
    if (
      binding === undefined ||
      binding.goalId !== content.goalId ||
      binding.goalRevision !== content.goalRevision
    ) {
      this.fail(event, "plan_binding_mismatch", "Plan revision changed Goal binding");
    }
    if (content.revision !== binding.latestRevision + 1) {
      this.fail(event, "plan_revision_invalid", "Plan revision must increase by one");
    }
    if (event.data.origin.kind === "agent") {
      this.assertAgentOrigin(
        event,
        event.data.origin,
        content.goalId,
        content.goalRevision,
        "unknown",
      );
    }
    if (this.pendingDraft !== null) {
      this.transitionPlanStatus(this.pendingDraft, "superseded", event.eventId);
    }
    const revised = this.newPlan(event, content, event.data.plan_sha256);
    binding.latestRevision = content.revision;
    this.pendingDraft = revised;
  }

  private exactPendingDecision(
    event: Extract<
      DecodedSessionEvent,
      { type: "plan.approved" | "plan.rejected" }
    >,
  ): MutablePlan {
    // PHASE16: approval/rejection binds Goal revision + Plan revision + full
    // canonical hash so a stale UI action cannot authorize different content.
    const draft = this.pendingDraft;
    if (
      draft === null ||
      draft.status !== "draft" ||
      draft.content.goalId !== event.data.goal_id ||
      draft.content.goalRevision !== event.data.goal_revision ||
      draft.content.planId !== event.data.plan_id ||
      draft.content.revision !== event.data.revision ||
      draft.planSha256 !== event.data.plan_sha256
    ) {
      this.fail(event, "plan_decision_stale", "Plan decision does not match pending draft");
    }
    const goal = this.goalsById.get(event.data.goal_id);
    if (
      goal?.status !== "active" ||
      this.activeGoalId !== event.data.goal_id ||
      goal.content.revision !== event.data.goal_revision
    ) {
      this.fail(event, "plan_binding_mismatch", "Plan decision Goal binding is stale");
    }
    return draft;
  }

  private approvePlan(
    event: Extract<DecodedSessionEvent, { type: "plan.approved" }>,
  ): void {
    const draft = this.exactPendingDecision(event);
    const previous = this.currentApprovedPlan;
    if (previous !== null) {
      this.carryTerminalItems(previous, draft);
      if (previous.status === "active") {
        this.transitionPlanStatus(previous, "superseded", event.eventId);
      }
    }
    this.transitionPlanStatus(draft, "active", event.eventId);
    draft.decisionEventId = event.eventId;
    this.pendingDraft = null;
    this.currentApprovedPlan = draft;
  }

  private carryTerminalItems(previous: MutablePlan, next: MutablePlan): void {
    for (const item of next.items) {
      const prior = previous.items.find(
        (candidate) => samePlanItemContent(candidate.content, item.content),
      );
      if (
        prior === undefined ||
        (prior.status !== "completed" && prior.status !== "skipped")
      ) {
        continue;
      }
      item.status = prior.status;
      item.note = prior.note;
      item.evidenceEventIds = [...prior.evidenceEventIds];
      item.lastTransitionEventId = prior.lastTransitionEventId;
      item.carriedFromRevision = previous.content.revision;
    }
  }

  private rejectPlan(
    event: Extract<DecodedSessionEvent, { type: "plan.rejected" }>,
  ): void {
    const draft = this.exactPendingDecision(event);
    this.transitionPlanStatus(draft, "rejected", event.eventId);
    draft.decisionEventId = event.eventId;
    this.pendingDraft = null;
  }

  private exactCurrentPlan(
    event: Extract<
      DecodedSessionEvent,
      { type: "plan.completed" | "plan.item.status_changed" }
    >,
  ): MutablePlan {
    const current = this.currentApprovedPlan;
    if (
      current === null ||
      current.content.goalId !== event.data.goal_id ||
      current.content.goalRevision !== event.data.goal_revision ||
      current.content.planId !== event.data.plan_id ||
      current.content.revision !== event.data.revision ||
      current.planSha256 !== event.data.plan_sha256
    ) {
      this.fail(event, "plan_binding_mismatch", "event does not match current approved Plan");
    }
    return current;
  }

  private changePlanItemStatus(
    event: Extract<DecodedSessionEvent, { type: "plan.item.status_changed" }>,
  ): void {
    // PHASE16: durable status events are the only Todo facts. UI checkboxes and
    // model prose are projections, never a second progress store.
    const plan = this.exactCurrentPlan(event);
    if (plan.status !== "active") {
      this.fail(event, "plan_item_transition_invalid", "only active Plan accepts progress");
    }
    this.assertAgentOrigin(
      event,
      event.data.origin,
      event.data.goal_id,
      event.data.goal_revision,
      "build",
    );
    const item = plan.items.find(
      (candidate) => candidate.content.id === event.data.item_id,
    );
    if (item === undefined || item.status !== event.data.from) {
      this.fail(event, "plan_item_transition_invalid", "Plan item or from status is stale");
    }
    if (!this.isAllowedItemTransition(event.data.from, event.data.to)) {
      this.fail(event, "plan_item_transition_invalid", "Plan item transition is not allowed");
    }
    if (event.data.to === "skipped" && item.content.required) {
      this.fail(event, "plan_required_item_skipped", "required Plan item cannot be skipped");
    }
    if (
      event.data.to === "in_progress" &&
      plan.items.some(
        (candidate) => candidate !== item && candidate.status === "in_progress",
      )
    ) {
      this.fail(event, "plan_multiple_in_progress", "Plan already has an in-progress item");
    }

    const evidenceIds = event.data.evidence_event_ids;
    if (
      (event.data.to === "in_progress" || event.data.to === "skipped") &&
      evidenceIds.length !== 0
    ) {
      this.fail(
        event,
        "evidence_reference_invalid",
        "in-progress and skipped transitions cannot carry evidence",
      );
    }
    if (event.data.to === "completed" && evidenceIds.length === 0) {
      this.fail(
        event,
        "evidence_reference_invalid",
        "completed transition requires evidence",
      );
    }
    if (
      (event.data.to === "completed" ||
        event.data.to === "blocked" ||
        event.data.to === "skipped") &&
      !isNonblankCanonicalText(event.data.note)
    ) {
      this.fail(
        event,
        "plan_item_transition_invalid",
        "terminal or blocked transition requires a nonblank note",
      );
    }

    for (const evidenceId of evidenceIds) {
      const evidence = this.eventsById.get(evidenceId);
      if (
        evidence === undefined ||
        evidence.sessionId !== event.sessionId ||
        evidence.sessionSeq >= event.sessionSeq
      ) {
        this.fail(
          event,
          "evidence_reference_invalid",
          "evidence must be an earlier event in the same session",
        );
      }
      const classification = classifyPlanItemEvidence(evidence, {
        eventsById: this.eventsById,
        goalId: event.data.goal_id,
        goalRevision: event.data.goal_revision,
        runBindings: this.runBindings,
      });
      if (
        (event.data.to === "completed" &&
          !classification.eligibleForCompleted) ||
        (event.data.to === "blocked" && !classification.eligibleForBlocked)
      ) {
        this.fail(
          event,
          "evidence_reference_invalid",
          "evidence type, result, or Goal binding is not eligible",
        );
      }
    }

    const transition: PlanItemTransitionProjection = {
      eventId: event.eventId,
      evidenceEventIds: [...evidenceIds],
      from: event.data.from,
      note: event.data.note,
      to: event.data.to,
    };
    item.status = event.data.to;
    item.note = event.data.note;
    item.evidenceEventIds = [...evidenceIds];
    item.lastTransitionEventId = event.eventId;
    item.carriedFromRevision = null;
    item.transitions.push(transition);
  }

  private isAllowedItemTransition(
    from: PlanItemStatus,
    to: PlanItemStatus,
  ): boolean {
    switch (from) {
      case "pending":
        return to === "in_progress" || to === "blocked" || to === "skipped";
      case "in_progress":
        return to === "completed" || to === "blocked" || to === "skipped";
      case "blocked":
        return to === "in_progress" || to === "skipped";
      case "completed":
      case "skipped":
        return false;
    }
  }

  private completePlan(
    event: Extract<DecodedSessionEvent, { type: "plan.completed" }>,
  ): void {
    const plan = this.exactCurrentPlan(event);
    if (plan.status !== "active" || !this.planReady(plan)) {
      this.fail(event, "plan_completion_invalid", "Plan is not ready for completion");
    }
    this.assertAcceptedCompletion(
      event,
      event.data.completion_evaluated_event_id,
      event.data.finish_task_call_id,
      event.data.goal_id,
      event.data.goal_revision,
    );
    this.transitionPlanStatus(plan, "completed", event.eventId);
    plan.completed = {
      completionEvaluatedEventId: event.data.completion_evaluated_event_id,
      eventId: event.eventId,
      finishTaskCallId: event.data.finish_task_call_id,
    };
  }

  private assertAcceptedCompletion(
    event: DecodedSessionEvent,
    completionEventId: string,
    finishTaskCallId: string,
    goalId: string,
    goalRevision: number,
  ): void {
    const completion = this.eventsById.get(completionEventId);
    if (
      completion === undefined ||
      completion.scope !== "run" ||
      completion.type !== "completion.evaluated" ||
      completion.data.effect !== "accept" ||
      completion.data.call_id !== finishTaskCallId ||
      completion.sessionSeq >= event.sessionSeq
    ) {
      this.fail(
        event,
        "plan_completion_invalid",
        "completion does not match an earlier accepted finish_task evaluation",
      );
    }
    const binding = this.runBindings.get(completion.runId);
    if (
      binding !== undefined &&
      (binding.goalId !== goalId || binding.goalRevision !== goalRevision)
    ) {
      this.fail(
        event,
        "goal_binding_mismatch",
        "completion run is bound to a different Goal revision",
      );
    }
  }

  private planReady(plan: MutablePlan): boolean {
    return plan.items.every((item) =>
      item.content.required
        ? item.status === "completed"
        : item.status === "completed" || item.status === "skipped",
    );
  }

  private transitionPlanStatus(
    plan: MutablePlan,
    to: PlanRevisionStatus,
    eventId: string,
  ): void {
    const from = plan.status;
    plan.status = to;
    plan.statusTransitions.push({ eventId, from, to });
  }

  private supersedeGoalPlans(
    goalId: string,
    goalRevision: number,
    eventId: string,
  ): void {
    for (const plan of this.plans) {
      if (
        plan.content.goalId === goalId &&
        plan.content.goalRevision === goalRevision &&
        (plan.status === "draft" || plan.status === "active")
      ) {
        this.transitionPlanStatus(plan, "superseded", eventId);
      }
    }
    if (
      this.pendingDraft?.content.goalId === goalId &&
      this.pendingDraft.content.goalRevision === goalRevision
    ) {
      this.pendingDraft = null;
    }
    if (
      this.currentApprovedPlan?.content.goalId === goalId &&
      this.currentApprovedPlan.content.goalRevision === goalRevision
    ) {
      this.currentApprovedPlan = null;
    }
  }

  private planRef(plan: MutablePlan | null): PlanRevisionRef | null {
    if (plan === null) return null;
    return {
      goalId: plan.content.goalId,
      goalRevision: plan.content.goalRevision,
      planId: plan.content.planId,
      planSha256: plan.planSha256,
      revision: plan.content.revision,
    };
  }

  private planProjection(plan: MutablePlan): PlanRevisionProjection {
    const itemStatuses: Record<string, PlanItemStatus> = {};
    const items: PlanItemProjection[] = plan.items.map((item) => {
      itemStatuses[item.content.id] = item.status;
      return {
        carriedFromRevision: item.carriedFromRevision,
        content: clonePlanItemContent(item.content),
        evidenceEventIds: [...item.evidenceEventIds],
        lastTransitionEventId: item.lastTransitionEventId,
        note: item.note,
        status: item.status,
        transitions: item.transitions.map((transition) => ({
          eventId: transition.eventId,
          evidenceEventIds: [...transition.evidenceEventIds],
          from: transition.from,
          note: transition.note,
          to: transition.to,
        })),
      };
    });
    return {
      completed:
        plan.completed === null
          ? null
          : {
              completionEvaluatedEventId:
                plan.completed.completionEvaluatedEventId,
              eventId: plan.completed.eventId,
              finishTaskCallId: plan.completed.finishTaskCallId,
            },
      content: clonePlanContent(plan.content),
      createdEventId: plan.createdEventId,
      decisionEventId: plan.decisionEventId,
      itemStatuses,
      items,
      planSha256: plan.planSha256,
      status: plan.status,
      statusTransitions: plan.statusTransitions.map((transition) => ({
        eventId: transition.eventId,
        from: transition.from,
        to: transition.to,
      })),
    };
  }

  private goalProjection(goal: MutableGoal): GoalProjection {
    return {
      content: {
        goalId: goal.content.goalId,
        objective: goal.content.objective,
        parentGoalId: goal.content.parentGoalId,
        revision: goal.content.revision,
      },
      createdEventId: goal.createdEventId,
      lastStatusEventId: goal.lastStatusEventId,
      status: goal.status,
    };
  }

  private blockers(): PlanBlockerProjection[] {
    const current = this.currentApprovedPlan;
    if (current === null) return [];
    const ref = this.planRef(current);
    if (ref === null) return [];
    return current.items
      .filter((item) => item.status === "blocked")
      .map((item) => ({
        evidenceEventIds: [...item.evidenceEventIds],
        itemId: item.content.id,
        note: item.note,
        plan: { ...ref },
      }));
  }

  private snapshot(lastSessionSeq: number): TaskStateProjection {
    const current = this.currentApprovedPlan;
    const projection: TaskStateProjection = {
      activeGoalId: this.activeGoalId,
      blockers: this.blockers(),
      currentApprovedPlan: this.planRef(current),
      goals: this.goals.map((goal) => this.goalProjection(goal)),
      lastSessionSeq,
      pendingDraft: this.planRef(this.pendingDraft),
      plans: this.plans.map((plan) => this.planProjection(plan)),
      readyForCompletion:
        current !== null &&
        (current.status === "active" || current.status === "completed") &&
        this.planReady(current),
      trackingMode: this.trackingMode,
    };
    return deepFreeze(projection);
  }
}

export class TaskStateMachine {
  public static project(
    events: readonly DecodedStoredEvent[],
  ): TaskStateProjection {
    assertDecodedStoredEventInvariants(events);
    return new TaskProjector().project(events);
  }

  public project(events: readonly DecodedStoredEvent[]): TaskStateProjection {
    return TaskStateMachine.project(events);
  }
}
