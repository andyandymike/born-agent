import { z } from "zod";

import { GoalManager } from "../../goals/goal-manager.js";
import { goalIdSchema, goalObjectiveSchema, revisionSchema, type GoalProjection } from "../../goals/goal-schema.js";
import { userEditablePlanSchema } from "../../plans/plan-file-loader.js";
import { PlanStore, type PlanBaseIdentity } from "../../plans/plan-store.js";
import { planIdSchema, sha256Schema } from "../../plans/plan-schema.js";
import type { PlanRevisionProjection } from "../../coordination/task-state-types.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import type { ReconstructedMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { createStrictCodec } from "../application-protocol.js";
import type { ApplicationActionDefinitionV1 } from "../application-action-registry.js";
import {
  executeSessionDomainAction,
  reconcileSessionDomainAction,
  resolveExistingSessionActionTarget,
  type SessionDomainActionDependenciesV1,
} from "./session-domain-action-support.js";
import {
  goalProjectionResultCodec,
  planProjectionResultCodec,
} from "./action-result-codecs.js";

const goalProposePayloadSchema = z.discriminatedUnion("operation", [
  z.object({ objective: goalObjectiveSchema, operation: z.literal("create_initial") }).strict(),
  z.object({
    baseRevision: revisionSchema,
    goalId: goalIdSchema,
    objective: goalObjectiveSchema,
    operation: z.literal("revise"),
  }).strict(),
  z.object({
    objective: goalObjectiveSchema,
    operation: z.literal("start_new"),
    parentGoalId: goalIdSchema.nullable(),
    replaceActive: z.object({
      confirmedAbandon: z.literal(true),
      goalId: goalIdSchema,
      revision: revisionSchema,
    }).strict().nullable(),
  }).strict(),
]);

const goalDecidePayloadSchema = z.object({
  decision: z.literal("abandon"),
  goalId: goalIdSchema,
  reason: z.string().min(1).max(4_096),
  revision: revisionSchema,
}).strict();

const planBaseSchema = z.object({
  planId: planIdSchema,
  revision: revisionSchema,
  sha256: sha256Schema,
}).strict();

const planProposePayloadSchema = z.object({
  base: planBaseSchema.nullable(),
  editablePlan: userEditablePlanSchema,
  goalId: goalIdSchema,
  goalRevision: revisionSchema,
}).strict();

const planDecidePayloadSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    goalId: goalIdSchema,
    goalRevision: revisionSchema,
    planId: planIdSchema,
    revision: revisionSchema,
    sha256: sha256Schema,
  }).strict(),
  z.object({
    decision: z.literal("reject"),
    goalId: goalIdSchema,
    goalRevision: revisionSchema,
    planId: planIdSchema,
    reason: z.string().min(1).max(4_096),
    revision: revisionSchema,
    sha256: sha256Schema,
  }).strict(),
]);

function sessionContract() {
  return Object.freeze({
    acceptedExpectedVersionKinds: Object.freeze(["session_ledger_head"] as const),
    resourceKinds: Object.freeze(["session"] as const),
    targetKind: "existing_resource" as const,
  });
}

function recoverGoal(session: ReconstructedMultiRunSession, events: readonly DecodedStoredEvent[]): GoalProjection {
  const data = events.at(-1)?.data as Readonly<{ goal_id?: unknown }> | undefined;
  const goalId = typeof data?.goal_id === "string" ? data.goal_id : null;
  const goal = goalId === null ? undefined : session.taskState.goals.find((candidate) => candidate.content.goalId === goalId);
  if (goal === undefined) throw new Error("application Goal fact did not reconstruct");
  return goal;
}

function recoverPlan(session: ReconstructedMultiRunSession, events: readonly DecodedStoredEvent[]): PlanRevisionProjection {
  const data = events.at(-1)?.data as Readonly<{
    content?: Readonly<{ planId?: unknown; revision?: unknown }>;
    plan_id?: unknown;
    revision?: unknown;
  }> | undefined;
  const planId = typeof data?.plan_id === "string"
    ? data.plan_id
    : typeof data?.content?.planId === "string" ? data.content.planId : null;
  const revision = typeof data?.revision === "number"
    ? data.revision
    : typeof data?.content?.revision === "number" ? data.content.revision : null;
  const plan = planId === null || revision === null
    ? undefined
    : session.taskState.plans.find((candidate) => candidate.content.planId === planId && candidate.content.revision === revision);
  if (plan === undefined) throw new Error("application Plan fact did not reconstruct");
  return plan;
}

export function createTaskActionDefinitions(
  dependencies: SessionDomainActionDependenciesV1,
): readonly ApplicationActionDefinitionV1[] {
  const goalPropose: ApplicationActionDefinitionV1<z.infer<typeof goalProposePayloadSchema>, GoalProjection> = {
    actionKind: "goal.propose",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: payload.operation === "revise" ? "Revise the exact active Goal." : "Create a new durable Goal.",
      warnings: Object.freeze(["Changing Goal authority invalidates Plan authority for the prior Goal revision."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => {
        const manager = new GoalManager(writerFactory);
        if (payload.operation === "create_initial") {
          return manager.createInitialGoal({ context: mutationContext, objective: payload.objective });
        }
        if (payload.operation === "revise") {
          return manager.reviseActiveGoal({
            baseRevision: payload.baseRevision,
            context: mutationContext,
            goalId: payload.goalId,
            objective: payload.objective,
          });
        }
        return manager.startNewGoal({
          context: mutationContext,
          objective: payload.objective,
          parentGoalId: payload.parentGoalId,
          replaceActive: payload.replaceActive,
        });
      },
      expectedEventTypes: ["goal.created", "goal.revised", "goal.status.changed"],
      prepared,
      recover: recoverGoal,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["goal.created", "goal.revised", "goal.status.changed"],
      prepared,
      recover: recoverGoal,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 48 * 1024, schema: goalProposePayloadSchema, schemaId: "phase21a.goal.propose.payload.v1" }),
    resultCodec: goalProjectionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const goalDecide: ApplicationActionDefinitionV1<z.infer<typeof goalDecidePayloadSchema>, GoalProjection> = {
    actionKind: "goal.decide",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Abandon Goal ${payload.goalId} revision ${String(payload.revision)}.`,
      warnings: Object.freeze(["This changes durable Goal authority; workspace bytes are not rolled back."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: ({ mutationContext, writerFactory }) => new GoalManager(writerFactory).abandonActiveGoal({
        context: mutationContext,
        goalId: payload.goalId,
        reason: payload.reason,
        revision: payload.revision,
      }),
      expectedEventTypes: ["goal.status.changed"],
      prepared,
      recover: recoverGoal,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["goal.status.changed"],
      prepared,
      recover: recoverGoal,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: goalDecidePayloadSchema, schemaId: "phase21a.goal.decide.payload.v1" }),
    resultCodec: goalProjectionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const planPropose: ApplicationActionDefinitionV1<z.infer<typeof planProposePayloadSchema>, PlanRevisionProjection> = {
    actionKind: "plan.propose",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.base === null ? "Propose" : "Revise"} a Plan for Goal ${payload.goalId} revision ${String(payload.goalRevision)}.`,
      warnings: Object.freeze(["Plan review does not authorize commands, patches, MCP calls, or other effects."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: ({ mutationContext, writerFactory }) => new PlanStore(writerFactory).replaceDraft({
        base: payload.base as PlanBaseIdentity | null,
        context: mutationContext,
        editablePlan: payload.editablePlan,
        goalId: payload.goalId,
        goalRevision: payload.goalRevision,
      }),
      expectedEventTypes: ["plan.proposed", "plan.revised"],
      prepared,
      recover: recoverPlan,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["plan.proposed", "plan.revised"],
      prepared,
      recover: recoverPlan,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 72 * 1024, schema: planProposePayloadSchema, schemaId: "phase21a.plan.propose.payload.v1" }),
    resultCodec: planProjectionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const planDecide: ApplicationActionDefinitionV1<z.infer<typeof planDecidePayloadSchema>, PlanRevisionProjection> = {
    actionKind: "plan.decide",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.decision === "approve" ? "Approve" : "Reject"} exact Plan ${payload.planId} revision ${String(payload.revision)}.`,
      warnings: Object.freeze(["This decision is not authority for any external effect."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: ({ mutationContext, writerFactory }) => {
        const store = new PlanStore(writerFactory);
        return payload.decision === "approve"
          ? store.approveDraft({
              context: mutationContext,
              goalId: payload.goalId,
              goalRevision: payload.goalRevision,
              planId: payload.planId,
              revision: payload.revision,
              sha256: payload.sha256,
            })
          : store.rejectDraft({
              context: mutationContext,
              goalId: payload.goalId,
              goalRevision: payload.goalRevision,
              planId: payload.planId,
              reason: payload.reason,
              revision: payload.revision,
              sha256: payload.sha256,
            });
      },
      expectedEventTypes: ["plan.approved", "plan.rejected"],
      prepared,
      recover: recoverPlan,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["plan.approved", "plan.rejected"],
      prepared,
      recover: recoverPlan,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: planDecidePayloadSchema, schemaId: "phase21a.plan.decide.payload.v1" }),
    resultCodec: planProjectionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  return Object.freeze([goalPropose, goalDecide, planPropose, planDecide]);
}
