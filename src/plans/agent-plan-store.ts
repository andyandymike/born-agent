import { randomUUID } from "node:crypto";

import { TaskStateProjectionError } from "../coordination/task-state-error.js";
import { TaskStateMachine } from "../coordination/task-state-machine.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { canonicalPlanIdentity } from "./plan-identity.js";
import {
  appliedPlanObservation,
  rejectedPlanObservation,
  type PlanToolObservation,
} from "./plan-tool-observation.js";
import type { PlanItemStatus } from "./plan-schema.js";
import type { UpdatePlanInput } from "./update-plan-input-schema.js";
import type { PlanMutationControl } from "./plan-mutation-control.js";

export type { PlanMutationControl } from "./plan-mutation-control.js";

export interface AgentPlanMutationContext {
  readonly activeGoal: {
    readonly goalId: string;
    readonly revision: number;
  };
  readonly agentMode: "plan" | "build";
  readonly callId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly step: number;
  readonly taskStateBeforeCall: TaskStateProjection;
  readonly writer: V2SessionWriter;
}

export interface AgentPlanMutationResult {
  readonly control: PlanMutationControl | null;
  readonly eventId: string | null;
  readonly mutationId: string;
  readonly observation: PlanToolObservation;
  readonly status: "applied" | "rejected";
}

export interface AgentPlanStore {
  applyAgentMutation(
    context: AgentPlanMutationContext,
    input: UpdatePlanInput,
  ): Promise<AgentPlanMutationResult>;
}

function rejected(
  context: AgentPlanMutationContext,
  input: UpdatePlanInput,
  code: string,
  message: string,
): AgentPlanMutationResult {
  return Object.freeze({
    control: null,
    eventId: null,
    mutationId: context.callId,
    observation: rejectedPlanObservation(input.operation, code, message),
    status: "rejected",
  });
}

function activeGoalMatches(
  state: TaskStateProjection,
  context: AgentPlanMutationContext,
): boolean {
  const active = state.goals.find(
    (goal) => goal.content.goalId === state.activeGoalId,
  );
  return (
    active?.status === "active" &&
    active.content.goalId === context.activeGoal.goalId &&
    active.content.revision === context.activeGoal.revision
  );
}

function exactPlan(
  ref: TaskStateProjection["pendingDraft"],
  input: {
    readonly planId: string;
    readonly revision: number;
    readonly sha256: string;
  },
): boolean {
  return (
    ref !== null &&
    ref.planId === input.planId &&
    ref.revision === input.revision &&
    ref.planSha256 === input.sha256
  );
}

function requestForContext(
  context: AgentPlanMutationContext,
): Extract<DecodedRunEvent, { type: "tool.call.requested" }> | undefined {
  return [...context.writer.events]
    .reverse()
    .find(
      (event): event is Extract<
        DecodedRunEvent,
        { type: "tool.call.requested" }
      > =>
        event.scope === "run" &&
        event.runId === context.runId &&
        event.type === "tool.call.requested" &&
        event.data.call_id === context.callId &&
        event.data.tool_name === "update_plan",
    );
}

function callClosed(context: AgentPlanMutationContext): boolean {
  return context.writer.events.some(
    (event) =>
      event.scope === "run" &&
      event.runId === context.runId &&
      (event.type === "tool.call.completed" ||
        event.type === "tool.call.recovered") &&
      event.data.call_id === context.callId &&
      event.data.tool_name === "update_plan",
  );
}

function mutationAlreadyUsed(context: AgentPlanMutationContext): boolean {
  return context.writer.events.some(
    (event) =>
      event.scope === "session" &&
      (event.type === "plan.proposed" ||
        event.type === "plan.revised" ||
        event.type === "plan.item.status_changed") &&
      event.data.origin.kind === "agent" &&
      event.data.origin.mutation_id === context.callId,
  );
}

function allowedTransition(from: PlanItemStatus, to: PlanItemStatus): boolean {
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

function projectionErrorCode(error: TaskStateProjectionError): string {
  switch (error.code) {
    case "evidence_reference_invalid":
      return "evidence_not_found";
    case "plan_required_item_skipped":
      return "required_item_cannot_skip";
    case "plan_decision_stale":
    case "plan_hash_mismatch":
    case "plan_revision_invalid":
      return "stale_plan_base";
    default:
      return "invalid_item_transition";
  }
}

function origin(context: AgentPlanMutationContext) {
  return {
    call_id: context.callId,
    kind: "agent" as const,
    mutation_id: context.callId,
    run_id: context.runId,
  };
}

export class DurableAgentPlanStore implements AgentPlanStore {
  constructor(private readonly randomUuid: () => string = randomUUID) {}

  async applyAgentMutation(
    context: AgentPlanMutationContext,
    input: UpdatePlanInput,
  ): Promise<AgentPlanMutationResult> {
    const request = requestForContext(context);
    if (
      request === undefined ||
      request.data.step !== context.step ||
      callClosed(context)
    ) {
      throw new Error(
        "update_plan mutation requires its earlier durable open tool request",
      );
    }
    if (mutationAlreadyUsed(context)) {
      throw new Error("update_plan mutation identity is already committed");
    }
    const state = TaskStateMachine.project(context.writer.events);
    if (!activeGoalMatches(state, context)) {
      return rejected(
        context,
        input,
        "no_active_goal",
        "No exact active Goal is bound to this run.",
      );
    }
    if (
      context.taskStateBeforeCall.activeGoalId !==
        context.activeGoal.goalId ||
      context.taskStateBeforeCall.lastSessionSeq > state.lastSessionSeq
    ) {
      return rejected(
        context,
        input,
        "no_active_goal",
        "The task state supplied to the call is not an authoritative prefix.",
      );
    }

    try {
      switch (input.operation) {
        case "propose":
          return await this.propose(context, state, input);
        case "revise":
          return await this.revise(context, state, input);
        case "set_item_status":
          return await this.setItemStatus(context, state, input);
      }
    } catch (error) {
      if (error instanceof TaskStateProjectionError) {
        return rejected(
          context,
          input,
          projectionErrorCode(error),
          error.message,
        );
      }
      throw error;
    }
  }

  private async propose(
    context: AgentPlanMutationContext,
    state: TaskStateProjection,
    input: Extract<UpdatePlanInput, { operation: "propose" }>,
  ): Promise<AgentPlanMutationResult> {
    if (
      context.agentMode !== "plan" ||
      state.pendingDraft !== null ||
      state.currentApprovedPlan !== null
    ) {
      return rejected(
        context,
        input,
        "plan_propose_not_allowed",
        "A new Plan may be proposed only in Plan mode with no current Plan.",
      );
    }
    const used = new Set(state.plans.map((plan) => plan.content.planId));
    let planId = "";
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.randomUuid();
      if (candidate !== context.sessionId && !used.has(candidate)) {
        planId = candidate;
        break;
      }
    }
    if (planId.length === 0) {
      throw new Error("could not allocate a unique Plan id");
    }
    const identity = canonicalPlanIdentity({
      goalId: context.activeGoal.goalId,
      goalRevision: context.activeGoal.revision,
      items: input.plan.items,
      planId,
      revision: 1,
      schemaVersion: 1,
      title: input.plan.title,
    });
    const event = await context.writer.appendTaskEvent("plan.proposed", {
      content: {
        ...identity.content,
        items: identity.content.items.map((item) => ({ ...item })),
      },
      origin: origin(context),
      plan_sha256: identity.sha256,
    });
    if (event.scope !== "session" || event.type !== "plan.proposed") {
      throw new Error("writer returned the wrong Plan event");
    }
    return Object.freeze({
      control: null,
      eventId: event.eventId,
      mutationId: context.callId,
      observation: appliedPlanObservation(input.operation, event),
      status: "applied",
    });
  }

  private async revise(
    context: AgentPlanMutationContext,
    state: TaskStateProjection,
    input: Extract<UpdatePlanInput, { operation: "revise" }>,
  ): Promise<AgentPlanMutationResult> {
    if (context.agentMode === "build" && state.pendingDraft !== null) {
      return rejected(
        context,
        input,
        "pending_draft_conflict",
        "Build mode cannot revise while a pending draft exists.",
      );
    }
    const base =
      context.agentMode === "plan"
        ? (state.pendingDraft ?? state.currentApprovedPlan)
        : state.currentApprovedPlan;
    if (base === null) {
      return rejected(
        context,
        input,
        "no_approved_plan",
        "No current Plan is available as a revision base.",
      );
    }
    if (
      !exactPlan(base, {
        planId: input.base_plan_id,
        revision: input.base_revision,
        sha256: input.base_sha256,
      })
    ) {
      return rejected(
        context,
        input,
        "stale_plan_base",
        "The Plan revision base is stale.",
      );
    }
    const revision =
      Math.max(
        ...state.plans
          .filter((plan) => plan.content.planId === base.planId)
          .map((plan) => plan.content.revision),
      ) + 1;
    const identity = canonicalPlanIdentity({
      goalId: context.activeGoal.goalId,
      goalRevision: context.activeGoal.revision,
      items: input.plan.items,
      planId: base.planId,
      revision,
      schemaVersion: 1,
      title: input.plan.title,
    });
    const event = await context.writer.appendTaskEvent("plan.revised", {
      base_revision: base.revision,
      base_sha256: base.planSha256,
      content: {
        ...identity.content,
        items: identity.content.items.map((item) => ({ ...item })),
      },
      origin: origin(context),
      plan_sha256: identity.sha256,
    });
    if (event.scope !== "session" || event.type !== "plan.revised") {
      throw new Error("writer returned the wrong Plan revision event");
    }
    const control: PlanMutationControl | null =
      context.agentMode === "build"
        ? Object.freeze({
            kind: "plan_revision_proposed",
            planId: identity.content.planId,
            reason: "plan_approval_required",
            revision: identity.content.revision,
            sha256: identity.sha256,
          })
        : null;
    return Object.freeze({
      control,
      eventId: event.eventId,
      mutationId: context.callId,
      observation: appliedPlanObservation(input.operation, event),
      status: "applied",
    });
  }

  private async setItemStatus(
    context: AgentPlanMutationContext,
    state: TaskStateProjection,
    input: Extract<UpdatePlanInput, { operation: "set_item_status" }>,
  ): Promise<AgentPlanMutationResult> {
    if (context.agentMode !== "build") {
      return rejected(
        context,
        input,
        "no_approved_plan",
        "Plan mode cannot mutate Todo progress.",
      );
    }
    const current = state.currentApprovedPlan;
    if (
      current === null ||
      !exactPlan(current, {
        planId: input.plan_id,
        revision: input.revision,
        sha256: input.plan_sha256,
      })
    ) {
      return rejected(
        context,
        input,
        "no_approved_plan",
        "Todo progress requires the exact current approved Plan.",
      );
    }
    const plan = state.plans.find(
      (candidate) =>
        candidate.content.planId === current.planId &&
        candidate.content.revision === current.revision,
    );
    const item = plan?.items.find(
      (candidate) => candidate.content.id === input.item_id,
    );
    if (
      plan === undefined ||
      item === undefined ||
      !allowedTransition(item.status, input.status)
    ) {
      return rejected(
        context,
        input,
        "invalid_item_transition",
        "The requested Todo transition is not allowed from its current status.",
      );
    }
    if (input.status === "skipped" && item.content.required) {
      return rejected(
        context,
        input,
        "required_item_cannot_skip",
        "A required Plan item cannot be skipped.",
      );
    }
    if (
      input.status === "in_progress" &&
      plan.items.some(
        (candidate) =>
          candidate.content.id !== item.content.id &&
          candidate.status === "in_progress",
      )
    ) {
      return rejected(
        context,
        input,
        "invalid_item_transition",
        "Only one Plan item may be in progress.",
      );
    }
    const event = await context.writer.appendTaskEvent(
      "plan.item.status_changed",
      {
        evidence_event_ids: [...input.evidence_event_ids],
        from: item.status,
        goal_id: current.goalId,
        goal_revision: current.goalRevision,
        item_id: input.item_id,
        note: input.note,
        origin: origin(context),
        plan_id: current.planId,
        plan_sha256: current.planSha256,
        revision: current.revision,
        to: input.status,
      },
    );
    if (
      event.scope !== "session" ||
      event.type !== "plan.item.status_changed"
    ) {
      throw new Error("writer returned the wrong Plan item event");
    }
    return Object.freeze({
      control: null,
      eventId: event.eventId,
      mutationId: context.callId,
      observation: appliedPlanObservation(input.operation, event),
      status: "applied",
    });
  }
}
