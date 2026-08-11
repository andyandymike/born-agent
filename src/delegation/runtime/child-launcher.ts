import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { ArtifactStore } from "../../artifacts/artifact-store.js";
import type { ApprovalPreview, ApprovalPrompt } from "../../approvals/approval-types.js";
import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../../coordination/task-control-plane.js";
import { taskMutationBlocker } from "../../coordination/task-control-plane.js";
import { SessionCatalog } from "../../sessions/session-catalog.js";
import { SessionLockError } from "../../sessions/session-lock.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import { parseStrictJson } from "../../system/strict-json.js";
import type { TaskGraphBudgetV1 } from "../../task-graph/task-graph-schema.js";
import type {
  ProcessTreeCleanup,
  ProcessTreeCleanupResult,
} from "../../execution/process-tree-cleanup.js";
import type { DelegationBudgetReservationV1 } from "../delegation-budget-ledger.js";
import { DelegationPreEffectRecovery } from "../delegation-pre-effect-recovery.js";
import { DelegationOperationStore } from "../delegation-operation-store.js";
import {
  createDelegationChildOperation,
  type DelegationChildOperationV1,
} from "../delegation-operation-schema.js";
import { DelegationError } from "../delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "../delegation-projector.js";
import type { ContextCapsuleV1 } from "../context/context-capsule-schema.js";
import type { PreparedChildEnvelopeV1 } from "../context/child-envelope-schema.js";
import {
  ChildReceiptBuilder,
  type CandidateChildReceiptClaimV1,
} from "../receipts/child-receipt-builder.js";
import { readVerifiedChildReceipt } from "../receipts/child-receipt-verifier.js";
import type { ChildReceiptBudgetUsageV1, ChildReceiptV1 } from "../receipts/child-receipt-schema.js";
import {
  assertBoundedProtocolFrame,
  delegationChildApprovalRequestFrameSchema,
  delegationChildHandshakeSchema,
  delegationChildTerminalFrameSchema,
  type DelegationChildApprovalRequestFrameV1,
  type DelegationChildHandshakeV1,
  type DelegationChildTerminalFrameV1,
} from "./child-handshake-schema.js";
import {
  revalidateDelegationChildExecutable,
  sealDelegationChildExecutable,
} from "./child-executable-descriptor.js";
import { createExecutableChildEnvelope, type ExecutableChildEnvelopeV1 } from "./executable-child-envelope.js";
import {
  childSessionShardWorkspace,
  importChildSessionShard,
  seedChildSessionShard,
} from "./child-session-shard.js";
import type { DelegationSessionWriterQueue } from "./child-session-shard.js";
import type { DelegationApprovalPromptQueue } from "./child-session-shard.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

const RETRYABLE_SESSION_LOCK_CODES = new Set<SessionLockError["code"]>([
  "active_session_lock",
  "lock_identity_changed",
  "lock_too_young",
  "unknown_session_lock_owner",
]);

async function openDelegationWriter(
  factory: TaskMutationWriterFactory,
  context: TaskMutationContext,
): ReturnType<TaskMutationWriterFactory> {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  for (;;) {
    try {
      return await factory(context);
    } catch (error) {
      if (
        !(error instanceof SessionLockError) ||
        !RETRYABLE_SESSION_LOCK_CODES.has(error.code) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // TUI/session status reads deliberately take the same short-lived lock
      // as mutations. Wait with a bounded, non-harmonic cadence; never remove,
      // recover, or impersonate the observed owner.
      const delayMs = 11 + ((attempt * 17) % 29);
      attempt += 1;
      await delay(delayMs);
    }
  }
}

export interface DelegationChildProcessFactoryV1 {
  spawn(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly executable: string;
  }): ChildProcess;
}

const nodeFactory: DelegationChildProcessFactoryV1 = {
  spawn(input) {
    return spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      // A Windows ConPTY Ctrl+C belongs to the foreground Host/TUI. Give the
      // sealed child its own hidden process group so cancellation reaches it
      // only through the durable, nonce-bound IPC protocol. The parent still
      // retains IPC ownership and performs bounded process-tree cleanup.
      detached: true,
      env: input.env,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
  },
};

function childEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  operationRoot: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "NO_COLOR", "BORN_PROVIDER", "BORN_MODEL", "BORN_OLLAMA_BASE_URL"] as const) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  result.BORN_DELEGATION_CHILD_STATE_ROOT = operationRoot;
  result.GIT_TERMINAL_PROMPT = "0";
  result.NO_COLOR = "1";
  return result;
}

function budgetCounters(budget: TaskGraphBudgetV1) {
  return {
    artifact_bytes: budget.maxArtifactBytes,
    attempts: budget.maxAttempts,
    changed_bytes: budget.maxChangedBytes,
    changed_files: budget.maxChangedFiles,
    command_executions: budget.maxCommandExecutions,
    command_output_bytes: budget.maxCommandOutputBytes,
    duration_ms: budget.maxDurationMs,
    model_steps: budget.maxModelSteps,
    reported_tokens: budget.maxReportedTokens,
  };
}

function usageCounters(usage: ChildReceiptBudgetUsageV1) {
  return {
    artifact_bytes: usage.artifactBytes,
    attempts: usage.attempts,
    changed_bytes: usage.changedBytes,
    changed_files: usage.changedFiles,
    command_executions: usage.commandExecutions,
    command_output_bytes: usage.commandOutputBytes,
    duration_ms: usage.durationMs,
    model_steps: usage.modelSteps,
    reported_tokens: usage.reportedTokens,
  };
}

function releasedCounters(reserved: TaskGraphBudgetV1, used: ChildReceiptBudgetUsageV1) {
  return {
    artifact_bytes: Math.max(0, reserved.maxArtifactBytes - used.artifactBytes),
    attempts: Math.max(0, reserved.maxAttempts - used.attempts),
    changed_bytes: Math.max(0, reserved.maxChangedBytes - used.changedBytes),
    changed_files: Math.max(0, reserved.maxChangedFiles - used.changedFiles),
    command_executions: Math.max(0, reserved.maxCommandExecutions - used.commandExecutions),
    command_output_bytes: Math.max(0, reserved.maxCommandOutputBytes - used.commandOutputBytes),
    duration_ms: Math.max(0, reserved.maxDurationMs - used.durationMs),
    model_steps: Math.max(0, reserved.maxModelSteps - used.modelSteps),
    reported_tokens: reserved.maxReportedTokens === null || used.reportedTokens === null
      ? null
      : Math.max(0, reserved.maxReportedTokens - used.reportedTokens),
  };
}

async function storeArtifact(input: {
  readonly workspace: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}) {
  const store = await ArtifactStore.create({ sessionId: input.sessionId, workspace: input.workspace });
  const captured = await store.storeSanitizedText({ chunks: [input.bytes], maximumBytes: 512 * 1024, runId: input.runId });
  if (
    captured.captureStatus !== "complete" || captured.artifact === null ||
    captured.artifact.sha256 !== input.sha256 || captured.artifact.bytes !== input.bytes.byteLength
  ) {
    throw new DelegationError("delegation_artifact_invalid", "delegation runtime artifact could not be stored exactly");
  }
  await store.readVerified(captured.artifact.artifactId);
  return Object.freeze({
    artifact_id: captured.artifact.artifactId,
    bytes: captured.artifact.bytes,
    object_ref: captured.artifact.objectRef,
    sha256: captured.artifact.sha256,
  });
}

function send(child: ChildProcess, frame: unknown): Promise<void> {
  assertBoundedProtocolFrame(frame);
  return new Promise((resolveSend, reject) => {
    if (!child.connected) {
      reject(new DelegationError("delegation_handshake_failed", "child IPC channel is closed"));
      return;
    }
    child.send(frame as Parameters<ChildProcess["send"]>[0], (error) => error === null ? resolveSend() : reject(error));
  });
}

function waitHandshake(child: ChildProcess, timeoutMs: number): Promise<DelegationChildHandshakeV1> {
  return new Promise((resolveHandshake, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: DelegationChildHandshakeV1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error === null) resolveHandshake(value!);
      else reject(error);
    };
    const onMessage = (message: unknown) => {
      const parsed = delegationChildHandshakeSchema.safeParse(message);
      if (!parsed.success) {
        finish(new DelegationError("delegation_child_protocol_invalid", "first child IPC frame is not a valid handshake"));
      } else finish(null, parsed.data);
    };
    const onError = (error: Error) => finish(new DelegationError("delegation_handshake_failed", "child failed before handshake", { cause: error }));
    const onExit = () => finish(new DelegationError("delegation_handshake_failed", "child exited before handshake"));
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    const timeout = setTimeout(() => finish(new DelegationError("delegation_handshake_failed", "child handshake timed out")), timeoutMs);
  });
}

async function verifyDurableApprovalRequest(input: {
  readonly context: TaskMutationContext;
  readonly frame: DelegationChildApprovalRequestFrameV1;
  readonly envelope: ExecutableChildEnvelopeV1;
  readonly operation: DelegationChildOperationV1;
  readonly writerFactory: TaskMutationWriterFactory;
}): Promise<ApprovalPreview> {
  const preview = input.frame.preview as unknown as ApprovalPreview;
  if (preview.actionKind !== input.frame.actionKind) {
    throw new DelegationError("delegation_decision_mismatch", "child approval preview kind does not match its frame");
  }
  const expected = sha256Canonical({
    action: preview,
    approval_namespace: input.envelope.prepared.approvalNamespace,
    actor_id: input.envelope.prepared.actor.actorId,
    attempt_id: input.envelope.prepared.actor.attemptId,
    delegation_sha256: input.envelope.prepared.actor.delegationSha256,
    workspace: input.envelope.prepared.workspace,
  });
  if (expected !== input.frame.actionDigest) {
    throw new DelegationError("delegation_decision_mismatch", "child approval action digest is not actor scoped");
  }
  const session = await new SessionCatalog(
    childSessionShardWorkspace(input.operation),
  ).read(input.context.sessionId).catch(async (error) => {
    // The child owns the shard lock while an approval is pending. Read-only
    // verification may observe only complete, synced JSONL lines.
    if (!(error instanceof Error)) throw error;
    const { readStoredSession } = await import("../../sessions/read-stored-session.js");
    const { SessionPathPolicy } = await import("../../sessions/session-path-policy.js");
    const policy = await SessionPathPolicy.create(
      childSessionShardWorkspace(input.operation),
    );
    const paths = await policy.inspectExistingSession(input.context.sessionId);
    const { reconstructMultiRunSession } = await import("../../sessions/reconstruct-multi-run-session.js");
    return reconstructMultiRunSession(await readStoredSession(paths.sessionFilePath));
  });
  const durable = session.events.find((event) =>
    event.scope === "session" && event.type === "delegation.child.approval_waiting" &&
    event.data.approval_request_id === input.frame.approvalRequestId &&
    event.data.action_digest === input.frame.actionDigest &&
    event.data.child_attempt_id === input.frame.childAttemptId);
  if (durable === undefined) {
    throw new DelegationError("delegation_decision_mismatch", "child approval request was not durable before presentation");
  }
  const previewActionSha256 = preview.actionKind === "apply_patch"
    ? (preview.actionSha256 ?? preview.planId)
    : preview.actionSha256;
  const durableRunRequest = [...session.events].reverse().find((event) => {
    if (
      event.scope !== "run" || event.runId !== input.operation.childRunId ||
      event.sessionSeq > durable.sessionSeq
    ) return false;
    if (event.type === "approval.requested") {
      const actionSha256 = event.data.action === "apply_patch"
        ? (event.data.action_sha256 ?? event.data.plan_id)
        : event.data.action_sha256;
      return event.data.action === preview.actionKind && actionSha256 === previewActionSha256;
    }
    return event.type === "mcp.approval.requested" &&
      event.data.action_kind === preview.actionKind &&
      event.data.action_sha256 === previewActionSha256;
  });
  if (durableRunRequest === undefined) {
    throw new DelegationError(
      "delegation_decision_mismatch",
      "child approval bridge has no exact durable run approval request",
    );
  }
  const parentWriter = await input.writerFactory(input.context);
  try {
    const existingIds = new Set(parentWriter.events.map((event) => event.eventId));
    const liveRunPrefix = session.events.filter((event) =>
      event.sessionSeq <= durable.sessionSeq &&
      event.scope === "run" && event.runId === input.operation.childRunId);
    const appendMissing = async (events: typeof liveRunPrefix): Promise<void> => {
      for (const event of events) {
        if (!existingIds.has(event.eventId)) {
          await parentWriter.appendImportedEvent(event);
          existingIds.add(event.eventId);
        }
      }
    };
    // PHASE20: close the previous run approval first, then project the new
    // actor/attempt-scoped wait, and only then expose its ordinary approval
    // modal. This removes both the unidentified-action window and stale early
    // decisions racing a consecutive child effect.
    await appendMissing(liveRunPrefix.filter((event) =>
      event.sessionSeq < durableRunRequest.sessionSeq));
    if (!existingIds.has(durable.eventId)) {
      await parentWriter.appendImportedEvent(durable);
      existingIds.add(durable.eventId);
    }
    await appendMissing(liveRunPrefix.filter((event) =>
      event.sessionSeq >= durableRunRequest.sessionSeq));
  } finally {
    await parentWriter.close();
  }
  return preview;
}

function waitTerminal(input: {
  readonly cancellationGraceMs: number;
  readonly child: ChildProcess;
  readonly context: TaskMutationContext;
  readonly envelope: ExecutableChildEnvelopeV1;
  readonly operation: DelegationChildOperationV1;
  readonly approvalQueue?: DelegationApprovalPromptQueue;
  readonly prompt: ApprovalPrompt;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly writerFactory: TaskMutationWriterFactory;
}): Promise<DelegationChildTerminalFrameV1> {
  return new Promise((resolveTerminal, reject) => {
    let settled = false;
    let approval = Promise.resolve();
    const abort = new AbortController();
    let cancellationRequested = input.signal?.aborted === true;
    let deliveredCancelRequestId: string | null = null;
    let cancelPollBusy = false;
    let cancelPoll: ReturnType<typeof setInterval> | null = null;
    let cancellationGrace: ReturnType<typeof setTimeout> | null = null;
    const armCancellationGrace = () => {
      if (cancellationGrace !== null || settled) return;
      cancellationGrace = setTimeout(() => finish(new DelegationError(
        "delegation_effect_reconciliation_required",
        "child ignored the bounded cancellation grace and requires verified process-tree cleanup",
      )), input.cancellationGraceMs);
    };
    const cancelModal = () => {
      cancellationRequested = true;
      if (cancelPoll !== null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      abort.abort();
    };
    const finish = (error: Error | null, terminal?: DelegationChildTerminalFrameV1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancellationGrace !== null) clearTimeout(cancellationGrace);
      if (cancelPoll !== null) clearInterval(cancelPoll);
      input.signal?.removeEventListener("abort", requestSignalCancellation);
      abort.abort();
      input.child.off("message", onMessage);
      input.child.off("error", onError);
      input.child.off("exit", onExit);
      if (error === null) resolveTerminal(terminal!);
      else reject(error);
    };
    const onMessage = (message: unknown) => {
      const terminal = delegationChildTerminalFrameSchema.safeParse(message);
      if (terminal.success) {
        approval.then(() => finish(null, terminal.data)).catch((error: unknown) => finish(error instanceof Error ? error : new Error("approval bridge failed")));
        return;
      }
      const requested = delegationChildApprovalRequestFrameSchema.safeParse(message);
      if (!requested.success) {
        finish(new DelegationError("delegation_child_protocol_invalid", "child emitted an unknown or invalid IPC frame"));
        return;
      }
      approval = approval.then(async () => {
        const preview = await verifyDurableApprovalRequest({
          context: input.context,
          envelope: input.envelope,
          frame: requested.data,
          operation: input.operation,
          writerFactory: input.writerFactory,
        });
        const decision = input.approvalQueue === undefined
          ? await input.prompt.request(preview, abort.signal)
          : await input.approvalQueue.request(input.prompt, preview, abort.signal);
        if (cancellationRequested) return;
        await send(input.child, {
          schemaVersion: 1,
          protocolVersion: 1,
          frame: "approval_decision",
          operationId: requested.data.operationId,
          childAttemptId: requested.data.childAttemptId,
          approvalRequestId: requested.data.approvalRequestId,
          actionDigest: requested.data.actionDigest,
          decision,
        });
      });
      void approval.catch((error: unknown) => {
        if (!cancellationRequested) {
          finish(error instanceof Error ? error : new Error("approval bridge failed"));
        }
      });
    };
    const onError = (error: Error) => finish(new DelegationError("delegation_child_protocol_invalid", "child process failed before terminal", { cause: error }));
    const onExit = () => finish(new DelegationError("delegation_effect_reconciliation_required", "child exited without a trusted terminal frame"));
    input.child.on("message", onMessage);
    input.child.once("error", onError);
    input.child.once("exit", onExit);
    const requestSignalCancellation = () => {
      cancelModal();
      approval = approval.then(async () => {
        // A separately issued durable cancellation wins this race. Otherwise
        // Ctrl+C first closes the approval modal, then appends one exact cancel
        // request after the approval-import writer has released its lock.
        if (deliveredCancelRequestId !== null) return;
        const cancelRequestId = input.context.randomUuid();
        const reason = "foreground delegated child cancellation requested";
        deliveredCancelRequestId = cancelRequestId;
        const cancelWriter = await input.writerFactory(input.context);
        try {
          await cancelWriter.appendDelegationEvent("delegation.cancel.requested", {
            cancel_request_id: cancelRequestId,
            delegation_id: input.envelope.prepared.actor.delegationId,
            delegation_revision: input.envelope.prepared.actor.delegationRevision,
            delegation_sha256: input.envelope.prepared.actor.delegationSha256,
            origin: { input_surface: input.context.inputSurface, kind: "user" },
            parent_actor_id: input.envelope.prepared.actor.parentActorId,
            parent_run_id: input.envelope.prepared.actor.parentRunId,
            reason,
            root_event_id: null,
          });
        } finally {
          await cancelWriter.close();
        }
        armCancellationGrace();
        await send(input.child, {
          schemaVersion: 1,
          protocolVersion: 1,
          frame: "cancel",
          operationId: input.operation.operationId,
          childAttemptId: input.envelope.prepared.actor.attemptId,
          cancelRequestId,
          reasonSha256: sha256Canonical({ reason }),
        });
      });
      void approval.catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("delegation cancellation bridge failed"));
      });
    };
    input.signal?.addEventListener("abort", requestSignalCancellation, { once: true });
    if (cancellationRequested) requestSignalCancellation();
    const pollDurableCancellation = async () => {
      if (settled || cancelPollBusy) return;
      cancelPollBusy = true;
      try {
        const session = await new SessionCatalog(input.context.workspace).read(input.context.sessionId);
        const actor = input.envelope.prepared.actor;
        const requested = [...session.events].reverse().find((event) =>
          event.scope === "session" && event.type === "delegation.cancel.requested" &&
          event.data.delegation_id === actor.delegationId &&
          event.data.delegation_revision === actor.delegationRevision &&
          event.data.delegation_sha256 === actor.delegationSha256 &&
          event.data.parent_actor_id === actor.parentActorId &&
          event.data.parent_run_id === actor.parentRunId);
        if (
          requested?.scope === "session" && requested.type === "delegation.cancel.requested" &&
          requested.data.cancel_request_id !== deliveredCancelRequestId
        ) {
          deliveredCancelRequestId = requested.data.cancel_request_id;
          cancelModal();
          armCancellationGrace();
          await send(input.child, {
            schemaVersion: 1,
            protocolVersion: 1,
            frame: "cancel",
            operationId: input.operation.operationId,
            childAttemptId: actor.attemptId,
            cancelRequestId: requested.data.cancel_request_id,
            reasonSha256: sha256Canonical({ reason: requested.data.reason }),
          }).catch(() => undefined);
        }
      } catch {
        // A concurrent append can make one read transiently unavailable. The
        // next bounded poll retries; child terminal/exit/timeout remains the
        // authoritative completion path.
      } finally {
        cancelPollBusy = false;
      }
    };
    void pollDurableCancellation();
    cancelPoll = setInterval(() => { void pollDurableCancellation(); }, 100);
    const timeout = setTimeout(() => finish(new DelegationError("delegation_effect_reconciliation_required", "child terminal timed out and requires reconciliation")), input.timeoutMs);
  });
}

function usageFromRun(run: Awaited<ReturnType<SessionCatalog["read"]>>["runs"][number] | undefined): ChildReceiptBudgetUsageV1 {
  const events = run?.events ?? [];
  const usage = [...events].reverse().find((event) => event.type === "usage");
  const commands = events.filter((event) => event.type === "command.completed");
  const artifacts = events.filter((event) => event.type === "artifact.stored");
  const duration = run?.terminal?.type === "run.completed" || run?.terminal?.type === "run.failed" || run?.terminal?.type === "run.cancelled" || run?.terminal?.type === "run.incomplete" || run?.terminal?.type === "run.budget_exceeded"
    ? run.terminal.data.duration_ms
    : 0;
  return Object.freeze({
    artifactBytes: artifacts.reduce((sum, event) => sum + event.data.bytes, 0),
    attempts: 1,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: commands.length,
    commandOutputBytes: commands.reduce((sum, event) => sum + event.data.total_bytes, 0),
    durationMs: duration,
    modelSteps: events.filter((event) => event.type === "agent.step.started").length,
    reportedTokens: usage?.type === "usage" ? usage.data.total_tokens : null,
  });
}

function terminalKind(status: string): "succeeded" | "known_failed" | "cancelled_clean" | "blocked_unknown_effect" {
  if (status === "completed") return "succeeded";
  if (status === "cancelled") return "cancelled_clean";
  if (["failed", "incomplete", "budget_exceeded"].includes(status)) return "known_failed";
  return "blocked_unknown_effect";
}

function failurePhase(
  state: DelegationChildOperationV1["state"],
): NonNullable<DelegationChildOperationV1["failure"]>["phase"] {
  if (state === "requested") return "before_spawn";
  if (state === "spawned") return "before_handshake";
  if (state === "handshaken" || state === "pre_effect_terminal") return "before_start_barrier";
  return "after_start_barrier";
}

function cleanupJournal(
  cleanup: ProcessTreeCleanupResult,
  pid: number,
  completedAt: string,
): NonNullable<DelegationChildOperationV1["processCleanup"]> {
  return Object.freeze({ ...cleanup, completedAt, pid });
}

export interface DelegationChildLaunchResultV1 {
  readonly childRunId: string;
  readonly operationId: string;
  readonly receipt: ChildReceiptV1;
  readonly terminalEventId: string;
}

export class DelegationChildLaunchFailure extends DelegationError {
  constructor(
    error: DelegationError,
    readonly operationId: string,
    readonly childAttemptId: string,
    readonly retryEligible: boolean,
  ) {
    super(error.code, error.message, { cause: error });
  }
}

export interface DelegationWorkspaceFinalizationV1 {
  readonly resultSnapshotSha256: string | null;
  readonly changeBundleRef: string | null;
  readonly changeBundleSha256: string | null;
  readonly candidateClaims: readonly CandidateChildReceiptClaimV1[];
}

export class DelegationChildLauncher {
  constructor(private readonly options: {
    readonly childFactory?: DelegationChildProcessFactoryV1;
    readonly cancellationGraceMs?: number;
    readonly cliEntryPath: string;
    readonly context: TaskMutationContext;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly handshakeTimeoutMs?: number;
    readonly nodeExecutablePath: string;
    readonly nodeVersion: string;
    readonly operationRoot: string;
    readonly processTreeCleanup: ProcessTreeCleanup;
    readonly prompt: ApprovalPrompt;
    readonly approvalQueue?: DelegationApprovalPromptQueue;
    readonly sessionWriterQueue?: DelegationSessionWriterQueue;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    const base = this.options.writerFactory ?? defaultWriterFactory;
    const queued = this.options.sessionWriterQueue?.wrap(base) ?? base;
    return (context) => openDelegationWriter(queued, context);
  }

  private async readParentSession() {
    const writer = await this.writerFactory(this.options.context);
    try {
      return reconstructMultiRunSession(writer.events);
    } finally {
      await writer.close();
    }
  }

  async launch(input: {
    readonly delegation: DelegationRevisionProjectionV1;
    readonly preparedEnvelope: PreparedChildEnvelopeV1;
    readonly capsule: ContextCapsuleV1;
    readonly reservation: DelegationBudgetReservationV1;
    readonly executionWorkspacePath: string;
    readonly finalizeWorkspace?: () => Promise<DelegationWorkspaceFinalizationV1>;
    readonly schedulerLeaseNonceSha256: string;
    readonly signal?: AbortSignal;
    readonly workspaceResult?: {
      readonly resultSnapshotSha256: string | null;
      readonly changeBundleRef: string | null;
      readonly changeBundleSha256: string | null;
    };
  }): Promise<DelegationChildLaunchResultV1> {
    const cancellationGraceMs = this.options.cancellationGraceMs ?? 5_000;
    if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 1 || cancellationGraceMs > 30_000) {
      throw new DelegationError(
        "delegation_child_protocol_invalid",
        "delegated child cancellation grace must be a bounded positive integer",
      );
    }
    const cancelled = () => input.signal?.aborted === true;
    if (cancelled()) {
      throw new DelegationError("delegation_cancelled", "delegated child launch was cancelled before admission");
    }
    if (
      input.delegation.status !== "queued" || input.delegation.envelope === null ||
      input.delegation.envelope.envelopeSha256 !== input.preparedEnvelope.envelopeSha256 ||
      input.preparedEnvelope.actor.attemptId !== input.reservation.childAttemptId ||
      input.reservation.status !== "held"
    ) {
      throw new DelegationError("delegation_binding_stale", "child launch inputs are not the exact prepared queued reservation");
    }
    const sealed = await sealDelegationChildExecutable({
      cliEntryPath: this.options.cliEntryPath,
      nodeExecutablePath: this.options.nodeExecutablePath,
      nodeVersion: this.options.nodeVersion,
    });
    const operationId = this.options.context.randomUuid();
    const childRunId = this.options.context.randomUuid();
    const rawNonce = randomBytes(32).toString("base64url");
    const nonceSha256 = createHash("sha256").update(rawNonce, "utf8").digest("hex");
    const startBarrierNonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");
    let writer = await this.writerFactory(this.options.context);
    const sessionLockNonceSha256 = writer.lockNonceSha256;
    if (sessionLockNonceSha256 === undefined) {
      await writer.close();
      throw new DelegationError("delegation_handshake_failed", "session writer has no exact lock nonce identity");
    }
    const executableEnvelope = createExecutableChildEnvelope({
      schemaVersion: 1,
      prepared: input.preparedEnvelope,
      execution: {
        executable: true,
        operationId,
        sessionId: this.options.context.sessionId,
        reservationId: input.reservation.reservationId,
        sessionLockNonceSha256,
        schedulerLeaseNonceSha256: input.schedulerLeaseNonceSha256,
        executableDescriptorSha256: sealed.descriptor.descriptorSha256,
        startBarrierNonceSha256,
      },
    });
    const executableBytes = Buffer.from(canonicalJson(executableEnvelope), "utf8");
    const capsuleBytes = Buffer.from(canonicalJson(input.capsule), "utf8");
    const executableArtifactSha256 = createHash("sha256").update(executableBytes).digest("hex");
    const capsuleArtifactSha256 = createHash("sha256").update(capsuleBytes).digest("hex");
    const executableArtifact = await storeArtifact({
      workspace: this.options.context.workspace,
      sessionId: this.options.context.sessionId,
      runId: input.delegation.delegationId,
      bytes: executableBytes,
      sha256: executableArtifactSha256,
    });
    const store = await DelegationOperationStore.create({ root: this.options.operationRoot, operationId });
    const envelopePath = await store.storePayload("envelope", executableBytes, executableArtifactSha256);
    const capsulePath = await store.storePayload("capsule", capsuleBytes, capsuleArtifactSha256);
    const operation = createDelegationChildOperation({
      schemaVersion: 1,
      revision: 1,
      operationId,
      sessionId: this.options.context.sessionId,
      delegationId: input.delegation.delegationId,
      childActorId: input.preparedEnvelope.actor.actorId,
      childAttemptId: input.preparedEnvelope.actor.attemptId,
      childRunId,
      parentRunId: input.delegation.parentRunId,
      envelopePath,
      envelopeArtifactSha256: executableArtifactSha256,
      envelopeSha256: executableEnvelope.envelopeSha256,
      capsulePath,
      capsuleArtifactSha256,
      capsuleSha256: input.capsule.capsuleSha256,
      sessionWorkspacePath: this.options.context.workspace,
      executionWorkspacePath: input.executionWorkspacePath,
      executableDescriptorSha256: sealed.descriptor.descriptorSha256,
      nonceSha256,
      startBarrierNonceSha256,
      requestedAt: this.options.context.now(),
      updatedAt: this.options.context.now(),
      state: "requested",
      process: null,
      processCleanup: null,
      failure: null,
      boundedResultRef: null,
      boundedResultSha256: null,
    });
    await store.initialize(operation);
    try {
      await writer.appendDelegationEvent("delegation.budget.reserved", {
        child_attempt_id: input.reservation.childAttemptId,
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
        reservation_id: input.reservation.reservationId,
        reservation_sha256: input.reservation.reservationSha256,
        reserved: budgetCounters(input.reservation.reserved),
      });
      await writer.appendDelegationEvent("delegation.child.launch_requested", {
        child_actor_id: input.preparedEnvelope.actor.actorId,
        child_attempt_id: input.preparedEnvelope.actor.attemptId,
        child_attempt_number: input.preparedEnvelope.actor.attemptNumber,
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        envelope_artifact: executableArtifact,
        envelope_sha256: executableEnvelope.envelopeSha256,
        prepared_envelope_sha256: input.preparedEnvelope.envelopeSha256,
        executable_descriptor_sha256: sealed.descriptor.descriptorSha256,
        operation_id: operationId,
        operation_nonce_sha256: nonceSha256,
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
      });
    } finally {
      await writer.close();
    }
    let child: ChildProcess | null = null;
    let current = (await store.read())!;
    const abortBeforeStart = () => child?.kill();
    input.signal?.addEventListener("abort", abortBeforeStart, { once: true });
    try {
      await revalidateDelegationChildExecutable(sealed);
      child = (this.options.childFactory ?? nodeFactory).spawn({
        argv: [sealed.descriptor.productEntrypointPath, "internal", "delegation-child", "--operation", operationId, "--envelope", envelopePath, "--nonce", rawNonce],
        cwd: input.executionWorkspacePath,
        env: childEnvironment(this.options.environment, this.options.operationRoot),
        executable: sealed.descriptor.runtimeExecutablePath,
      });
      if (child.pid === undefined) {
        throw new DelegationError("delegation_handshake_failed", "delegated child spawn returned no process identity");
      }
      current = await store.compareAndSwap({
        expectedSha256: current.operationSha256,
        expectedState: "requested",
        now: this.options.context.now(),
        mutate: (value) => ({
          ...value,
          state: "spawned",
          process: { pid: child!.pid!, processStartIdentity: `pending:${String(child!.pid)}` },
        }),
      });
      const handshake: DelegationChildHandshakeV1 = await waitHandshake(
        child,
        this.options.handshakeTimeoutMs ?? 30_000,
      );
      if (cancelled()) {
        throw new DelegationError("delegation_cancelled", "delegated child launch was cancelled during handshake");
      }
      const expectedProof = sha256Canonical({
        nonce: rawNonce,
        operation_id: operationId,
        attempt_id: input.preparedEnvelope.actor.attemptId,
        envelope_sha256: executableEnvelope.envelopeSha256,
      });
      if (
        handshake.operationId !== operationId ||
        handshake.childActorId !== input.preparedEnvelope.actor.actorId ||
        handshake.childAttemptId !== input.preparedEnvelope.actor.attemptId ||
        handshake.envelopeSha256 !== executableEnvelope.envelopeSha256 ||
        handshake.executableDescriptorSha256 !== sealed.descriptor.descriptorSha256 ||
        handshake.nonceProofSha256 !== expectedProof ||
        handshake.pid !== child.pid
      ) {
        throw new DelegationError("delegation_handshake_failed", "delegated child handshake does not match the sealed operation");
      }
      current = await store.compareAndSwap({
        expectedSha256: current.operationSha256,
        expectedState: "spawned",
        now: this.options.context.now(),
        mutate: (value) => ({
          ...value,
          state: "handshaken",
          process: { pid: handshake.pid, processStartIdentity: handshake.processStartIdentity },
        }),
      });
      writer = await this.writerFactory(this.options.context);
      try {
        await writer.appendDelegationEvent("delegation.child.started", {
          child_actor_id: input.preparedEnvelope.actor.actorId,
          child_attempt_id: input.preparedEnvelope.actor.attemptId,
          child_attempt_number: input.preparedEnvelope.actor.attemptNumber,
          child_run_id: childRunId,
          delegation_id: input.delegation.delegationId,
          delegation_revision: input.delegation.delegationRevision,
          delegation_sha256: input.delegation.delegationSha256,
          envelope_sha256: executableEnvelope.envelopeSha256,
          operation_id: operationId,
          parent_actor_id: input.delegation.parentActorId,
          parent_run_id: input.delegation.parentRunId,
          process_id: handshake.pid,
          process_start_identity: handshake.processStartIdentity,
        });
      } finally {
        await writer.close();
      }
      current = await store.compareAndSwap({
        expectedSha256: current.operationSha256,
        expectedState: "handshaken",
        now: this.options.context.now(),
        mutate: (value) => ({ ...value, state: "running" }),
      });
      const parent = await this.readParentSession();
      await seedChildSessionShard({
        operation,
        parentEvents: parent.events,
        randomUuid: this.options.context.randomUuid,
        timestamp: this.options.context.now,
      });
      await send(child, {
        schemaVersion: 1,
        protocolVersion: 1,
        frame: "start",
        operationId,
        childAttemptId: input.preparedEnvelope.actor.attemptId,
        envelopeSha256: executableEnvelope.envelopeSha256,
        startBarrierProofSha256: startBarrierNonceSha256,
      });
    } catch (error) {
      const normalized = error instanceof DelegationError
        ? error
        : new DelegationError("delegation_handshake_failed", "delegated child launch infrastructure failed", { cause: error });
      const observed = (await store.read())!;
      const pid = observed.process?.pid ?? child?.pid;
      const cleanup = pid === undefined
        ? null
        : await this.options.processTreeCleanup.terminate(pid);
      const processIdentity = observed.process ?? (pid === undefined
        ? null
        : { pid, processStartIdentity: `parent-handle:${operationId}:${String(pid)}` });
      const phase = failurePhase(observed.state);
      const cleanupRecord = cleanup === null || pid === undefined
        ? null
        : cleanupJournal(cleanup, pid, this.options.context.now());
      const retryableInfrastructure =
        normalized.code === "delegation_handshake_failed" ||
        normalized.code === "delegation_child_protocol_invalid";
      const cleanupProven = processIdentity === null || cleanupRecord?.verified === true;
      const parentSession = await this.readParentSession();
      const durableStarted = parentSession.delegations.revisions.some((candidate) =>
        candidate.delegationId === input.delegation.delegationId &&
        candidate.attempts.some((attempt) =>
          attempt.attemptId === input.preparedEnvelope.actor.attemptId &&
          attempt.startedEventId !== null));
      const preEffectState = ["requested", "spawned", "handshaken"].includes(observed.state) &&
        !durableStarted;
      if (!cancelled() && retryableInfrastructure && preEffectState && cleanupProven) {
        await store.compareAndSwap({
          expectedSha256: observed.operationSha256,
          expectedState: observed.state,
          now: this.options.context.now(),
          mutate: (value) => ({
            ...value,
            failure: { code: normalized.code, phase },
            process: processIdentity,
            processCleanup: cleanupRecord,
            state: "pre_effect_terminal",
          }),
        });
        const recovery = await new DelegationPreEffectRecovery(this.writerFactory).reconcile({
          context: this.options.context,
          store,
        });
        throw new DelegationChildLaunchFailure(
          normalized,
          operationId,
          input.preparedEnvelope.actor.attemptId,
          recovery.retryEligible,
        );
      }
      if (!["terminal_observed", "reconciled", "blocked"].includes(observed.state)) {
        await store.compareAndSwap({
          expectedSha256: observed.operationSha256,
          expectedState: observed.state,
          now: this.options.context.now(),
          mutate: (value) => ({
            ...value,
            failure: { code: normalized.code, phase },
            process: processIdentity,
            processCleanup: cleanupRecord,
            state: "blocked",
          }),
        });
      }
      if (cancelled()) {
        writer = await this.writerFactory(this.options.context);
        try {
          const cancelRequestId = this.options.context.randomUuid();
          await writer.appendDelegationEvent("delegation.cancel.requested", {
            cancel_request_id: cancelRequestId,
            delegation_id: input.delegation.delegationId,
            delegation_revision: input.delegation.delegationRevision,
            delegation_sha256: input.delegation.delegationSha256,
            origin: { input_surface: this.options.context.inputSurface, kind: "user" },
            parent_actor_id: input.delegation.parentActorId,
            parent_run_id: input.delegation.parentRunId,
            reason: "cancelled before the trusted child start barrier completed",
            root_event_id: null,
          });
          await writer.appendDelegationEvent("delegation.blocked", {
            blocker_code: "cancelled_before_start_reconciliation_required",
            delegation_id: input.delegation.delegationId,
            delegation_revision: input.delegation.delegationRevision,
            delegation_sha256: input.delegation.delegationSha256,
            evidence_sha256s: [nonceSha256],
            parent_actor_id: input.delegation.parentActorId,
            parent_run_id: input.delegation.parentRunId,
          });
        } finally {
          await writer.close();
        }
      }
      throw normalized;
    } finally {
      input.signal?.removeEventListener("abort", abortBeforeStart);
    }
    if (child === null) {
      throw new DelegationError("delegation_handshake_failed", "delegated child was not retained after its start barrier");
    }
    const activeChild = child;
    const terminalFrame = await waitTerminal({
      cancellationGraceMs,
      child: activeChild,
      context: this.options.context,
      envelope: executableEnvelope,
      operation,
      ...(this.options.approvalQueue === undefined
        ? {}
        : { approvalQueue: this.options.approvalQueue }),
      prompt: this.options.prompt,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.reservation.reserved.maxDurationMs + 30_000,
      writerFactory: this.writerFactory,
    }).catch(async (error: unknown) => {
      const normalized = error instanceof DelegationError
        ? error
        : new DelegationError("delegation_effect_reconciliation_required", "delegated child lost its trusted terminal", { cause: error });
      const cleanup = await this.options.processTreeCleanup.terminate(activeChild.pid);
      let observed = await store.read();
      if (observed !== null && !["terminal_observed", "reconciled", "blocked"].includes(observed.state)) {
        observed = await store.compareAndSwap({
          expectedSha256: observed.operationSha256,
          expectedState: observed.state,
          now: this.options.context.now(),
          mutate: (value) => ({
            ...value,
            failure: { code: normalized.code, phase: "after_start_barrier" },
            processCleanup: activeChild.pid === undefined
              ? null
              : cleanupJournal(cleanup, activeChild.pid, this.options.context.now()),
            state: "blocked",
          }),
        });
        const blockedWriter = await this.writerFactory(this.options.context);
        try {
          await blockedWriter.appendDelegationEvent("delegation.blocked", {
            blocker_code: "delegation_effect_reconciliation_required",
            delegation_id: input.delegation.delegationId,
            delegation_revision: input.delegation.delegationRevision,
            delegation_sha256: input.delegation.delegationSha256,
            evidence_sha256s: [observed.operationSha256],
            parent_actor_id: input.delegation.parentActorId,
            parent_run_id: input.delegation.parentRunId,
          });
        } finally {
          await blockedWriter.close();
        }
      }
      throw normalized;
    });
    if (
      terminalFrame.operationId !== operationId ||
      terminalFrame.childAttemptId !== input.preparedEnvelope.actor.attemptId ||
      terminalFrame.childRunId !== childRunId
    ) {
      throw new DelegationError("delegation_child_protocol_invalid", "child terminal frame does not match the active attempt");
    }
    await importChildSessionShard({
      context: this.options.context,
      operation,
      writerFactory: this.writerFactory,
    });
    const session = await this.readParentSession();
    const run = session.runs.find((candidate) => candidate.runId === childRunId);
    if (run?.terminal?.eventId !== terminalFrame.observedTerminalEventId) {
      throw new DelegationError("delegation_effect_reconciliation_required", "child terminal IPC has no matching durable run terminal");
    }
    const blocker = taskMutationBlocker(session);
    const unresolved = blocker?.details ?? [];
    const usage = usageFromRun(run);
    const terminal = terminalKind(run?.status ?? "interrupted");
    writer = await this.writerFactory(this.options.context);
    let childTerminalEventId: string;
    try {
      const persisted = await writer.appendDelegationEvent("delegation.child.terminal", {
        budget_usage: usageCounters(usage),
        child_actor_id: input.preparedEnvelope.actor.actorId,
        child_attempt_id: input.preparedEnvelope.actor.attemptId,
        child_run_id: childRunId,
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        diagnostic_code: terminal === "blocked_unknown_effect" ? "delegation_effect_reconciliation_required" : null,
        operation_id: operationId,
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
        terminal,
        unresolved_effect_ids: [...unresolved],
      });
      childTerminalEventId = persisted.eventId;
    } finally {
      await writer.close();
    }
    const operationAfter = await store.read();
    if (operationAfter === null || operationAfter.state !== "terminal_observed" || operationAfter.boundedResultRef === null || operationAfter.boundedResultSha256 === null) {
      throw new DelegationError("delegation_child_protocol_invalid", "child terminal result journal is missing");
    }
    const resultBytes = await readFile(operationAfter.boundedResultRef);
    if (createHash("sha256").update(resultBytes).digest("hex") !== operationAfter.boundedResultSha256) {
      throw new DelegationError("delegation_artifact_invalid", "child bounded result failed hash verification");
    }
    const bounded = parseStrictJson(resultBytes.toString("utf8")) as {
      readonly summary: string;
      readonly candidateClaims: readonly CandidateChildReceiptClaimV1[];
    };
    const artifactStore = await ArtifactStore.create({ sessionId: this.options.context.sessionId, workspace: this.options.context.workspace });
    const boundedArtifact = await storeArtifact({
      workspace: this.options.context.workspace,
      sessionId: this.options.context.sessionId,
      runId: input.delegation.delegationId,
      bytes: resultBytes,
      sha256: operationAfter.boundedResultSha256,
    });
    const sourceSnapshotSha256 = executableEnvelope.prepared.workspace.sourceSnapshotSha256;
    const candidateClaims: CandidateChildReceiptClaimV1[] = bounded.candidateClaims.map((claim) =>
      claim.kind === "answer" && claim.evidence.length === 0
        ? {
            ...claim,
            evidence: [{
              artifactRef: boundedArtifact.object_ref,
              kind: "artifact" as const,
              sha256: boundedArtifact.sha256,
              sourceSnapshotSha256,
            }],
          }
        : claim);
    const verificationEvents = run?.events.filter((event) =>
      event.type === "verification.completed" && event.data.status === "passed") ?? [];
    const verificationGenerationIds: string[] = [];
    for (const [index, claim] of input.delegation.content.expectedReceipt.requiredClaims
      .filter((candidate) => candidate.kind === "verification_result").entries()) {
      const verification = verificationEvents[index] ?? verificationEvents.at(-1);
      if (verification?.type !== "verification.completed") continue;
      const evidenceBytes = Buffer.from(canonicalJson({
        kind: "delegation_verification_evidence_v1",
        eventId: verification.eventId,
        data: verification.data,
      }), "utf8");
      const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
      const stored = await storeArtifact({
        workspace: this.options.context.workspace,
        sessionId: this.options.context.sessionId,
        runId: input.delegation.delegationId,
        bytes: evidenceBytes,
        sha256: evidenceSha256,
      });
      verificationGenerationIds.push(verification.data.verification_id);
      candidateClaims.push({
        claimId: claim.claimId,
        kind: claim.kind,
        narrative: claim.description,
        evidence: [{
          artifactRef: stored.object_ref,
          kind: "verification_generation",
          sha256: stored.sha256,
          sourceSnapshotSha256,
        }],
      });
    }
    for (const claim of input.delegation.content.expectedReceipt.requiredClaims.filter((candidate) =>
      candidate.kind === "file_observation" || candidate.kind === "symbol_observation")) {
      const matching = [...(run?.events ?? [])].reverse().find((event) =>
        event.type === "tool.call.completed" && event.data.status === "success" &&
        (claim.kind === "file_observation"
          ? ["read_file", "list_files", "search"].includes(event.data.tool_name)
          : ["find_symbol", "find_references", "repository_outline"].includes(event.data.tool_name)));
      if (matching?.type !== "tool.call.completed") continue;
      const evidenceBytes = Buffer.from(canonicalJson({
        kind: "delegation_tool_observation_v1",
        eventId: matching.eventId,
        data: matching.data,
      }), "utf8");
      const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
      const stored = await storeArtifact({
        workspace: this.options.context.workspace,
        sessionId: this.options.context.sessionId,
        runId: input.delegation.delegationId,
        bytes: evidenceBytes,
        sha256: evidenceSha256,
      });
      candidateClaims.push({
        claimId: claim.claimId,
        kind: claim.kind,
        narrative: claim.description,
        evidence: [{
          artifactRef: stored.object_ref,
          kind: claim.kind === "file_observation" ? "repository_observation" : "symbol_observation",
          sha256: stored.sha256,
          sourceSnapshotSha256,
        }],
      });
    }
    const finalizedWorkspace = await input.finalizeWorkspace?.();
    if (finalizedWorkspace !== undefined) candidateClaims.push(...finalizedWorkspace.candidateClaims);
    const workspaceResult = finalizedWorkspace ?? input.workspaceResult;
    const receipt = await new ChildReceiptBuilder().build({
      delegation: input.delegation,
      envelope: executableEnvelope,
      runTerminal: terminal === "succeeded" ? "succeeded" : terminal === "known_failed" ? "known_failed" : terminal === "cancelled_clean" ? "cancelled" : "blocked",
      terminalEventId: childTerminalEventId,
      summary: bounded.summary,
      candidateClaims,
      evidenceVerifier: {
        verify: async ({ evidence, sourceSnapshotSha256 }) => {
          if (evidence.sourceSnapshotSha256 !== null && evidence.sourceSnapshotSha256 !== sourceSnapshotSha256) return "stale";
          try {
            const stored = await artifactStore.readVerified(`sha256:${evidence.sha256}`);
            return stored.objectRef === evidence.artifactRef ? "verified" : "unverified";
          } catch {
            return "unverified";
          }
        },
      },
      workspace: {
        logicalWorkspaceId: executableEnvelope.prepared.workspace.logicalWorkspaceId,
        sourceSnapshotSha256: executableEnvelope.prepared.workspace.sourceSnapshotSha256,
        resultSnapshotSha256: workspaceResult?.resultSnapshotSha256 ?? null,
        changeBundleRef: workspaceResult?.changeBundleRef ?? null,
        changeBundleSha256: workspaceResult?.changeBundleSha256 ?? null,
      },
      verificationGenerationIds,
      unresolvedEffects: unresolved,
      budgetUsage: usage,
    });
    const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    const receiptArtifactSha256 = createHash("sha256").update(receiptBytes).digest("hex");
    const receiptArtifact = await storeArtifact({
      workspace: this.options.context.workspace,
      sessionId: this.options.context.sessionId,
      runId: input.delegation.delegationId,
      bytes: receiptBytes,
      sha256: receiptArtifactSha256,
    });
    writer = await this.writerFactory(this.options.context);
    try {
      const ready = await writer.appendDelegationEvent("delegation.receipt.ready", {
        child_actor_id: input.preparedEnvelope.actor.actorId,
        child_attempt_id: input.preparedEnvelope.actor.attemptId,
        claim_statuses: receipt.claims.map((claim) => ({ claim_id: claim.claimId, status: claim.status })),
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
        receipt_artifact: receiptArtifact,
        receipt_sha256: receipt.receiptSha256,
        status: receipt.status,
        terminal_event_id: childTerminalEventId,
      });
      const currentSession = reconstructMultiRunSession(writer.events);
      const currentRevision = currentSession.delegations.revisions.find((candidate) =>
        candidate.delegationId === input.delegation.delegationId && candidate.delegationRevision === input.delegation.delegationRevision)!;
      await readVerifiedChildReceipt({ workspace: this.options.context.workspace, sessionId: this.options.context.sessionId, revision: currentRevision });
      await writer.appendDelegationEvent("delegation.receipt.accepted", {
        child_attempt_id: input.preparedEnvelope.actor.attemptId,
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
        ready_event_id: ready.eventId,
        receipt_artifact_id: receiptArtifact.artifact_id,
        receipt_sha256: receipt.receiptSha256,
      });
      await writer.appendDelegationEvent("delegation.budget.settled", {
        child_attempt_id: input.preparedEnvelope.actor.attemptId,
        delegation_id: input.delegation.delegationId,
        delegation_revision: input.delegation.delegationRevision,
        delegation_sha256: input.delegation.delegationSha256,
        held: usageCounters({ artifactBytes: 0, attempts: 0, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 0, modelSteps: 0, reportedTokens: usage.reportedTokens === null ? null : 0 }),
        parent_actor_id: input.delegation.parentActorId,
        parent_run_id: input.delegation.parentRunId,
        released: releasedCounters(input.reservation.reserved, usage),
        reservation_id: input.reservation.reservationId,
        used: usageCounters(usage),
      });
    } finally {
      await writer.close();
    }
    current = (await store.read())!;
    if (current.state === "terminal_observed") {
      await store.compareAndSwap({
        expectedSha256: current.operationSha256,
        expectedState: "terminal_observed",
        now: this.options.context.now(),
        mutate: (value) => ({ ...value, state: "reconciled" }),
      });
    }
    return Object.freeze({ childRunId, operationId, receipt, terminalEventId: childTerminalEventId });
  }
}
