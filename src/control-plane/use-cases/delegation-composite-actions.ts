import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import type {
  DelegationModelEnvelopeV1,
  PreparedChildEnvelopeV1,
} from "../../delegation/context/child-envelope-schema.js";
import type { DelegationGroupTakeoverResultV1 } from "../../delegation/delegation-group-takeover.js";
import type { DelegationRevisionProjectionV1 } from "../../delegation/delegation-projector.js";
import type { DelegationOperationInspectionV1 } from "../../delegation/delegation-reconciler.js";
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
import {
  delegationPrepareCompositeResultCodec,
  delegationResumeCompositeResultCodec,
  delegationStartCompositeResultCodec,
} from "./action-result-codecs.js";

const payloadSchema = z.object({ delegationId: z.string().uuid() }).strict();

export type DelegationCompositePayloadV1 = Readonly<z.infer<typeof payloadSchema>>;

export interface DelegationPreparedResultV1 {
  readonly kind: "prepared";
  readonly childNotStarted: true;
  readonly capsuleBytes: number;
  readonly capsuleSha256: string;
  readonly envelopeSha256: string;
  readonly toolCount: number;
  readonly capabilityCount: number;
  readonly model: DelegationModelEnvelopeV1;
  readonly workspace: PreparedChildEnvelopeV1["workspace"];
}

export type DelegationGroupTerminalItemV1 =
  | Readonly<{
      readonly childRunId: string;
      readonly delegationId: string;
      readonly receiptSha256: string;
      readonly status: "blocked" | "cancelled" | "failed" | "succeeded";
    }>
  | Readonly<{
      readonly cancelRequestEventId: string;
      readonly cancelRequestId: string;
      readonly childAttemptId: string;
      readonly delegationId: string;
      readonly operationId: string;
      readonly status: "pre_effect_cancelled";
      readonly terminalEventId: string;
    }>
  | Readonly<{
      readonly delegationId: string;
      readonly diagnostic: string;
      readonly error: string;
      readonly status: "blocked";
    }>;

export interface DelegationGroupTerminalResultV1 {
  readonly kind: "group_terminal";
  readonly deferred: readonly Readonly<{
    readonly delegationId: string;
    readonly reason: "actor_limit" | "budget" | "workspace_conflict";
  }>[];
  readonly groupId: string;
  readonly results: readonly DelegationGroupTerminalItemV1[];
  readonly terminalStatus: "blocked" | "cancelled" | "completed";
}

export interface DelegationPreEffectTerminalResultV1 {
  readonly cancelRequestEventId: string;
  readonly cancelRequestId: string;
  readonly delegationId: string;
  readonly kind: "pre_effect_terminal";
  readonly outcome: "cancelled";
  readonly terminalEventId: string;
}

export type DelegationCompositeResultV1 =
  | DelegationPreparedResultV1
  | DelegationGroupTerminalResultV1
  | DelegationPreEffectTerminalResultV1
  | Readonly<{
      readonly kind: "queued";
      readonly delegation: DelegationRevisionProjectionV1;
    }>
  | Readonly<{
      readonly kind: "pre_effect_recovery";
      readonly observation: DelegationOperationInspectionV1 | null;
      readonly operationId: string;
      readonly reconciled: boolean;
      readonly retryEligible: false;
    }>
  | Readonly<{
      readonly kind: "group_takeover";
      readonly takeover: DelegationGroupTakeoverResultV1;
    }>
  | Readonly<{
      readonly kind: "operation_recovery";
      readonly observation: DelegationOperationInspectionV1;
    }>;

export type DelegationCompositeOwnerRequestV1 =
  | Readonly<{ readonly actionKind: "delegation.prepare"; readonly payload: DelegationCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "delegation.resume"; readonly payload: DelegationCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "delegation.start"; readonly payload: DelegationCompositePayloadV1 }>;

export interface DelegationCompositeOwnerCommitV1 {
  readonly applicationOperationId: string;
  readonly domainRecordRefs: readonly DurableRecordReferenceV1[];
  readonly primaryDomainRecord: DurableRecordReferenceV1;
  readonly primaryEventType: string;
  readonly resolvedHead: SessionLedgerHeadV1;
  readonly result: DelegationCompositeResultV1;
  readonly underlyingOperationRefs: readonly DurableRecordReferenceV1[];
}

export interface DelegationCompositeOwnerPortV1 {
  /**
   * PHASE21: this port owns only the composition boundary. Phase 20 retains
   * scheduler, group lease, budget, child-launch, receipt, and reconciliation
   * authority; the application service accepts only exact durable evidence.
   */
  execute(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly repositoryId: string;
    readonly request: DelegationCompositeOwnerRequestV1;
    readonly sessionId: string;
  }>): Promise<DelegationCompositeOwnerCommitV1>;
  reconcile?(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly repositoryId: string;
    readonly request: DelegationCompositeOwnerRequestV1;
    readonly sessionId: string;
  }>): Promise<DelegationCompositeOwnerCommitV1 | null>;
}

interface DelegationCompositeCommitContractV1 {
  readonly minimumUnderlyingRefs: number;
  readonly primaryEventType: string;
}

const contracts: Readonly<Record<DelegationCompositeOwnerRequestV1["actionKind"], DelegationCompositeCommitContractV1>> = Object.freeze({
  "delegation.prepare": Object.freeze({ minimumUnderlyingRefs: 1, primaryEventType: "delegation.envelope.prepared" }),
  "delegation.resume": Object.freeze({ minimumUnderlyingRefs: 1, primaryEventType: "delegation.resume.requested" }),
  "delegation.start": Object.freeze({ minimumUnderlyingRefs: 10, primaryEventType: "delegation.group.lease.acquired" }),
});

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

function validateCommit(
  context: ApplicationActionExecutionContextV1,
  request: DelegationCompositeOwnerRequestV1,
  commit: DelegationCompositeOwnerCommitV1,
): void {
  const scope = context.resolvedTarget.resourceScope;
  const contract = contracts[request.actionKind];
  const preEffectTerminal = commit.result.kind === "pre_effect_terminal";
  if (
    scope.kind !== "session" ||
    commit.applicationOperationId !== context.operationId ||
    (preEffectTerminal
      ? commit.primaryEventType !== "delegation.owner.pre_effect.terminal"
      : commit.primaryEventType !== contract.primaryEventType) ||
    commit.domainRecordRefs.length === 0 ||
    commit.domainRecordRefs.length > 128 ||
    commit.underlyingOperationRefs.length < (preEffectTerminal ? 1 : contract.minimumUnderlyingRefs) ||
    commit.underlyingOperationRefs.length > 128 ||
    !commit.domainRecordRefs.some((reference) =>
      reference.recordId === commit.primaryDomainRecord.recordId &&
      reference.recordSha256 === commit.primaryDomainRecord.recordSha256
    )
  ) {
    throw new ApplicationControlError("control_operation_busy", "Delegation owner returned an incomplete composite commit predicate");
  }
  for (const reference of [...commit.domainRecordRefs, ...commit.underlyingOperationRefs]) {
    if (reference.ownerKind !== "session" || reference.ledgerId !== `session:${scope.sessionId}`) {
      throw new ApplicationControlError("control_operation_busy", "Delegation owner returned a cross-resource composite reference");
    }
  }
  const sequenced = [...commit.domainRecordRefs, ...commit.underlyingOperationRefs]
    .filter((reference): reference is DurableRecordReferenceV1 & { readonly sequence: number } => reference.sequence !== null);
  const end = sequenced.reduce((latest, reference) => reference.sequence > latest.sequence ? reference : latest);
  if (commit.resolvedHead.sessionId !== scope.sessionId || commit.resolvedHead.sequence !== end.sequence ||
      commit.resolvedHead.eventId !== end.recordId) {
    throw new ApplicationControlError("control_operation_busy", "Delegation owner returned a tail-sensitive or mismatched resolved head");
  }
}

function translateOwnerError(error: unknown): ApplicationControlError {
  if (error instanceof ApplicationControlError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "Delegation owner operation failed";
  if (/stale|conflict|not_found|not_approved|binding/u.test(code)) {
    return new ApplicationControlError("control_stale_projection", message, { cause: error });
  }
  if (/invalid|unsupported|unavailable|schema|authority_expansion|model_unqualified/u.test(code)) {
    return new ApplicationControlError("control_target_invalid", message, { cause: error });
  }
  if (/denied|cancelled/u.test(code)) {
    return new ApplicationControlError("control_authorization_denied", message, { cause: error });
  }
  // Unknown, response-loss, lease, and reconciliation failures are never
  // converted into permission to repeat a child launch.
  return new ApplicationControlError("control_operation_busy", message, { cause: error });
}

async function executeComposite(input: Readonly<{
  readonly context: ApplicationActionExecutionContextV1;
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly owner: DelegationCompositeOwnerPortV1;
  readonly prepared: PreparedActionV1;
  readonly reconcileOnly?: boolean;
  readonly request: DelegationCompositeOwnerRequestV1;
}>): Promise<ApplicationActionExecutionResultV1<DelegationCompositeResultV1>> {
  const scope = input.context.resolvedTarget.resourceScope;
  const version = input.context.resolvedTarget.resourceVersion;
  if (scope.kind !== "session" || version.kind !== "session_ledger_head" || version.head.sequence === 0) {
    throw new ApplicationControlError("control_session_not_started", "Delegation composite action requires a materialized session");
  }
  if (input.prepared.preparedActionSha256 !== input.context.applicationCommit.preparedActionSha256) {
    throw new ApplicationControlError("control_prepared_action_mismatch", "Delegation prepared binding changed before dispatch");
  }
  try {
    const ownerInput = {
      applicationCommit: input.context.applicationCommit,
      authenticatedMutation: authenticatedMutation(input.context),
      expectedHead: version.head,
      repositoryId: scope.repositoryId,
      request: input.request,
      sessionId: scope.sessionId,
    } as const;
    const commit = input.reconcileOnly === true
      ? await input.owner.reconcile?.(ownerInput) ?? null
      : await input.owner.execute(ownerInput);
    if (commit === null) {
      throw new ApplicationControlError(
        "control_operation_busy",
        "Delegation owner has no complete exact reconciliation predicate",
      );
    }
    validateCommit(input.context, input.request, commit);
    return Object.freeze({
      domainRecordRefs: commit.domainRecordRefs,
      primaryDomainRecord: commit.primaryDomainRecord,
      resolvedResourceScope: scope,
      resolvedResourceVersion: Object.freeze({ head: commit.resolvedHead, kind: "session_ledger_head" as const }),
      result: commit.result,
      underlyingOperationRefs: commit.underlyingOperationRefs,
    });
  } catch (error) {
    throw translateOwnerError(error);
  }
}

export function createDelegationCompositeActionDefinitions(input: Readonly<{
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly owner: DelegationCompositeOwnerPortV1;
}>): readonly ApplicationActionDefinitionV1[] {
  const common = {
    confirmation: "show_before_commit" as const,
    effectClass: "runtime_effect" as const,
    payloadCodec: createStrictCodec({ maximumBytes: 2 * 1024, schema: payloadSchema, schemaId: "phase21a.delegation.composite.payload.v1" }),
    requiredPrincipalKind: "human" as const,
    requiredScopes: Object.freeze(["session.mutate"]),
    resolveTarget: (target: Parameters<typeof resolveExistingSessionActionTarget>[1]) =>
      resolveExistingSessionActionTarget(input.dependencies, target),
    targetContracts: Object.freeze([sessionContract()]),
    zeroHeadPolicy: "deny" as const,
  };
  const prepare: ApplicationActionDefinitionV1<DelegationCompositePayloadV1, DelegationCompositeResultV1> = {
    ...common,
    actionKind: "delegation.prepare",
    resultCodec: delegationPrepareCompositeResultCodec,
    display: (_resolved, payload) => Object.freeze({
      summary: `Prepare the exact sealed envelope for delegation ${payload.delegationId}; do not start a child.`,
      warnings: Object.freeze(["Prepared artifacts remain non-executable until a separate start action commits."]),
    }),
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "delegation.prepare", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "delegation.prepare", payload }),
      }),
    }),
  };
  const start: ApplicationActionDefinitionV1<DelegationCompositePayloadV1, DelegationCompositeResultV1> = {
    ...common,
    actionKind: "delegation.start",
    resultCodec: delegationStartCompositeResultCodec,
    display: (_resolved, payload) => Object.freeze({
      summary: `Admit and start the exact prepared delegation group containing ${payload.delegationId}.`,
      warnings: Object.freeze(["This can launch a child process; Phase 20 leases, budgets, conflicts, receipts, and approvals remain authoritative."]),
    }),
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "delegation.start", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "delegation.start", payload }),
      }),
    }),
  };
  const resume: ApplicationActionDefinitionV1<DelegationCompositePayloadV1, DelegationCompositeResultV1> = {
    ...common,
    actionKind: "delegation.resume",
    resultCodec: delegationResumeCompositeResultCodec,
    display: (_resolved, payload) => Object.freeze({
      summary: `Reconcile or continue the exact delegation ${payload.delegationId}.`,
      warnings: Object.freeze(["Unknown prior child effects block; resume never generically repeats a launch after response loss."]),
    }),
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "delegation.resume", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "delegation.resume", payload }),
      }),
    }),
  };
  return Object.freeze([prepare, start, resume]);
}
