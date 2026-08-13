import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { CliIO } from "../cli/types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import type { Phase20DelegationSessionEventData } from "../delegation/delegation-event-schema.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { currentProcessIdentity } from "../sessions/process-identity.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import {
  DeterministicTaskScheduler,
  type TaskAttemptExecutor,
  type TaskSchedulerRunResultV1,
} from "../scheduling/deterministic-task-scheduler.js";
import { NodeGitWorktreePort, type GitWorktreePort } from "../worktrees/git-worktree-port.js";
import { BackgroundError } from "./background-errors.js";
import { openBackgroundSessionWriter } from "./background-session-writer.js";
import { sealBackgroundExecutable } from "./background-executable-descriptor.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import {
  backgroundHandoffRecordSchema,
  graphWorkerBootstrapSchema,
  graphWorkerCancelControlSchema,
  graphWorkerHeartbeatSchema,
  graphWorkerReadySchema,
  graphWorkerParentAckSchema,
  type GraphWorkerBootstrapV1,
  type GraphWorkerCancelControlV1,
  type GraphWorkerReadyV1,
} from "./background-schema.js";

const MAX_WORKER_LIFETIME_MS = 24 * 60 * 60 * 1_000;
type TerminalGraphStatus = "awaiting_integration" | "blocked" | "cancelled" | "completed" | "failed" | "stale" | "waiting_for_user";

function isTerminalGraphStatus(value: string): value is TerminalGraphStatus {
  return ["awaiting_integration", "blocked", "cancelled", "completed", "failed", "stale", "waiting_for_user"].includes(value);
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertAuthenticatedControlMatchesWriter(input: Readonly<{
  readonly control: GraphWorkerCancelControlV1;
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly writer: V2SessionWriter;
}>): void {
  const control = input.control;
  if (control.schemaVersion === 1) return;
  const event = input.writer.events.at(control.sessionCancel.sessionSeq - 1);
  const value = event?.data as Readonly<Record<string, unknown>> | undefined;
  let durableIdentity: ReturnType<V2SessionWriter["readDurableEventIdentity"]> | null = null;
  if (event !== undefined) {
    try {
      durableIdentity = input.writer.readDurableEventIdentity(event.eventId);
    } catch {
      durableIdentity = null;
    }
  }
  if (
    control.repositoryId !== input.repositoryId || control.sessionId !== input.sessionId ||
    event === undefined || value === undefined ||
    event.scope !== "session" || event.eventId !== control.sessionCancel.eventId ||
    event.sessionId !== input.sessionId || event.sessionSeq !== control.sessionCancel.sessionSeq ||
    event.type !== "task_graph.cancel.requested" || durableIdentity === null ||
    durableIdentity.sequence !== control.sessionCancel.sessionSeq ||
    durableIdentity.sessionId !== input.sessionId ||
    durableIdentity.rawEventSha256 !== control.sessionCancel.rawEventSha256 ||
    value.graph_id !== control.graphId || value.graph_revision !== control.graphRevision ||
    value.graph_sha256 !== control.graphSha256 || value.reason !== control.reason ||
    value.request_id !== control.requestId || sha256Canonical(value.origin) !== sha256Canonical(control.origin)
  ) {
    throw new BackgroundError(
      "worker_control_stale",
      "background cancel control failed its exact locked session application binding",
    );
  }
}

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return openBackgroundSessionWriter(context);
}

const CANCELLABLE_DELEGATION_STATUSES = new Set([
  "approved",
  "queued",
  "active",
  "waiting_approval",
  "reconciling",
  "receipt_ready",
  "cancelling",
]);

/**
 * Bind a verified Graph cancellation to every non-terminal delegation owned by
 * that exact Graph before any process-local cancellation signal is delivered.
 * The Graph cancel event is the authenticated root; this is an idempotent
 * owner-internal cascade and never manufactures a second human operation.
 */
export async function persistDelegationCancelCascade(input: Readonly<{
  readonly context: TaskMutationContext;
  readonly control: GraphWorkerCancelControlV1;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly operationId: string;
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly workerId: string;
  readonly writerFactory: TaskMutationWriterFactory;
}>): Promise<void> {
  const writer = await input.writerFactory(input.context);
  try {
    let session = reconstructMultiRunSession(writer.events);
    const current = session.background.current;
    if (
      current === null || current.status !== "running" ||
      current.operationId !== input.operationId || current.workerId !== input.workerId ||
      current.graphId !== input.graphId || current.graphRevision !== input.graphRevision ||
      current.graphSha256 !== input.graphSha256 ||
      input.control.operationId !== current.operationId ||
      input.control.workerId !== current.workerId ||
      input.control.workerNonceSha256 !== current.workerNonceSha256 ||
      input.control.graphId !== current.graphId ||
      input.control.graphRevision !== current.graphRevision ||
      input.control.graphSha256 !== current.graphSha256
    ) {
      throw new BackgroundError(
        "worker_control_stale",
        "authenticated delegation cancel cascade lost its exact background Graph owner",
      );
    }
    let root;
    if (input.control.schemaVersion === 2) {
      assertAuthenticatedControlMatchesWriter({
        control: input.control,
        repositoryId: input.repositoryId,
        sessionId: input.sessionId,
        writer,
      });
      root = writer.events.at(input.control.sessionCancel.sessionSeq - 1);
      if (
        root === undefined || root.eventId !== input.control.sessionCancel.eventId ||
        root.type !== "task_graph.cancel.requested" ||
        writer.readDurableEventIdentity(root.eventId).rawEventSha256 !== input.control.sessionCancel.rawEventSha256
      ) {
        throw new BackgroundError(
          "worker_control_stale",
          "authenticated delegation cancel cascade lost its exact Graph cancel root",
        );
      }
    } else {
      const existingRoots = writer.events.filter((event) => {
        if (event.scope !== "session" || event.type !== "task_graph.cancel.requested") return false;
        const value = event.data as Readonly<Record<string, unknown>>;
        return value.graph_id === input.graphId && value.graph_revision === input.graphRevision &&
          value.graph_sha256 === input.graphSha256 && value.request_id === input.control.requestId &&
          value.reason === input.control.reason;
      });
      if (existingRoots.length > 1) {
        throw new BackgroundError(
          "worker_reconciliation_required",
          "internal Graph deadline cancellation root is ambiguous",
        );
      }
      root = existingRoots[0] ?? await writer.appendTaskGraphEvent("task_graph.cancel.requested", {
        active_attempt_id: session.taskExecution?.activeAttempt?.attemptId ?? null,
        graph_id: input.graphId,
        graph_revision: input.graphRevision,
        graph_sha256: input.graphSha256,
        reason: input.control.reason,
        request_id: input.control.requestId,
      });
    }
    const candidates = session.delegations.revisions.filter((revision) =>
      CANCELLABLE_DELEGATION_STATUSES.has(revision.status) &&
      revision.binding.graphId === input.graphId &&
      revision.binding.graphRevision === input.graphRevision &&
      revision.binding.graphSha256 === input.graphSha256);
    const admittedCandidateKeys = new Set(candidates.flatMap((revision) => {
      const actorId = revision.attempts.at(-1)?.actorId;
      return actorId !== null && actorId !== undefined &&
          session.delegations.activeActorSlots.some((slot) => slot.actorId === actorId)
        ? [`${revision.delegationId}\0${String(revision.delegationRevision)}`]
        : [];
    }));
    const activeCandidates = candidates.filter((revision) =>
      admittedCandidateKeys.has(`${revision.delegationId}\0${String(revision.delegationRevision)}`) ||
      ["active", "waiting_approval", "reconciling", "receipt_ready"].includes(revision.status));
    const activeGroupIds = new Set(activeCandidates.flatMap((revision) => {
      const actorId = revision.attempts.at(-1)?.actorId;
      return actorId === null || actorId === undefined
        ? []
        : session.delegations.activeActorSlots
          .filter((slot) => slot.actorId === actorId)
          .map((slot) => slot.groupId);
    }));
    if (activeCandidates.length > 0 && activeGroupIds.size !== 1) {
      throw new BackgroundError(
        "worker_reconciliation_required",
        "active Graph delegation cancellation has no unique durable group binding",
      );
    }
    if (activeGroupIds.size === 1) {
      const groupId = [...activeGroupIds][0]!;
      const groupActors = new Set(session.delegations.activeActorSlots
        .filter((slot) => slot.groupId === groupId)
        .map((slot) => slot.actorId));
      const groupDelegations = candidates.filter((revision) => {
        const actorId = revision.attempts.at(-1)?.actorId;
        return actorId !== null && actorId !== undefined && groupActors.has(actorId);
      });
      const barrier = session.delegations.barriers.find((candidate) =>
        candidate.status === "suspended" &&
        groupDelegations.every((revision) => candidate.requiredDelegationIds.includes(revision.delegationId)));
      if (groupDelegations.length !== activeCandidates.length || barrier === undefined) {
        throw new BackgroundError(
          "worker_reconciliation_required",
          "active Graph delegation cancellation lost its exact group/barrier binding",
        );
      }
    }
    const cascadedRequest = (delegationId: string) => writer.events.find((event) => {
      if (event.scope !== "session" || event.type !== "delegation.cancel.requested") return false;
      const value = event.data as Phase20DelegationSessionEventData<"delegation.cancel.requested">;
      const revision = candidates.find((candidate) => candidate.delegationId === delegationId);
      return revision !== undefined &&
        value.delegation_id === revision.delegationId &&
        value.delegation_revision === revision.delegationRevision &&
        value.delegation_sha256 === revision.delegationSha256 &&
        value.parent_actor_id === revision.parentActorId &&
        value.parent_run_id === revision.parentRunId &&
        value.reason === input.control.reason &&
        value.root_event_id === root.eventId && (
          input.control.schemaVersion === 2
            ? sha256Canonical(value.origin) === sha256Canonical(input.control.origin)
            : sha256Canonical(value.origin) === sha256Canonical({ input_surface: "internal", kind: "host" })
        );
    });
    for (const revision of candidates) {
      const existingRequest = cascadedRequest(revision.delegationId);
      if (revision.status === "cancelling" && existingRequest === undefined) {
        throw new BackgroundError(
          "worker_reconciliation_required",
          "Graph delegation was already cancelling from a different durable root",
        );
      }
      const cancelRequestId = existingRequest?.scope === "session" && existingRequest.type === "delegation.cancel.requested"
        ? existingRequest.data.cancel_request_id
        : input.context.randomUuid();
      if (existingRequest === undefined) {
        await writer.appendDelegationEvent("delegation.cancel.requested", {
          cancel_request_id: cancelRequestId,
          delegation_id: revision.delegationId,
          delegation_revision: revision.delegationRevision,
          delegation_sha256: revision.delegationSha256,
          origin: input.control.schemaVersion === 2
            ? input.control.origin
            : { input_surface: "internal" as const, kind: "host" as const },
          parent_actor_id: revision.parentActorId,
          parent_run_id: revision.parentRunId,
          reason: input.control.reason,
          root_event_id: root.eventId,
        });
      }
      const admitted = admittedCandidateKeys.has(
        `${revision.delegationId}\0${String(revision.delegationRevision)}`,
      );
      if (!admitted && revision.attempts.every((attempt) => attempt.startedEventId === null)) {
        await writer.appendDelegationEvent("delegation.cancelled", {
          cancel_request_id: cancelRequestId,
          delegation_id: revision.delegationId,
          delegation_revision: revision.delegationRevision,
          delegation_sha256: revision.delegationSha256,
          parent_actor_id: revision.parentActorId,
          parent_run_id: revision.parentRunId,
          terminal_event_id: null,
        });
      }
    }
    session = reconstructMultiRunSession(writer.events);
    if (candidates.some((candidate) => {
      const currentRevision = session.delegations.revisions.find((revision) =>
        revision.delegationId === candidate.delegationId &&
        revision.delegationRevision === candidate.delegationRevision &&
        revision.delegationSha256 === candidate.delegationSha256);
      const admitted = admittedCandidateKeys.has(
        `${candidate.delegationId}\0${String(candidate.delegationRevision)}`,
      );
      const hadStartedEffect = candidate.attempts.some((attempt) => attempt.startedEventId !== null);
      return currentRevision === undefined ||
        currentRevision.status !== (admitted || hadStartedEffect ? "cancelling" : "cancelled");
    })) {
      throw new BackgroundError(
        "worker_reconciliation_required",
        "authenticated Graph cancellation did not durably bind every selected delegation",
      );
    }
  } finally {
    await writer.close();
  }
}

export interface BackgroundWorkerIpcPort {
  disconnect(): void;
  receive(timeoutMs: number): Promise<unknown>;
  send(message: GraphWorkerReadyV1): Promise<void>;
}

export class NodeBackgroundWorkerIpcPort implements BackgroundWorkerIpcPort {
  constructor(private readonly target: NodeJS.Process = process) {}

  receive(timeoutMs: number): Promise<unknown> {
    if (typeof this.target.send !== "function" || this.target.connected !== true) {
      throw new BackgroundError("worker_protocol_mismatch", "internal Graph worker requires inherited IPC");
    }
    return new Promise((resolveMessage, reject) => {
      let settled = false;
      const finish = (error: Error | null, message?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.target.off("message", onMessage);
        this.target.off("disconnect", onDisconnect);
        if (error === null) resolveMessage(message);
        else reject(error);
      };
      const onMessage = (message: unknown) => finish(null, message);
      const onDisconnect = () => finish(new BackgroundError("worker_protocol_mismatch", "parent IPC closed before bootstrap"));
      const timer = setTimeout(
        () => finish(new BackgroundError("worker_handshake_timeout", "background bootstrap was not received before the fixed deadline")),
        timeoutMs,
      );
      this.target.once("message", onMessage);
      this.target.once("disconnect", onDisconnect);
    });
  }

  send(message: GraphWorkerReadyV1): Promise<void> {
    if (typeof this.target.send !== "function" || this.target.connected !== true) {
      throw new BackgroundError("worker_protocol_mismatch", "parent IPC closed before ready receipt");
    }
    return new Promise((resolveSend, reject) => {
      this.target.send!(message, (error) => {
        if (error == null) resolveSend();
        else reject(new BackgroundError("worker_handshake_timeout", "ready receipt could not be sent", { cause: error }));
      });
    });
  }

  disconnect(): void {
    if (this.target.connected === true) this.target.disconnect();
  }
}

export interface BackgroundWorkerRuntimeResultV1 {
  readonly graphStatus: string | null;
  readonly operationId: string;
  readonly reconciled: boolean;
  readonly workerId: string | null;
}

export interface BackgroundDelegationCoordinationResultV1 {
  readonly handledGroups: number;
  readonly requestedActionRef: string | null;
  readonly status: "ready" | "waiting_for_foreground_approval";
}

export class BackgroundWorkerRuntime {
  constructor(private readonly options: {
    readonly createExecutor: (input: {
      readonly approvalMode: "defer";
      readonly io: CliIO;
      readonly runtimeProfileId: string;
      readonly sessionId: string;
      readonly writerFactory: TaskMutationWriterFactory;
    }) => TaskAttemptExecutor;
    readonly coordinateDelegations?: (input: {
      readonly backgroundOperationId: string;
      readonly graphId: string;
      readonly graphRevision: number;
      readonly graphSha256: string;
      readonly repositoryId: string;
      readonly sessionId: string;
      readonly signal: AbortSignal;
    }) => Promise<BackgroundDelegationCoordinationResultV1>;
    readonly currentCliEntryPath?: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly git?: GitWorktreePort;
    readonly heartbeatIntervalMs?: number;
    readonly ipc?: BackgroundWorkerIpcPort;
    readonly io: CliIO;
    readonly nodeVersion: string;
    readonly operationId: string;
    readonly repositoryId: string;
    readonly userStateRoot: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async run(): Promise<BackgroundWorkerRuntimeResultV1> {
    const ipc = this.options.ipc ?? new NodeBackgroundWorkerIpcPort();
    let bootstrap: GraphWorkerBootstrapV1 | null = null;
    let context: TaskMutationContext | null = null;
    let store: BackgroundOperationStore | null = null;
    let workerOwned = false;
    try {
      bootstrap = graphWorkerBootstrapSchema.parse(await ipc.receive(10_000));
      if (bootstrap.operationId !== this.options.operationId) {
        throw new BackgroundError("worker_protocol_mismatch", "bootstrap operation does not match internal argv");
      }
      if (Date.parse(bootstrap.launchDeadline) < Date.now()) {
        throw new BackgroundError("worker_handshake_timeout", "background bootstrap launch deadline expired");
      }
      store = await BackgroundOperationStore.create({
        operationId: this.options.operationId,
        repositoryId: this.options.repositoryId,
        root: this.options.userStateRoot,
      });
      const [launch, handoff] = await Promise.all([store.readLaunch(), store.readHandoff()]);
      if (
        launch === null || handoff === null || launch.operationId !== bootstrap.operationId ||
        launch.workerId !== bootstrap.workerId || launch.sessionId !== bootstrap.sessionId ||
        launch.graphRevision !== bootstrap.graphRevision || launch.graphSha256 !== bootstrap.graphSha256 ||
        launch.repositoryId !== this.options.repositoryId || launch.descriptorSha256 !== bootstrap.executableDescriptorSha256 ||
        launch.parentPid !== bootstrap.parentPid || launch.parentProcessStartIdentity !== bootstrap.parentProcessStartIdentity ||
        launch.launchDeadline !== bootstrap.launchDeadline || launch.workerNonceSha256 !== hash(bootstrap.rawNonce) ||
        handoff.owner !== "parent" || handoff.state !== "launching" || handoff.workerId !== bootstrap.workerId ||
        handoff.workerNonceSha256 !== launch.workerNonceSha256 || handoff.graphSha256 !== launch.graphSha256
      ) {
        throw new BackgroundError("worker_protocol_mismatch", "bootstrap, launch record, and designated handoff do not exact-match");
      }
      const sealed = await sealBackgroundExecutable({
        cliEntryPath: launch.cliEntryPath,
        nodeExecutablePath: launch.nodeExecutablePath,
        nodeVersion: this.options.nodeVersion,
      });
      if (this.options.currentCliEntryPath !== undefined && await realpath(this.options.currentCliEntryPath) !== sealed.cliEntryPath) {
        throw new BackgroundError("worker_launch_stale", "internal worker is not executing the sealed CLI entry");
      }
      if (sealed.descriptorSha256 !== launch.descriptorSha256 || sealed.descriptorSha256 !== bootstrap.executableDescriptorSha256) {
        throw new BackgroundError("worker_launch_stale", "worker executable does not match the parent's sealed descriptor");
      }
      const git = this.options.git ?? new NodeGitWorktreePort({ environment: this.options.environment });
      const repository = await git.observe(launch.originRoot);
      if (repository.identity.repositoryId !== launch.repositoryId || repository.originRoot !== launch.originRoot) {
        throw new BackgroundError("worker_launch_stale", "worker repository identity changed before handoff");
      }
      context = Object.freeze({
        inputSurface: "cli" as const,
        now: () => new Date().toISOString(),
        randomUuid: randomUUID,
        sessionId: launch.sessionId,
        workspace: launch.originRoot,
      });
      await this.#validateSession(context, launch.graphSha256, launch.graphRevision, launch.workerId, launch.operationId);
      const identity = currentProcessIdentity();
      const workerHandoff = backgroundHandoffRecordSchema.parse({
        ...handoff,
        owner: "worker",
        ownerPid: identity.pid,
        ownerProcessStartIdentity: identity.startIdentity,
        state: "worker_owned",
        updatedAt: context.now(),
      });
      await store.compareAndSwapHandoff({
        expectedOwner: "parent",
        expectedState: "launching",
        next: workerHandoff,
        nonce: randomUUID(),
      });
      workerOwned = true;

      const executor = this.options.createExecutor({
        approvalMode: "defer",
        io: this.options.io,
        runtimeProfileId: launch.runtimeProfileId,
        sessionId: launch.sessionId,
        writerFactory: this.writerFactory,
      });
      const controller = new AbortController();
      let pendingControl: GraphWorkerCancelControlV1 | null = null;
      let sidecarFailure: Error | null = null;
      let controlPoll: Promise<void> = Promise.resolve();
      const discoverControl = async (): Promise<void> => {
        if (pendingControl !== null) return;
        const controls = await store!.listCancelControls();
        const selectedControls = controls.filter((control) =>
          control.operationId === launch.operationId && control.workerId === launch.workerId &&
          control.workerNonceSha256 === launch.workerNonceSha256 && control.graphId === launch.graphId &&
          control.graphRevision === launch.graphRevision && control.graphSha256 === launch.graphSha256
        );
        let lastFailure: unknown = null;
        for (const selected of selectedControls) {
          try {
            await persistDelegationCancelCascade({
              context: context!,
              control: selected,
              graphId: launch.graphId,
              graphRevision: launch.graphRevision,
              graphSha256: launch.graphSha256,
              operationId: launch.operationId,
              repositoryId: launch.repositoryId,
              sessionId: launch.sessionId,
              workerId: launch.workerId,
              writerFactory: this.writerFactory,
            });
            // This is the only process-local cancellation boundary: exact Graph
            // control and every selected delegation are already durable under one
            // writer snapshot before the active child can observe the signal.
            pendingControl = selected;
            controller.abort();
            return;
          } catch (error) {
            lastFailure = error;
          }
        }
        if (lastFailure !== null) throw lastFailure;
      };
      const flushControl = async (): Promise<void> => {
        await discoverControl();
        if (sidecarFailure !== null) throw sidecarFailure;
        const control = pendingControl;
        if (control === null) return;
        const writer = await this.writerFactory(context!);
        try {
          const session = reconstructMultiRunSession(writer.events);
          const current = session.background.current;
          const execution = session.taskExecution;
          const controlSha256 = sha256Canonical(control);
          const acceptedEvents = writer.events.filter((event) => {
            if (event.scope !== "session" || event.type !== "task_worker.control.accepted") return false;
            const value = event.data as Readonly<Record<string, unknown>>;
            return value.control_sha256 === controlSha256 && value.graph_id === launch.graphId &&
              value.graph_revision === launch.graphRevision && value.graph_sha256 === launch.graphSha256 &&
              value.operation_id === launch.operationId && value.request_id === control.requestId &&
              value.worker_id === launch.workerId;
          });
          const alreadyAccepted = current?.acceptedControlIds.includes(control.requestId) === true;
          const exactAcceptedEvent = alreadyAccepted && acceptedEvents.length === 1;
          const exactAcceptedPrefix = exactAcceptedEvent && execution?.activeAttempt === null &&
            ["queued", "running", "cancelled"].includes(execution.status);
          if (
            current === null || current.operationId !== launch.operationId || current.workerId !== launch.workerId ||
            current.status !== "running" || execution === null || execution.graph.graphSha256 !== launch.graphSha256 ||
            (!exactAcceptedPrefix && !["queued", "running"].includes(execution.status)) ||
            (alreadyAccepted && !exactAcceptedPrefix)
          ) {
            throw new BackgroundError("worker_control_stale", "cancel control no longer targets the current worker and Graph");
          }
          if (control.schemaVersion === 2) {
            assertAuthenticatedControlMatchesWriter({
              control,
              repositoryId: launch.repositoryId,
              sessionId: launch.sessionId,
              writer,
            });
          }
          if (!alreadyAccepted) {
            await writer.appendTaskGraphEvent("task_worker.control.accepted", {
              control_sha256: controlSha256,
              graph_id: launch.graphId,
              graph_revision: launch.graphRevision,
              graph_sha256: launch.graphSha256,
              operation_id: launch.operationId,
              request_id: control.requestId,
              worker_id: launch.workerId,
            });
            if (execution.activeAttempt === null) {
              await writer.appendTaskGraphEvent("task_graph.terminal", {
                graph_id: launch.graphId,
                graph_revision: launch.graphRevision,
                graph_sha256: launch.graphSha256,
                reason: "background cancellation accepted before another attempt was admitted",
                status: "cancelled",
              });
            }
          } else if (execution.status !== "cancelled") {
            await writer.appendTaskGraphEvent("task_graph.terminal", {
              graph_id: launch.graphId,
              graph_revision: launch.graphRevision,
              graph_sha256: launch.graphSha256,
              reason: "background cancellation recovered after accepted-control response loss",
              status: "cancelled",
            });
          }
        } finally {
          await writer.close();
        }
        let consumed = false;
        let consumeFailure: unknown = null;
        for (let attempt = 0; attempt < 3 && !consumed; attempt += 1) {
          try {
            await store!.consumeCancel(control, randomUUID());
            consumed = true;
          } catch (error) {
            consumeFailure = error;
            const [evidence, active] = await Promise.all([
              store!.readCancelEvidence(control.requestId),
              store!.listCancelControls(),
            ]);
            consumed = evidence !== null && sha256Canonical(evidence) === sha256Canonical(control) &&
              !active.some((candidate) => candidate.requestId === control.requestId);
          }
        }
        if (!consumed) throw consumeFailure;
        pendingControl = null;
      };
      const scheduler = new DeterministicTaskScheduler({
        beforeTransition: flushControl,
        context,
        executor,
        repositoryId: launch.repositoryId,
        writerFactory: this.writerFactory,
      });
      const owned = await scheduler.startOwnership();
      const schedulerLeaseSha256 = owned.schedulerLeaseNonceSha256;
      if (schedulerLeaseSha256 === null) {
        throw new BackgroundError("worker_handoff_conflict", "worker did not acquire the exact scheduler lease");
      }
      const startedWriter = await this.writerFactory(context);
      let startedEvent;
      try {
        startedEvent = await startedWriter.appendTaskGraphEvent("task_worker.started", {
          descriptor_sha256: launch.descriptorSha256,
          graph_id: launch.graphId,
          graph_revision: launch.graphRevision,
          graph_sha256: launch.graphSha256,
          handoff_sha256: sha256Canonical(workerHandoff),
          operation_id: launch.operationId,
          scheduler_lease_sha256: schedulerLeaseSha256,
          worker_id: launch.workerId,
          worker_nonce_sha256: launch.workerNonceSha256,
        });
      } finally {
        await startedWriter.close();
      }
      const ready = graphWorkerReadySchema.parse({
        operationId: launch.operationId,
        protocolVersion: 1,
        schedulerLeaseSha256,
        startedEventId: startedEvent.eventId,
        startedSessionSeq: startedEvent.sessionSeq,
        workerId: launch.workerId,
        workerNonceSha256: launch.workerNonceSha256,
        workerPid: identity.pid,
        workerProcessStartIdentity: identity.startIdentity,
      });
      await ipc.send(ready);
      const ack = graphWorkerParentAckSchema.parse(await ipc.receive(30_000));
      if (
        ack.operationId !== launch.operationId || ack.workerId !== launch.workerId ||
        ack.startedEventId !== startedEvent.eventId
      ) {
        throw new BackgroundError("worker_protocol_mismatch", "parent acknowledgement does not match the durable ready boundary");
      }
      ipc.disconnect();

      let heartbeatSequence = 0;
      let lastDurableSessionSeq = startedEvent.sessionSeq;
      let heartbeatChain: Promise<void> = Promise.resolve();
      const writeHeartbeat = (): void => {
        heartbeatChain = heartbeatChain.then(async () => {
          heartbeatSequence += 1;
          await store!.writeHeartbeat(graphWorkerHeartbeatSchema.parse({
            activeAttemptId: null,
            graphSha256: launch.graphSha256,
            lastDurableSessionSeq,
            observedAt: context!.now(),
            operationId: launch.operationId,
            schemaVersion: 1,
            sequence: heartbeatSequence,
            workerId: launch.workerId,
            workerNonceSha256: launch.workerNonceSha256,
            workerPid: identity.pid,
            workerProcessStartIdentity: identity.startIdentity,
          }), randomUUID());
        }).catch((error: unknown) => {
          sidecarFailure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        });
      };
      writeHeartbeat();
      const heartbeatTimer = setInterval(writeHeartbeat, this.options.heartbeatIntervalMs ?? 5_000);
      const controlTimer = setInterval(() => {
        // A locked/partial/transient session observation is not cancellation
        // authority. Keep the durable control in place and retry; never expose a
        // raw AbortSignal until persistDelegationCancelCascade succeeds.
        controlPoll = controlPoll.then(discoverControl).catch(() => undefined);
      }, Math.min(1_000, this.options.heartbeatIntervalMs ?? 5_000));
      const lifetimeMs = Math.max(1, Math.min(MAX_WORKER_LIFETIME_MS, owned.graph.content.graphBudget.maxDurationMs));
      const deadlineTimer = setTimeout(() => {
        const internal = graphWorkerCancelControlSchema.parse({
          graphId: launch.graphId,
          graphRevision: launch.graphRevision,
          graphSha256: launch.graphSha256,
          operationId: launch.operationId,
          reason: "background worker reached its fixed Graph lifetime budget",
          requestId: randomUUID(),
          requestedAt: context!.now(),
          schemaVersion: 1,
          workerId: launch.workerId,
          workerNonceSha256: launch.workerNonceSha256,
        });
        void store!.createCancelIdempotent(internal).then(() => discoverControl()).catch(() => undefined);
      }, lifetimeMs);
      let result: TaskSchedulerRunResultV1;
      try {
        const delegationCoordination = await this.options.coordinateDelegations?.({
          backgroundOperationId: launch.operationId,
          graphId: launch.graphId,
          graphRevision: launch.graphRevision,
          graphSha256: launch.graphSha256,
          repositoryId: launch.repositoryId,
          sessionId: launch.sessionId,
          signal: controller.signal,
        });
        if (delegationCoordination?.status === "waiting_for_foreground_approval") {
          const waitingWriter = await this.writerFactory(context);
          try {
            const waiting = reconstructMultiRunSession(waitingWriter.events).taskExecution;
            if (
              waiting === null || waiting.activeAttempt !== null ||
              !["queued", "running"].includes(waiting.status) ||
              waiting.graph.graphSha256 !== launch.graphSha256
            ) {
              throw new BackgroundError(
                "worker_reconciliation_required",
                "delegation approval wait no longer targets the exact queued Graph",
              );
            }
            await waitingWriter.appendTaskGraphEvent("task_graph.waiting_for_user", {
              attempt_id: null,
              graph_id: launch.graphId,
              graph_revision: launch.graphRevision,
              graph_sha256: launch.graphSha256,
              reason: "approval_required",
              ...(delegationCoordination.requestedActionRef === null
                ? {}
                : { requested_action_ref: delegationCoordination.requestedActionRef }),
            });
            const execution = reconstructMultiRunSession(waitingWriter.events).taskExecution;
            if (execution === null || execution.status !== "waiting_for_user") {
              throw new BackgroundError("worker_reconciliation_required", "delegation approval wait did not become durable");
            }
            result = Object.freeze({ execution, startedAttempts: 0, stopReason: "waiting_for_user" });
          } finally {
            await waitingWriter.close();
          }
        } else {
          result = await scheduler.run(controller.signal);
        }
        await controlPoll;
        await flushControl();
        await heartbeatChain;
      } finally {
        clearInterval(controlTimer);
        clearInterval(heartbeatTimer);
        clearTimeout(deadlineTimer);
      }
      if (sidecarFailure !== null) throw sidecarFailure;
      const graphStatus = result.execution.status;
      if (!isTerminalGraphStatus(graphStatus)) {
        throw new BackgroundError("worker_reconciliation_required", "scheduler returned without a bounded Graph stop state");
      }
      const terminalWriter = await this.writerFactory(context);
      try {
        const session = reconstructMultiRunSession(terminalWriter.events);
        if (session.background.current?.operationId !== launch.operationId || session.taskExecution === null || session.taskExecution.activeAttempt !== null) {
          throw new BackgroundError("worker_reconciliation_required", "worker cannot prove a clean terminal session boundary");
        }
        const terminalSessionSeq = terminalWriter.events.length + 1;
        const receipt = await store.writeTerminalReceipt({
          activeAttemptId: null,
          graphStatus,
          lastSessionSeq: terminalSessionSeq,
          operationId: launch.operationId,
          processTreeCleanup: "complete",
          schemaVersion: 1,
          workerId: launch.workerId,
        }, randomUUID());
        const event = await terminalWriter.appendTaskGraphEvent("task_worker.terminal", {
          graph_id: launch.graphId,
          graph_revision: launch.graphRevision,
          graph_sha256: launch.graphSha256,
          graph_status: graphStatus,
          operation_id: launch.operationId,
          process_tree_cleanup: "complete",
          receipt_ref: receipt.receiptRef,
          receipt_sha256: receipt.receiptSha256,
          worker_id: launch.workerId,
        });
        lastDurableSessionSeq = event.sessionSeq;
      } finally {
        await terminalWriter.close();
      }
      await store.compareAndSwapHandoff({
        expectedOwner: "worker",
        expectedState: "worker_owned",
        next: backgroundHandoffRecordSchema.parse({
          ...workerHandoff,
          state: "terminal",
          updatedAt: context.now(),
        }),
        nonce: randomUUID(),
      });
      return Object.freeze({
        graphStatus,
        operationId: launch.operationId,
        reconciled: false,
        workerId: launch.workerId,
      });
    } catch (error) {
      ipc.disconnect();
      if (store !== null && bootstrap !== null) {
        const code = error instanceof BackgroundError
          ? error.code
          : error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_.:-]/gu, "_").slice(0, 128) : "unknown_worker_failure";
        await store.writeFailureDiagnostic({
          code,
          observedAt: new Date().toISOString(),
          phase: workerOwned ? "worker_owned" : "bootstrap",
          schemaVersion: 1,
          workerId: bootstrap.workerId,
        }, randomUUID()).catch(() => undefined);
      }
      if (workerOwned && bootstrap !== null && context !== null && store !== null) {
        await this.#markUnknown(context, store, bootstrap).catch(() => undefined);
      }
      throw error;
    }
  }

  async #validateSession(
    context: TaskMutationContext,
    graphSha256: string,
    graphRevision: number,
    workerId: string,
    operationId: string,
  ): Promise<void> {
    const writer = await this.writerFactory(context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (
        session.background.current?.status !== "launching" || session.background.current.workerId !== workerId ||
        session.background.current.operationId !== operationId || session.taskExecution === null ||
        session.taskExecution.enqueue.requestedExecution !== "background" || session.taskExecution.status !== "queued" ||
        session.taskExecution.graph.revision !== graphRevision || session.taskExecution.graph.graphSha256 !== graphSha256
      ) {
        throw new BackgroundError("worker_launch_stale", "session no longer contains the exact queued background Graph");
      }
    } finally {
      await writer.close();
    }
  }

  async #markUnknown(
    context: TaskMutationContext,
    store: BackgroundOperationStore,
    bootstrap: GraphWorkerBootstrapV1,
  ): Promise<void> {
    const launch = await store.readLaunch();
    const handoff = await store.readHandoff();
    if (launch === null || handoff === null || handoff.owner !== "worker" || handoff.state !== "worker_owned") return;
    const writer = await this.writerFactory(context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (session.background.current?.operationId === bootstrap.operationId) {
        await writer.appendTaskGraphEvent("task_worker.reconciled", {
          evidence_sha256: sha256Canonical({
            graph_sha256: bootstrap.graphSha256,
            observation: "worker_runtime_failed_without_terminal_receipt",
            operation_id: bootstrap.operationId,
          }),
          graph_id: launch.graphId,
          graph_revision: launch.graphRevision,
          graph_sha256: launch.graphSha256,
          observation: "unknown",
          operation_id: launch.operationId,
          worker_id: launch.workerId,
        });
      }
    } finally {
      await writer.close();
    }
    await store.compareAndSwapHandoff({
      expectedOwner: "worker",
      expectedState: "worker_owned",
      next: backgroundHandoffRecordSchema.parse({
        ...handoff,
        state: "reconciliation_required",
        updatedAt: context.now(),
      }),
      nonce: randomUUID(),
    });
  }
}
