import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import type { BackgroundLaunchResultV1 } from "../../background/background-worker-launcher.js";
import type { TaskSchedulerRunResultV1 } from "../../scheduling/deterministic-task-scheduler.js";
import type { TaskExecutionProjectionV1 } from "../../scheduling/task-execution-projector.js";
import type { TaskExecutionMutationResultV1 } from "../../scheduling/task-execution-control-plane.js";
import type { ManagedWorkspaceHandleV1 } from "../../worktrees/managed-worktree-manager.js";
import type { OriginVerificationResultV1 } from "../../worktrees/origin-verification-runtime.js";
import type { PromotionResultV1 } from "../../worktrees/promotion-runtime.js";
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
  graphRetryCompositeResultCodec,
  graphRunCompositeResultCodec,
  promotionApplyCompositeResultCodec,
  promotionVerifyOriginCompositeResultCodec,
  worktreeAllocateCompositeResultCodec,
  worktreeCleanupCompositeResultCodec,
} from "./action-result-codecs.js";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const execution = z.enum(["foreground", "background"]);

export const graphRunCompositePayloadSchema = z.object({
  execution,
  revision,
  sha256,
}).strict();

export const graphResumeCompositePayloadSchema = z.object({
  execution,
  revision,
  sha256,
  takeover: z.boolean(),
}).strict();

export const graphRetryCompositePayloadSchema = z.object({
  attemptNumber: z.number().int().positive().max(3),
  attemptTerminal: z.enum(["known_failed", "pre_effect_infrastructure_failure", "cancelled_clean"]),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  revision,
  sha256,
  terminalEventId: uuid,
}).strict();

export const worktreeAllocateCompositePayloadSchema = z.object({
  allowDirty: z.boolean(),
  revision,
  sha256,
  sourceNodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
}).strict();

export const promotionApplyCompositePayloadSchema = z.object({
  attemptId: uuid,
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  revision,
  sha256,
}).strict();

export const promotionVerifyOriginCompositePayloadSchema = z.object({
  promotionOperationId: uuid,
  revision,
  sha256,
}).strict();

export const worktreeCleanupCompositePayloadSchema = z.object({
  archiveAndRemove: z.boolean(),
  graphId: uuid,
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  revision,
  sha256,
}).strict();

export type GraphRunCompositePayloadV1 = Readonly<z.infer<typeof graphRunCompositePayloadSchema>>;
export type GraphResumeCompositePayloadV1 = Readonly<z.infer<typeof graphResumeCompositePayloadSchema>>;
export type GraphRetryCompositePayloadV1 = Readonly<z.infer<typeof graphRetryCompositePayloadSchema>>;
export type WorktreeAllocateCompositePayloadV1 = Readonly<z.infer<typeof worktreeAllocateCompositePayloadSchema>>;
export type PromotionApplyCompositePayloadV1 = Readonly<z.infer<typeof promotionApplyCompositePayloadSchema>>;
export type PromotionVerifyOriginCompositePayloadV1 = Readonly<z.infer<typeof promotionVerifyOriginCompositePayloadSchema>>;
export type WorktreeCleanupCompositePayloadV1 = Readonly<z.infer<typeof worktreeCleanupCompositePayloadSchema>>;

export interface GraphBackgroundCompositeResultV1 {
  readonly execution: "background";
  readonly graph: TaskExecutionProjectionV1["graph"];
  readonly launch: BackgroundLaunchResultV1;
}

export interface GraphForegroundCompositeResultV1 {
  readonly execution: "foreground";
  readonly run: TaskSchedulerRunResultV1;
}

export type GraphRunCompositeResultV1 = GraphBackgroundCompositeResultV1 | GraphForegroundCompositeResultV1;

export interface WorktreeAllocateCompositeResultV1 {
  readonly baselineManifestSha256: string;
  readonly identity: ManagedWorkspaceHandleV1["identity"];
  readonly nodeIds: readonly string[];
}

export interface WorktreeCleanupCompositeResultV1 {
  readonly archiveSha256: string | null;
  readonly status: "archived" | "removed";
  readonly workspaceId: string;
}

export type OwnerInternalCompositeActionKindV1 =
  | "promotion.apply"
  | "promotion.verify_origin"
  | "worktree.allocate"
  | "worktree.cleanup";

/**
 * Exact durable proof that an owner-internal effect never crossed its first
 * admission record. This is a known terminal result, not an unknown effect.
 */
export interface GraphCompositePreEffectTerminalResultV1 {
  readonly actionKind: OwnerInternalCompositeActionKindV1;
  readonly kind: "pre_effect_terminal";
  readonly outcome: "cancelled" | "denied";
  readonly targetIdentitySha256: string;
}

export type WorktreeAllocateActionResultV1 = WorktreeAllocateCompositeResultV1 | GraphCompositePreEffectTerminalResultV1;
export type PromotionApplyActionResultV1 = PromotionResultV1 | GraphCompositePreEffectTerminalResultV1;
export type PromotionVerifyOriginActionResultV1 = OriginVerificationResultV1 | GraphCompositePreEffectTerminalResultV1;
export type WorktreeCleanupActionResultV1 = WorktreeCleanupCompositeResultV1 | GraphCompositePreEffectTerminalResultV1;

export function isGraphCompositePreEffectTerminalResult(
  value: unknown,
): value is GraphCompositePreEffectTerminalResultV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.kind === "pre_effect_terminal" &&
    ["promotion.apply", "promotion.verify_origin", "worktree.allocate", "worktree.cleanup"].includes(String(candidate.actionKind)) &&
    (candidate.outcome === "cancelled" || candidate.outcome === "denied") &&
    typeof candidate.targetIdentitySha256 === "string" && /^[a-f0-9]{64}$/u.test(candidate.targetIdentitySha256);
}

export type GraphCompositeOwnerRequestV1 =
  | Readonly<{ readonly actionKind: "graph.run"; readonly payload: GraphRunCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "graph.resume"; readonly payload: GraphResumeCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "graph.retry"; readonly payload: GraphRetryCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "worktree.allocate"; readonly payload: WorktreeAllocateCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "promotion.apply"; readonly payload: PromotionApplyCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "promotion.verify_origin"; readonly payload: PromotionVerifyOriginCompositePayloadV1 }>
  | Readonly<{ readonly actionKind: "worktree.cleanup"; readonly payload: WorktreeCleanupCompositePayloadV1 }>;

export type GraphCompositeOwnerResultV1 =
  | GraphRunCompositeResultV1
  | TaskExecutionMutationResultV1
  | WorktreeAllocateCompositeResultV1
  | PromotionResultV1
  | OriginVerificationResultV1
  | WorktreeCleanupCompositeResultV1
  | GraphCompositePreEffectTerminalResultV1;

export interface GraphCompositeOwnerCommitV1<TResult = GraphCompositeOwnerResultV1> {
  readonly applicationOperationId: string;
  readonly domainRecordRefs: readonly DurableRecordReferenceV1[];
  readonly primaryDomainRecord: DurableRecordReferenceV1;
  readonly primaryEventType: string;
  readonly resolvedHead: SessionLedgerHeadV1;
  readonly result: TResult;
  readonly underlyingOperationRefs: readonly DurableRecordReferenceV1[];
}

export interface GraphCompositeOwnerPortV1 {
  /**
   * Observation-only exact-target validation performed before the Application
   * operation crosses its durable domain-dispatch boundary. This is not an
   * effect owner and must never append a domain fact.
   */
  preflight(input: Readonly<{
    readonly expectedHead: SessionLedgerHeadV1;
    readonly repositoryId: string;
    readonly request: GraphCompositeOwnerRequestV1;
    readonly sessionId: string;
  }>): Promise<void>;
  /**
   * PHASE21: this is an action-specific owner bridge, not a generic runtime
   * command. Implementations must return only exact durable commit evidence.
   */
  execute(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly repositoryId: string;
    readonly request: GraphCompositeOwnerRequestV1;
    readonly sessionId: string;
  }>): Promise<GraphCompositeOwnerCommitV1>;
  reconcile?(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly repositoryId: string;
    readonly request: GraphCompositeOwnerRequestV1;
    readonly sessionId: string;
  }>): Promise<GraphCompositeOwnerCommitV1 | null>;
}

export interface GraphCompositeCommitContractV1 {
  readonly bindingLocation: "event.data.origin.application_commit";
  readonly minimumUnderlyingRefs: number;
  readonly owner: "phase19_graph_scheduler" | "phase19_background_worker" | "phase19_worktree_manager" | "phase19_promotion_runtime";
  readonly primaryEventTypes: readonly string[];
  readonly reconciler: "exact_owner_commit_predicate";
}

export const graphCompositeCommitContractsV1: Readonly<Record<GraphCompositeOwnerRequestV1["actionKind"], GraphCompositeCommitContractV1>> = Object.freeze({
  "graph.resume": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 1,
    owner: "phase19_graph_scheduler",
    primaryEventTypes: Object.freeze(["task_graph.enqueued", "task_worker.spawn.requested"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "graph.run": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 1,
    owner: "phase19_graph_scheduler",
    primaryEventTypes: Object.freeze(["task_graph.started", "task_worker.spawn.requested"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "graph.retry": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 0,
    owner: "phase19_graph_scheduler",
    primaryEventTypes: Object.freeze(["task_node.retry.requested"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "promotion.apply": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 3,
    owner: "phase19_promotion_runtime",
    primaryEventTypes: Object.freeze(["task_worktree.promotion.proposed", "task_effect.admission.terminal"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "promotion.verify_origin": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 2,
    owner: "phase19_promotion_runtime",
    primaryEventTypes: Object.freeze(["task_origin_verification.requested", "task_effect.admission.terminal"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "worktree.allocate": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 4,
    owner: "phase19_worktree_manager",
    primaryEventTypes: Object.freeze(["task_worktree.allocation.prepared", "task_effect.admission.terminal"]),
    reconciler: "exact_owner_commit_predicate",
  }),
  "worktree.cleanup": Object.freeze({
    bindingLocation: "event.data.origin.application_commit",
    minimumUnderlyingRefs: 1,
    owner: "phase19_worktree_manager",
    primaryEventTypes: Object.freeze(["task_worktree.cleanup.requested", "task_effect.admission.terminal"]),
    reconciler: "exact_owner_commit_predicate",
  }),
});

function sessionContract() {
  return Object.freeze({
    acceptedExpectedVersionKinds: Object.freeze(["session_ledger_head"] as const),
    resourceKinds: Object.freeze(["session"] as const),
    targetKind: "existing_resource" as const,
  });
}

function authenticatedMutation(context: ApplicationActionExecutionContextV1): AuthenticatedTaskMutationBindingV1 {
  const scope = context.resolvedTarget.resourceScope;
  return Object.freeze({
    actionIdentitySha256: sha256Canonical({
      application_commit: context.applicationCommit,
      resource_scope: scope,
      schema_version: 1,
    }),
    applicationCommit: context.applicationCommit,
    authenticationId: context.call.principal.authenticationId,
    requestId: context.requestId,
    surface: context.call.surface,
  });
}

function validateReferenceSet(input: Readonly<{
  readonly commit: GraphCompositeOwnerCommitV1;
  readonly context: ApplicationActionExecutionContextV1;
  readonly contract: GraphCompositeCommitContractV1;
}>): void {
  const scope = input.context.resolvedTarget.resourceScope;
  if (scope.kind !== "session") {
    throw new ApplicationControlError("control_target_invalid", "Graph composite target is not a session");
  }
  const preEffectTerminal = input.commit.result as Partial<GraphCompositePreEffectTerminalResultV1>;
  const minimumUnderlyingRefs = preEffectTerminal.kind === "pre_effect_terminal"
    ? 0
    : input.contract.minimumUnderlyingRefs;
  if (
    input.commit.applicationOperationId !== input.context.operationId ||
    !input.contract.primaryEventTypes.includes(input.commit.primaryEventType) ||
    input.commit.domainRecordRefs.length === 0 ||
    input.commit.domainRecordRefs.length > 128 ||
    input.commit.underlyingOperationRefs.length < minimumUnderlyingRefs ||
    input.commit.underlyingOperationRefs.length > 128 ||
    !input.commit.domainRecordRefs.some((reference) =>
      reference.recordId === input.commit.primaryDomainRecord.recordId &&
      reference.recordSha256 === input.commit.primaryDomainRecord.recordSha256
    )
  ) {
    throw new ApplicationControlError("control_operation_busy", "Graph owner returned an incomplete composite commit predicate");
  }
  for (const reference of [...input.commit.domainRecordRefs, ...input.commit.underlyingOperationRefs]) {
    if (reference.ownerKind !== "session" || reference.ledgerId !== `session:${scope.sessionId}`) {
      throw new ApplicationControlError("control_operation_busy", "Graph owner returned a cross-resource composite reference");
    }
  }
  const sequenced = [...input.commit.domainRecordRefs, ...input.commit.underlyingOperationRefs]
    .filter((reference): reference is DurableRecordReferenceV1 & { readonly sequence: number } => reference.sequence !== null);
  const end = sequenced.reduce((latest, reference) => reference.sequence > latest.sequence ? reference : latest);
  if (input.commit.resolvedHead.sessionId !== scope.sessionId || input.commit.resolvedHead.sequence !== end.sequence ||
      input.commit.resolvedHead.eventId !== end.recordId) {
    throw new ApplicationControlError("control_operation_busy", "Graph owner returned a tail-sensitive or mismatched resolved head");
  }
}

function translateOwnerError(error: unknown): ApplicationControlError {
  if (error instanceof ApplicationControlError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "Graph owner operation failed";
  if (/busy|incomplete|reconciliation|required|unknown|owner_active/u.test(code)) {
    return new ApplicationControlError("control_operation_busy", message, { cause: error });
  }
  if (/stale|conflict|not_approved|not_found|waiting_for_user|launch_stale|identity/u.test(code)) {
    return new ApplicationControlError("control_stale_projection", message, { cause: error });
  }
  if (/denied|cancelled/u.test(code)) {
    return new ApplicationControlError("control_authorization_denied", message, { cause: error });
  }
  if (/invalid|unsupported|unavailable|schema/u.test(code)) {
    return new ApplicationControlError("control_target_invalid", message, { cause: error });
  }
  return new ApplicationControlError("control_operation_busy", message, { cause: error });
}

async function executeComposite<TResult>(input: Readonly<{
  readonly context: ApplicationActionExecutionContextV1;
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly owner: GraphCompositeOwnerPortV1;
  readonly prepared: PreparedActionV1;
  readonly request: GraphCompositeOwnerRequestV1;
  readonly reconcileOnly?: boolean;
}>): Promise<ApplicationActionExecutionResultV1<TResult>> {
  const scope = input.context.resolvedTarget.resourceScope;
  const version = input.context.resolvedTarget.resourceVersion;
  if (scope.kind !== "session" || version.kind !== "session_ledger_head" || version.head.sequence === 0) {
    throw new ApplicationControlError("control_session_not_started", "Graph composite action requires a materialized session");
  }
  if (input.prepared.preparedActionSha256 !== input.context.applicationCommit.preparedActionSha256) {
    throw new ApplicationControlError("control_prepared_action_mismatch", "Graph composite prepared binding changed before dispatch");
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
        "Graph owner has no complete exact reconciliation predicate",
      );
    }
    validateReferenceSet({
      commit,
      context: input.context,
      contract: graphCompositeCommitContractsV1[input.request.actionKind],
    });
    return Object.freeze({
      domainRecordRefs: commit.domainRecordRefs,
      primaryDomainRecord: commit.primaryDomainRecord,
      resolvedResourceScope: scope,
      resolvedResourceVersion: Object.freeze({ head: commit.resolvedHead, kind: "session_ledger_head" as const }),
      result: commit.result as TResult,
      underlyingOperationRefs: commit.underlyingOperationRefs,
    });
  } catch (error) {
    throw translateOwnerError(error);
  }
}

export function createGraphCompositeActionDefinitions(input: Readonly<{
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly owner: GraphCompositeOwnerPortV1;
}>): readonly ApplicationActionDefinitionV1[] {
  const common = {
    requiredPrincipalKind: "human" as const,
    requiredScopes: Object.freeze(["session.mutate"]),
    resolveTarget: (target: Parameters<typeof resolveExistingSessionActionTarget>[1]) =>
      resolveExistingSessionActionTarget(input.dependencies, target),
    targetContracts: Object.freeze([sessionContract()]),
    zeroHeadPolicy: "deny" as const,
  };

  const run: ApplicationActionDefinitionV1<GraphRunCompositePayloadV1, GraphRunCompositeResultV1> = {
    ...common,
    actionKind: "graph.run",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Run the exact Graph revision ${String(payload.revision)} with ${payload.execution} ownership.`,
      warnings: Object.freeze(["Node effects remain fenced by their existing Phase 19/20 owners."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "graph.run", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "graph.run", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: graphRunCompositePayloadSchema, schemaId: "phase21a.graph.run.composite.payload.v1" }),
    resultCodec: graphRunCompositeResultCodec,
  };

  const resume: ApplicationActionDefinitionV1<GraphResumeCompositePayloadV1, GraphRunCompositeResultV1> = {
    ...common,
    actionKind: "graph.resume",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Resume the exact Graph revision ${String(payload.revision)} with ${payload.execution} ownership.`,
      warnings: Object.freeze([payload.takeover ? "Takeover must reconcile the exact earlier background owner before launch." : "Resume re-enqueues only one exact waiting Graph."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "graph.resume", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "graph.resume", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: graphResumeCompositePayloadSchema, schemaId: "phase21a.graph.resume.composite.payload.v1" }),
    resultCodec: graphRunCompositeResultCodec,
  };

  const retry: ApplicationActionDefinitionV1<GraphRetryCompositePayloadV1, TaskExecutionMutationResultV1> = {
    ...common,
    actionKind: "graph.retry",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Authorize attempt ${String(payload.attemptNumber)} of node ${payload.nodeId} for one fresh retry.`,
      warnings: Object.freeze(["Retry does not inherit effect approval; the fresh attempt must request every authority again."]),
    }),
    effectClass: "control_only",
    resolveTarget: async (target, payload) => {
      const resolved = await resolveExistingSessionActionTarget(input.dependencies, target);
      const scope = resolved.resourceScope;
      const version = resolved.resourceVersion;
      if (scope.kind !== "session" || version.kind !== "session_ledger_head") {
        throw new ApplicationControlError("control_target_invalid", "Graph retry target is not an exact session head");
      }
      try {
        await input.owner.preflight({
          expectedHead: version.head,
          repositoryId: scope.repositoryId,
          request: Object.freeze({ actionKind: "graph.retry", payload }),
          sessionId: scope.sessionId,
        });
      } catch (error) {
        throw translateOwnerError(error);
      }
      return resolved;
    },
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "graph.retry", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "graph.retry", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: graphRetryCompositePayloadSchema, schemaId: "phase21a.graph.retry.payload.v1" }),
    resultCodec: graphRetryCompositeResultCodec,
  };

  const allocate: ApplicationActionDefinitionV1<WorktreeAllocateCompositePayloadV1, WorktreeAllocateActionResultV1> = {
    ...common,
    actionKind: "worktree.allocate",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Allocate the managed worktree lineage rooted at ${payload.sourceNodeId}.`,
      warnings: Object.freeze([payload.allowDirty ? "The exact current dirty overlay still requires the existing allocation approval." : "Origin must remain clean through allocation approval."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "worktree.allocate", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "worktree.allocate", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: worktreeAllocateCompositePayloadSchema, schemaId: "phase21a.worktree.allocate.payload.v1" }),
    resultCodec: worktreeAllocateCompositeResultCodec,
  };

  const promote: ApplicationActionDefinitionV1<PromotionApplyCompositePayloadV1, PromotionApplyActionResultV1> = {
    ...common,
    actionKind: "promotion.apply",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Build, approve, and apply the exact promotion for node ${payload.nodeId}.`,
      warnings: Object.freeze(["Origin bytes change only through the existing atomic promotion owner and fresh preimage approval."]),
    }),
    effectClass: "external_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "promotion.apply", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "promotion.apply", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: promotionApplyCompositePayloadSchema, schemaId: "phase21a.promotion.apply.payload.v1" }),
    resultCodec: promotionApplyCompositeResultCodec,
  };

  const verify: ApplicationActionDefinitionV1<PromotionVerifyOriginCompositePayloadV1, PromotionVerifyOriginActionResultV1> = {
    ...common,
    actionKind: "promotion.verify_origin",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `Verify origin after promotion operation ${payload.promotionOperationId}.`,
      warnings: Object.freeze(["The existing command permission and approval boundaries remain authoritative."]),
    }),
    effectClass: "runtime_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "promotion.verify_origin", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "promotion.verify_origin", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: promotionVerifyOriginCompositePayloadSchema, schemaId: "phase21a.promotion.verify-origin.payload.v1" }),
    resultCodec: promotionVerifyOriginCompositeResultCodec,
  };

  const cleanup: ApplicationActionDefinitionV1<WorktreeCleanupCompositePayloadV1, WorktreeCleanupActionResultV1> = {
    ...common,
    actionKind: "worktree.cleanup",
    confirmation: "show_before_commit",
    display: (_resolved, payload) => Object.freeze({
      summary: `${payload.archiveAndRemove ? "Archive and remove" : "Remove"} the exact managed worktree for node ${payload.nodeId}.`,
      warnings: Object.freeze(["Dirty bytes are retained unless the existing owner creates and approves a recoverable archive."]),
    }),
    effectClass: "external_effect",
    execute: (context, payload, prepared) => executeComposite({
      context,
      dependencies: input.dependencies,
      owner: input.owner,
      prepared,
      request: Object.freeze({ actionKind: "worktree.cleanup", payload }),
    }),
    ...(input.owner.reconcile === undefined ? {} : {
      reconcile: (context, payload, prepared) => executeComposite({
        context,
        dependencies: input.dependencies,
        owner: input.owner,
        prepared,
        reconcileOnly: true,
        request: Object.freeze({ actionKind: "worktree.cleanup", payload }),
      }),
    }),
    payloadCodec: createStrictCodec({ maximumBytes: 4 * 1024, schema: worktreeCleanupCompositePayloadSchema, schemaId: "phase21a.worktree.cleanup.payload.v1" }),
    resultCodec: worktreeCleanupCompositeResultCodec,
  };

  return Object.freeze([run, resume, retry, allocate, promote, verify, cleanup]);
}
