import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { taskMutationContext, taskWriterFactory } from "./task-control-plane-command.js";
import { DelegationControlPlane } from "../delegation/delegation-control-plane.js";
import { DelegationFileLoader } from "../delegation/delegation-file-loader.js";
import { DelegationError } from "../delegation/delegation-errors.js";
import { DelegationPreparationRuntime } from "../delegation/delegation-preparation-runtime.js";
import {
  computeDelegationAuthority,
  delegationAuthorityCeiling,
} from "../delegation/delegable-authority.js";
import { buildChildToolProfile } from "../delegation/context/child-tool-profile.js";
import { DELEGATED_BUILTIN_TOOL_IDS, delegatedBuiltinToolCatalog } from "../delegation/context/delegated-tool-catalog.js";
import { buildChildEnvironmentPolicy } from "../delegation/context/child-environment-policy.js";
import type { ContextFactReaderV1 } from "../delegation/context/context-capsule-builder.js";
import { contextCapsuleSchema } from "../delegation/context/context-capsule-schema.js";
import { preparedChildEnvelopeSchema } from "../delegation/context/child-envelope-schema.js";
import { DelegationBudgetLedger } from "../delegation/delegation-budget-ledger.js";
import {
  delegationRemainingBudget,
  preEffectInfrastructureUsage,
} from "../delegation/delegation-retry.js";
import {
  BoundedDelegationScheduler,
  type DelegationAdmissionV1,
} from "../delegation/bounded-delegation-scheduler.js";
import { readVerifiedChildReceipt } from "../delegation/receipts/child-receipt-verifier.js";
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
  type DelegationWorkspaceFinalizationV1,
} from "../delegation/runtime/child-launcher.js";
import {
  isPhase20CanonicalFakeSelection,
  PHASE20_CANONICAL_CODING_FAKE_QUALIFICATION_SHA256,
  PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
} from "../delegation/runtime/canonical-fake-child-backend.js";
import { createCapabilitySnapshot } from "../capabilities/capability-snapshot.js";
import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";

export interface DelegationsListOptions {
  readonly delegationId?: string;
  readonly expectedSessionSeq?: number;
  readonly inputSurface?: "cli" | "tui";
  readonly json: boolean;
  readonly sessionId: string;
  readonly status?: string;
}
export interface DelegationsShowOptions extends DelegationsListOptions { readonly delegationId: string }
export interface DelegationsProposeOptions extends DelegationsListOptions {
  readonly file: string;
  readonly baseRevision?: string;
  readonly baseSha256?: string;
}
export interface DelegationsDecisionOptions extends DelegationsShowOptions {
  readonly revision: string;
  readonly sha256: string;
  readonly queue?: boolean;
  readonly reason?: string;
}
export interface DelegationsCancelOptions extends DelegationsShowOptions { readonly reason: string }

const TOOL_IDS = DELEGATED_BUILTIN_TOOL_IDS;
const TOOL_CATALOG = delegatedBuiltinToolCatalog();

export interface DelegationSummaryJsonV1 {
  readonly schemaVersion: 1;
  readonly delegationId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly sequence: number;
  readonly title: string;
  readonly status: string;
  readonly parent: { readonly actorId: string; readonly runId: string; readonly graphId: string | null; readonly nodeId: string | null };
  readonly child: { readonly actorId: string | null; readonly attemptId: string | null; readonly attemptNumber: number; readonly model: string | null };
  readonly context: { readonly capsuleSha256: string | null; readonly bytes: number | null };
  readonly authority: { readonly profile: string; readonly tools: number; readonly capabilities: number };
  readonly workspace: { readonly id: string; readonly mode: string; readonly status: string };
  readonly budget: Readonly<Record<string, unknown>>;
  readonly receipt: { readonly sha256: string | null; readonly verifiedClaims: number; readonly blockers: readonly string[] };
  readonly live: { readonly coordinator: string | null; readonly heartbeatAgeMs: number | null } | null;
}

type DelegationSession = Awaited<ReturnType<SessionCatalog["read"]>>;
type DelegationRevision = DelegationSession["delegations"]["revisions"][number];

function delegationWriterFactory(runtime: CliRuntime) {
  if (runtime.delegationWriterFactory === undefined) return taskWriterFactory(runtime);
  return async (context: Parameters<NonNullable<CliRuntime["delegationWriterFactory"]>>[0]) => {
    const writer = await runtime.delegationWriterFactory!(context);
    runtime.observeSessionWriter?.(writer);
    return writer;
  };
}

async function queuedDelegationSnapshot(
  runtime: CliRuntime,
  options: DelegationsListOptions,
) {
  const writer = await delegationWriterFactory(runtime)(
    delegationMutationContext(runtime, options),
  );
  try {
    return reconstructMultiRunSession(writer.events);
  } finally {
    await writer.close();
  }
}

function internalDelegationIO(): { readonly io: CliIO; readonly stderr: () => string } {
  let error = "";
  return {
    io: {
      stderr: {
        write: (value) => {
          if (Buffer.byteLength(error, "utf8") < 8 * 1024) error += value;
        },
      },
      stdout: { write: () => undefined },
    },
    stderr: () => error,
  };
}

function delegationContinuationOptions(
  options: DelegationsShowOptions,
): DelegationsShowOptions {
  return {
    delegationId: options.delegationId,
    ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
    json: options.json,
    sessionId: options.sessionId,
  };
}

async function summary(
  runtime: CliRuntime,
  sessionId: string,
  state: DelegationSession,
  revision: DelegationRevision,
  operations: Awaited<ReturnType<NonNullable<CliRuntime["inspectDelegationOperations"]>>>,
): Promise<DelegationSummaryJsonV1> {
  const attempt = revision.attempts.at(-1);
  let model: string | null = null;
  let workspaceId = revision.content.workspace.managedWorkspaceId ?? revision.binding.parentWorkspaceLineageId;
  if (revision.envelope !== null) {
    const store = await ArtifactStore.create({ sessionId, workspace: runtime.cwd });
    const stored = await store.readVerified(revision.envelope.envelope.artifactId);
    const envelope = preparedChildEnvelopeSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
    model = envelope.model.modelId;
    workspaceId = envelope.workspace.logicalWorkspaceId;
  }
  const managedWorkspace = state.worktrees.workspaces.find((candidate) =>
    candidate.identity.workspaceId === workspaceId);
  const operation = [...operations].reverse().find((candidate) =>
    candidate.delegationId === revision.delegationId);
  return Object.freeze({
    schemaVersion: 1,
    delegationId: revision.delegationId,
    revision: revision.delegationRevision,
    sha256: revision.delegationSha256,
    sequence: revision.content.sequence,
    title: revision.content.title,
    status: revision.status,
    parent: {
      actorId: revision.parentActorId,
      runId: revision.parentRunId,
      graphId: revision.binding.graphId,
      nodeId: revision.binding.nodeId,
    },
    child: {
      actorId: attempt?.actorId ?? null,
      attemptId: attempt?.attemptId ?? null,
      attemptNumber: attempt?.attemptNumber ?? 0,
      model,
    },
    context: {
      capsuleSha256: revision.envelope?.contextCapsuleSha256 ?? null,
      bytes: revision.envelope?.contextCapsule.bytes ?? null,
    },
    authority: {
      profile: revision.content.authorityRequest.taskProfile,
      tools: revision.content.authorityRequest.toolIds.length,
      capabilities: revision.content.authorityRequest.capabilityIds.length,
    },
    workspace: {
      id: workspaceId,
      mode: revision.content.workspace.mode,
      status: managedWorkspace?.status ?? (revision.content.workspace.mode === "origin_read_only" ? "origin_read_only" : "unavailable"),
    },
    budget: Object.freeze({
      requested: revision.content.budget,
      reservationId: attempt?.reservationId ?? null,
      terminal: attempt?.terminal ?? null,
    }),
    receipt: {
      sha256: revision.receipt?.sha256 ?? null,
      verifiedClaims: revision.receipt?.claimStatuses.filter((claim) => claim.status === "verified").length ?? 0,
      blockers: Object.freeze([
        ...revision.blockerCodes,
        ...(revision.receipt?.claimStatuses.filter((claim) => claim.status !== "verified")
          .map((claim) => `${claim.claimId}:${claim.status}`) ?? []),
      ]),
    },
    live: operation === undefined
      ? null
      : {
          coordinator: operation.ownerObservation === "matching" ? operation.operationId : null,
          heartbeatAgeMs: null,
        },
  });
}

function positive(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new DelegationError("delegation_invalid", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function sha(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new DelegationError("delegation_invalid", "delegation SHA-256 is invalid");
  return value;
}

function document(revision: Awaited<ReturnType<SessionCatalog["read"]>>["delegations"]["revisions"][number]) {
  return {
    artifact: revision.artifact,
    attempts: revision.attempts,
    authorityPreviewSha256: revision.authorityPreviewSha256,
    binding: revision.binding,
    content: revision.content,
    createdEventId: revision.createdEventId,
    decisionEventId: revision.decisionEventId,
    delegationId: revision.delegationId,
    delegationRevision: revision.delegationRevision,
    delegationSha256: revision.delegationSha256,
    envelope: revision.envelope,
    receipt: revision.receipt,
    status: revision.status,
    terminalEventId: revision.terminalEventId,
  };
}

function success(command: string, result: unknown) {
  return { schemaVersion: 1, ok: true as const, command, result };
}

function writeResult(io: CliIO, json: boolean, command: string, result: unknown, human: string): void {
  io.stdout.write(json ? `${canonicalJson(success(command, result))}\n` : human);
}

function failure(error: unknown, io: CliIO): 1 | 2 | 3 | 7 | 8 {
  if (error instanceof DelegationError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof SessionCatalogError || error instanceof SessionLockError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 8;
  }
  if (error instanceof SessionProjectionError) {
    io.stderr.write(`delegation_session_corrupt: ${error.message}\n`);
    return 1;
  }
  io.stderr.write("delegation_internal_error\n");
  return 1;
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

async function session(runtime: CliRuntime, sessionId: string) {
  assertCanonicalSessionId(sessionId);
  return new SessionCatalog(runtime.cwd).read(sessionId);
}

function delegationMutationContext(runtime: CliRuntime, options: DelegationsListOptions) {
  return taskMutationContext(
    runtime,
    options.sessionId,
    options.inputSurface ?? "cli",
    options.expectedSessionSeq,
  );
}

export async function executeDelegationsList(options: DelegationsListOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const state = await session(runtime, options.sessionId);
    const operations = await (runtime.inspectDelegationOperations?.(options.sessionId) ?? Promise.resolve([]));
    const selected = state.delegations.revisions.filter((revision) =>
      options.status === undefined || revision.status === options.status);
    const records = await Promise.all(selected.map((revision) =>
      summary(runtime, options.sessionId, state, revision, operations)));
    writeResult(io, options.json, "delegations.list", { records }, records.length === 0
      ? "Delegations: none\n"
      : records.map((record) => `${String(record.sequence)} ${record.delegationId} r${String(record.revision)} ${record.status} ${record.title}\n`).join(""));
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsShow(options: DelegationsShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const state = await session(runtime, options.sessionId);
    const revision = [...state.delegations.revisions].reverse().find((candidate) => candidate.delegationId === options.delegationId);
    if (revision === undefined) throw new DelegationError("delegation_revision_conflict", "delegation was not found");
    const allOperations = await (runtime.inspectDelegationOperations?.(options.sessionId) ?? Promise.resolve([]));
    const operations = options.delegationId === undefined
      ? allOperations
      : allOperations.filter((operation) => operation.delegationId === options.delegationId);
    const result = await summary(runtime, options.sessionId, state, revision, operations);
    writeResult(io, options.json, "delegations.show", result,
      `Delegation ${revision.delegationId} r${String(revision.delegationRevision)} ${revision.status}\nSHA-256: ${revision.delegationSha256}\nObjective: ${revision.content.objective}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsPropose(options: DelegationsProposeOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    if ((options.baseRevision === undefined) !== (options.baseSha256 === undefined)) {
      throw new DelegationError("delegation_invalid", "replacement requires both base revision and base SHA-256");
    }
    const current = await session(runtime, options.sessionId);
    if (current.lastRun === null) throw new DelegationError("delegation_parent_not_active", "session has no parent run");
    const loaded = await new DelegationFileLoader().load(runtime.cwd, options.file);
    const result = await new DelegationControlPlane(delegationWriterFactory(runtime)).replace({
      base: options.baseRevision === undefined ? null : { revision: positive(options.baseRevision, "base revision"), sha256: sha(options.baseSha256!) },
      context: delegationMutationContext(runtime, options),
      parentRunId: current.lastRun.runId,
      revision: loaded,
    });
    writeResult(io, options.json, "delegations.propose", document(result.delegation),
      `Delegation draft ${result.delegation.delegationId} r${String(result.delegation.delegationRevision)}\nSHA-256: ${result.delegation.delegationSha256}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsApprove(options: DelegationsDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const result = await new DelegationControlPlane(delegationWriterFactory(runtime)).approve({
      context: delegationMutationContext(runtime, options),
      delegationId: options.delegationId,
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
      queue: options.queue === true,
    });
    writeResult(io, options.json, "delegations.approve", document(result.delegation),
      `Delegation ${result.delegation.status}: ${result.delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsReject(options: DelegationsDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const result = await new DelegationControlPlane(delegationWriterFactory(runtime)).reject({
      context: delegationMutationContext(runtime, options),
      delegationId: options.delegationId,
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    writeResult(io, options.json, "delegations.reject", document(result.delegation), `Delegation rejected: ${result.delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsCancel(options: DelegationsCancelOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const result = await new DelegationControlPlane(delegationWriterFactory(runtime)).cancel({
      context: delegationMutationContext(runtime, options),
      delegationId: options.delegationId,
      reason: options.reason,
    });
    writeResult(io, options.json, "delegations.cancel", document(result.delegation), `Delegation cancellation requested: ${result.delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsResume(options: DelegationsShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
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
        observation.reconcile.kind === "pre_effect_failure_terminal"
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
          const internal = internalDelegationIO();
          const prepared = await executeDelegationsPrepare(retryOptions, runtime, internal.io);
          if (prepared !== 0) {
            io.stderr.write(internal.stderr());
            return prepared;
          }
        } else if (revision.envelopePreparationCount !== 2) {
          throw new DelegationError(
            "delegation_child_protocol_invalid",
            "automatic retry has an invalid envelope preparation count",
          );
        }
        return executeDelegationsStart(retryOptions, runtime, io);
      }
      const refreshed = await runtime.inspectDelegationOperations?.(options.sessionId) ?? [];
      observation = refreshed.find((candidate) => candidate.operationId === recovery.operation.operationId);
      writeResult(io, options.json, "delegations.resume", {
        operationId: recovery.operation.operationId,
        reconciled: recovery.changed,
        retryEligible: false,
        ...(observation === undefined ? {} : { observation }),
      }, `Delegation pre-effect failure reconciled; retry is not eligible\nOperation: ${recovery.operation.operationId}\n`);
      return 8;
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
      writeResult(io, options.json, "delegations.resume", takeover,
        `Delegation coordinator takeover reconciled\nGroup: ${takeover.groupId}\n`);
      return revision.status === "accepted" ? 0 : 8;
    }
    if (["active", "waiting_approval", "cancelling", "reconciling", "blocked"].includes(revision.status)) {
      if (observation === undefined) {
        throw new DelegationError("delegation_effect_reconciliation_required", "delegation has no exact recoverable operation journal");
      }
      writeResult(io, options.json, "delegations.resume", observation,
        `Delegation recovery: ${observation.reconcile.kind}\nOperation: ${observation.operationId}\n`);
      return observation.reconcile.kind === "terminal_backfilled" || observation.reconcile.kind === "cancelled_clean" ? 0 : 8;
    }
    if (revision.status === "queued") {
      const retryOptions = delegationContinuationOptions(options);
      if (revision.envelope === null) {
        const prepared = await executeDelegationsPrepare(retryOptions, runtime, io);
        if (prepared !== 0) return prepared;
      }
      return executeDelegationsStart(retryOptions, runtime, io);
    }
    const result = await new DelegationControlPlane(delegationWriterFactory(runtime)).enqueue({
      context: delegationMutationContext(runtime, options),
      delegationId: options.delegationId,
    });
    writeResult(io, options.json, "delegations.resume", document(result.delegation), `Delegation queued: ${result.delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

async function storeCapabilitySnapshot(runtime: CliRuntime, sessionId: string, runId: string, requested: readonly string[]) {
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

function factReader(runtime: CliRuntime, sessionId: string, sourceSnapshotSha256: string): ContextFactReaderV1 {
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
  runtime: CliRuntime,
  io: CliIO,
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
  const manager = await runtime.createManagedWorktreeManager?.({ io, sessionId });
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

export async function executeDelegationsPrepare(options: DelegationsShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
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
      context: delegationMutationContext(runtime, options),
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
    writeResult(io, options.json, "delegations.prepare", {
      childNotStarted: true,
      capsuleBytes: Buffer.byteLength(canonicalJson(result.capsule), "utf8"),
      capsuleSha256: result.capsule.capsuleSha256,
      envelopeSha256: result.envelope.envelopeSha256,
      toolCount: result.envelope.effectiveAuthority.toolIds.length,
      capabilityCount: delegation.content.authorityRequest.capabilityIds.length,
      model: result.envelope.model,
      workspace: result.envelope.workspace,
    }, `Delegation prepared (child not started)\nCapsule: ${result.capsule.capsuleSha256}\nEnvelope: ${result.envelope.envelopeSha256}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
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
  runtime: CliRuntime,
  io: CliIO,
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
    ? await managedExecution(runtime, io, sessionId, delegation, envelope.actor.attemptId)
    : null;
  return Object.freeze({ capsule, delegation, envelope, managed });
}

export async function executeDelegationsStart(options: DelegationsShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  const controller = new AbortController();
  const stopCancel = runtime.onCancel(() => controller.abort());
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
          io,
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
    const slotClaims = new Map<string, { readonly claimId: string; readonly admission: DelegationAdmissionV1 }>();
    const retryMutations = new DelegationRetryMutationQueue();
    const writerFactory = delegationWriterFactory(runtime);
    const mutationContext = delegationMutationContext(runtime, options);
    let writer = await writerFactory(mutationContext);
    try {
      await writer.appendDelegationEvent("delegation.group.lease.acquired", {
        coordinator_kind: coordinatorKind,
        coordinator_process_id: identity.pid,
        coordinator_process_start_identity: identity.processStartIdentity,
        group_id: groupId,
        lease_nonce_sha256: leaseNonceSha256,
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
        repository_id: admission.admitted[0]!.candidate.conflict.repositoryId,
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
          approvalPrompt: runtime.createApprovalPrompt(io),
          inputSurface: options.inputSurface ?? "cli",
          io,
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

            const internal = internalDelegationIO();
            const retryOptions = delegationContinuationOptions({
              ...options,
              delegationId,
            });
            const preparedExit = await executeDelegationsPrepare(
              retryOptions,
              runtime,
              internal.io,
            );
            if (preparedExit !== 0) {
              throw new DelegationError(
                "delegation_effect_reconciliation_required",
                `automatic retry could not prepare a fresh child envelope (${internalDiagnosticIdentity(internal.stderr())})`,
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
              io,
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
    let releaseReason: "terminal" | "cancelled" | null = null;
    writer = await writerFactory(mutationContext);
    try {
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status !== "fulfilled") continue;
        const item = admission.admitted[index]!;
        const delegationId = item.candidate.revision.delegationId;
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
          release_reason: outcome.value.receipt.status === "cancelled" ? "cancelled" : "terminal",
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
            : fulfilled.length === settled.length && fulfilled.every((result) =>
              result.receipt.status === "cancelled")
              ? "cancelled"
              : "blocked",
        });
        releaseReason = fulfilled.length === settled.length && fulfilled.every((result) =>
          result.receipt.status === "cancelled")
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
    const results = settled.map((outcome, index) => outcome.status === "fulfilled"
      ? {
          delegationId: admission.admitted[index]!.candidate.revision.delegationId,
          childRunId: outcome.value.childRunId,
          receiptSha256: outcome.value.receipt.receiptSha256,
          status: outcome.value.receipt.status,
        }
      : {
          delegationId: admission.admitted[index]!.candidate.revision.delegationId,
          error: outcome.reason instanceof DelegationError ? outcome.reason.code : "delegation_effect_reconciliation_required",
          diagnostic: internalDiagnosticIdentity(outcome.reason),
          status: "blocked" as const,
        });
    writeResult(io, options.json, "delegations.start", {
      groupId,
      results,
      deferred: admission.deferred,
    }, [
      `Delegation group ${groupId} terminal`,
      ...results.map((result) => `${result.delegationId} ${result.status}${"receiptSha256" in result ? ` receipt=${result.receiptSha256}` : ""}`),
      ...admission.deferred.map((item) => `${item.delegationId} deferred=${item.reason}`),
      "",
    ].join("\n"));
    if (controller.signal.aborted) {
      io.stderr.write("delegation_cancelled: delegated child cancellation reached a reconciled terminal\n");
      return 130;
    }
    return settled.every((outcome) =>
      outcome.status === "fulfilled" && outcome.value.receipt.status === "succeeded") ? 0 : 8;
  } catch (error) {
    if (controller.signal.aborted) {
      io.stderr.write("delegation_cancelled: delegated child cancellation was requested\n");
      return 130;
    }
    return failure(error, io);
  } finally {
    stopCancel();
  }
}

export async function executeDelegationsReceipt(options: DelegationsShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const state = await session(runtime, options.sessionId);
    const revision = [...state.delegations.revisions].reverse().find((candidate) => candidate.delegationId === options.delegationId);
    if (revision === undefined || revision.receipt === null) throw new DelegationError("delegation_receipt_invalid", "delegation has no receipt");
    const receipt = await readVerifiedChildReceipt({ workspace: runtime.cwd, sessionId: options.sessionId, revision });
    writeResult(io, options.json, "delegations.receipt", receipt,
      `Receipt ${receipt.receiptSha256}: ${receipt.status}\n${receipt.summary}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsDoctor(options: DelegationsListOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const state = await session(runtime, options.sessionId);
    const descriptor = await (runtime.doctorDelegationChild?.() ?? Promise.reject(new DelegationError("delegation_handshake_failed", "runtime has no sealed child doctor")));
    const allOperations = await (runtime.inspectDelegationOperations?.(options.sessionId) ?? Promise.resolve([]));
    const operations = options.delegationId === undefined
      ? allOperations
      : allOperations.filter((operation) => operation.delegationId === options.delegationId);
    const result = {
      valid: true,
      descriptor: { ...descriptor, runtimeExecutablePath: undefined, productEntrypointPath: undefined },
      trackingMode: state.delegations.trackingMode,
      activeActorSlots: state.delegations.activeActorSlots.length,
      activeConflictClaims: state.delegations.activeConflictClaims.length,
      operations,
      unsupported: ["nested_delegation", "daemon", "remote_worker", "automatic_publish"],
    };
    writeResult(io, options.json, "delegations.doctor", result,
      `Delegation runtime: valid\nProtocol: ${String(descriptor.protocolVersion)}\nActive slots: ${String(result.activeActorSlots)}/2\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}
