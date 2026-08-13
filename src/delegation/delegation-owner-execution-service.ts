import { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type {
  AuthenticatedTaskMutationBindingV1,
  TaskMutationContext,
  TaskMutationWriterFactory,
} from "../coordination/task-control-plane.js";
import { taskUserOrigin } from "../coordination/task-control-plane.js";
import { DelegationControlPlane } from "./delegation-control-plane.js";
import { DelegationError } from "./delegation-errors.js";
import { DelegationPreparationRuntime } from "./delegation-preparation-runtime.js";
import {
  computeDelegationAuthority,
  delegationAuthorityCeiling,
} from "./delegable-authority.js";
import { buildChildToolProfile } from "./context/child-tool-profile.js";
import { DELEGATED_BUILTIN_TOOL_IDS, delegatedBuiltinToolCatalog } from "./context/delegated-tool-catalog.js";
import { buildChildEnvironmentPolicy } from "./context/child-environment-policy.js";
import type { ContextFactReaderV1 } from "./context/context-capsule-builder.js";
import { contextCapsuleSchema } from "./context/context-capsule-schema.js";
import { preparedChildEnvelopeSchema } from "./context/child-envelope-schema.js";
import { DelegationBudgetLedger } from "./delegation-budget-ledger.js";
import {
  delegationRemainingBudget,
  preEffectInfrastructureUsage,
} from "./delegation-retry.js";
import {
  BoundedDelegationScheduler,
  type DelegationAdmissionV1,
} from "./bounded-delegation-scheduler.js";
import { readVerifiedChildReceipt } from "./receipts/child-receipt-verifier.js";
import { SessionCatalog, SessionCatalogError } from "../sessions/session-catalog.js";
import { SessionLockError } from "../sessions/session-lock.js";
import {
  reconstructMultiRunSession,
  SessionProjectionError,
} from "../sessions/reconstruct-multi-run-session.js";
import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import { parseStrictJson } from "../system/strict-json.js";
import { NodeGitWorktreePort } from "../worktrees/git-worktree-port.js";
import { RepositorySourceSnapshotter } from "../repository-intelligence/source-snapshotter.js";
import { captureWorkspaceSnapshot } from "../worktrees/workspace-baseline.js";
import {
  DelegationChildLaunchFailure,
  type DelegationChildLauncher,
  type DelegationWorkspaceFinalizationV1,
} from "./runtime/child-launcher.js";
import {
  isPhase20CanonicalFakeSelection,
  PHASE20_CANONICAL_CODING_FAKE_QUALIFICATION_SHA256,
  PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
} from "./runtime/canonical-fake-child-backend.js";
import { createCapabilitySnapshot } from "../capabilities/capability-snapshot.js";
import type { CapabilityPlatformLike } from "../capabilities/capability-platform.js";
import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import type {
  DelegationCompositeResultV1,
  DelegationGroupTerminalItemV1,
  DelegationGroupTerminalResultV1,
} from "../control-plane/use-cases/delegation-composite-actions.js";
import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { ModelQualificationGate } from "../model/model-qualification-gate.js";
import type { ManagedWorktreeManager } from "../worktrees/managed-worktree-manager.js";
import type { DelegationOperationInspectionV1 } from "./delegation-reconciler.js";
import type { DelegationPreEffectRecoveryResultV1 } from "./delegation-pre-effect-recovery.js";
import type { DelegationGroupLeaseRecordV1 } from "./delegation-group-lease-store.js";
import type { DelegationGroupTakeoverResultV1 } from "./delegation-group-takeover.js";

export interface DelegationOwnerActionOptionsV1 {
  readonly delegationId: string;
  readonly expectedSessionSeq?: number;
  readonly inputSurface?: "cli" | "tui";
  readonly sessionId: string;
}

export interface DelegationOwnerExecutionV1 {
  readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
  /** Host-authorized only after a durable typed delegation.cancel request. */
  readonly cancellationSignal?: AbortSignal;
}

export interface DelegationOwnerInteractionPortV1 {
  createApprovalPrompt(): ApprovalPrompt;
}

export type DelegationOwnerExitCodeV1 = 0 | 1 | 2 | 3 | 7 | 8 | 130;

export interface DelegationOwnerDiagnosticV1 {
  readonly code: string;
  readonly message: string;
}

export interface DelegationOwnerExecutionOutcomeV1 {
  readonly diagnostic: DelegationOwnerDiagnosticV1 | null;
  readonly exitCode: DelegationOwnerExitCodeV1;
  readonly result: DelegationCompositeResultV1 | null;
}

export interface DelegationOwnerRuntimePortV1 {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly modelQualificationGate?: ModelQualificationGate;
  readonly delegationWriterFactory?: TaskMutationWriterFactory;
  readonly observeSessionWriter?: (writer: SessionWriter) => void;
  readonly inspectDelegationOperations?: (sessionId: string) => Promise<readonly DelegationOperationInspectionV1[]>;
  readonly reconcileDelegationPreEffectOperation?: (input: {
    readonly inputSurface?: "cli" | "tui";
    readonly operationId: string;
    readonly sessionId: string;
  }) => Promise<DelegationPreEffectRecoveryResultV1>;
  readonly reconcileDelegationGroupTakeover?: (input: {
    readonly delegationId: string;
    readonly inputSurface?: "cli" | "tui";
    readonly sessionId: string;
  }) => Promise<DelegationGroupTakeoverResultV1>;
  readonly createCapabilityPlatform?: (workspace: string) => CapabilityPlatformLike;
  readonly createManagedWorktreeManager?: (options: {
    readonly authenticatedMutation?: AuthenticatedTaskMutationBindingV1;
    readonly inputSurface?: "cli" | "tui";
    readonly sessionId: string;
  }) => Promise<ManagedWorktreeManager>;
  readonly createDelegationChildLauncher?: (options: {
    readonly authenticatedMutation?: AuthenticatedTaskMutationBindingV1;
    readonly approvalPrompt?: ApprovalPrompt;
    readonly inputSurface?: "cli" | "tui";
    readonly observeSessionWriter?: (writer: SessionWriter) => void;
    readonly sessionId: string;
  }) => DelegationChildLauncher;
  readonly delegationCoordinatorIdentity?: () => {
    readonly backgroundOperationId?: string;
    readonly kind?: "foreground" | "phase19_background_worker";
    readonly pid: number;
    readonly processStartIdentity: string;
  };
  readonly acquireDelegationGroupLease?: (input: {
    readonly graphBindingSha256: string | null;
    readonly groupId: string;
    readonly nonceSha256: string;
    readonly ownerBackgroundOperationId: string | null;
    readonly ownerKind: "foreground" | "phase19_background_worker";
    readonly ownerPid: number;
    readonly ownerProcessStartIdentity: string;
    readonly parentActorId: string;
    readonly parentRunId: string;
    readonly repositoryId: string;
    readonly sessionId: string;
  }) => Promise<DelegationGroupLeaseRecordV1>;
  readonly releaseDelegationGroupLease?: (input: {
    readonly effectsReconciled: boolean;
    readonly expectedLeaseSha256?: string;
    readonly groupId: string;
    readonly reason: "terminal" | "cancelled" | "reconciled";
    readonly sessionId: string;
  }) => Promise<DelegationGroupLeaseRecordV1>;
  /** Host-only observation used to rebuild an exact completed takeover after response loss. */
  readonly inspectDelegationGroupLease?: (input: {
    readonly groupId: string;
    readonly repositoryId: string;
    readonly sessionId: string;
  }) => Promise<DelegationGroupLeaseRecordV1 | null>;
  onCancel(listener: () => void): () => void;
  randomUUID(): string;
  timestamp(): string;
  /** Host timer used only for bounded lock/writer handoff retries. */
  waitForRetry(delayMs: number): Promise<void>;
}

/** @internal Exact proof helper shared by every pre-admission cancellation fence. */
export async function releaseCancelledDelegationGroupLease(
  runtime: Pick<DelegationOwnerRuntimePortV1, "releaseDelegationGroupLease">,
  input: {
    readonly expectedLeaseSha256: string;
    readonly groupId: string;
    readonly sessionId: string;
  },
): Promise<void> {
  const released = await (runtime.releaseDelegationGroupLease?.({
    effectsReconciled: true,
    expectedLeaseSha256: input.expectedLeaseSha256,
    groupId: input.groupId,
    reason: "cancelled",
    sessionId: input.sessionId,
  }) ?? Promise.reject(new DelegationError(
    "delegation_lease_busy",
    "runtime cannot release a cancelled delegation group lease",
  )));
  if (
    released.groupId !== input.groupId ||
    released.sessionId !== input.sessionId ||
    released.state !== "released" ||
    released.releaseReason !== "cancelled"
  ) {
    throw new DelegationError(
      "delegation_lease_busy",
      "cancelled delegation group lease has no exact release proof",
    );
  }
}

const TOOL_IDS = DELEGATED_BUILTIN_TOOL_IDS;
const TOOL_CATALOG = delegatedBuiltinToolCatalog();

type DelegationSession = Awaited<ReturnType<SessionCatalog["read"]>>;
type DelegationRevision = DelegationSession["delegations"]["revisions"][number];

function delegationWriterFactory(runtime: DelegationOwnerRuntimePortV1): TaskMutationWriterFactory {
  const base = runtime.delegationWriterFactory ?? (async (context: TaskMutationContext) =>
    V2SessionWriter.openExisting(context.workspace, context.sessionId, {
      createEventId: context.randomUuid,
      timestamp: context.now,
    }));
  return async (context) => {
    const writer = await base(context);
    try {
      runtime.observeSessionWriter?.(writer);
      return writer;
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  };
}

async function queuedDelegationSnapshot(
  runtime: DelegationOwnerRuntimePortV1,
  options: DelegationOwnerActionOptionsV1,
  ownerExecution?: DelegationOwnerExecutionV1,
) {
  const writer = await delegationWriterFactory(runtime)(
    delegationMutationContext(runtime, options, ownerExecution),
  );
  try {
    return reconstructMultiRunSession(writer.events);
  } finally {
    await writer.close();
  }
}

function delegationContinuationOptions(
  options: DelegationOwnerActionOptionsV1,
): DelegationOwnerActionOptionsV1 {
  return {
    delegationId: options.delegationId,
    ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
    sessionId: options.sessionId,
  };
}
function document(revision: Awaited<ReturnType<SessionCatalog["read"]>>["delegations"]["revisions"][number]) {
  return {
    artifact: revision.artifact,
    attempts: revision.attempts,
    authorityPreviewSha256: revision.authorityPreviewSha256,
    binding: revision.binding,
    blockerCodes: revision.blockerCodes,
    content: revision.content,
    createdEventId: revision.createdEventId,
    decisionEventId: revision.decisionEventId,
    delegationId: revision.delegationId,
    delegationRevision: revision.delegationRevision,
    delegationSha256: revision.delegationSha256,
    envelope: revision.envelope,
    envelopePreparationCount: revision.envelopePreparationCount,
    parentActorId: revision.parentActorId,
    parentRunId: revision.parentRunId,
    receipt: revision.receipt,
    status: revision.status,
    terminalEventId: revision.terminalEventId,
  };
}

function ownerResult(
  result: DelegationCompositeResultV1,
  exitCode: DelegationOwnerExitCodeV1 = 0,
  diagnostic: DelegationOwnerDiagnosticV1 | null = null,
): DelegationOwnerExecutionOutcomeV1 {
  return Object.freeze({
    diagnostic,
    exitCode,
    result: Object.freeze(result),
  });
}

function failure(error: unknown): DelegationOwnerExecutionOutcomeV1 {
  if (error instanceof DelegationError) {
    return Object.freeze({
      diagnostic: Object.freeze({ code: error.code, message: error.message }),
      exitCode: error.exitCode,
      result: null,
    });
  }
  if (error instanceof SessionCatalogError || error instanceof SessionLockError) {
    return Object.freeze({
      diagnostic: Object.freeze({ code: error.code, message: error.message }),
      exitCode: 8,
      result: null,
    });
  }
  if (error instanceof SessionProjectionError) {
    return Object.freeze({
      diagnostic: Object.freeze({ code: "delegation_session_corrupt", message: error.message }),
      exitCode: 1,
      result: null,
    });
  }
  return Object.freeze({
    diagnostic: Object.freeze({ code: "delegation_internal_error", message: "" }),
    exitCode: 1,
    result: null,
  });
}

function internalDiagnosticIdentity(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as Readonly<Record<string, unknown>>;
    const code = typeof record.code === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(record.code)
      ? record.code
      : null;
    const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(record.name)
      ? record.name
      : null;
    parts.push(code ?? name ?? "UnknownError");
    current = record.cause;
  }
  return parts.join(":").slice(0, 256) || "UnknownError";
}

async function session(runtime: DelegationOwnerRuntimePortV1, sessionId: string) {
  assertCanonicalSessionId(sessionId);
  return new SessionCatalog(runtime.cwd).read(sessionId);
}

function exactDelegationRevision(
  current: DelegationSession,
  expected: DelegationRevision,
): DelegationRevision {
  const revision = current.delegations.revisions.find((candidate) =>
    candidate.delegationId === expected.delegationId &&
    candidate.delegationRevision === expected.delegationRevision &&
    candidate.delegationSha256 === expected.delegationSha256);
  if (revision === undefined) {
    throw new DelegationError(
      "delegation_binding_stale",
      "delegation revision changed while the owner was preparing admission",
    );
  }
  return revision;
}

function assertNoDurablePreAdmissionCancellation(
  current: DelegationSession,
  expected: DelegationRevision,
): void {
  const revision = exactDelegationRevision(current, expected);
  const graphCancellation = expected.binding.graphId === null
    ? undefined
    : current.events.find((event) => {
        if (event.scope !== "session" || event.type !== "task_graph.cancel.requested") return false;
        const value = event.data as Readonly<Record<string, unknown>>;
        return value.graph_id === expected.binding.graphId &&
          value.graph_revision === expected.binding.graphRevision &&
          value.graph_sha256 === expected.binding.graphSha256;
      });
  if (graphCancellation !== undefined) {
    throw new DelegationError(
      "delegation_cancelled",
      "durable Graph cancellation closed delegation owner admission",
    );
  }
  if (revision.status === "cancelling" || revision.status === "cancelled") {
    throw new DelegationError(
      "delegation_cancelled",
      "durable delegation cancellation won before owner effect admission",
    );
  }
  if (revision.status !== "queued") {
    throw new DelegationError(
      "delegation_revision_conflict",
      "delegation is no longer queued at the owner effect admission fence",
    );
  }
}

function delegationMutationContext(
  runtime: DelegationOwnerRuntimePortV1,
  options: DelegationOwnerActionOptionsV1,
  ownerExecution?: DelegationOwnerExecutionV1,
) {
  return Object.freeze({
    ...(options.expectedSessionSeq === undefined ? {} : { expectedSessionSeq: options.expectedSessionSeq }),
    inputSurface: options.inputSurface ?? "cli",
    now: () => runtime.timestamp(),
    randomUuid: () => runtime.randomUUID(),
    sessionId: options.sessionId,
    workspace: runtime.cwd,
    ...(ownerExecution === undefined ? {} : { authenticatedApplication: ownerExecution.authenticatedMutation }),
  });
}

export async function executeDelegationOwnerResume(
  options: DelegationOwnerActionOptionsV1,
  runtime: DelegationOwnerRuntimePortV1,
  interaction: DelegationOwnerInteractionPortV1,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<DelegationOwnerExecutionOutcomeV1> {
  try {
    let current = await session(runtime, options.sessionId);
    let revision = [...current.delegations.revisions].reverse().find((candidate) =>
      candidate.delegationId === options.delegationId);
    if (revision === undefined) {
      throw new DelegationError("delegation_revision_conflict", "delegation was not found");
    }
    const inspections = await runtime.inspectDelegationOperations?.(options.sessionId) ?? [];
    const latestOperationId = revision.attempts.at(-1)?.operationId;
    let observation = latestOperationId === null || latestOperationId === undefined
      ? undefined
      : inspections.find((candidate) => candidate.operationId === latestOperationId);
    if (
      observation !== undefined && (
        observation.state === "pre_effect_terminal" ||
        observation.reconcile.kind === "retry_pre_effect_allowed" ||
        observation.reconcile.kind === "pre_effect_failure_terminal" ||
        observation.reconcile.kind === "pre_effect_cancelled"
      )
    ) {
      const recovery = await (runtime.reconcileDelegationPreEffectOperation?.({
        ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
        operationId: observation.operationId,
        sessionId: options.sessionId,
      }) ?? Promise.reject(new DelegationError(
        "delegation_effect_reconciliation_required",
        "runtime has no durable pre-effect operation reconciler",
      )));
      current = await session(runtime, options.sessionId);
      revision = [...current.delegations.revisions].reverse().find((candidate) =>
        candidate.delegationId === options.delegationId);
      if (revision === undefined) {
        throw new DelegationError("delegation_revision_conflict", "reconciled delegation disappeared");
      }
      if (recovery.retryEligible) {
        const retryOptions = delegationContinuationOptions(options);
        if (revision.envelopePreparationCount === 1) {
          const prepared = await executeDelegationOwnerPrepare(retryOptions, runtime, interaction, ownerExecution);
          if (prepared.exitCode !== 0) return prepared;
        } else if (revision.envelopePreparationCount !== 2) {
          throw new DelegationError(
            "delegation_child_protocol_invalid",
            "automatic retry has an invalid envelope preparation count",
          );
        }
        return executeDelegationOwnerStart(retryOptions, runtime, interaction, ownerExecution);
      }
      const refreshed = await runtime.inspectDelegationOperations?.(options.sessionId) ?? [];
      observation = refreshed.find((candidate) => candidate.operationId === recovery.operation.operationId);
      return ownerResult({
        kind: "pre_effect_recovery",
        operationId: recovery.operation.operationId,
        reconciled: recovery.changed,
        retryEligible: false,
        observation: observation ?? null,
      }, 8);
    }
    const latestActorId = revision.attempts.at(-1)?.actorId;
    const hasOrphanedAdmission = latestActorId !== null && latestActorId !== undefined && (
      current.delegations.activeActorSlots.some((claim) => claim.actorId === latestActorId) ||
      current.delegations.activeConflictClaims.some((claim) => claim.actorId === latestActorId)
    );
    if (
      hasOrphanedAdmission && observation?.state === "reconciled" &&
      ["accepted", "failed", "cancelled"].includes(revision.status)
    ) {
      const takeover = await (runtime.reconcileDelegationGroupTakeover?.({
        delegationId: revision.delegationId,
        ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
        sessionId: options.sessionId,
      }) ?? Promise.reject(new DelegationError(
        "delegation_effect_reconciliation_required",
        "runtime has no durable delegation group takeover reconciler",
      )));
      return ownerResult(
        Object.freeze({ kind: "group_takeover", takeover }),
        revision.status === "accepted" ? 0 : 8,
      );
    }
    if (["active", "waiting_approval", "cancelling", "reconciling", "blocked"].includes(revision.status)) {
      if (observation === undefined) {
        throw new DelegationError("delegation_effect_reconciliation_required", "delegation has no exact recoverable operation journal");
      }
      return ownerResult(
        Object.freeze({ kind: "operation_recovery", observation }),
        observation.reconcile.kind === "terminal_backfilled" || observation.reconcile.kind === "cancelled_clean" ? 0 : 8,
      );
    }
    if (revision.status === "queued") {
      const retryOptions = delegationContinuationOptions(options);
      if (revision.envelope === null) {
        const prepared = await executeDelegationOwnerPrepare(retryOptions, runtime, interaction, ownerExecution);
        if (prepared.exitCode !== 0) return prepared;
      }
      return executeDelegationOwnerStart(retryOptions, runtime, interaction, ownerExecution);
    }
    const delegation = (await new DelegationControlPlane(delegationWriterFactory(runtime)).enqueue({
      context: delegationMutationContext(runtime, options, ownerExecution),
      delegationId: options.delegationId,
    })).delegation;
    return ownerResult(
      Object.freeze({ delegation: document(delegation), kind: "queued" }),
    );
  } catch (error) { return failure(error); }
}

async function storeCapabilitySnapshot(runtime: DelegationOwnerRuntimePortV1, sessionId: string, runId: string, requested: readonly string[]) {
  const platform = runtime.createCapabilityPlatform?.(runtime.cwd);
  if (platform === undefined) {
    if (requested.length > 0) throw new DelegationError("delegation_authority_expansion", "runtime has no capability platform");
    const empty = await createCapabilitySnapshot({
      catalog: {
        diagnostics: [],
        enablementRevision: 0,
        plugins: [],
        sourceRevisions: { builtin: 0, user_install: 0, workspace: 0 },
      },
      platform: runtime.platform,
      timestamp: runtime.timestamp(),
      workspace: runtime.cwd,
    });
    const bytes = Buffer.from(canonicalJson(empty), "utf8");
    const sha256 = sha256Canonical(empty);
    const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
    const captured = await store.storeSanitizedText({ chunks: [bytes], runId });
    if (captured.artifact === null || captured.captureStatus !== "complete" || captured.artifact.sha256 !== sha256) {
      throw new DelegationError("delegation_artifact_invalid", "empty capability snapshot could not be stored");
    }
    return { available: [] as string[], ref: captured.artifact.objectRef, sha256 };
  }
  const snapshot = await platform.createSnapshot(runtime.timestamp());
  const available = snapshot.plugins.flatMap((plugin) => plugin.components.map((component) => component.identity.qualifiedId));
  if (requested.some((id) => !available.includes(id))) {
    throw new DelegationError("delegation_authority_expansion", "requested capability is not enabled in the current frozen snapshot");
  }
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
  const digest = sha256Canonical(snapshot);
  const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
  const captured = await store.storeSanitizedText({ chunks: [bytes], maximumBytes: 512 * 1024, runId });
  if (captured.artifact === null || captured.captureStatus !== "complete" || captured.artifact.sha256 !== digest) {
    throw new DelegationError("delegation_artifact_invalid", "capability snapshot could not be stored exactly");
  }
  return { available, ref: captured.artifact.objectRef, sha256: digest };
}

function factReader(runtime: DelegationOwnerRuntimePortV1, sessionId: string, sourceSnapshotSha256: string): ContextFactReaderV1 {
  return {
    read: async (request) => {
      try {
        const state = await new SessionCatalog(runtime.cwd).read(sessionId);
        if (request.kind === "receipt") {
          const revision = state.delegations.revisions.find((candidate) =>
            candidate.status === "accepted" && candidate.receipt?.sha256 === request.sha256);
          if (revision === undefined) return { kind: "omitted", reason: "unverified" } as const;
          const receipt = await readVerifiedChildReceipt({ workspace: runtime.cwd, sessionId, revision });
          return {
            kind: "available",
            fact: {
              factId: sha256Canonical({ kind: request.kind, ref: request.ref, sha256: request.sha256 }),
              kind: "accepted_child_receipt",
              trustClass: "host_verified",
              artifactRef: revision.receipt!.artifact.objectRef,
              artifactSha256: request.sha256,
              sourceSnapshotSha256,
              boundedProjection: {
                kind: "accepted_child_receipt",
                receiptSha256: receipt.receiptSha256,
                status: receipt.status,
                verifiedClaimIds: receipt.claims.filter((claim) => claim.status === "verified").map((claim) => claim.claimId),
              },
            },
          } as const;
        }
        const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
        const stored = await store.readVerified(`sha256:${request.sha256}`);
        const text = stored.bytes.subarray(0, 32 * 1024).toString("utf8");
        const common = {
          factId: sha256Canonical({ kind: request.kind, ref: request.ref, sha256: request.sha256 }),
          trustClass: "host_verified" as const,
          artifactRef: stored.objectRef,
          artifactSha256: request.sha256,
          sourceSnapshotSha256,
        };
        if (request.kind === "repository_snapshot") return {
          kind: "available",
          fact: { ...common, kind: "repository_observation", boundedProjection: { kind: "repository_observation", observedPaths: [], repositoryId: sha256Canonical({ sourceSnapshotSha256 }), summary: text } },
        } as const;
        if (request.kind === "rule_manifest") return {
          kind: "available",
          fact: { ...common, kind: "rule_summary", boundedProjection: { kind: "rule_summary", ruleIds: [], scopes: ["."], summary: text } },
        } as const;
        return {
          kind: "available",
          fact: { ...common, kind: "artifact_excerpt", boundedProjection: { kind: "artifact_excerpt", mediaType: "text/plain", text, truncated: stored.bytes.byteLength > 32 * 1024 } },
        } as const;
      } catch {
        return { kind: "omitted", reason: "artifact_missing" } as const;
      }
    },
  };
}

async function managedExecution(
  runtime: DelegationOwnerRuntimePortV1,
  interaction: DelegationOwnerInteractionPortV1,
  sessionId: string,
  delegation: Awaited<ReturnType<SessionCatalog["read"]>>["delegations"]["revisions"][number],
  childAttemptId: string,
): Promise<{
  readonly executionWorkspacePath: string;
  readonly finalizeWorkspace: () => Promise<DelegationWorkspaceFinalizationV1>;
}> {
  const binding = delegation.binding;
  const workspaceId = delegation.content.workspace.managedWorkspaceId;
  if (
    delegation.content.workspace.mode !== "managed_worktree" || workspaceId === null ||
    binding.graphId === null || binding.graphRevision === null || binding.graphSha256 === null || binding.nodeId === null
  ) {
    throw new DelegationError("delegation_workspace_conflict", "coding delegation requires an exact Phase 19 Graph worktree binding");
  }
  const state = await new SessionCatalog(runtime.cwd).read(sessionId);
  const projected = state.worktrees.workspaces.find((workspace) =>
    workspace.identity.workspaceId === workspaceId &&
    workspace.identity.graphId === binding.graphId &&
    workspace.nodeIds.includes(binding.nodeId!));
  if (projected === undefined || ["removed", "archived", "reconciliation_required"].includes(projected.status)) {
    throw new DelegationError("delegation_workspace_conflict", "delegation managed workspace is missing, stale, or unavailable");
  }
  const manager = await runtime.createManagedWorktreeManager?.({ sessionId });
  if (manager === undefined) throw new DelegationError("delegation_workspace_conflict", "runtime cannot locate the approved managed worktree");
  const handle = await manager.locate({
    graphId: binding.graphId,
    graphRevision: binding.graphRevision,
    graphSha256: binding.graphSha256,
    nodeId: binding.nodeId,
  });
  if (handle.identity.workspaceId !== workspaceId || handle.baselineManifestSha256 !== projected.baseline.manifestSha256) {
    throw new DelegationError("delegation_binding_stale", "located worktree does not match the approved delegation workspace identity");
  }
  return {
    executionWorkspacePath: handle.workspacePath,
    finalizeWorkspace: async () => {
      const snapshot = await captureWorkspaceSnapshot({
        baselineManifestSha256: projected.baseline.manifestSha256,
        workspaceId,
        workspaceRoot: handle.workspacePath,
      });
      const before = new Map(projected.baseline.entries.map((entry) => [entry.path, entry]));
      const after = new Map(snapshot.manifest.entries.map((entry) => [entry.path, entry]));
      const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
      const changed = paths.filter((path) => before.get(path)?.sha256 !== after.get(path)?.sha256);
      const declared = delegation.content.workspace.declaredPathPrefixes;
      if (changed.some((path) => !declared.some((prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)))) {
        throw new DelegationError("delegation_workspace_conflict", "delegated child changed a path outside its approved workspace scope");
      }
      if (changed.length === 0) {
        return {
          candidateClaims: [],
          changeBundleRef: null,
          changeBundleSha256: null,
          resultSnapshotSha256: snapshot.manifest.snapshotSha256,
        };
      }
      const content = {
        schemaVersion: 1 as const,
        kind: "delegation_workspace_change_bundle_v1" as const,
        delegationId: delegation.delegationId,
        childAttemptId,
        workspaceId,
        baselineManifestSha256: projected.baseline.manifestSha256,
        resultSnapshotSha256: snapshot.manifest.snapshotSha256,
        entries: changed.map((path) => ({
          bytes: after.get(path)?.bytes ?? 0,
          mode: after.get(path)?.mode ?? before.get(path)?.mode ?? "100644",
          path,
          preSha256: before.get(path)?.sha256 ?? null,
          postSha256: after.get(path)?.sha256 ?? null,
        })),
      };
      const bytes = Buffer.from(canonicalJson(content), "utf8");
      const digest = sha256Canonical(content);
      const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
      const captured = await store.storeSanitizedText({ chunks: [bytes], maximumBytes: 512 * 1024, runId: delegation.delegationId });
      if (captured.captureStatus !== "complete" || captured.artifact === null || captured.artifact.sha256 !== digest) {
        throw new DelegationError("delegation_artifact_invalid", "managed workspace change bundle could not be stored exactly");
      }
      await store.readVerified(captured.artifact.artifactId);
      const evidence = {
        artifactRef: captured.artifact.objectRef,
        kind: "change_bundle" as const,
        sha256: digest,
        sourceSnapshotSha256: delegation.content.workspace.sourceSnapshotSha256,
      };
      return {
        candidateClaims: delegation.content.expectedReceipt.requiredClaims
          .filter((claim) => claim.kind === "change_bundle")
          .map((claim) => ({ claimId: claim.claimId, kind: claim.kind, narrative: claim.description, evidence: [evidence] })),
        changeBundleRef: captured.artifact.objectRef,
        changeBundleSha256: digest,
        resultSnapshotSha256: snapshot.manifest.snapshotSha256,
      };
    },
  };
}

export async function executeDelegationOwnerPrepare(
  options: DelegationOwnerActionOptionsV1,
  runtime: DelegationOwnerRuntimePortV1,
  interaction: DelegationOwnerInteractionPortV1,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<DelegationOwnerExecutionOutcomeV1> {
  void interaction;
  try {
    const state = await session(runtime, options.sessionId);
    const delegation = [...state.delegations.revisions].reverse().find((candidate) =>
      candidate.delegationId === options.delegationId && ["approved", "queued"].includes(candidate.status));
    if (delegation === undefined) throw new DelegationError("delegation_revision_conflict", "prepare requires an approved delegation");
    if (delegation.envelopePreparationCount >= 2) {
      throw new DelegationError(
        "delegation_revision_conflict",
        "automatic retry envelope is already prepared",
      );
    }
    const previousEnvelope = delegation.envelope === null
      ? null
      : preparedChildEnvelopeSchema.parse(parseStrictJson((await (
          await ArtifactStore.create({ sessionId: options.sessionId, workspace: runtime.cwd })
        ).readVerified(delegation.envelope.envelope.artifactId)).bytes.toString("utf8")));
    const canonicalRetryQualification = delegation.content.authorityRequest.taskProfile === "coding"
      ? PHASE20_CANONICAL_CODING_FAKE_QUALIFICATION_SHA256
      : PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256;
    const canonicalRetry = previousEnvelope?.model.executionBackend === "canonical_fake" &&
      previousEnvelope.model.qualificationSha256 === canonicalRetryQualification &&
      isPhase20CanonicalFakeSelection({
        modelId: previousEnvelope.model.modelId,
        policyProfileId: previousEnvelope.model.policyProfileId,
        providerId: previousEnvelope.model.providerId,
        taskProfile: delegation.content.authorityRequest.taskProfile,
      });
    const parent = state.runs.find((run) => run.runId === delegation.parentRunId);
    const policy = parent?.started.data.runtime_policy;
    if (parent === undefined || (!canonicalRetry && (policy === undefined || parent.started.data.model_qualification_sha256 === undefined))) {
      throw new DelegationError("delegation_model_unqualified", "parent run has no exact policy/model qualification evidence");
    }
    const source = await (await RepositorySourceSnapshotter.create(runtime.cwd, { environment: runtime.env })).snapshot();
    if (source.snapshot.sourceStateSha256 !== delegation.content.workspace.sourceSnapshotSha256) {
      throw new DelegationError("delegation_binding_stale", "repository source snapshot changed before prepare");
    }
    if (delegation.content.workspace.mode === "managed_worktree") {
      const workspace = state.worktrees.workspaces.find((candidate) =>
        candidate.identity.workspaceId === delegation.content.workspace.managedWorkspaceId &&
        candidate.identity.graphId === delegation.binding.graphId &&
        delegation.binding.nodeId !== null && candidate.nodeIds.includes(delegation.binding.nodeId));
      if (
        delegation.binding.graphId === null || delegation.binding.graphRevision === null ||
        delegation.binding.graphSha256 === null || delegation.binding.nodeId === null ||
        workspace === undefined || ["archived", "removed", "reconciliation_required"].includes(workspace.status)
      ) {
        throw new DelegationError("delegation_workspace_conflict", "managed coding delegation has no exact active Phase 19 worktree binding");
      }
    }
    const repository = await new NodeGitWorktreePort({ environment: runtime.env }).observe(runtime.cwd);
    const capabilities = await storeCapabilitySnapshot(runtime, options.sessionId, delegation.delegationId, delegation.content.authorityRequest.capabilityIds);
    const model = canonicalRetry
      ? {
          executionBackend: "canonical_fake" as const,
          policyProfileId: previousEnvelope.model.policyProfileId,
          providerId: previousEnvelope.model.providerId,
          modelId: previousEnvelope.model.modelId,
          qualificationSha256: canonicalRetryQualification,
        }
      : delegation.content.model.strategy === "same_as_parent"
      ? {
          executionBackend: "provider" as const,
          policyProfileId: policy!.profile_id,
          providerId: parent.started.data.provider,
          modelId: parent.started.data.model,
          qualificationSha256: parent.started.data.model_qualification_sha256,
        }
      : {
          executionBackend: "provider" as const,
          policyProfileId: delegation.content.model.exactProfileId,
          providerId: delegation.content.model.exactProviderId,
          modelId: delegation.content.model.exactModelId,
          qualificationSha256: (await (runtime.modelQualificationGate?.requireQualified({
            mode: delegation.content.authorityRequest.taskProfile === "coding" ? "build" : "plan",
            model: delegation.content.model.exactModelId,
            policyHash: policy!.profile_sha256,
            policyProfileId: delegation.content.model.exactProfileId,
            provider: delegation.content.model.exactProviderId,
          }) ?? Promise.reject(new DelegationError("delegation_model_unqualified", "runtime has no exact model qualification gate")))).evidenceSha256,
        };
    const ceiling = delegationAuthorityCeiling({
      taskProfiles: [delegation.content.authorityRequest.taskProfile],
      toolIds: TOOL_IDS,
      capabilityIds: capabilities.available,
      modelProfileIds: [model.policyProfileId],
      workspaceModes: [delegation.content.workspace.mode],
      maximumBudget: delegation.content.budget,
      maximumContextBytes: delegation.content.contextRequest.maximumCapsuleBytes,
      maximumAttempts: delegation.content.retry.maxAttempts,
    });
    const authority = computeDelegationAuthority({
      request: delegation.content.authorityRequest,
      workspace: delegation.content.workspace,
      requestedBudget: delegation.content.budget,
      requestedContextBytes: delegation.content.contextRequest.maximumCapsuleBytes,
      requestedMaximumAttempts: delegation.content.retry.maxAttempts,
      requestedModelProfileId: model.policyProfileId,
      ceilings: [ceiling],
    });
    if (!authority.eligible) throw new DelegationError("delegation_authority_expansion", authority.denied.map((denial) => denial.id).join(", "));
    const parentTools = parent.started.data.tools ?? [];
    const toolProfile = buildChildToolProfile({
      taskProfile: delegation.content.authorityRequest.taskProfile,
      requestedToolIds: delegation.content.authorityRequest.toolIds,
      policyToolIds: TOOL_IDS,
      parentDelegableToolIds: parentTools,
      catalog: TOOL_CATALOG,
    });
    const remainingBudget = delegationRemainingBudget(delegation);
    const result = await new DelegationPreparationRuntime(delegationWriterFactory(runtime)).prepare({
      context: delegationMutationContext(runtime, options, ownerExecution),
      delegationId: delegation.delegationId,
      authority,
      toolProfile,
      factReader: factReader(runtime, options.sessionId, source.snapshot.sourceStateSha256),
      repository: {
        repositoryId: repository.identity.repositoryId,
        sourceSnapshotSha256: source.snapshot.sourceStateSha256,
        ruleManifestRef: null,
        ruleManifestSha256: null,
        indexGenerationId: null,
        indexSourceSnapshotSha256: null,
      },
      workspace: {
        logicalWorkspaceId: delegation.content.workspace.managedWorkspaceId ?? repository.identity.repositoryId,
        lineageId: delegation.binding.parentWorkspaceLineageId,
        mode: delegation.content.workspace.mode,
        baselineSha256: source.snapshot.sourceStateSha256,
      },
      runtimeMaximumContextBytes: delegation.content.contextRequest.maximumCapsuleBytes,
      capabilitySnapshot: { ref: capabilities.ref, sha256: capabilities.sha256 },
      model: {
        executionBackend: model.executionBackend,
        policyProfileId: model.policyProfileId,
        providerId: model.providerId,
        modelId: model.modelId,
        qualificationId: `qualification:${model.qualificationSha256}`,
        qualificationSha256: model.qualificationSha256,
        contextCapacity: null,
        networkEligibility: canonicalRetry
          ? previousEnvelope.model.networkEligibility
          : policy!.profile_mode === "local_free" ? "local_only" : "remote_explicit",
      },
      budget: {
        parentLedgerRevision: 0,
        graphLedgerRevision: delegation.binding.graphRevision,
        parentRemaining: remainingBudget,
        graphRemaining: delegation.binding.graphId === null ? null : remainingBudget,
      },
      environmentPolicy: buildChildEnvironmentPolicy({ requestedVariableNames: [] }),
      policySha256: canonicalRetry ? previousEnvelope.preparation.policySha256 : policy!.profile_sha256,
      systemAndResponseReserveBytes: 16 * 1024,
    });
    return ownerResult({
      kind: "prepared",
      childNotStarted: true,
      capsuleBytes: Buffer.byteLength(canonicalJson(result.capsule), "utf8"),
      capsuleSha256: result.capsule.capsuleSha256,
      envelopeSha256: result.envelope.envelopeSha256,
      toolCount: result.envelope.effectiveAuthority.toolIds.length,
      capabilityCount: delegation.content.authorityRequest.capabilityIds.length,
      model: result.envelope.model,
      workspace: result.envelope.workspace,
    });
  } catch (error) { return failure(error); }
}

interface PreparedStartCandidate {
  readonly capsule: ReturnType<typeof contextCapsuleSchema.parse>;
  readonly delegation: DelegationRevision;
  readonly envelope: ReturnType<typeof preparedChildEnvelopeSchema.parse>;
  readonly managed: Awaited<ReturnType<typeof managedExecution>> | null;
}

class DelegationRetryMutationQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation, operation);
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function addBudgets(values: readonly TaskGraphBudgetV1[]): TaskGraphBudgetV1 {
  const sum = (key: Exclude<keyof TaskGraphBudgetV1, "maxReportedTokens">) => {
    const value = values.reduce((total, budget) => total + budget[key], 0);
    if (!Number.isSafeInteger(value)) {
      throw new DelegationError("delegation_budget_exhausted", "delegation group budget exceeds safe integer bounds");
    }
    return value;
  };
  const reported = values.some((budget) => budget.maxReportedTokens === null)
    ? null
    : values.reduce((total, budget) => total + (budget.maxReportedTokens ?? 0), 0);
  if (reported !== null && !Number.isSafeInteger(reported)) {
    throw new DelegationError("delegation_budget_exhausted", "delegation group token budget exceeds safe integer bounds");
  }
  return Object.freeze({
    maxArtifactBytes: sum("maxArtifactBytes"),
    maxAttempts: sum("maxAttempts"),
    maxChangedBytes: sum("maxChangedBytes"),
    maxChangedFiles: sum("maxChangedFiles"),
    maxCommandExecutions: sum("maxCommandExecutions"),
    maxCommandOutputBytes: sum("maxCommandOutputBytes"),
    maxDurationMs: sum("maxDurationMs"),
    maxModelSteps: sum("maxModelSteps"),
    maxReportedTokens: reported,
  });
}

async function loadStartCandidate(
  runtime: DelegationOwnerRuntimePortV1,
  interaction: DelegationOwnerInteractionPortV1,
  sessionId: string,
  delegation: DelegationRevision,
  currentSourceSnapshotSha256: string,
): Promise<PreparedStartCandidate> {
  if (delegation.envelope === null) {
    throw new DelegationError("delegation_binding_stale", "queued delegation has no prepared envelope");
  }
  const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
  const [capsuleStored, envelopeStored] = await Promise.all([
    store.readVerified(delegation.envelope.contextCapsule.artifactId),
    store.readVerified(delegation.envelope.envelope.artifactId),
  ]);
  const capsule = contextCapsuleSchema.parse(parseStrictJson(capsuleStored.bytes.toString("utf8")));
  const envelope = preparedChildEnvelopeSchema.parse(parseStrictJson(envelopeStored.bytes.toString("utf8")));
  if (
    delegation.content.workspace.sourceSnapshotSha256 !== currentSourceSnapshotSha256 ||
    capsule.repository.sourceSnapshotSha256 !== currentSourceSnapshotSha256 ||
    capsule.workspace.baselineSha256 !== currentSourceSnapshotSha256 ||
    envelope.workspace.sourceSnapshotSha256 !== currentSourceSnapshotSha256
  ) {
    throw new DelegationError(
      "delegation_binding_stale",
      "repository source snapshot changed after delegation preparation",
    );
  }
  if (
    capsule.delegationId !== delegation.delegationId ||
    capsule.delegationRevision !== delegation.delegationRevision ||
    capsule.delegationSha256 !== delegation.delegationSha256 ||
    envelope.actor.delegationId !== delegation.delegationId ||
    envelope.actor.delegationRevision !== delegation.delegationRevision ||
    envelope.actor.delegationSha256 !== delegation.delegationSha256 ||
    envelope.contextCapsuleSha256 !== capsule.capsuleSha256 ||
    envelope.envelopeSha256 !== delegation.envelope.envelopeSha256
  ) {
    throw new DelegationError(
      "delegation_binding_stale",
      "prepared capsule or envelope no longer matches the queued delegation revision",
    );
  }
  const managed = delegation.content.workspace.mode === "managed_worktree"
    ? await managedExecution(runtime, interaction, sessionId, delegation, envelope.actor.attemptId)
    : null;
  return Object.freeze({ capsule, delegation, envelope, managed });
}

export async function executeDelegationOwnerStart(
  options: DelegationOwnerActionOptionsV1,
  runtime: DelegationOwnerRuntimePortV1,
  interaction: DelegationOwnerInteractionPortV1,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<DelegationOwnerExecutionOutcomeV1> {
  const controller = new AbortController();
  // PHASE21: an authenticated product owner never consumes raw Host SIGINT.
  // The surface must first persist delegation.cancel through ApplicationService;
  // the child launcher observes that durable request and only then signals the
  // exact child. Legacy execution retains its historical local abort bridge.
  const forwardApplicationCancellation = () => controller.abort(
    ownerExecution?.cancellationSignal?.reason,
  );
  ownerExecution?.cancellationSignal?.addEventListener("abort", forwardApplicationCancellation, { once: true });
  if (ownerExecution?.cancellationSignal?.aborted === true) controller.abort();
  const stopCancel = ownerExecution === undefined
    ? runtime.onCancel(() => controller.abort())
    : () => ownerExecution.cancellationSignal?.removeEventListener("abort", forwardApplicationCancellation);
  try {
    const state = await session(runtime, options.sessionId);
    const delegation = [...state.delegations.revisions].reverse().find((candidate) => candidate.delegationId === options.delegationId);
    if (delegation?.status !== "queued" || delegation.envelope === null) {
      throw new DelegationError("delegation_revision_conflict", "start requires one prepared queued delegation");
    }
    if (
      state.delegations.activeActorSlots.length > 0 ||
      state.delegations.revisions.some((candidate) =>
        ["active", "waiting_approval", "cancelling", "reconciling"].includes(candidate.status))
    ) {
      throw new DelegationError("delegation_lease_busy", "another delegation coordinator still owns active child facts");
    }
    const readyRevisions = state.delegations.revisions.filter((candidate) =>
      candidate.status === "queued" && candidate.envelope !== null &&
      candidate.parentActorId === delegation.parentActorId &&
      candidate.parentRunId === delegation.parentRunId);
    const currentSource = await (
      await RepositorySourceSnapshotter.create(runtime.cwd, { environment: runtime.env })
    ).snapshot();
    const prepared = await Promise.all(
      readyRevisions.map((candidate) =>
        loadStartCandidate(
          runtime,
          interaction,
          options.sessionId,
          candidate,
          currentSource.snapshot.sourceStateSha256,
        )),
    );
    const preparedById = new Map(prepared.map((candidate) => [candidate.delegation.delegationId, candidate]));
    const maximum = addBudgets(prepared.map((candidate) => candidate.envelope.budgetReservationPlan.ceiling));
    const ledger = new DelegationBudgetLedger(maximum);
    const groupId = runtime.randomUUID();
    const scheduler = new BoundedDelegationScheduler({ groupId, ledger, randomUuid: runtime.randomUUID });
    const admission = scheduler.admit({
      parentModelActive: false,
      ready: prepared.map((candidate) => ({
        revision: candidate.delegation,
        childActorId: candidate.envelope.actor.actorId,
        childAttemptId: candidate.envelope.actor.attemptId,
        requestedBudget: candidate.envelope.budgetReservationPlan.ceiling,
        conflict: {
          access: candidate.envelope.effectiveAuthority.taskProfile === "coding" ? "write" : "read",
          repositoryId: candidate.capsule.repository.repositoryId,
          workspaceId: candidate.envelope.workspace.mode === "managed_worktree"
            ? candidate.envelope.workspace.logicalWorkspaceId
            : null,
          sourceLineageId: candidate.envelope.workspace.lineageId,
          sourceSnapshotSha256: candidate.envelope.workspace.sourceSnapshotSha256,
          pathPrefixes: candidate.envelope.workspace.declaredPathPrefixes,
        },
      })),
    });
    if (!admission.admitted.some((item) => item.candidate.revision.delegationId === delegation.delegationId)) {
      const deferred = admission.deferred.find((item) => item.delegationId === delegation.delegationId);
      throw new DelegationError(
        deferred?.reason === "budget"
          ? "delegation_budget_exhausted"
          : deferred?.reason === "workspace_conflict"
            ? "delegation_workspace_conflict"
            : "delegation_parallel_limit",
        `selected delegation was deferred by ${deferred?.reason ?? "scheduler admission"}`,
      );
    }
    const identity = runtime.delegationCoordinatorIdentity?.();
    if (identity === undefined) {
      throw new DelegationError("delegation_handshake_failed", "runtime has no exact coordinator process identity");
    }
    const coordinatorKind = identity.kind ?? "foreground";
    const ownerBackgroundOperationId = identity.backgroundOperationId ?? null;
    if (coordinatorKind === "phase19_background_worker" && ownerBackgroundOperationId === null) {
      throw new DelegationError(
        "delegation_handshake_failed",
        "background delegation coordinator has no exact Phase 19 worker operation",
      );
    }
    // Cross-process cancellation has no process-local AbortSignal. Re-read the
    // durable projection before touching the repository-scoped lease; the
    // writer fence below closes the remaining request/admission race.
    try {
      assertNoDurablePreAdmissionCancellation(
        await session(runtime, options.sessionId),
        delegation,
      );
    } catch (error) {
      if (error instanceof DelegationError && error.code === "delegation_cancelled") {
        controller.abort();
      }
      throw error;
    }
    // Final pre-lease fence. Product cancellation is signalled only after the
    // typed delegation.cancel request is durable; no group lease or child
    // admission may be created after observing it here.
    if (controller.signal.aborted) {
      throw new DelegationError("delegation_cancelled", "delegation was cancelled before group lease admission");
    }
    const barrierId = runtime.randomUUID();
    const leaseNonceSha256 = sha256Canonical({ groupId, nonce: runtime.randomUUID(), sessionId: options.sessionId });
    const durableGroupLease = await (runtime.acquireDelegationGroupLease?.({
      graphBindingSha256: delegation.binding.graphId === null
        ? null
        : sha256Canonical({
            graphId: delegation.binding.graphId,
            graphRevision: delegation.binding.graphRevision,
            graphSha256: delegation.binding.graphSha256,
            nodeAttemptId: delegation.binding.nodeAttemptId,
            nodeId: delegation.binding.nodeId,
          }),
      groupId,
      nonceSha256: leaseNonceSha256,
      ownerBackgroundOperationId,
      ownerKind: coordinatorKind,
      ownerPid: identity.pid,
      ownerProcessStartIdentity: identity.processStartIdentity,
      parentActorId: delegation.parentActorId,
      parentRunId: delegation.parentRunId,
      repositoryId: admission.admitted[0]!.candidate.conflict.repositoryId,
      sessionId: options.sessionId,
    }) ?? Promise.reject(new DelegationError(
      "delegation_lease_busy",
      "runtime has no durable repository delegation group lease",
    )));
    if (controller.signal.aborted) {
      await releaseCancelledDelegationGroupLease(runtime, {
        expectedLeaseSha256: durableGroupLease.leaseSha256,
        groupId,
        sessionId: options.sessionId,
      });
      throw new DelegationError("delegation_cancelled", "delegation was cancelled before group event admission");
    }
    const slotClaims = new Map<string, { readonly claimId: string; readonly admission: DelegationAdmissionV1 }>();
    const retryMutations = new DelegationRetryMutationQueue();
    const writerFactory = delegationWriterFactory(runtime);
    const mutationContext = delegationMutationContext(runtime, options, ownerExecution);
    let writer = await writerFactory(mutationContext);
    try {
      try {
        assertNoDurablePreAdmissionCancellation(
          reconstructMultiRunSession(writer.events),
          delegation,
        );
      } catch (error) {
        if (
          error instanceof DelegationError &&
          error.code === "delegation_cancelled"
        ) {
          await releaseCancelledDelegationGroupLease(runtime, {
            expectedLeaseSha256: durableGroupLease.leaseSha256,
            groupId,
            sessionId: options.sessionId,
          });
          controller.abort();
        }
        throw error;
      }
      if (controller.signal.aborted) {
        await releaseCancelledDelegationGroupLease(runtime, {
          expectedLeaseSha256: durableGroupLease.leaseSha256,
          groupId,
          sessionId: options.sessionId,
        });
        throw new DelegationError("delegation_cancelled", "delegation was cancelled at the final group admission fence");
      }
      await writer.appendDelegationEvent("delegation.group.lease.acquired", {
        coordinator_kind: coordinatorKind,
        coordinator_process_id: identity.pid,
        coordinator_process_start_identity: identity.processStartIdentity,
        group_id: groupId,
        lease_nonce_sha256: leaseNonceSha256,
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
        repository_id: admission.admitted[0]!.candidate.conflict.repositoryId,
        ...(mutationContext.authenticatedApplication === undefined ? {} : { origin: taskUserOrigin(mutationContext) }),
      });
      await writer.appendDelegationEvent("delegation.parent.barrier.requested", {
        barrier_id: barrierId,
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
        required_delegation_ids: admission.admitted.map((item) => item.candidate.revision.delegationId),
      });
      await writer.appendDelegationEvent("delegation.parent.barrier.suspended", {
        barrier_id: barrierId,
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
      });
      for (const item of admission.admitted) {
        const claimId = runtime.randomUUID();
        slotClaims.set(item.candidate.revision.delegationId, { admission: item, claimId });
        await writer.appendDelegationEvent("delegation.actor_slot.claimed", {
          actor_id: item.candidate.childActorId,
          actor_kind: "child",
          claim_id: claimId,
          group_id: groupId,
          slot: item.actorSlot,
        });
        await writer.appendDelegationEvent("delegation.conflict_claim.granted", {
          access: item.conflictClaim.access,
          actor_id: item.conflictClaim.actorId,
          claim_id: item.conflictClaim.claimId,
          group_id: groupId,
          path_prefixes: [...item.conflictClaim.canonicalPathPrefixes],
          repository_id: item.conflictClaim.repositoryId,
          source_lineage_id: item.conflictClaim.sourceLineageId,
          source_snapshot_sha256: item.conflictClaim.sourceSnapshotSha256,
          workspace_id: item.conflictClaim.workspaceId,
        });
      }
    } finally {
      await writer.close();
    }
    const settled = await scheduler.execute(admission.admitted, async (initialAdmission) => {
      let item = initialAdmission;
      let candidate = preparedById.get(item.candidate.revision.delegationId)!;
      while (true) {
        const launcher = runtime.createDelegationChildLauncher?.({
          ...(ownerExecution === undefined ? {} : { authenticatedMutation: ownerExecution.authenticatedMutation }),
          approvalPrompt: interaction.createApprovalPrompt(),
          inputSurface: options.inputSurface ?? "cli",
          ...(runtime.observeSessionWriter === undefined
            ? {}
            : { observeSessionWriter: runtime.observeSessionWriter }),
          sessionId: options.sessionId,
        });
        if (launcher === undefined) {
          throw new DelegationError("delegation_handshake_failed", "runtime has no sealed delegated child launcher");
        }
        try {
          return await launcher.launch({
            delegation: candidate.delegation,
            preparedEnvelope: candidate.envelope,
            capsule: candidate.capsule,
            reservation: item.reservation,
            executionWorkspacePath: candidate.managed?.executionWorkspacePath ?? runtime.cwd,
            ...(candidate.managed === null ? {} : { finalizeWorkspace: candidate.managed.finalizeWorkspace }),
            schedulerLeaseNonceSha256: leaseNonceSha256,
            signal: controller.signal,
          });
        } catch (error) {
          if (!(error instanceof DelegationChildLaunchFailure)) throw error;
          const retry = await retryMutations.run(async () => {
            const delegationId = item.candidate.revision.delegationId;
            const resources = slotClaims.get(delegationId);
            if (resources === undefined || resources.admission.reservation.reservationId !== item.reservation.reservationId) {
              throw new DelegationError("delegation_lease_busy", "automatic retry lost its exact active admission");
            }
            ledger.settle({
              expectedRevision: ledger.state.revision,
              reservationId: item.reservation.reservationId,
              usage: preEffectInfrastructureUsage(),
              unresolvedEffect: false,
            });
            let retryWriter = await writerFactory(mutationContext);
            try {
              await retryWriter.appendDelegationEvent("delegation.conflict_claim.released", {
                actor_id: item.conflictClaim.actorId,
                claim_id: item.conflictClaim.claimId,
                group_id: groupId,
              });
              await retryWriter.appendDelegationEvent("delegation.actor_slot.released", {
                actor_id: item.candidate.childActorId,
                claim_id: resources.claimId,
                group_id: groupId,
                release_reason: "reconciled",
              });
            } finally {
              await retryWriter.close();
            }
            slotClaims.delete(delegationId);
            if (!error.retryEligible) return null;

            const retryOptions = delegationContinuationOptions({
              ...options,
              delegationId,
            });
            const preparedExit = await executeDelegationOwnerPrepare(
              retryOptions,
              runtime,
              interaction,
              ownerExecution,
            );
            if (preparedExit.exitCode !== 0) {
              throw new DelegationError(
                "delegation_effect_reconciliation_required",
                `automatic retry could not prepare a fresh child envelope (${internalDiagnosticIdentity(preparedExit.diagnostic)})`,
              );
            }
            const nextState = await queuedDelegationSnapshot(runtime, retryOptions);
            const nextRevision = [...nextState.delegations.revisions].reverse().find((value) =>
              value.delegationId === delegationId && value.status === "queued" && value.envelope !== null);
            if (nextRevision === undefined) {
              throw new DelegationError("delegation_binding_stale", "automatic retry preparation did not project a queued envelope");
            }
            const nextCandidate = await loadStartCandidate(
              runtime,
              interaction,
              options.sessionId,
              nextRevision,
              currentSource.snapshot.sourceStateSha256,
            );
            const active = [...slotClaims.values()];
            const nextAdmission = scheduler.admit({
              activeActorSlots: active.map((value) => value.admission.actorSlot),
              activeChildCount: active.length,
              activeClaims: active.map((value) => value.admission.conflictClaim),
              parentModelActive: false,
              ready: [{
                revision: nextCandidate.delegation,
                childActorId: nextCandidate.envelope.actor.actorId,
                childAttemptId: nextCandidate.envelope.actor.attemptId,
                requestedBudget: nextCandidate.envelope.budgetReservationPlan.ceiling,
                conflict: {
                  access: nextCandidate.envelope.effectiveAuthority.taskProfile === "coding" ? "write" : "read",
                  repositoryId: nextCandidate.capsule.repository.repositoryId,
                  workspaceId: nextCandidate.envelope.workspace.mode === "managed_worktree"
                    ? nextCandidate.envelope.workspace.logicalWorkspaceId
                    : null,
                  sourceLineageId: nextCandidate.envelope.workspace.lineageId,
                  sourceSnapshotSha256: nextCandidate.envelope.workspace.sourceSnapshotSha256,
                  pathPrefixes: nextCandidate.envelope.workspace.declaredPathPrefixes,
                },
              }],
            }).admitted[0];
            if (nextAdmission === undefined) {
              throw new DelegationError("delegation_parallel_limit", "automatic retry could not reacquire its bounded actor slot");
            }
            const nextClaimId = runtime.randomUUID();
            retryWriter = await writerFactory(mutationContext);
            try {
              await retryWriter.appendDelegationEvent("delegation.actor_slot.claimed", {
                actor_id: nextAdmission.candidate.childActorId,
                actor_kind: "child",
                claim_id: nextClaimId,
                group_id: groupId,
                slot: nextAdmission.actorSlot,
              });
              await retryWriter.appendDelegationEvent("delegation.conflict_claim.granted", {
                access: nextAdmission.conflictClaim.access,
                actor_id: nextAdmission.conflictClaim.actorId,
                claim_id: nextAdmission.conflictClaim.claimId,
                group_id: groupId,
                path_prefixes: [...nextAdmission.conflictClaim.canonicalPathPrefixes],
                repository_id: nextAdmission.conflictClaim.repositoryId,
                source_lineage_id: nextAdmission.conflictClaim.sourceLineageId,
                source_snapshot_sha256: nextAdmission.conflictClaim.sourceSnapshotSha256,
                workspace_id: nextAdmission.conflictClaim.workspaceId,
              });
            } finally {
              await retryWriter.close();
            }
            slotClaims.set(delegationId, { admission: nextAdmission, claimId: nextClaimId });
            return Object.freeze({ admission: nextAdmission, candidate: nextCandidate });
          });
          if (retry === null) throw error;
          item = retry.admission;
          candidate = retry.candidate;
        }
      }
    });
    const preEffectCancelledResults = new Map<
      string,
      Extract<DelegationGroupTerminalItemV1, { readonly status: "pre_effect_cancelled" }>
    >();
    let releaseReason: "terminal" | "cancelled" | null = null;
    writer = await writerFactory(mutationContext);
    try {
      for (const [index, outcome] of settled.entries()) {
        const item = admission.admitted[index]!;
        const delegationId = item.candidate.revision.delegationId;
        const projectedBeforeRelease = reconstructMultiRunSession(writer.events);
        const cancelledPreStart = projectedBeforeRelease.delegations.revisions.find((candidate) =>
          candidate.delegationId === delegationId &&
          candidate.delegationRevision === item.candidate.revision.delegationRevision &&
          candidate.delegationSha256 === item.candidate.revision.delegationSha256 &&
          candidate.status === "cancelled" &&
          candidate.attempts.some((attempt) =>
            attempt.attemptId === item.candidate.childAttemptId &&
            attempt.actorId === item.candidate.childActorId &&
            attempt.startedEventId === null &&
            attempt.terminal === "cancelled_clean" &&
            attempt.terminalEventId !== null &&
            attempt.budgetSettlementEventId !== null));
        const cancelledAttempt = cancelledPreStart?.attempts.find((attempt) =>
          attempt.attemptId === item.candidate.childAttemptId &&
          attempt.actorId === item.candidate.childActorId &&
          attempt.startedEventId === null && attempt.terminal === "cancelled_clean" &&
          attempt.terminalEventId !== null && attempt.budgetSettlementEventId !== null);
        const cancelledTerminal = cancelledAttempt?.terminalEventId === null || cancelledAttempt === undefined
          ? undefined
          : writer.events.find((event) =>
              event.eventId === cancelledAttempt.terminalEventId && event.scope === "session" &&
              event.type === "delegation.owner.pre_effect.terminal" &&
              event.data.delegation_id === delegationId &&
              event.data.child_attempt_id === cancelledAttempt.attemptId &&
              event.data.operation_id === cancelledAttempt.operationId);
        const releaseRejectedCancellation =
          outcome.status === "rejected" && cancelledTerminal?.scope === "session" &&
          cancelledTerminal.type === "delegation.owner.pre_effect.terminal";
        if (releaseRejectedCancellation && cancelledAttempt !== undefined &&
            cancelledTerminal?.scope === "session" && cancelledTerminal.type === "delegation.owner.pre_effect.terminal" &&
            cancelledAttempt.operationId !== null) {
          preEffectCancelledResults.set(delegationId, Object.freeze({
            cancelRequestEventId: cancelledTerminal.data.cancel_request_event_id,
            cancelRequestId: cancelledTerminal.data.cancel_request_id,
            childAttemptId: cancelledAttempt.attemptId,
            delegationId,
            operationId: cancelledAttempt.operationId,
            status: "pre_effect_cancelled" as const,
            terminalEventId: cancelledTerminal.eventId,
          }));
        }
        if (outcome.status !== "fulfilled" && !releaseRejectedCancellation) continue;
        const claims = slotClaims.get(delegationId);
        if (claims === undefined) {
          throw new DelegationError(
            "delegation_lease_busy",
            "terminal child lost its exact active admission claims",
          );
        }
        const activeAdmission = claims.admission;
        await writer.appendDelegationEvent("delegation.conflict_claim.released", {
          actor_id: activeAdmission.conflictClaim.actorId,
          claim_id: activeAdmission.conflictClaim.claimId,
          group_id: groupId,
        });
        await writer.appendDelegationEvent("delegation.actor_slot.released", {
          actor_id: activeAdmission.candidate.childActorId,
          claim_id: claims.claimId,
          group_id: groupId,
          release_reason: releaseRejectedCancellation ||
              (outcome.status === "fulfilled" && outcome.value.receipt.status === "cancelled")
            ? "cancelled"
            : "terminal",
        });
        slotClaims.delete(delegationId);
      }
      const projected = reconstructMultiRunSession(writer.events);
      const required = admission.admitted.map((item) =>
        [...projected.delegations.revisions].reverse().find((candidate) =>
          candidate.delegationId === item.candidate.revision.delegationId &&
          candidate.parentRunId === delegation.parentRunId));
      const groupHasActiveAdmission = projected.delegations.activeActorSlots.some((claim) =>
        claim.groupId === groupId) || projected.delegations.activeConflictClaims.some((claim) =>
        claim.groupId === groupId);
      const allKnown = required.every((candidate) =>
        candidate !== undefined && ["accepted", "failed", "blocked", "cancelled"].includes(candidate.status));
      if (!groupHasActiveAdmission && allKnown) {
        const fulfilled = settled.flatMap((outcome) =>
          outcome.status === "fulfilled" ? [outcome.value] : []);
        const exactPreStartCancelled = required.filter((candidate) =>
          candidate?.status === "cancelled" && candidate.attempts.some((attempt) =>
            attempt.startedEventId === null && attempt.terminal === "cancelled_clean" &&
            attempt.terminalEventId !== null && attempt.budgetSettlementEventId !== null)).length;
        const allCancelled = fulfilled.filter((result) => result.receipt.status === "cancelled").length +
          exactPreStartCancelled === settled.length;
        await writer.appendDelegationEvent("delegation.parent.barrier.released", {
          barrier_id: barrierId,
          parent_actor_id: delegation.parentActorId,
          parent_run_id: delegation.parentRunId,
          receipt_sha256s: required.flatMap((candidate) =>
            candidate?.receipt?.acceptedEventId === null || candidate?.receipt === null || candidate?.receipt === undefined
              ? []
              : [candidate.receipt.sha256]),
          status: fulfilled.length === settled.length && fulfilled.every((result) =>
            result.receipt.status === "succeeded")
            ? "completed"
            : allCancelled
              ? "cancelled"
              : "blocked",
        });
        releaseReason = allCancelled
          ? "cancelled"
          : "terminal";
      }
    } finally {
      await writer.close();
    }
    if (releaseReason !== null) {
      await (runtime.releaseDelegationGroupLease?.({
        effectsReconciled: true,
        expectedLeaseSha256: durableGroupLease.leaseSha256,
        groupId,
        reason: releaseReason,
        sessionId: options.sessionId,
      }) ?? Promise.reject(new DelegationError(
        "delegation_lease_busy",
        "runtime cannot release the terminal durable delegation group lease",
      )));
    }
    const results: DelegationGroupTerminalItemV1[] = settled.map((outcome, index) => {
      const delegationId = admission.admitted[index]!.candidate.revision.delegationId;
      if (outcome.status === "fulfilled") return {
          delegationId: admission.admitted[index]!.candidate.revision.delegationId,
          childRunId: outcome.value.childRunId,
          receiptSha256: outcome.value.receipt.receiptSha256,
          status: outcome.value.receipt.status,
        };
      const preEffectCancelled = preEffectCancelledResults.get(delegationId);
      if (preEffectCancelled !== undefined) return preEffectCancelled;
      return {
          delegationId,
          error: outcome.reason instanceof DelegationError ? outcome.reason.code : "delegation_effect_reconciliation_required",
          diagnostic: internalDiagnosticIdentity(outcome.reason),
          status: "blocked" as const,
        };
    });
    const terminalStatus: DelegationGroupTerminalResultV1["terminalStatus"] =
      settled.length > 0 && settled.every((outcome) =>
        outcome.status === "fulfilled" && outcome.value.receipt.status === "succeeded")
        ? "completed"
        : results.length > 0 && results.every((item) =>
          item.status === "cancelled" || item.status === "pre_effect_cancelled")
          ? "cancelled"
          : "blocked";
    const result: DelegationGroupTerminalResultV1 = {
      kind: "group_terminal",
      groupId,
      results,
      deferred: admission.deferred,
      terminalStatus,
    };
    if (terminalStatus === "cancelled") {
      return ownerResult(
        result,
        // A clean cancellation is a successful owner predicate. The surface
        // maps its strict terminal status to exit 130; ApplicationService must
        // still link and complete this exact durable result.
        0,
        Object.freeze({
          code: "delegation_cancelled",
          message: "delegated child cancellation reached a reconciled terminal",
        }),
      );
    }
    return ownerResult(
      result,
      terminalStatus === "completed" ? 0 : 8,
    );
  } catch (error) {
    if (
      controller.signal.aborted && error instanceof DelegationError &&
      error.code === "delegation_cancelled"
    ) {
      return Object.freeze({
        diagnostic: Object.freeze({
          code: "delegation_cancelled",
          message: "delegated child cancellation was requested",
        }),
        exitCode: 130,
        result: null,
      });
    }
    return failure(error);
  } finally {
    stopCancel();
  }
}
