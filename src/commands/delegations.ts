import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { canonicalJson } from "../completion/canonical-json.js";
import { taskMutationContext, taskWriterFactory } from "./task-control-plane-command.js";
import {
  executeDelegationOwnerPrepare,
  executeDelegationOwnerResume,
  executeDelegationOwnerStart,
  type DelegationOwnerExecutionOutcomeV1,
  type DelegationOwnerExecutionV1,
} from "../delegation/delegation-owner-execution-service.js";
import {
  createDelegationOwnerInteractionPort,
  createDelegationOwnerRuntimePort,
} from "../delegation/delegation-owner-cli-ports.js";
import { DelegationControlPlane } from "../delegation/delegation-control-plane.js";
import { DelegationFileLoader } from "../delegation/delegation-file-loader.js";
import { DelegationError } from "../delegation/delegation-errors.js";
import { preparedChildEnvelopeSchema } from "../delegation/context/child-envelope-schema.js";
import { readVerifiedChildReceipt } from "../delegation/receipts/child-receipt-verifier.js";
import { SessionCatalog, SessionCatalogError } from "../sessions/session-catalog.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { SessionProjectionError } from "../sessions/reconstruct-multi-run-session.js";
import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import { parseStrictJson } from "../system/strict-json.js";
import {
  executeTaskActionThroughApplicationService,
  requestActiveDelegationCancelThroughApplicationService,
} from "../control-plane/adapters/task-cli-adapter.js";
import type { DelegationCompositeResultV1 } from "../control-plane/use-cases/delegation-composite-actions.js";
import {
  queryDelegationDoctorThroughApplicationService,
  queryDelegationParentThroughApplicationService,
  queryDelegationReceiptThroughApplicationService,
  queryDelegationSummariesThroughApplicationService,
} from "../control-plane/adapters/task-surface-cli-query-adapter.js";

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

export type { DelegationOwnerExecutionV1 } from "../delegation/delegation-owner-execution-service.js";

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

async function summary(
  runtime: CliRuntime,
  sessionId: string,
  state: Pick<DelegationSession, "worktrees">,
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

function delegationCompositePresentation(result: DelegationCompositeResultV1): Readonly<{
  readonly command: "delegations.prepare" | "delegations.resume" | "delegations.start";
  readonly human: string;
}> {
  switch (result.kind) {
    case "pre_effect_terminal":
      return Object.freeze({
        command: "delegations.start",
        human: `Delegation ${result.delegationId} cancelled before child effect admission\n`,
      });
    case "prepared":
      return Object.freeze({
        command: "delegations.prepare",
        human: `Delegation prepared (child not started)\nCapsule: ${result.capsuleSha256}\nEnvelope: ${result.envelopeSha256}\n`,
      });
    case "group_terminal":
      return Object.freeze({
        command: "delegations.start",
        human: [
          `Delegation group ${result.groupId} ${result.terminalStatus}`,
          ...result.results.map((item) =>
            `${item.delegationId} ${item.status}${"receiptSha256" in item ? ` receipt=${item.receiptSha256}` : ""}`),
          ...result.deferred.map((item) => `${item.delegationId} deferred=${item.reason}`),
          "",
        ].join("\n"),
      });
    case "queued":
      return Object.freeze({
        command: "delegations.resume",
        human: `Delegation queued: ${result.delegation.delegationId}\n`,
      });
    case "pre_effect_recovery":
      return Object.freeze({
        command: "delegations.resume",
        human: `Delegation pre-effect failure reconciled; retry is not eligible\nOperation: ${result.operationId}\n`,
      });
    case "group_takeover":
      return Object.freeze({
        command: "delegations.resume",
        human: `Delegation coordinator takeover reconciled\nGroup: ${result.takeover.groupId}\n`,
      });
    case "operation_recovery":
      return Object.freeze({
        command: "delegations.resume",
        human: `Delegation recovery: ${result.observation.reconcile.kind}\nOperation: ${result.observation.operationId}\n`,
      });
  }
}

function delegationCompositeExitCode(
  result: DelegationCompositeResultV1,
  fallback: DelegationOwnerExecutionOutcomeV1["exitCode"],
): DelegationOwnerExecutionOutcomeV1["exitCode"] {
  if (result.kind === "pre_effect_terminal") return 130;
  if (result.kind !== "group_terminal") return fallback;
  if (result.terminalStatus === "cancelled") return 130;
  if (result.terminalStatus === "blocked") return 8;
  return 0;
}

export function renderDelegationOwnerOutcome(
  outcome: DelegationOwnerExecutionOutcomeV1,
  json: boolean,
  io: CliIO,
): DelegationOwnerExecutionOutcomeV1["exitCode"] {
  if (outcome.result !== null) {
    const presentation = delegationCompositePresentation(outcome.result);
    writeResult(io, json, presentation.command, outcome.result, presentation.human);
  }
  if (outcome.diagnostic !== null) {
    io.stderr.write(outcome.diagnostic.message.length === 0
      ? `${outcome.diagnostic.code}\n`
      : `${outcome.diagnostic.code}: ${outcome.diagnostic.message}\n`);
  }
  return outcome.result === null ? outcome.exitCode : delegationCompositeExitCode(outcome.result, outcome.exitCode);
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

async function session(runtime: CliRuntime, sessionId: string) {
  assertCanonicalSessionId(sessionId);
  return new SessionCatalog(runtime.cwd).read(sessionId);
}

function delegationMutationContext(
  runtime: CliRuntime,
  options: DelegationsListOptions,
  ownerExecution?: DelegationOwnerExecutionV1,
) {
  return Object.freeze({
    ...taskMutationContext(
    runtime,
    options.sessionId,
    options.inputSurface ?? "cli",
    options.expectedSessionSeq,
    ),
    ...(ownerExecution === undefined ? {} : { authenticatedApplication: ownerExecution.authenticatedMutation }),
  });
}

async function executeDelegationCompositeSurface(
  actionKind: "delegation.prepare" | "delegation.resume" | "delegation.start",
  options: DelegationsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 8 | 130> {
  const response = await executeTaskActionThroughApplicationService({
    actionKind,
    io,
    ...(options.expectedSessionSeq === undefined ? {} : { expectedSessionSeq: options.expectedSessionSeq }),
    payload: { delegationId: options.delegationId },
    runtime,
    sessionId: options.sessionId,
    ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
  });
  if (response.envelope.result === null) return response.exitCode;
  const result = response.envelope.result;
  const presentation = delegationCompositePresentation(result);
  writeResult(io, options.json, presentation.command, result, presentation.human);
  if (result.kind === "pre_effect_terminal") return 130;
  if (result.kind === "group_terminal") {
    if (result.terminalStatus === "cancelled") return 130;
    if (result.terminalStatus === "blocked") return 8;
    return 0;
  }
  return response.exitCode;
}

export async function executeDelegationsList(options: DelegationsListOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    if (runtime.controlPlaneStateRoot !== undefined) {
      const queried = await queryDelegationSummariesThroughApplicationService({
        delegationId: options.delegationId ?? null,
        io,
        runtime,
        sessionId: options.sessionId,
        status: options.status ?? null,
        ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
      });
      if (queried.value === null) return queried.exitCode;
      const records = queried.value.records;
      writeResult(io, options.json, "delegations.list", queried.value, records.length === 0
        ? "Delegations: none\n"
        : records.map((record) => `${String(record.sequence)} ${record.delegationId} r${String(record.revision)} ${record.status} ${record.title}\n`).join(""));
      return 0;
    }
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
    if (runtime.controlPlaneStateRoot !== undefined) {
      const queried = await queryDelegationSummariesThroughApplicationService({
        delegationId: options.delegationId,
        io,
        runtime,
        sessionId: options.sessionId,
        status: null,
        ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
      });
      if (queried.value === null) return queried.exitCode;
      const result = queried.value.records.at(-1);
      if (result === undefined) throw new DelegationError("delegation_revision_conflict", "delegation was not found");
      writeResult(io, options.json, "delegations.show", result,
        `Delegation ${result.delegationId} r${String(result.revision)} ${result.status}\nSHA-256: ${result.sha256}\nObjective: ${result.objective}\n`);
      return 0;
    }
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
    const current = runtime.controlPlaneStateRoot === undefined ? await session(runtime, options.sessionId) : null;
    const applicationParent = runtime.controlPlaneStateRoot === undefined
      ? null
      : await queryDelegationParentThroughApplicationService({
          io,
          runtime,
          sessionId: options.sessionId,
          ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
        });
    if (applicationParent !== null && applicationParent.value === null) return applicationParent.exitCode;
    const parentRunId = applicationParent?.value?.parentRunId ?? current?.lastRun?.runId ?? null;
    if (parentRunId === null) throw new DelegationError("delegation_parent_not_active", "session has no parent run");
    const loaded = await new DelegationFileLoader().load(runtime.cwd, options.file);
    const base = options.baseRevision === undefined ? null : { revision: positive(options.baseRevision, "base revision"), sha256: sha(options.baseSha256!) };
    const delegation = runtime.controlPlaneStateRoot === undefined
      ? (await new DelegationControlPlane(delegationWriterFactory(runtime)).replace({
          base,
          context: delegationMutationContext(runtime, options),
          parentRunId,
          revision: loaded,
        })).delegation
      : (await executeTaskActionThroughApplicationService({
          actionKind: "delegation.propose",
          io,
          payload: { base, parentRunId, revision: loaded.content },
          runtime,
          sessionId: options.sessionId,
          ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
        })).envelope.result;
    if (delegation === null) return 2;
    writeResult(io, options.json, "delegations.propose", document(delegation),
      `Delegation draft ${delegation.delegationId} r${String(delegation.delegationRevision)}\nSHA-256: ${delegation.delegationSha256}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsApprove(options: DelegationsDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const payload = {
      decision: "approve" as const,
      delegationId: options.delegationId,
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
    };
    let delegation = runtime.controlPlaneStateRoot === undefined
      ? (await new DelegationControlPlane(delegationWriterFactory(runtime)).approve({
          context: delegationMutationContext(runtime, options),
          delegationId: payload.delegationId,
          revision: payload.revision,
          sha256: payload.sha256,
          queue: options.queue === true,
        })).delegation
      : (await executeTaskActionThroughApplicationService({
          actionKind: "delegation.decide",
          io,
          payload,
          runtime,
          sessionId: options.sessionId,
          ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
        })).envelope.result;
    if (delegation === null) return 2;
    if (runtime.controlPlaneStateRoot !== undefined && options.queue === true) {
      delegation = (await executeTaskActionThroughApplicationService({
        actionKind: "delegation.enqueue",
        io,
        payload: { delegationId: options.delegationId },
        runtime,
        sessionId: options.sessionId,
        ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
      })).envelope.result;
      if (delegation === null) return 2;
    }
    writeResult(io, options.json, "delegations.approve", document(delegation),
      `Delegation ${delegation.status}: ${delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsReject(options: DelegationsDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const payload = {
      decision: "reject" as const,
      delegationId: options.delegationId,
      reason: options.reason ?? "rejected by local owner",
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
    };
    const delegation = runtime.controlPlaneStateRoot === undefined
      ? (await new DelegationControlPlane(delegationWriterFactory(runtime)).reject({
          context: delegationMutationContext(runtime, options),
          delegationId: payload.delegationId,
          reason: payload.reason,
          revision: payload.revision,
          sha256: payload.sha256,
        })).delegation
      : (await executeTaskActionThroughApplicationService({
          actionKind: "delegation.decide",
          io,
          payload,
          runtime,
          sessionId: options.sessionId,
          ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
        })).envelope.result;
    if (delegation === null) return 2;
    writeResult(io, options.json, "delegations.reject", document(delegation), `Delegation rejected: ${delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsCancel(options: DelegationsCancelOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const delegation = runtime.controlPlaneStateRoot === undefined
      ? (await new DelegationControlPlane(delegationWriterFactory(runtime)).cancel({
          context: delegationMutationContext(runtime, options),
          delegationId: options.delegationId,
          reason: options.reason,
        })).delegation
      : (await requestActiveDelegationCancelThroughApplicationService({
          delegationId: options.delegationId,
          io,
          reason: options.reason,
          runtime,
          sessionId: options.sessionId,
          surface: options.inputSurface ?? "cli",
        })).envelope.result;
    if (delegation === null) return 2;
    writeResult(io, options.json, "delegations.cancel", document(delegation), `Delegation cancellation requested: ${delegation.delegationId}\n`);
    return 0;
  } catch (error) { return failure(error, io); }
}

export async function executeDelegationsResume(
  options: DelegationsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  if (runtime.controlPlaneStateRoot !== undefined && ownerExecution === undefined) {
    return executeDelegationCompositeSurface("delegation.resume", options, runtime, io);
  }
  return renderDelegationOwnerOutcome(
    await executeDelegationOwnerResume(
      {
        delegationId: options.delegationId,
        ...(options.expectedSessionSeq === undefined ? {} : { expectedSessionSeq: options.expectedSessionSeq }),
        ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
        sessionId: options.sessionId,
      },
      createDelegationOwnerRuntimePort(runtime, io),
      createDelegationOwnerInteractionPort(runtime, io),
      ownerExecution,
    ),
    options.json,
    io,
  );
}
export async function executeDelegationsPrepare(
  options: DelegationsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  if (runtime.controlPlaneStateRoot !== undefined && ownerExecution === undefined) {
    return executeDelegationCompositeSurface("delegation.prepare", options, runtime, io) as Promise<0 | 1 | 2 | 3 | 7 | 8>;
  }
  return renderDelegationOwnerOutcome(
    await executeDelegationOwnerPrepare(
      {
        delegationId: options.delegationId,
        ...(options.expectedSessionSeq === undefined ? {} : { expectedSessionSeq: options.expectedSessionSeq }),
        ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
        sessionId: options.sessionId,
      },
      createDelegationOwnerRuntimePort(runtime, io),
      createDelegationOwnerInteractionPort(runtime, io),
      ownerExecution,
    ),
    options.json,
    io,
  ) as Exclude<DelegationOwnerExecutionOutcomeV1["exitCode"], 130>;
}

export async function executeDelegationsStart(
  options: DelegationsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
  ownerExecution?: DelegationOwnerExecutionV1,
): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  if (runtime.controlPlaneStateRoot !== undefined && ownerExecution === undefined) {
    return executeDelegationCompositeSurface("delegation.start", options, runtime, io);
  }
  return renderDelegationOwnerOutcome(
    await executeDelegationOwnerStart(
      {
        delegationId: options.delegationId,
        ...(options.expectedSessionSeq === undefined ? {} : { expectedSessionSeq: options.expectedSessionSeq }),
        ...(options.inputSurface === undefined ? {} : { inputSurface: options.inputSurface }),
        sessionId: options.sessionId,
      },
      createDelegationOwnerRuntimePort(runtime, io),
      createDelegationOwnerInteractionPort(runtime, io),
      ownerExecution,
    ),
    options.json,
    io,
  );
}
export async function executeDelegationsReceipt(
  options: DelegationsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    if (runtime.controlPlaneStateRoot !== undefined) {
      const queried = await queryDelegationReceiptThroughApplicationService({
        delegationId: options.delegationId,
        io,
        runtime,
        sessionId: options.sessionId,
        ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
      });
      if (queried.value === null) return queried.exitCode;
      const receipt = queried.value.receipt;
      writeResult(io, options.json, "delegations.receipt", receipt,
        `Receipt ${receipt.receiptSha256}: ${receipt.status}\n${receipt.summary}\n`);
      return 0;
    }
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
    const descriptor = await (runtime.doctorDelegationChild?.() ?? Promise.reject(new DelegationError("delegation_handshake_failed", "runtime has no sealed child doctor")));
    if (runtime.controlPlaneStateRoot !== undefined) {
      const queried = await queryDelegationDoctorThroughApplicationService({
        delegationId: options.delegationId ?? null,
        io,
        runtime,
        sessionId: options.sessionId,
        status: options.status ?? null,
        ...(options.inputSurface === undefined ? {} : { surface: options.inputSurface }),
      });
      if (queried.value === null) return queried.exitCode;
      const result = {
        valid: true,
        descriptor: { ...descriptor, runtimeExecutablePath: undefined, productEntrypointPath: undefined },
        ...queried.value,
        unsupported: ["nested_delegation", "daemon", "remote_worker", "automatic_publish"],
      };
      writeResult(io, options.json, "delegations.doctor", result,
        `Delegation runtime: valid\nProtocol: ${String(descriptor.protocolVersion)}\nActive slots: ${String(result.activeActorSlots)}/2\n`);
      return 0;
    }
    const state = await session(runtime, options.sessionId);
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
