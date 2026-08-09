import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { SessionCatalog } from "../sessions/session-catalog.js";
import { NodeGitWorktreePort, type GitWorktreePort } from "../worktrees/git-worktree-port.js";
import { currentProcessIdentity } from "../sessions/process-identity.js";
import { BackgroundError } from "./background-errors.js";
import { revalidateBackgroundExecutable, sealBackgroundExecutable, type SealedBackgroundExecutableV1 } from "./background-executable-descriptor.js";
import { BackgroundOperationStore } from "./background-operation-store.js";
import {
  backgroundHandoffRecordSchema,
  backgroundLaunchRecordSchema,
  graphWorkerBootstrapSchema,
  graphWorkerParentAckSchema,
  graphWorkerReadySchema,
  type BackgroundHandoffRecordV1,
  type GraphWorkerReadyV1,
} from "./background-schema.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, { createEventId: context.randomUuid, timestamp: context.now });
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function currentProcessStartIdentity(): string {
  return currentProcessIdentity().startIdentity;
}

function workerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  workerUserStateRoot: string,
  worktreeUserStateRoot: string | undefined,
): NodeJS.ProcessEnv {
  const names = [
    "PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "XDG_STATE_HOME", "LANG", "LC_ALL",
    "BORN_PROVIDER", "BORN_MODEL", "BORN_OLLAMA_BASE_URL",
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) if (environment[name] !== undefined) result[name] = environment[name];
  result.BORN_BACKGROUND_WORKER = "1";
  result.BORN_WORKER_STATE_ROOT = workerUserStateRoot;
  if (worktreeUserStateRoot !== undefined) result.BORN_WORKTREE_STATE_ROOT = worktreeUserStateRoot;
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

export interface BackgroundLaunchResultV1 {
  readonly accepted: true;
  readonly operationId: string;
  readonly startedEventId: string;
  readonly workerId: string;
}

export interface BackgroundChildFactory {
  spawn(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly executable: string;
  }): ChildProcess;
}

const nodeChildFactory: BackgroundChildFactory = {
  spawn(input) {
    // PHASE19: a PID is only a process observation. Background success is
    // withheld until the child owns the durable lease, appends started, and
    // returns the matching IPC receipt.
    return spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      detached: false,
      env: input.env,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
  },
};

export class BackgroundWorkerLauncher {
  constructor(private readonly options: {
    readonly childFactory?: BackgroundChildFactory;
    readonly cliEntryPath: string;
    readonly context: TaskMutationContext;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly git?: GitWorktreePort;
    readonly handshakeTimeoutMs?: number;
    readonly nodeExecutablePath: string;
    readonly nodeVersion: string;
    readonly userStateRoot: string;
    readonly worktreeUserStateRoot?: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async doctor(): Promise<SealedBackgroundExecutableV1> {
    return sealBackgroundExecutable({
      cliEntryPath: this.options.cliEntryPath,
      nodeExecutablePath: this.options.nodeExecutablePath,
      nodeVersion: this.options.nodeVersion,
    });
  }

  async launch(): Promise<BackgroundLaunchResultV1> {
    const sealed = await this.doctor();
    let writer = await this.writerFactory(this.options.context);
    let graph;
    let runtimeProfileId: string;
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (session.background.current !== null) throw new BackgroundError("worker_owner_active", "Graph already has a background owner");
      if (session.taskExecution === null || session.taskExecution.status !== "queued" || session.taskExecution.enqueue.requestedExecution !== "background") {
        throw new BackgroundError("worker_launch_stale", "only one exact background-enqueued Graph can be launched");
      }
      graph = session.taskExecution.graph;
      runtimeProfileId = session.taskExecution.enqueue.runtimeProfileId;
    } finally {
      await writer.close();
    }
    const git = this.options.git ?? new NodeGitWorktreePort({ environment: this.options.environment });
    const repository = await git.observe(this.options.context.workspace);
    const operationId = this.options.context.randomUuid();
    const workerId = this.options.context.randomUuid();
    const rawNonce = randomBytes(32).toString("base64url");
    const workerNonceSha256 = hash(rawNonce);
    const parentNonce = randomBytes(32).toString("base64url");
    const parentProcessStartIdentity = currentProcessStartIdentity();
    const launchDeadline = new Date(Date.now() + (this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)).toISOString();
    const store = await BackgroundOperationStore.create({ operationId, repositoryId: repository.identity.repositoryId, root: this.options.userStateRoot });
    const launch = backgroundLaunchRecordSchema.parse({
      cliEntryPath: sealed.cliEntryPath,
      descriptor: sealed.descriptor,
      descriptorSha256: sealed.descriptorSha256,
      graphId: graph.graphId,
      graphRevision: graph.revision,
      graphSha256: graph.graphSha256,
      launchDeadline,
      nodeExecutablePath: sealed.nodeExecutablePath,
      operationId,
      originRoot: repository.originRoot,
      parentPid: process.pid,
      parentProcessStartIdentity,
      repositoryId: repository.identity.repositoryId,
      runtimeProfileId,
      schemaVersion: 1,
      sessionId: this.options.context.sessionId,
      workerId,
      workerNonceSha256,
    });
    const handoff = backgroundHandoffRecordSchema.parse({
      graphSha256: graph.graphSha256,
      operationId,
      owner: "parent",
      ownerPid: process.pid,
      ownerProcessStartIdentity: parentProcessStartIdentity,
      parentNonceSha256: hash(parentNonce),
      schemaVersion: 1,
      state: "launching",
      updatedAt: this.options.context.now(),
      workerId,
      workerNonceSha256,
    });
    await store.createLaunch(launch);
    await store.createHandoff(handoff);
    writer = await this.writerFactory(this.options.context);
    try {
      const current = reconstructMultiRunSession(writer.events);
      if (current.taskExecution?.graph.graphSha256 !== graph.graphSha256 || current.taskExecution.status !== "queued") {
        throw new BackgroundError("worker_launch_stale", "Graph changed before durable worker spawn request");
      }
      await writer.appendTaskGraphEvent("task_worker.spawn.requested", {
        graph_id: graph.graphId,
        graph_revision: graph.revision,
        graph_sha256: graph.graphSha256,
        descriptor: sealed.descriptor,
        descriptor_sha256: sealed.descriptorSha256,
        operation_id: operationId,
        repository_id: repository.identity.repositoryId,
        worker_id: workerId,
        worker_nonce_sha256: workerNonceSha256,
      });
    } finally {
      // PHASE19: the parent closes session ownership before spawning. The child
      // may not claim the handoff while a parent writer is still live.
      await writer.close();
    }
    await revalidateBackgroundExecutable(sealed);
    const child = (this.options.childFactory ?? nodeChildFactory).spawn({
      argv: [sealed.cliEntryPath, "internal", "graph-worker", "--operation", operationId, "--repository", repository.identity.repositoryId],
      cwd: repository.originRoot,
      env: workerEnvironment(this.options.environment, this.options.userStateRoot, this.options.worktreeUserStateRoot),
      executable: sealed.nodeExecutablePath,
    });
    const bootstrap = graphWorkerBootstrapSchema.parse({
      executableDescriptorSha256: sealed.descriptorSha256,
      graphRevision: graph.revision,
      graphSha256: graph.graphSha256,
      launchDeadline,
      operationId,
      parentPid: process.pid,
      parentProcessStartIdentity,
      protocolVersion: 1,
      rawNonce,
      sessionId: this.options.context.sessionId,
      workerId,
    });
    let ready: GraphWorkerReadyV1;
    try {
      ready = await this.#handshake(child, bootstrap);
    } catch (error) {
      child.kill();
      await this.#markLaunchFailure({
        graphId: graph.graphId,
        graphRevision: graph.revision,
        graphSha256: graph.graphSha256,
        handoff,
        operationId,
        store,
        workerId,
      }).catch(() => undefined);
      throw error;
    }
    try {
      await revalidateBackgroundExecutable(sealed);
      if (ready.workerNonceSha256 !== workerNonceSha256 || ready.operationId !== operationId || ready.workerId !== workerId) {
        throw new BackgroundError("worker_protocol_mismatch", "ready receipt identity does not match the sealed bootstrap");
      }
      const handoffAfter = await store.readHandoff();
      if (handoffAfter?.owner !== "worker" || handoffAfter.state !== "worker_owned" || handoffAfter.workerNonceSha256 !== workerNonceSha256) {
        throw new BackgroundError("worker_handoff_conflict", "child ready receipt arrived without durable worker ownership");
      }
      const verification = await new SessionCatalog(this.options.context.workspace).read(this.options.context.sessionId);
      const started = verification.events.find((event) => event.eventId === ready.startedEventId);
      if (started === undefined || started.scope !== "session" || started.type !== "task_worker.started" ||
          started.sessionSeq !== ready.startedSessionSeq || started.data.operation_id !== operationId ||
          started.data.worker_id !== workerId || started.data.scheduler_lease_sha256 !== ready.schedulerLeaseSha256) {
        throw new BackgroundError("worker_protocol_mismatch", "IPC ready receipt has no matching durable worker started event");
      }
      await this.#sendAck(child, graphWorkerParentAckSchema.parse({
        accepted: true,
        operationId,
        protocolVersion: 1,
        startedEventId: ready.startedEventId,
        workerId,
      }));
      if (child.connected) child.disconnect();
      child.unref();
      return Object.freeze({ accepted: true, operationId, startedEventId: ready.startedEventId, workerId });
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async #handshake(child: ChildProcess, bootstrap: ReturnType<typeof graphWorkerBootstrapSchema.parse>): Promise<GraphWorkerReadyV1> {
    return new Promise((resolveReady, reject) => {
      let settled = false;
      const finish = (error: Error | null, ready?: GraphWorkerReadyV1): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (error !== null) reject(error);
        else resolveReady(ready!);
      };
      const onError = (error: Error) => finish(new BackgroundError("worker_handshake_timeout", "background child failed before ready", { cause: error }));
      const onExit = () => finish(new BackgroundError("worker_handshake_timeout", "background child exited before ready"));
      const onMessage = (message: unknown) => {
        try {
          finish(null, graphWorkerReadySchema.parse(message));
        } catch (error) {
          finish(new BackgroundError("worker_protocol_mismatch", "background child sent an invalid ready receipt", { cause: error }));
        }
      };
      const timeout = setTimeout(() => finish(new BackgroundError("worker_handshake_timeout", "background child ready handshake timed out")), this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("message", onMessage);
      // PHASE19: the raw nonce travels only over inherited IPC. It never enters
      // argv, env, the session log, or the restricted launch record.
      child.send?.(bootstrap, (error) => {
        if (error !== null) finish(new BackgroundError("worker_handshake_timeout", "background bootstrap could not be sent", { cause: error }));
      });
    });
  }

  async #sendAck(child: ChildProcess, ack: ReturnType<typeof graphWorkerParentAckSchema.parse>): Promise<void> {
    if (!child.connected || child.send === undefined) {
      throw new BackgroundError("worker_handshake_timeout", "background child disconnected before parent acknowledgement");
    }
    await new Promise<void>((resolveAck, reject) => {
      child.send!(ack, (error) => {
        if (error == null) resolveAck();
        else reject(new BackgroundError("worker_handshake_timeout", "parent acknowledgement could not be sent", { cause: error }));
      });
    });
  }

  async #markLaunchFailure(input: {
    readonly graphId: string;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly handoff: BackgroundHandoffRecordV1;
    readonly operationId: string;
    readonly store: BackgroundOperationStore;
    readonly workerId: string;
  }): Promise<void> {
    const current = await input.store.readHandoff();
    if (current?.owner !== "parent" || current.state !== "launching") return;
    await input.store.compareAndSwapHandoff({
      expectedOwner: "parent",
      expectedState: "launching",
      next: backgroundHandoffRecordSchema.parse({
        ...input.handoff,
        state: "reconciliation_required",
        updatedAt: this.options.context.now(),
      }),
      nonce: this.options.context.randomUuid(),
    });
    const writer = await this.writerFactory(this.options.context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (session.background.current?.operationId === input.operationId) {
        await writer.appendTaskGraphEvent("task_worker.reconciled", {
          evidence_sha256: sha256Canonical({
            graph_sha256: input.graphSha256,
            observation: "parent_handshake_failed_before_verified_ready",
            operation_id: input.operationId,
          }),
          graph_id: input.graphId,
          graph_revision: input.graphRevision,
          graph_sha256: input.graphSha256,
          observation: "unknown",
          operation_id: input.operationId,
          worker_id: input.workerId,
        });
      }
    } finally {
      await writer.close();
    }
  }
}
