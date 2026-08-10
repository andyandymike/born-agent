import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { CliIO } from "../cli/types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
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

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return openBackgroundSessionWriter(context);
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
        const selected = controls.find((control) =>
          control.operationId === launch.operationId && control.workerId === launch.workerId &&
          control.workerNonceSha256 === launch.workerNonceSha256 && control.graphId === launch.graphId &&
          control.graphRevision === launch.graphRevision && control.graphSha256 === launch.graphSha256
        );
        if (selected !== undefined) {
          pendingControl = selected;
          controller.abort();
        }
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
          if (
            current === null || current.operationId !== launch.operationId || current.workerId !== launch.workerId ||
            current.status !== "running" || execution === null || execution.graph.graphSha256 !== launch.graphSha256 ||
            !["queued", "running"].includes(execution.status)
          ) {
            throw new BackgroundError("worker_control_stale", "cancel control no longer targets the current worker and Graph");
          }
          if (!current.acceptedControlIds.includes(control.requestId)) {
            await writer.appendTaskGraphEvent("task_worker.control.accepted", {
              control_sha256: sha256Canonical(control),
              graph_id: launch.graphId,
              graph_revision: launch.graphRevision,
              graph_sha256: launch.graphSha256,
              operation_id: launch.operationId,
              request_id: control.requestId,
              worker_id: launch.workerId,
            });
            await writer.appendTaskGraphEvent("task_graph.cancel.requested", {
              active_attempt_id: execution.activeAttempt?.attemptId ?? null,
              graph_id: launch.graphId,
              graph_revision: launch.graphRevision,
              graph_sha256: launch.graphSha256,
              reason: control.reason,
              request_id: control.requestId,
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
          }
        } finally {
          await writer.close();
        }
        await store!.consumeCancel(control, randomUUID());
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
        controlPoll = controlPoll.then(discoverControl).catch((error: unknown) => {
          sidecarFailure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        });
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
        void store!.createCancel(internal).then(() => discoverControl()).catch((error: unknown) => {
          sidecarFailure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        });
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
