import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import type {
  ApplicationActionDefinitionV1,
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
} from "../application-action-registry.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  createStrictCodec,
  type ApplicationCommitBindingV1,
  type PreparedActionV1,
  type SessionLedgerHeadV1,
} from "../application-protocol.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import {
  resolveExistingSessionActionTarget,
  type SessionDomainActionDependenciesV1,
} from "./session-domain-action-support.js";
import { graphCancelResultCodec } from "./action-result-codecs.js";

export const graphCancelPayloadSchema = z.object({
  reason: z.string().min(1).max(2_048),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type GraphCancelPayloadV1 = Readonly<z.infer<typeof graphCancelPayloadSchema>>;

export interface GraphCancelLocalResultV1 {
  readonly delivery: "session_request";
  readonly execution: TaskExecutionProjectionV1;
  readonly graph: TaskExecutionProjectionV1["graph"];
}

export interface GraphCancelBackgroundResultV1 {
  readonly accepted: true;
  readonly controlSha256: string;
  readonly delivery: "background_control_queued";
  readonly graph: TaskExecutionProjectionV1["graph"];
  readonly operationId: string;
  readonly requestId: string;
  readonly terminal: false;
  readonly workerId: string;
}

export type GraphCancelResultV1 = GraphCancelLocalResultV1 | GraphCancelBackgroundResultV1;

export interface GraphCancelOwnerCommitV1 {
  readonly applicationOperationId: string;
  readonly domainRecordRefs: readonly DurableRecordReferenceV1[];
  readonly primaryDomainRecord: DurableRecordReferenceV1;
  readonly primaryEventType: "task_graph.cancel.requested";
  readonly resolvedHead: SessionLedgerHeadV1;
  readonly result: GraphCancelResultV1;
  readonly underlyingOperationRefs: readonly DurableRecordReferenceV1[];
}

export interface GraphCancelOwnerPortV1 {
  execute(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly payload: GraphCancelPayloadV1;
    readonly repositoryId: string;
    readonly sessionId: string;
  }>): Promise<GraphCancelOwnerCommitV1>;
  reconcile?(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly payload: GraphCancelPayloadV1;
    readonly repositoryId: string;
    readonly sessionId: string;
  }>): Promise<GraphCancelOwnerCommitV1 | null>;
}

function sessionContract() {
  return Object.freeze({
    acceptedExpectedVersionKinds: Object.freeze(["session_ledger_head"] as const),
    resourceKinds: Object.freeze(["session"] as const),
    targetKind: "existing_resource" as const,
  });
}

function authenticatedMutation(context: ApplicationActionExecutionContextV1): AuthenticatedTaskMutationBindingV1 {
  return Object.freeze({
    actionIdentitySha256: sha256Canonical({
      application_commit: context.applicationCommit,
      resource_scope: context.resolvedTarget.resourceScope,
      schema_version: 1,
    }),
    applicationCommit: context.applicationCommit,
    authenticationId: context.call.principal.authenticationId,
    requestId: context.requestId,
    surface: context.call.surface,
  });
}

function sameReference(left: DurableRecordReferenceV1, right: DurableRecordReferenceV1): boolean {
  return left.ledgerId === right.ledgerId && left.ownerKind === right.ownerKind &&
    left.recordId === right.recordId && left.recordSha256 === right.recordSha256 && left.sequence === right.sequence;
}

function validateCommit(
  context: ApplicationActionExecutionContextV1,
  payload: GraphCancelPayloadV1,
  commit: GraphCancelOwnerCommitV1,
): void {
  const scope = context.resolvedTarget.resourceScope;
  if (scope.kind !== "session" || commit.applicationOperationId !== context.operationId ||
      commit.resolvedHead.sessionId !== scope.sessionId || commit.resolvedHead.sequence < 1 ||
      commit.result.graph.revision !== payload.revision || commit.result.graph.graphSha256 !== payload.sha256 ||
      commit.domainRecordRefs.length !== 1 || !sameReference(commit.domainRecordRefs[0]!, commit.primaryDomainRecord) ||
      commit.primaryDomainRecord.ownerKind !== "session" || commit.primaryDomainRecord.ledgerId !== `session:${scope.sessionId}` ||
      commit.primaryDomainRecord.sequence === null || commit.primaryDomainRecord.sequence !== commit.resolvedHead.sequence &&
        commit.underlyingOperationRefs.every((reference) => reference.sequence !== commit.resolvedHead.sequence)) {
    throw new ApplicationControlError("control_operation_busy", "Graph cancel owner returned an incomplete exact commit predicate");
  }
  if (commit.result.delivery === "background_control_queued") {
    const effect = commit.underlyingOperationRefs.find((reference) => reference.ownerKind === "effect");
    if (commit.underlyingOperationRefs.length !== 1 || commit.result.requestId !== context.operationId || effect === undefined || effect.sequence !== null ||
        effect.recordId !== `cancel:${commit.result.requestId}` || effect.recordSha256 !== commit.result.controlSha256 ||
        effect.ledgerId !== `background:${commit.result.operationId}`) {
      throw new ApplicationControlError("control_operation_busy", "Graph background cancel lacks its exact durable control reference");
    }
  } else if (commit.underlyingOperationRefs.length > 2 || commit.underlyingOperationRefs.some((reference) =>
    reference.ownerKind !== "session" || reference.ledgerId !== `session:${scope.sessionId}` || reference.sequence === null
  )) {
    throw new ApplicationControlError("control_operation_busy", "local Graph cancel returned an unexpected effect reference");
  }
}

function translate(error: unknown): ApplicationControlError {
  if (error instanceof ApplicationControlError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "Graph cancellation failed";
  if (/stale|conflict|not_approved|not_found|revision|binding/u.test(code)) {
    return new ApplicationControlError("control_stale_projection", message, { cause: error });
  }
  if (/invalid|unsupported|protocol|schema/u.test(code)) {
    return new ApplicationControlError("control_target_invalid", message, { cause: error });
  }
  return new ApplicationControlError("control_operation_busy", message, { cause: error });
}

async function executeOwner(input: Readonly<{
  readonly context: ApplicationActionExecutionContextV1;
  readonly owner: GraphCancelOwnerPortV1;
  readonly payload: GraphCancelPayloadV1;
  readonly prepared: PreparedActionV1;
  readonly reconcileOnly: boolean;
}>): Promise<ApplicationActionExecutionResultV1<GraphCancelResultV1> | null> {
  const scope = input.context.resolvedTarget.resourceScope;
  const version = input.context.resolvedTarget.resourceVersion;
  if (scope.kind !== "session" || version.kind !== "session_ledger_head" || version.head.sequence === 0) {
    throw new ApplicationControlError("control_session_not_started", "Graph cancellation requires a materialized session");
  }
  if (input.prepared.preparedActionSha256 !== input.context.applicationCommit.preparedActionSha256) {
    throw new ApplicationControlError("control_prepared_action_mismatch", "Graph cancel prepared binding changed before dispatch");
  }
  try {
    const ownerInput = Object.freeze({
      applicationCommit: input.context.applicationCommit,
      authenticatedMutation: authenticatedMutation(input.context),
      expectedHead: version.head,
      payload: input.payload,
      repositoryId: scope.repositoryId,
      sessionId: scope.sessionId,
    });
    const commit = input.reconcileOnly ? await input.owner.reconcile?.(ownerInput) ?? null : await input.owner.execute(ownerInput);
    if (commit === null) return null;
    validateCommit(input.context, input.payload, commit);
    return Object.freeze({
      domainRecordRefs: commit.domainRecordRefs,
      primaryDomainRecord: commit.primaryDomainRecord,
      resolvedResourceScope: scope,
      resolvedResourceVersion: Object.freeze({ head: commit.resolvedHead, kind: "session_ledger_head" as const }),
      result: commit.result,
      underlyingOperationRefs: commit.underlyingOperationRefs,
    });
  } catch (error) {
    throw translate(error);
  }
}

export function createGraphCancelAction(input: Readonly<{
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly owner: GraphCancelOwnerPortV1;
}>): ApplicationActionDefinitionV1<GraphCancelPayloadV1, GraphCancelResultV1> {
  const definition: ApplicationActionDefinitionV1<GraphCancelPayloadV1, GraphCancelResultV1> = {
    actionKind: "graph.cancel",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Request cancellation for Graph revision ${String(payload.revision)}.`,
      warnings: Object.freeze(["A durable request or queued worker control is not proof that an active worker has stopped."]),
    }),
    effectClass: "runtime_effect",
    execute: async (context, payload, prepared) => (await executeOwner({ context, owner: input.owner, payload, prepared, reconcileOnly: false }))!,
    reconcile: (context, payload, prepared) => executeOwner({ context, owner: input.owner, payload, prepared, reconcileOnly: true }),
    payloadCodec: createStrictCodec({ maximumBytes: 8 * 1024, schema: graphCancelPayloadSchema, schemaId: "phase21a.graph.cancel.payload.v2" }),
    resultCodec: graphCancelResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: Object.freeze(["session.mutate"]),
    resolveTarget: (target) => resolveExistingSessionActionTarget(input.dependencies, target),
    targetContracts: Object.freeze([sessionContract()]),
    zeroHeadPolicy: "deny",
  };
  return Object.freeze(definition);
}
