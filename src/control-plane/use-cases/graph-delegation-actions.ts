import { z } from "zod";

import { DelegationControlPlane } from "../../delegation/delegation-control-plane.js";
import { canonicalDelegationIdentity } from "../../delegation/delegation-identity.js";
import type { DelegationRevisionProjectionV1 } from "../../delegation/delegation-projector.js";
import { delegationRevisionContentSchema } from "../../delegation/delegation-schema.js";
import { revisionSchema } from "../../goals/goal-schema.js";
import { sha256Schema } from "../../plans/plan-schema.js";
import { TaskGraphControlPlane } from "../../task-graph/task-graph-control-plane.js";
import { TaskExecutionControlPlane } from "../../scheduling/task-execution-control-plane.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import { canonicalTaskGraphIdentity } from "../../task-graph/task-graph-identity.js";
import type { TaskGraphRevisionProjectionV1 } from "../../task-graph/task-graph-projector.js";
import { taskGraphRevisionContentSchema } from "../../task-graph/task-graph-schema.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import type { ReconstructedMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import type { ApplicationActionDefinitionV1 } from "../application-action-registry.js";
import type { ActiveDelegationControlRegistry } from "../active-delegation-control-registry.js";
import { createStrictCodec } from "../application-protocol.js";
import {
  executeSessionDomainAction,
  reconcileSessionDomainAction,
  resolveExistingSessionActionTarget,
  type SessionDomainActionDependenciesV1,
} from "./session-domain-action-support.js";
import {
  delegationRevisionResultCodec,
  graphRevisionResultCodec,
  taskExecutionResultCodec,
} from "./action-result-codecs.js";

const graphBaseSchema = z.object({ revision: revisionSchema, sha256: sha256Schema }).strict();
const graphProposePayloadSchema = z.object({
  base: graphBaseSchema.nullable(),
  graph: taskGraphRevisionContentSchema,
}).strict();
const graphDecidePayloadSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), revision: revisionSchema, sha256: sha256Schema }).strict(),
  z.object({ decision: z.literal("reject"), reason: z.string().min(1).max(4_096), revision: revisionSchema, sha256: sha256Schema }).strict(),
]);
const graphRunPayloadSchema = z.object({
  requestedExecution: z.enum(["foreground", "background"]),
  revision: revisionSchema,
  runtimeProfileId: z.string().min(1).max(128),
  sha256: sha256Schema,
}).strict();
const delegationBaseSchema = z.object({ revision: revisionSchema, sha256: sha256Schema }).strict();
const delegationProposePayloadSchema = z.object({
  base: delegationBaseSchema.nullable(),
  parentRunId: z.string().uuid(),
  revision: delegationRevisionContentSchema,
}).strict();
const delegationDecidePayloadSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    delegationId: z.string().uuid(),
    revision: revisionSchema,
    sha256: sha256Schema,
  }).strict(),
  z.object({
    decision: z.literal("reject"),
    delegationId: z.string().uuid(),
    reason: z.string().min(1).max(4_096),
    revision: revisionSchema,
    sha256: sha256Schema,
  }).strict(),
]);
const delegationStartPayloadSchema = z.object({ delegationId: z.string().uuid() }).strict();
const delegationCancelPayloadSchema = z.object({
  delegationId: z.string().uuid(),
  reason: z.string().min(1).max(4_096),
}).strict();

function sessionContract() {
  return Object.freeze({
    acceptedExpectedVersionKinds: Object.freeze(["session_ledger_head"] as const),
    resourceKinds: Object.freeze(["session"] as const),
    targetKind: "existing_resource" as const,
  });
}

function recoverGraph(
  session: ReconstructedMultiRunSession,
  events: readonly DecodedStoredEvent[],
): TaskGraphRevisionProjectionV1 {
  const data = events.at(-1)?.data as Readonly<{
    graph_id?: unknown;
    graph_revision?: unknown;
    graph_sha256?: unknown;
  }> | undefined;
  const graph = session.taskGraph.revisions.find((candidate) =>
    candidate.graphId === data?.graph_id &&
    candidate.revision === data?.graph_revision &&
    candidate.graphSha256 === data?.graph_sha256
  );
  if (graph === undefined) throw new Error("application Graph fact did not reconstruct");
  return graph;
}

function recoverDelegation(
  session: ReconstructedMultiRunSession,
  events: readonly DecodedStoredEvent[],
): DelegationRevisionProjectionV1 {
  const data = events.at(-1)?.data as Readonly<{
    delegation_id?: unknown;
    delegation_revision?: unknown;
    delegation_sha256?: unknown;
  }> | undefined;
  const delegation = session.delegations.revisions.find((candidate) =>
    candidate.delegationId === data?.delegation_id &&
    candidate.delegationRevision === data?.delegation_revision &&
    candidate.delegationSha256 === data?.delegation_sha256
  );
  if (delegation === undefined) throw new Error("application Delegation fact did not reconstruct");
  return delegation;
}

function recoverExecution(session: ReconstructedMultiRunSession): TaskExecutionProjectionV1 {
  if (session.taskExecution === null) throw new Error("application Graph execution fact did not reconstruct");
  return session.taskExecution;
}

export function createGraphDelegationActionDefinitions(
  dependencies: SessionDomainActionDependenciesV1,
  activeDelegations?: ActiveDelegationControlRegistry,
): readonly ApplicationActionDefinitionV1[] {
  const graphPropose: ApplicationActionDefinitionV1<z.infer<typeof graphProposePayloadSchema>, TaskGraphRevisionProjectionV1> = {
    actionKind: "graph.propose",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.base === null ? "Propose" : "Replace"} the exact Task Graph revision.`,
      warnings: Object.freeze(["Graph approval does not authorize node effects or promotion."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => (await new TaskGraphControlPlane(writerFactory).replace({
        base: payload.base,
        context: mutationContext,
        graph: canonicalTaskGraphIdentity(payload.graph),
      })).graph,
      expectedEventTypes: ["task_graph.proposed", "task_graph.replaced"],
      prepared,
      recover: recoverGraph,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["task_graph.proposed", "task_graph.replaced"],
      prepared,
      recover: recoverGraph,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 512 * 1024, schema: graphProposePayloadSchema, schemaId: "phase21a.graph.propose.payload.v1" }),
    resultCodec: graphRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const graphDecide: ApplicationActionDefinitionV1<z.infer<typeof graphDecidePayloadSchema>, TaskGraphRevisionProjectionV1> = {
    actionKind: "graph.decide",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.decision === "approve" ? "Approve" : "Reject"} Graph revision ${String(payload.revision)} at ${payload.sha256}.`,
      warnings: Object.freeze(["This records review only; execution remains a separate action."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => {
        const plane = new TaskGraphControlPlane(writerFactory);
        return (payload.decision === "approve"
          ? await plane.approve({ context: mutationContext, revision: payload.revision, sha256: payload.sha256 })
          : await plane.reject({ context: mutationContext, reason: payload.reason, revision: payload.revision, sha256: payload.sha256 })).graph;
      },
      expectedEventTypes: ["task_graph.approved", "task_graph.rejected"],
      prepared,
      recover: recoverGraph,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["task_graph.approved", "task_graph.rejected"],
      prepared,
      recover: recoverGraph,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: graphDecidePayloadSchema, schemaId: "phase21a.graph.decide.payload.v1" }),
    resultCodec: graphRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const graphEnqueue: ApplicationActionDefinitionV1<z.infer<typeof graphRunPayloadSchema>, TaskExecutionProjectionV1> = {
    actionKind: "graph.enqueue",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Queue Graph revision ${String(payload.revision)} for ${payload.requestedExecution} execution.`,
      warnings: Object.freeze(["This records execution intent; every later node effect remains independently fenced."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => (await new TaskExecutionControlPlane(writerFactory).enqueue({
        context: mutationContext,
        requestedExecution: payload.requestedExecution,
        revision: payload.revision,
        runtimeProfileId: payload.runtimeProfileId,
        sha256: payload.sha256,
      })).execution,
      expectedEventTypes: ["task_graph.enqueued"],
      prepared,
      recover: recoverExecution,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["task_graph.enqueued"],
      prepared,
      recover: recoverExecution,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: graphRunPayloadSchema, schemaId: "phase21a.graph.enqueue.payload.v1" }),
    resultCodec: taskExecutionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const delegationPropose: ApplicationActionDefinitionV1<z.infer<typeof delegationProposePayloadSchema>, DelegationRevisionProjectionV1> = {
    actionKind: "delegation.propose",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.base === null ? "Propose" : "Replace"} a bounded child delegation.`,
      warnings: Object.freeze(["This stores a draft only; child launch remains separately authorized."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => (await new DelegationControlPlane(writerFactory).replace({
        base: payload.base,
        context: mutationContext,
        parentRunId: payload.parentRunId,
        revision: canonicalDelegationIdentity(payload.revision),
      })).delegation,
      expectedEventTypes: ["delegation.revision.proposed", "delegation.revision.replaced"],
      prepared,
      recover: recoverDelegation,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["delegation.revision.proposed", "delegation.revision.replaced"],
      prepared,
      recover: recoverDelegation,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 512 * 1024, schema: delegationProposePayloadSchema, schemaId: "phase21a.delegation.propose.payload.v1" }),
    resultCodec: delegationRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const delegationDecide: ApplicationActionDefinitionV1<z.infer<typeof delegationDecidePayloadSchema>, DelegationRevisionProjectionV1> = {
    actionKind: "delegation.decide",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.decision === "approve" ? "Approve" : "Reject"} delegation ${payload.delegationId} revision ${String(payload.revision)}.`,
      warnings: Object.freeze(["Approval does not start the child or authorize its later effects."]),
    }),
    effectClass: "control_only",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => {
        const plane = new DelegationControlPlane(writerFactory);
        return (payload.decision === "approve"
          ? await plane.approve({ context: mutationContext, delegationId: payload.delegationId, revision: payload.revision, sha256: payload.sha256 })
          : await plane.reject({ context: mutationContext, delegationId: payload.delegationId, reason: payload.reason, revision: payload.revision, sha256: payload.sha256 })).delegation;
      },
      expectedEventTypes: ["delegation.decision.recorded"],
      prepared,
      recover: recoverDelegation,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["delegation.decision.recorded"],
      prepared,
      recover: recoverDelegation,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: delegationDecidePayloadSchema, schemaId: "phase21a.delegation.decide.payload.v1" }),
    resultCodec: delegationRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const delegationEnqueue: ApplicationActionDefinitionV1<z.infer<typeof delegationStartPayloadSchema>, DelegationRevisionProjectionV1> = {
    actionKind: "delegation.enqueue",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Queue approved delegation ${payload.delegationId}.`,
      warnings: Object.freeze(["Queueing is durable; actual child admission remains under the Phase 20 scheduler and leases."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeSessionDomainAction({
      context,
      dependencies,
      execute: async ({ mutationContext, writerFactory }) => (await new DelegationControlPlane(writerFactory).enqueue({
        context: mutationContext,
        delegationId: payload.delegationId,
      })).delegation,
      expectedEventTypes: ["delegation.queued"],
      prepared,
      recover: recoverDelegation,
    }),
    reconcile: (context, _payload, prepared) => reconcileSessionDomainAction({
      context,
      dependencies,
      expectedEventTypes: ["delegation.queued"],
      prepared,
      recover: recoverDelegation,
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 2 * 1024, schema: delegationStartPayloadSchema, schemaId: "phase21a.delegation.enqueue.payload.v1" }),
    resultCodec: delegationRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  const delegationCancel: ApplicationActionDefinitionV1<z.infer<typeof delegationCancelPayloadSchema>, DelegationRevisionProjectionV1> = {
    actionKind: "delegation.cancel",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Request cancellation for delegation ${payload.delegationId}.`,
      warnings: Object.freeze(["Cancellation is requested, not reported terminal, until the owner reconciles it."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => {
      const scope = context.resolvedTarget.resourceScope;
      const active = scope.kind === "session" ? activeDelegations?.active(scope.sessionId) ?? null : null;
      if (active !== null) {
        if (active.delegationId !== payload.delegationId) {
          throw new Error("active Delegation owner does not match the cancellation target");
        }
        return active.requestCancel({
          context,
          delegationId: payload.delegationId,
          reason: payload.reason,
          reconcileOnly: false,
        }).then((result) => {
          if (result === null) throw new Error("active Delegation cancellation returned no durable result");
          return result;
        });
      }
      return executeSessionDomainAction({
        context,
        dependencies,
        execute: async ({ mutationContext, writerFactory }) => (await new DelegationControlPlane(writerFactory).cancel({
          context: mutationContext,
          delegationId: payload.delegationId,
          reason: payload.reason,
        })).delegation,
        expectedEventTypes: ["delegation.cancel.requested"],
        prepared,
        recover: recoverDelegation,
      });
    },
    reconcile: (context, payload, prepared) => {
      const scope = context.resolvedTarget.resourceScope;
      const active = scope.kind === "session" ? activeDelegations?.active(scope.sessionId) ?? null : null;
      if (active !== null) {
        if (active.delegationId !== payload.delegationId) return Promise.resolve(null);
        return active.requestCancel({
          context,
          delegationId: payload.delegationId,
          reason: payload.reason,
          reconcileOnly: true,
        });
      }
      return reconcileSessionDomainAction({
        context,
        dependencies,
        expectedEventTypes: ["delegation.cancel.requested"],
        prepared,
        recover: recoverDelegation,
      });
    },
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: delegationCancelPayloadSchema, schemaId: "phase21a.delegation.cancel.payload.v1" }),
    resultCodec: delegationRevisionResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.mutate"],
    resolveTarget: (target) => resolveExistingSessionActionTarget(dependencies, target),
    targetContracts: [sessionContract()],
    zeroHeadPolicy: "deny",
  };

  return Object.freeze([
    graphPropose,
    graphDecide,
    graphEnqueue,
    delegationPropose,
    delegationDecide,
    delegationEnqueue,
    delegationCancel,
  ]);
}
