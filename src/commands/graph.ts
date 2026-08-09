import { z } from "zod";

import { ArtifactError } from "../artifacts/artifact-types.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { canonicalJson } from "../completion/canonical-json.js";
import { SessionCatalog, SessionCatalogError } from "../sessions/session-catalog.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { assertCanonicalSessionId } from "../sessions/session-path-policy.js";
import { taskMutationContext, taskWriterFactory } from "./task-control-plane-command.js";
import {
  TaskGraphControlPlane,
  verifyTaskGraphRevisionArtifact,
  type TaskGraphMutationResultV1,
} from "../task-graph/task-graph-control-plane.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import { TaskGraphFileLoader } from "../task-graph/task-graph-file-loader.js";
import { observeTaskGraphBinding, type TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import { TaskExecutionControlPlane } from "../scheduling/task-execution-control-plane.js";
import { DeterministicTaskScheduler } from "../scheduling/deterministic-task-scheduler.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskExecutionProjectionV1 } from "../scheduling/task-execution-projector.js";
import { WorktreeError } from "../worktrees/worktree-errors.js";
import { BackgroundError } from "../background/background-errors.js";
import { taskNodeReceiptSchema } from "../task-graph/task-node-receipt.js";
import { parseStrictJson } from "../system/strict-json.js";
import { NodeGitWorktreePort } from "../worktrees/git-worktree-port.js";
import {
  originVerificationReceiptMatchesCompletedEvent,
  originVerificationReceiptSchema,
} from "../worktrees/origin-verification-receipt.js";

export interface GraphValidateOptions { readonly file: string; readonly json: boolean }
export interface GraphShowOptions { readonly json: boolean; readonly revision?: string; readonly sessionId: string }
export interface GraphReplaceOptions {
  readonly baseRevision?: string;
  readonly baseSha256?: string;
  readonly file: string;
  readonly json: boolean;
  readonly sessionId: string;
}
export interface GraphDecisionOptions {
  readonly json: boolean;
  readonly reason?: string;
  readonly revision: string;
  readonly sessionId: string;
  readonly sha256: string;
}
export interface GraphExecutionTargetOptions {
  readonly json: boolean;
  readonly revision: string;
  readonly sessionId: string;
  readonly sha256: string;
}
export interface GraphEnqueueOptions extends GraphExecutionTargetOptions {
  readonly background: boolean;
  readonly runtimeProfile: string;
}
export interface GraphCancelOptions extends GraphExecutionTargetOptions { readonly reason: string }
export interface GraphStatusOptions { readonly json: boolean; readonly live: boolean; readonly sessionId: string }
export interface GraphRunOptions { readonly background: boolean; readonly json: boolean; readonly sessionId: string }
export interface GraphResumeOptions extends GraphExecutionTargetOptions {
  readonly background: boolean;
  readonly foreground: boolean;
  readonly takeover: boolean;
}
export interface GraphWorkerDoctorOptions { readonly json: boolean }
export interface GraphDoctorOptions { readonly json: boolean }
export interface GraphLogsOptions { readonly cursor?: string; readonly json: boolean; readonly node?: string; readonly sessionId: string }
export interface GraphRetryOptions {
  readonly attempt: string;
  readonly json: boolean;
  readonly node: string;
  readonly sessionId: string;
  readonly terminalEvent: string;
}
export interface GraphWorktreesOptions { readonly json: boolean; readonly sessionId: string }
export interface GraphWorktreeAllocateOptions extends GraphExecutionTargetOptions {
  readonly includeCurrentChanges: boolean;
  readonly sourceNode: string;
}
export interface GraphPromoteOptions extends GraphExecutionTargetOptions {
  readonly attemptId: string;
  readonly nodeId: string;
}
export interface GraphOriginVerifyOptions extends GraphExecutionTargetOptions {
  readonly promotionOperation: string;
}
export interface GraphWorktreeCleanupOptions extends GraphExecutionTargetOptions {
  readonly archiveAndRemove: boolean;
  readonly graphId: string;
  readonly nodeId: string;
}

function positive(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TaskGraphError("task_graph_schema_invalid", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function sha(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TaskGraphError("task_graph_schema_invalid", "Graph SHA-256 must be 64 lowercase hex characters");
  }
  return value;
}

function graphLogCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TaskGraphError("task_graph_schema_invalid", "Graph log cursor is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("sessionSeq" in parsed) ||
        !Number.isSafeInteger(parsed.sessionSeq) || (parsed.sessionSeq as number) < 0) {
      throw new Error("invalid cursor payload");
    }
    return parsed.sessionSeq as number;
  } catch (error) {
    throw new TaskGraphError("task_graph_schema_invalid", "Graph log cursor is invalid", { cause: error });
  }
}

function encodeGraphLogCursor(sessionSeq: number): string {
  return Buffer.from(JSON.stringify({ sessionSeq }), "utf8").toString("base64url");
}

function graphDocument(graph: TaskGraphRevisionProjectionV1) {
  return {
    approvedEventId: graph.approvedEventId,
    artifact: graph.artifact,
    binding: graph.binding,
    content: graph.content,
    createdEventId: graph.createdEventId,
    decisionEventId: graph.decisionEventId,
    graphId: graph.graphId,
    graphSha256: graph.graphSha256,
    revision: graph.revision,
    status: graph.status,
    terminalEventId: graph.terminalEventId,
  };
}

function envelope(command: string, sessionId: string | null, graph: TaskGraphRevisionProjectionV1 | null, result: unknown, warnings: readonly string[] = []) {
  return {
    command,
    graph: graph === null ? null : {
      graphId: graph.graphId,
      graphSha256: graph.graphSha256,
      revision: graph.revision,
      status: graph.status,
    },
    result,
    schemaVersion: 1,
    sessionId,
    warnings,
  };
}

function executionDocument(execution: TaskExecutionProjectionV1) {
  return {
    activeAttempt: execution.activeAttempt,
    blocker: execution.blocker,
    budget: execution.budget,
    enqueue: execution.enqueue,
    graph: {
      graphId: execution.graph.graphId,
      graphSha256: execution.graph.graphSha256,
      revision: execution.graph.revision,
      status: execution.status,
    },
    lastSessionSeq: execution.lastSessionSeq,
    nodes: execution.nodes.map((node) => ({
      attempts: node.attempts,
      nextAttemptOrigin: node.nextAttemptOrigin,
      nodeId: node.nodeId,
      sequence: node.node.sequence,
      status: node.status,
      terminalEventId: node.terminalEventId,
      title: node.node.title,
    })),
    readyNodeIds: execution.readyNodeIds,
    schedulerLeaseNonceSha256: execution.schedulerLeaseNonceSha256,
  };
}

function renderFailure(error: unknown, io: CliIO): 1 | 2 | 7 | 8 {
  if (error instanceof TaskGraphError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof SessionCatalogError || error instanceof SessionLockError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 8;
  }
  if (error instanceof ArtifactError) {
    io.stderr.write(`task_graph_artifact_invalid: ${error.message}\n`);
    return 1;
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    io.stderr.write(`task_graph_schema_invalid: ${error instanceof z.ZodError ? error.issues[0]?.message ?? "invalid Graph" : error.message}\n`);
    return 2;
  }
  io.stderr.write("task_graph_internal_error\n");
  return 1;
}

function renderWorktreeFailure(error: unknown, io: CliIO): 1 | 2 | 3 | 7 | 8 {
  if (error instanceof WorktreeError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  return renderFailure(error, io);
}

function renderBackgroundFailure(error: unknown, io: CliIO): 1 | 2 | 3 | 7 | 8 {
  if (error instanceof BackgroundError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
  return renderFailure(error, io);
}

function renderMutation(command: string, result: TaskGraphMutationResultV1, options: { readonly json: boolean }, io: CliIO): void {
  if (options.json) {
    io.stdout.write(`${canonicalJson(envelope(command, result.graph.binding.sessionId, result.graph, {
      deduplicated: result.deduplicated,
      graph: graphDocument(result.graph),
    }))}\n`);
    return;
  }
  io.stdout.write(
    `Graph ${result.graph.graphId} revision ${String(result.graph.revision)} status=${result.graph.status}\nSHA-256: ${result.graph.graphSha256}\n`,
  );
}

export async function executeGraphValidate(options: GraphValidateOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2> {
  try {
    const identity = await new TaskGraphFileLoader().load(runtime.cwd, options.file);
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.validate", null, null, {
        bytes: identity.byteLength,
        canonical: true,
        graphId: identity.content.graphId,
        graphSha256: identity.graphSha256,
        nodeCount: identity.content.nodes.length,
        title: identity.content.title,
      }))}\n`);
    } else {
      io.stdout.write(`Graph valid: ${identity.content.graphId}\nSHA-256: ${identity.graphSha256}\nNodes: ${String(identity.content.nodes.length)}\n`);
    }
    return 0;
  } catch (error) {
    return renderFailure(error, io) === 1 ? 1 : 2;
  }
}

export async function executeGraphShow(options: GraphShowOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    const revisionNumber = options.revision === undefined ? undefined : positive(options.revision, "revision");
    const candidates = revisionNumber === undefined
      ? session.taskGraph.revisions
      : session.taskGraph.revisions.filter((candidate) => candidate.revision === revisionNumber);
    for (const graph of candidates) await verifyTaskGraphRevisionArtifact(runtime.cwd, options.sessionId, graph);
    const current = candidates.find((candidate) =>
      session.taskGraph.currentExecution?.graphSha256 === candidate.graphSha256 ||
      session.taskGraph.currentApproved?.graphSha256 === candidate.graphSha256 ||
      session.taskGraph.currentDraft?.graphSha256 === candidate.graphSha256
    ) ?? candidates.at(-1) ?? null;
    if (revisionNumber !== undefined && current === null) {
      throw new TaskGraphError("task_graph_not_found", "requested Graph revision was not found");
    }
    const observation = current === null ? "unavailable" : observeTaskGraphBinding(current, session.taskState);
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.show", options.sessionId, current, {
        currentObservation: { binding: observation, observedAt: runtime.timestamp() },
        currentApproved: session.taskGraph.currentApproved,
        currentDraft: session.taskGraph.currentDraft,
        currentExecution: session.taskGraph.currentExecution,
        revisions: candidates.map(graphDocument),
        trackingMode: session.taskGraph.trackingMode,
      }))}\n`);
    } else if (current === null) {
      io.stdout.write("Graph: none\n");
    } else {
      io.stdout.write(`Graph ${current.graphId} revision=${String(current.revision)} status=${current.status}\n`);
      io.stdout.write(`Title: ${current.content.title}\nSHA-256: ${current.graphSha256}\nBinding: ${observation}\n`);
      for (const node of current.content.nodes) {
        io.stdout.write(`- ${node.nodeId} [${node.kind}] seq=${String(node.sequence)} depends=${node.dependsOn.join(",") || "none"} ${node.title}\n`);
      }
    }
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphReplace(options: GraphReplaceOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    if ((options.baseRevision === undefined) !== (options.baseSha256 === undefined)) {
      throw new TaskGraphError("task_graph_schema_invalid", "--base-revision and --base-sha256 must be provided together");
    }
    const graph = await new TaskGraphFileLoader().load(runtime.cwd, options.file);
    const result = await new TaskGraphControlPlane(taskWriterFactory(runtime)).replace({
      base: options.baseRevision === undefined || options.baseSha256 === undefined
        ? null
        : { revision: positive(options.baseRevision, "base revision"), sha256: sha(options.baseSha256) },
      context: taskMutationContext(runtime, options.sessionId),
      graph,
    });
    renderMutation("graph.replace", result, options, io);
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphApprove(options: GraphDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const result = await new TaskGraphControlPlane(taskWriterFactory(runtime)).approve({
      context: taskMutationContext(runtime, options.sessionId),
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
    });
    renderMutation("graph.approve", result, options, io);
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphReject(options: GraphDecisionOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const result = await new TaskGraphControlPlane(taskWriterFactory(runtime)).reject({
      context: taskMutationContext(runtime, options.sessionId),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      revision: positive(options.revision, "revision"),
      sha256: sha(options.sha256),
    });
    renderMutation("graph.reject", result, options, io);
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphEnqueue(options: GraphEnqueueOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const result = await new TaskExecutionControlPlane(taskWriterFactory(runtime)).enqueue({
      context: taskMutationContext(runtime, options.sessionId),
      requestedExecution: options.background ? "background" : "foreground",
      revision: positive(options.revision, "revision"),
      runtimeProfileId: options.runtimeProfile,
      sha256: sha(options.sha256),
    });
    const document = executionDocument(result.execution);
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.enqueue", options.sessionId, result.graph, {
        deduplicated: result.deduplicated,
        execution: document,
      }))}\n`);
    } else {
      io.stdout.write(`Graph queued: ${result.graph.graphId} revision=${String(result.graph.revision)}\nReady: ${result.execution.readyNodeIds.join(",") || "none"}\n`);
    }
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphStatus(options: GraphStatusOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    const execution = session.taskExecution;
    const graph = execution?.graph ?? session.taskGraph.revisions.at(-1) ?? null;
    const liveWorker = options.live
      ? await (runtime.observeBackgroundWorkerLive?.({ sessionId: options.sessionId }) ??
          Promise.reject(new BackgroundError("background_executable_unsealed", "runtime has no bounded worker observation capability")))
      : null;
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.status", options.sessionId, graph, {
        background: session.background,
        execution: execution === null ? null : executionDocument(execution),
        liveWorker,
        observedAt: runtime.timestamp(),
        worktrees: session.worktrees,
      }))}\n`);
    } else if (execution === null) {
      io.stdout.write("Graph execution: none\n");
    } else {
      io.stdout.write(`Graph ${execution.graph.graphId} status=${execution.status}\n`);
      io.stdout.write(`Ready: ${execution.readyNodeIds.join(",") || "none"}\n`);
      for (const node of execution.nodes) io.stdout.write(`- ${node.nodeId}: ${node.status} attempts=${String(node.attempts.length)}\n`);
      for (const workspace of session.worktrees.workspaces) io.stdout.write(`- workspace ${workspace.identity.workspaceId}: ${workspace.status} source=${workspace.identity.sourceNodeId}\n`);
      if (session.background.current !== null) io.stdout.write(`Worker ${session.background.current.workerId}: ${session.background.current.status}\n`);
      if (liveWorker !== null) io.stdout.write(`Live worker: ${liveWorker.state} observed=${liveWorker.observedAt}\n`);
    }
    return 0;
  } catch (error) {
    return renderBackgroundFailure(error, io);
  }
}

export async function executeGraphCancel(options: GraphCancelOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const revision = positive(options.revision, "revision");
    const graphSha256 = sha(options.sha256);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    if (session.background.current !== null) {
      const queued = await (runtime.queueBackgroundWorkerCancel?.({
        graphRevision: revision,
        graphSha256,
        reason: options.reason,
        sessionId: options.sessionId,
      }) ?? Promise.reject(new BackgroundError("worker_control_stale", "runtime has no exact background control capability")));
      const graph = session.taskExecution?.graph ?? null;
      if (options.json) {
        io.stdout.write(`${canonicalJson(envelope("graph.cancel", options.sessionId, graph, {
          accepted: true,
          controlSha256: queued.controlSha256,
          operationId: queued.operationId,
          requestId: queued.requestId,
          terminal: false,
          workerId: queued.workerId,
        }))}\n`);
      } else {
        io.stdout.write(`Background Graph cancel queued: request=${queued.requestId} worker=${queued.workerId}\n`);
      }
      return 0;
    }
    const result = await new TaskExecutionControlPlane(taskWriterFactory(runtime)).cancel({
      context: taskMutationContext(runtime, options.sessionId),
      reason: options.reason,
      revision,
      sha256: graphSha256,
    });
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.cancel", options.sessionId, result.graph, {
        execution: executionDocument(result.execution),
      }))}\n`);
    } else {
      io.stdout.write(`Graph cancel requested: ${result.graph.graphId} status=${result.execution.status}\n`);
    }
    return 0;
  } catch (error) {
    return renderBackgroundFailure(error, io);
  }
}

export async function executeGraphRun(options: GraphRunOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    if (session.taskExecution === null) throw new TaskGraphError("task_graph_not_approved", "Graph must be enqueued before run");
    if (options.background) {
      if (session.taskExecution.enqueue.requestedExecution !== "background") {
        throw new TaskGraphError("task_background_unavailable", "this Graph was not enqueued for background ownership");
      }
      const launcher = runtime.createBackgroundWorkerLauncher?.({ sessionId: options.sessionId });
      if (launcher === undefined) {
        throw new BackgroundError("background_executable_unsealed", "runtime has no sealed background worker launcher");
      }
      const result = await launcher.launch();
      if (options.json) {
        io.stdout.write(`${canonicalJson(envelope("graph.run", options.sessionId, session.taskExecution.graph, {
          ...result,
          statusHint: `born graph status ${options.sessionId} --live --json`,
        }))}\n`);
      } else {
        io.stdout.write(`Background Graph accepted: worker=${result.workerId} operation=${result.operationId}\n`);
        io.stdout.write(`Started event: ${result.startedEventId}\n`);
      }
      return 0;
    }
    if (session.taskExecution.enqueue.requestedExecution !== "foreground") {
      throw new TaskGraphError("task_background_unavailable", "this Graph was enqueued for background ownership");
    }
    const executor = runtime.createTaskAttemptExecutor?.({
      io,
      runtimeProfileId: session.taskExecution.enqueue.runtimeProfileId,
      sessionId: options.sessionId,
    });
    if (executor === undefined) {
      throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no Graph attempt executor");
    }
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const result = await new DeterministicTaskScheduler({
        context: taskMutationContext(runtime, options.sessionId),
        executor,
        repositoryId: sha256Canonical({ workspace: runtime.cwd }),
        writerFactory: taskWriterFactory(runtime),
      }).run(controller.signal);
      if (options.json) {
        io.stdout.write(`${canonicalJson(envelope("graph.run", options.sessionId, result.execution.graph, {
          execution: executionDocument(result.execution),
          startedAttempts: result.startedAttempts,
          stopReason: result.stopReason,
        }))}\n`);
      } else {
        io.stdout.write(`Graph stopped: ${result.stopReason}; attempts=${String(result.startedAttempts)}\n`);
      }
      return result.stopReason === "completed" ? 0 : result.stopReason === "cancelled" ? 130 : 8;
    } finally {
      stop();
    }
  } catch (error) {
    return renderBackgroundFailure(error, io);
  }
}

export async function executeGraphResume(options: GraphResumeOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    if (options.background === options.foreground) {
      throw new TaskGraphError("task_graph_schema_invalid", "resume requires exactly one of --foreground or --background");
    }
    const revision = positive(options.revision, "revision");
    const graphSha256 = sha(options.sha256);
    if (options.takeover) {
      if (!options.background) {
        throw new BackgroundError("worker_control_stale", "v1 takeover may only launch a fresh background owner");
      }
      const reconcile = runtime.reconcileBackgroundWorkerTakeover;
      if (reconcile === undefined) {
        throw new BackgroundError("background_executable_unsealed", "runtime has no bounded takeover reconciler");
      }
      await reconcile({ graphRevision: revision, graphSha256, sessionId: options.sessionId });
    }
    const before = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    const enqueued = options.takeover
      ? (() => {
          if (
            before.taskExecution === null ||
            before.taskExecution.status !== "queued" ||
            before.taskExecution.activeAttempt !== null ||
            before.taskExecution.enqueue.requestedExecution !== "background" ||
            before.taskExecution.graph.revision !== revision ||
            before.taskExecution.graph.graphSha256 !== graphSha256 ||
            before.background.current !== null
          ) {
            throw new BackgroundError("worker_reconciliation_required", "takeover did not produce one clean queued Graph");
          }
          return { execution: before.taskExecution, graph: before.taskExecution.graph };
        })()
      : await (async () => {
          if (
            before.taskExecution === null || before.taskExecution.status !== "waiting_for_user" ||
            before.taskExecution.graph.revision !== revision || before.taskExecution.graph.graphSha256 !== graphSha256 ||
            before.background.current !== null
          ) {
            throw new BackgroundError("worker_waiting_for_user", "resume requires one exact waiting Graph with no active worker owner");
          }
          return new TaskExecutionControlPlane(taskWriterFactory(runtime)).enqueue({
            context: taskMutationContext(runtime, options.sessionId),
            requestedExecution: options.background ? "background" : "foreground",
            revision,
            runtimeProfileId: before.taskExecution.enqueue.runtimeProfileId,
            sha256: graphSha256,
          });
        })();
    if (options.background) {
      const launcher = runtime.createBackgroundWorkerLauncher?.({ sessionId: options.sessionId });
      if (launcher === undefined) throw new BackgroundError("background_executable_unsealed", "runtime has no sealed background worker launcher");
      const result = await launcher.launch();
      if (options.json) {
        io.stdout.write(`${canonicalJson(envelope("graph.resume", options.sessionId, enqueued.graph, {
          execution: "background",
          ...result,
          statusHint: `born graph status ${options.sessionId} --live --json`,
        }))}\n`);
      } else {
        io.stdout.write(`Background Graph resumed: worker=${result.workerId} operation=${result.operationId}\n`);
      }
      return 0;
    }
    const executor = runtime.createTaskAttemptExecutor?.({
      io,
      runtimeProfileId: enqueued.execution.enqueue.runtimeProfileId,
      sessionId: options.sessionId,
    });
    if (executor === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no Graph attempt executor");
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const result = await new DeterministicTaskScheduler({
        context: taskMutationContext(runtime, options.sessionId),
        executor,
        repositoryId: sha256Canonical({ workspace: runtime.cwd }),
        writerFactory: taskWriterFactory(runtime),
      }).run(controller.signal);
      if (options.json) {
        io.stdout.write(`${canonicalJson(envelope("graph.resume", options.sessionId, result.execution.graph, {
          execution: "foreground",
          projection: executionDocument(result.execution),
          startedAttempts: result.startedAttempts,
          stopReason: result.stopReason,
        }))}\n`);
      } else {
        io.stdout.write(`Graph resumed and stopped: ${result.stopReason}; attempts=${String(result.startedAttempts)}\n`);
      }
      return result.stopReason === "completed" ? 0 : result.stopReason === "cancelled" ? 130 : 8;
    } finally {
      stop();
    }
  } catch (error) {
    return renderBackgroundFailure(error, io);
  }
}

export async function executeGraphWorkerDoctor(options: GraphWorkerDoctorOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    const descriptor = await (runtime.doctorBackgroundWorker?.() ??
      Promise.reject(new BackgroundError("background_executable_unsealed", "runtime has no sealed worker doctor")));
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.worker.doctor", null, null, {
        descriptor,
        valid: true,
      }))}\n`);
    } else {
      io.stdout.write(`Background worker: valid\nProtocol: ${String(descriptor.workerProtocolVersion)}\nPackage: ${descriptor.packageName}@${descriptor.packageVersion}\n`);
    }
    return 0;
  } catch (error) {
    return renderBackgroundFailure(error, io);
  }
}

export async function executeGraphDoctor(options: GraphDoctorOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8> {
  try {
    if (runtime.supportsPhase16TaskState !== true || runtime.createTaskAttemptExecutor === undefined ||
        runtime.createManagedWorktreeManager === undefined || runtime.createWorktreePromotionRuntime === undefined) {
      throw new TaskGraphError("task_workspace_mode_unavailable", "runtime does not expose the complete foreground Graph/worktree authority");
    }
    const repository = await new NodeGitWorktreePort({ environment: runtime.env }).observe(runtime.cwd);
    const descriptor = await (runtime.doctorBackgroundWorker?.() ??
      Promise.reject(new BackgroundError("background_executable_unsealed", "runtime has no sealed worker doctor")));
    const result = {
      background: { descriptor, valid: true },
      foreground: { deterministicSingleActive: true, valid: true },
      repository: {
        baseCommit: repository.identity.baseCommit,
        objectFormat: repository.identity.objectFormat,
        repositoryId: repository.identity.repositoryId,
        trackedFiles: repository.tracked.length,
      },
      valid: true,
      worktrees: { managed: true, promotion: true, valid: true },
    };
    if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.doctor", null, null, result))}\n`);
    else io.stdout.write(`Graph runtime: valid\nRepository: ${repository.identity.repositoryId}\nTracked files: ${String(repository.tracked.length)}\nBackground worker: valid (${descriptor.packageName}@${descriptor.packageVersion})\n`);
    return 0;
  } catch (error) {
    return error instanceof WorktreeError ? renderWorktreeFailure(error, io) : renderBackgroundFailure(error, io);
  }
}

export async function executeGraphRetry(options: GraphRetryOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    assertCanonicalSessionId(options.terminalEvent);
    const result = await new TaskExecutionControlPlane(taskWriterFactory(runtime)).retry({
      attemptNumber: positive(options.attempt, "attempt"),
      context: taskMutationContext(runtime, options.sessionId),
      nodeId: options.node,
      terminalEventId: options.terminalEvent,
    });
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.retry", options.sessionId, result.graph, {
        execution: executionDocument(result.execution),
        resumeRequired: true,
      }))}\n`);
    } else {
      io.stdout.write(`Graph retry authorized for node ${options.node}; run graph resume with fresh foreground or background authority.\n`);
    }
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphLogs(options: GraphLogsOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    if (options.node !== undefined && !/^[a-z][a-z0-9-]{0,63}$/u.test(options.node)) {
      throw new TaskGraphError("task_graph_schema_invalid", "node selector is invalid");
    }
    const after = graphLogCursor(options.cursor);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    const candidates = session.events.filter((event) =>
      event.scope === "session" && event.sessionSeq > after && (
        (event.type === "task_node.attempt.terminal" && (options.node === undefined || event.data.node_id === options.node)) ||
        (event.type === "task_origin_verification.completed" && (options.node === undefined || event.data.verification_node_id === options.node))
      )
    );
    const selected = candidates.slice(0, 20);
    const store = await ArtifactStore.create({ sessionId: options.sessionId, workspace: runtime.cwd });
    const records = [];
    for (const event of selected) {
      if (event.scope !== "session") continue;
      if (event.type === "task_origin_verification.completed") {
        const artifact = await store.readVerified(event.data.receipt_artifact_id);
        const receipt = originVerificationReceiptSchema.parse(parseStrictJson(artifact.bytes.toString("utf8")));
        if (!originVerificationReceiptMatchesCompletedEvent(receipt, event.data)) {
          throw new TaskGraphError("task_graph_artifact_invalid", "origin verification receipt does not exact-match its terminal event");
        }
        records.push({
          kind: "origin_verification",
          nodeId: event.data.verification_node_id,
          promotionOperationId: event.data.promotion_operation_id,
          receipt,
          sessionSeq: event.sessionSeq,
          status: event.data.status,
          verificationId: event.data.verification_id,
        });
        continue;
      }
      if (event.type !== "task_node.attempt.terminal") continue;
      if (event.data.receipt_artifact_id === null || event.data.receipt_sha256 === null) {
        records.push({ attemptId: event.data.attempt_id, nodeId: event.data.node_id, receipt: null, sessionSeq: event.sessionSeq, terminal: event.data.terminal });
        continue;
      }
      const artifact = await store.readVerified(event.data.receipt_artifact_id);
      const receipt = taskNodeReceiptSchema.parse(parseStrictJson(artifact.bytes.toString("utf8")));
      if (receipt.receiptSha256 !== event.data.receipt_sha256 || receipt.attemptId !== event.data.attempt_id || receipt.nodeId !== event.data.node_id) {
        throw new TaskGraphError("task_graph_artifact_invalid", "node receipt does not exact-match its terminal event");
      }
      records.push({ attemptId: event.data.attempt_id, nodeId: event.data.node_id, receipt, sessionSeq: event.sessionSeq, terminal: event.data.terminal });
    }
    const nextCursor = candidates.length > selected.length && selected.length > 0
      ? encodeGraphLogCursor(selected.at(-1)!.sessionSeq)
      : null;
    const graph = session.taskExecution?.graph ?? session.taskGraph.revisions.at(-1) ?? null;
    if (options.json) {
      io.stdout.write(`${canonicalJson(envelope("graph.logs", options.sessionId, graph, { nextCursor, records }))}\n`);
    } else if (records.length === 0) {
      io.stdout.write("Graph logs: no matching node receipts\n");
    } else {
      for (const record of records) {
        if ("verificationId" in record) {
          io.stdout.write(`[${String(record.sessionSeq)}] ${record.nodeId}/origin:${record.verificationId}: ${record.status}\n`);
        } else {
          io.stdout.write(`[${String(record.sessionSeq)}] ${record.nodeId}/${record.attemptId}: ${record.receipt?.summary ?? record.terminal}\n`);
        }
      }
      if (nextCursor !== null) io.stdout.write(`Next cursor: ${nextCursor}\n`);
    }
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphWorktrees(options: GraphWorktreesOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 7 | 8> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    const graph = session.taskExecution?.graph ?? session.taskGraph.revisions.at(-1) ?? null;
    const result = {
      pendingOperationIds: session.worktrees.pendingOperationIds,
      promotions: session.worktrees.promotions.map((promotion) => ({
        bundleSha256: promotion.bundle.bundleSha256,
        nodeId: promotion.bundle.nodeId,
        status: promotion.status,
        workspaceId: promotion.bundle.workspaceId,
      })),
      originVerifications: session.worktrees.originVerifications.map((verification) => ({
        promotionOperationId: verification.promotionOperationId,
        receiptSha256: verification.receiptSha256,
        status: verification.status,
        verificationId: verification.verificationId,
        verificationNodeId: verification.verificationNodeId,
        workspaceId: verification.workspaceId,
      })),
      workspaces: session.worktrees.workspaces.map((workspace) => ({
        activeAttemptId: workspace.activeAttemptId,
        baselineSha256: workspace.baseline.manifestSha256,
        lastSnapshotSha256: workspace.lastSnapshot?.sha256 ?? null,
        nodeIds: workspace.nodeIds,
        sourceNodeId: workspace.identity.sourceNodeId,
        status: workspace.status,
        workspaceId: workspace.identity.workspaceId,
      })),
    };
    if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.worktrees", options.sessionId, graph, result))}\n`);
    else if (result.workspaces.length === 0) io.stdout.write("Managed worktrees: none\n");
    else for (const workspace of result.workspaces) io.stdout.write(`${workspace.workspaceId}: ${workspace.status} source=${workspace.sourceNodeId} snapshot=${workspace.lastSnapshotSha256 ?? "none"}\n`);
    return 0;
  } catch (error) {
    return renderFailure(error, io);
  }
}

export async function executeGraphWorktreeAllocate(options: GraphWorktreeAllocateOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    const manager = await runtime.createManagedWorktreeManager?.({ io, sessionId: options.sessionId });
    if (manager === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no managed worktree authority");
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const handle = await manager.allocate({
        allowDirty: options.includeCurrentChanges,
        graphRevision: positive(options.revision, "revision"),
        graphSha256: sha(options.sha256),
        signal: controller.signal,
        sourceNodeId: options.sourceNode,
      });
      const result = {
        baselineManifestSha256: handle.baselineManifestSha256,
        identity: handle.identity,
        nodeIds: handle.nodeIds,
      };
      if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.worktree.allocate", options.sessionId, null, result))}\n`);
      else io.stdout.write(`Managed worktree ready: ${handle.identity.workspaceId}\nBaseline: ${handle.baselineManifestSha256}\nNodes: ${handle.nodeIds.join(", ")}\n`);
      return 0;
    } finally {
      stop();
    }
  } catch (error) {
    return renderWorktreeFailure(error, io);
  }
}

export async function executeGraphPromote(options: GraphPromoteOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    assertCanonicalSessionId(options.attemptId);
    const promotion = await runtime.createWorktreePromotionRuntime?.({ io, sessionId: options.sessionId });
    if (promotion === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no worktree promotion authority");
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const result = await promotion.promote({
        attemptId: options.attemptId,
        graphRevision: positive(options.revision, "revision"),
        graphSha256: sha(options.sha256),
        nodeId: options.nodeId,
        signal: controller.signal,
      });
      if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.promote", options.sessionId, null, result))}\n`);
      else io.stdout.write(`Promotion applied: ${result.bundle.bundleSha256}\nPaths: ${result.changedPaths.join(", ")}\nOrigin snapshot: ${result.originSourceSnapshotSha256}\nOrigin verification: ${result.originVerification?.status ?? "not_required"}\n`);
      return result.originVerification === null || result.originVerification.status === "passed" ? 0 : 8;
    } finally {
      stop();
    }
  } catch (error) {
    return renderWorktreeFailure(error, io);
  }
}

export async function executeGraphOriginVerify(options: GraphOriginVerifyOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    assertCanonicalSessionId(options.promotionOperation);
    const promotion = await runtime.createWorktreePromotionRuntime?.({ io, sessionId: options.sessionId });
    if (promotion === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no origin verification authority");
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const result = await promotion.verifyOrigin({
        graphRevision: positive(options.revision, "revision"),
        graphSha256: sha(options.sha256),
        promotionOperationId: options.promotionOperation,
        signal: controller.signal,
      });
      if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.verify-origin", options.sessionId, null, result))}\n`);
      else io.stdout.write(`Origin verification ${result.status}: ${result.verificationId}\nReceipt: ${result.receiptSha256}\n`);
      return result.status === "passed" ? 0 : 8;
    } finally {
      stop();
    }
  } catch (error) {
    return renderWorktreeFailure(error, io);
  }
}

export async function executeGraphWorktreeCleanup(options: GraphWorktreeCleanupOptions, runtime: CliRuntime, io: CliIO): Promise<0 | 1 | 2 | 3 | 7 | 8 | 130> {
  try {
    assertCanonicalSessionId(options.sessionId);
    assertCanonicalSessionId(options.graphId);
    const manager = await runtime.createManagedWorktreeManager?.({ io, sessionId: options.sessionId });
    if (manager === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no managed worktree cleanup authority");
    const controller = new AbortController();
    const stop = runtime.onCancel(() => controller.abort());
    try {
      const result = await manager.cleanup({
        archiveAndRemove: options.archiveAndRemove,
        graphId: options.graphId,
        graphRevision: positive(options.revision, "revision"),
        graphSha256: sha(options.sha256),
        nodeId: options.nodeId,
        signal: controller.signal,
      });
      if (options.json) io.stdout.write(`${canonicalJson(envelope("graph.worktree.cleanup", options.sessionId, null, result))}\n`);
      else io.stdout.write(`Managed worktree ${result.status}: ${result.workspaceId}${result.archiveSha256 === null ? "" : `\nArchive: ${result.archiveSha256}`}\n`);
      return 0;
    } finally {
      stop();
    }
  } catch (error) {
    return renderWorktreeFailure(error, io);
  }
}
