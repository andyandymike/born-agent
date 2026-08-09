import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import type { TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskNodeSpecV1 } from "../task-graph/task-graph-schema.js";
import {
  reservationForTaskNode,
  taskBudgetCanReserve,
  taskBudgetEventReservation,
  taskBudgetTerminal,
} from "./task-budget-ledger.js";
import type { TaskBudgetCountersV1, TaskExecutionProjectionV1 } from "./task-execution-projector.js";
import { deterministicReadyQueue } from "./task-ready-queue.js";
import { persistTaskNodeReceipt } from "../task-graph/task-node-receipt.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

export interface TaskAttemptExecutionResultV1 {
  readonly budget: TaskBudgetCountersV1;
  readonly diagnosticCode?: string;
  readonly receiptArtifactId: string | null;
  readonly receiptSha256: string | null;
  readonly structuredEvidence?: readonly {
    readonly artifactRef: string;
    readonly kind: string;
    readonly sha256: string;
  }[];
  readonly terminal:
    | "blocked_reconciliation"
    | "blocked_unknown_effect"
    | "cancelled_clean"
    | "known_failed"
    | "pre_effect_infrastructure_failure"
    | "succeeded";
  readonly usageCompleteness: "complete" | "none" | "partial";
  readonly waitingForUser?: {
    readonly reason: "approval_required" | "input_required" | "profile_required" | "promotion_required";
    readonly requestedActionRef: string;
  };
}

export interface StartedTaskAttemptV1 {
  /** Resolves only after the exact normal run.started fact is durable. */
  readonly attemptStartedPersisted?: boolean;
  readonly result: Promise<TaskAttemptExecutionResultV1>;
}

export interface PreparedTaskWorkspaceV1 {
  /** Trusted absolute path; never persisted or returned to the model. */
  readonly executionRoot: string;
  readonly binding: {
    readonly managed_path_sha256: string;
    readonly repository_id: string;
    readonly source_snapshot_sha256: string;
    readonly workspace_baseline_sha256: string;
    readonly workspace_id: string;
  } | null;
}

export interface TaskAttemptExecutor {
  supports(node: TaskNodeSpecV1): boolean;
  readonly prepareWorkspace?: (input: {
    readonly attemptId: string;
    readonly graph: TaskGraphRevisionProjectionV1;
    readonly node: TaskNodeSpecV1;
    readonly signal: AbortSignal;
  }) => Promise<PreparedTaskWorkspaceV1>;
  start(input: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly graph: TaskGraphRevisionProjectionV1;
    readonly node: TaskNodeSpecV1;
    readonly runId: string;
    readonly schedulerLeaseNonceSha256: string;
    readonly signal: AbortSignal;
    readonly workspace: PreparedTaskWorkspaceV1;
  }): Promise<StartedTaskAttemptV1>;
}

export interface TaskSchedulerRunResultV1 {
  readonly execution: TaskExecutionProjectionV1;
  readonly startedAttempts: number;
  readonly stopReason: "blocked" | "cancelled" | "completed" | "failed" | "waiting_for_user";
}

interface AdmittedTaskAttemptV1 {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly node: TaskNodeSpecV1;
  readonly runId: string;
  readonly schedulerLeaseNonceSha256: string;
  readonly workspace: PreparedTaskWorkspaceV1;
}

function exactFields(graph: TaskGraphRevisionProjectionV1) {
  return {
    graph_id: graph.graphId,
    graph_revision: graph.revision,
    graph_sha256: graph.graphSha256,
  } as const;
}

function zeroConsumption(reservation: TaskBudgetCountersV1): TaskBudgetCountersV1 {
  return Object.freeze({
    artifactBytes: 0,
    attempts: 1,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: 0,
    commandOutputBytes: 0,
    durationMs: 0,
    modelSteps: 0,
    reportedTokens: reservation.reportedTokens === null ? null : 0,
  });
}

function terminalStatus(terminal: TaskAttemptExecutionResultV1["terminal"]): "blocked" | "cancelled" | "failed" {
  if (terminal === "cancelled_clean") return "cancelled";
  if (terminal === "blocked_reconciliation" || terminal === "blocked_unknown_effect") return "blocked";
  return "failed";
}

function terminalBlocker(terminal: TaskAttemptExecutionResultV1["terminal"]): string | undefined {
  return terminal === "blocked_unknown_effect" ? "task_effect_unknown"
    : terminal === "blocked_reconciliation" ? "task_effect_reconciliation_required"
      : undefined;
}

export class DeterministicTaskScheduler {
  constructor(private readonly options: {
    readonly beforeTransition?: () => Promise<void>;
    readonly context: TaskMutationContext;
    readonly executor: TaskAttemptExecutor;
    readonly repositoryId: string;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  private get writerFactory(): TaskMutationWriterFactory {
    return this.options.writerFactory ?? defaultWriterFactory;
  }

  async #mutate<T>(operation: (writer: V2SessionWriter, execution: TaskExecutionProjectionV1) => Promise<T>): Promise<T> {
    const writer = await this.writerFactory(this.options.context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (session.taskExecution === null) throw new TaskGraphError("task_graph_not_approved", "Graph is not enqueued");
      return await operation(writer, session.taskExecution);
    } finally {
      await writer.close();
    }
  }

  async #snapshot(): Promise<TaskExecutionProjectionV1> {
    return this.#mutate(async (_writer, execution) => execution);
  }

  async #ensureStarted(): Promise<TaskExecutionProjectionV1> {
    return this.#mutate(async (writer, execution) => {
      if (execution.status === "running") return execution;
      if (execution.status !== "queued") {
        throw new TaskGraphError("task_scheduler_busy", `Graph cannot start from ${execution.status}`);
      }
      const nonce = this.options.context.randomUuid();
      const leaseSha256 = sha256Canonical({
        graph_id: execution.graph.graphId,
        graph_revision: execution.graph.revision,
        nonce,
        repository_id: this.options.repositoryId,
        session_id: this.options.context.sessionId,
      });
      await writer.appendTaskGraphEvent("task_scheduler.lease.acquired", {
        ...exactFields(execution.graph),
        lease_nonce_sha256: leaseSha256,
        repository_id: this.options.repositoryId,
      });
      await writer.appendTaskGraphEvent("task_graph.started", {
        ...exactFields(execution.graph),
        enqueue_id: execution.enqueue.enqueueId,
        scheduler_lease_nonce_sha256: leaseSha256,
      });
      const next = reconstructMultiRunSession(writer.events).taskExecution;
      if (next === null) throw new TaskGraphError("task_graph_invalid", "Graph start projection disappeared");
      return next;
    });
  }

  async #admit(execution: TaskExecutionProjectionV1, signal: AbortSignal): Promise<AdmittedTaskAttemptV1 | null> {
    const ready = deterministicReadyQueue(execution);
    const selected = ready[0];
    if (selected === undefined) return null;
    if (!this.options.executor.supports(selected.node)) {
      throw new TaskGraphError("task_workspace_mode_unavailable", `node ${selected.nodeId} is not supported by this scheduler runtime`);
    }
    const held = reservationForTaskNode(selected.node);
    if (!taskBudgetCanReserve(execution.budget, held)) {
      await this.#mutate(async (writer, current) => {
        const counters = [
          ["attempts", held.attempts, current.budget.remaining.attempts],
          ["duration_ms", held.durationMs, current.budget.remaining.durationMs],
          ["model_steps", held.modelSteps, current.budget.remaining.modelSteps],
          ["command_executions", held.commandExecutions, current.budget.remaining.commandExecutions],
          ["command_output_bytes", held.commandOutputBytes, current.budget.remaining.commandOutputBytes],
          ["changed_files", held.changedFiles, current.budget.remaining.changedFiles],
          ["changed_bytes", held.changedBytes, current.budget.remaining.changedBytes],
          ["artifact_bytes", held.artifactBytes, current.budget.remaining.artifactBytes],
          ["reported_tokens", held.reportedTokens, current.budget.remaining.reportedTokens],
        ] as const;
        const exhausted = counters.find(([, requested, remaining]) => remaining !== null && requested !== null && requested > remaining);
        await writer.appendTaskGraphEvent("task_budget.exhausted", {
          ...exactFields(current.graph),
          counter: exhausted?.[0] ?? "attempts",
          node_id: selected.nodeId,
        });
        await writer.appendTaskGraphEvent("task_graph.terminal", {
          ...exactFields(current.graph),
          blocker_code: "task_budget_exhausted",
          reason: "approved Graph budget cannot reserve the next node",
          status: "blocked",
        });
      });
      return null;
    }
    const attemptId = this.options.context.randomUuid();
    const runId = this.options.context.randomUuid();
    const attemptNumber = selected.attempts.length + 1;
    const lease = execution.schedulerLeaseNonceSha256;
    if (lease === null) throw new TaskGraphError("task_scheduler_busy", "Graph has no active scheduler lease");
    const workspace = this.options.executor.prepareWorkspace === undefined
      ? Object.freeze({ executionRoot: this.options.context.workspace, binding: null })
      : await this.options.executor.prepareWorkspace({ attemptId, graph: execution.graph, node: selected.node, signal });
    if ((selected.node.workspace.mode === "origin_read_only") !== (workspace.binding === null)) {
      throw new TaskGraphError("task_workspace_mode_unavailable", `node ${selected.nodeId} workspace preparation violated its Graph mode`);
    }
    await this.#mutate(async (writer, current) => {
      if (current.readyNodeIds[0] !== selected.nodeId || current.activeAttempt !== null) {
        throw new TaskGraphError("task_scheduler_busy", "ready queue changed before node admission");
      }
      if (workspace.binding !== null) {
        await writer.appendTaskGraphEvent("task_worktree.lease.acquired", {
          ...exactFields(current.graph),
          attempt_id: attemptId,
          lease_nonce_sha256: sha256Canonical({ attempt_id: attemptId, scheduler_lease_nonce_sha256: lease, workspace_id: workspace.binding.workspace_id }),
          node_id: selected.nodeId,
          workspace_id: workspace.binding.workspace_id,
        });
      }
      await writer.appendTaskGraphEvent("task_node.attempt.requested", {
        ...exactFields(current.graph),
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        node_id: selected.nodeId,
        reservation: taskBudgetEventReservation(held),
        retry_origin: selected.nextAttemptOrigin ?? (() => {
          throw new TaskGraphError("task_graph_invalid", `node ${selected.nodeId} has no next-attempt authority`);
        })(),
        ...(workspace.binding === null ? {} : { workspace_binding: workspace.binding }),
      });
    });
    return { attemptId, attemptNumber, node: selected.node, runId, schedulerLeaseNonceSha256: lease, workspace };
  }

  async #terminal(
    admitted: AdmittedTaskAttemptV1,
    result: TaskAttemptExecutionResultV1,
  ): Promise<TaskExecutionProjectionV1> {
    return this.#mutate(async (writer, execution) => {
      if (execution.activeAttempt?.attemptId !== admitted.attemptId) {
        throw new TaskGraphError("task_scheduler_busy", "attempt ownership changed before terminal append");
      }
      const sessionBeforeTerminal = reconstructMultiRunSession(writer.events);
      const acceptedSnapshot = sessionBeforeTerminal.worktrees.workspaces.find((workspace) =>
        workspace.lastSnapshot?.attemptId === admitted.attemptId
      )?.lastSnapshot?.sha256 ?? null;
      const receipt = result.receiptArtifactId === null && result.receiptSha256 === null
        ? await persistTaskNodeReceipt({
            attemptId: admitted.attemptId,
            attemptNumber: admitted.attemptNumber,
            context: this.options.context,
            graph: execution.graph,
            node: admitted.node,
            result,
            verificationGenerationId: null,
            workspaceSnapshotSha256: acceptedSnapshot,
          })
        : null;
      if ((result.receiptArtifactId === null) !== (result.receiptSha256 === null)) {
        throw new TaskGraphError("task_effect_reconciliation_required", "executor returned an incomplete task node receipt identity");
      }
      const terminalBudget = receipt === null ? result.budget : Object.freeze({
        ...result.budget,
        artifactBytes: result.budget.artifactBytes + receipt.artifactBytes,
      });
      const terminalEvent = await writer.appendTaskGraphEvent("task_node.attempt.terminal", {
        ...exactFields(execution.graph),
        attempt_id: admitted.attemptId,
        budget: taskBudgetTerminal(terminalBudget, result.usageCompleteness),
        node_id: admitted.node.nodeId,
        receipt_artifact_id: receipt?.artifactId ?? result.receiptArtifactId,
        receipt_sha256: receipt?.receipt.receiptSha256 ?? result.receiptSha256,
        run_id: admitted.runId,
        terminal: result.terminal,
      });
      if (execution.activeAttempt.workspaceBinding !== null) {
        await writer.appendTaskGraphEvent("task_worktree.lease.released", {
          ...exactFields(execution.graph),
          attempt_id: admitted.attemptId,
          node_id: admitted.node.nodeId,
          terminal_event_id: terminalEvent.eventId,
          workspace_id: execution.activeAttempt.workspaceBinding.workspace_id,
        });
      }
      let next = reconstructMultiRunSession(writer.events).taskExecution!;
      if (result.terminal !== "succeeded" && next.readyNodeIds.length === 0) {
        const blockerNodeIds = next.nodes
          .filter((node) => ["blocked", "cancelled", "failed", "skipped"].includes(node.status))
          .map((node) => node.nodeId);
        for (const node of next.nodes.filter((candidate) => candidate.status === "pending" || candidate.status === "ready")) {
          const roots = blockerNodeIds.filter((root) => {
            const visit = (id: string): boolean => {
              if (id === root) return true;
              const found = next.nodes.find((candidate) => candidate.nodeId === id);
              return found?.node.dependsOn.some(visit) ?? false;
            };
            return node.node.dependsOn.some(visit);
          });
          if (roots.length > 0) {
            const terminalIds = roots.flatMap((root) => {
              const eventId = next.nodes.find((candidate) => candidate.nodeId === root)?.terminalEventId;
              return eventId === null || eventId === undefined ? [] : [eventId];
            });
            await writer.appendTaskGraphEvent("task_node.skipped", {
              ...exactFields(next.graph),
              node_id: node.nodeId,
              root_blocker_node_ids: [...new Set(roots)].sort(),
              terminal_event_ids: [...new Set(terminalIds)].sort(),
            });
            next = reconstructMultiRunSession(writer.events).taskExecution!;
          }
        }
        const status = terminalStatus(result.terminal);
        await writer.appendTaskGraphEvent("task_graph.terminal", {
          ...exactFields(next.graph),
          ...(terminalBlocker(result.terminal) === undefined ? {} : { blocker_code: terminalBlocker(result.terminal) }),
          reason: `node ${admitted.node.nodeId} ended ${result.terminal}`,
          status,
        });
      } else if (result.terminal === "succeeded") {
        next = reconstructMultiRunSession(writer.events).taskExecution!;
        if (next.nodes.every((node) => node.status === "succeeded")) {
          const requiresIntegration = next.nodes.some((node) =>
            node.node.workspace.mode !== "origin_read_only"
          );
          await writer.appendTaskGraphEvent("task_graph.terminal", {
            ...exactFields(next.graph),
            reason: requiresIntegration
              ? "all node attempts succeeded; origin integration remains explicit"
              : "all read-only node attempts succeeded",
            status: requiresIntegration ? "awaiting_integration" : "completed",
          });
        }
      }
      return reconstructMultiRunSession(writer.events).taskExecution!;
    });
  }

  async #waiting(
    admitted: AdmittedTaskAttemptV1,
    result: TaskAttemptExecutionResultV1,
    waiting: NonNullable<TaskAttemptExecutionResultV1["waitingForUser"]>,
  ): Promise<TaskExecutionProjectionV1> {
    return this.#mutate(async (writer, execution) => {
      if (execution.activeAttempt?.attemptId !== admitted.attemptId) {
        throw new TaskGraphError("task_scheduler_busy", "attempt ownership changed before waiting transition");
      }
      await writer.appendTaskGraphEvent("task_node.attempt.waiting_for_user", {
        ...exactFields(execution.graph),
        attempt_id: admitted.attemptId,
        node_id: admitted.node.nodeId,
        reason: waiting.reason,
        requested_action_ref: waiting.requestedActionRef,
      });
      const receipt = await persistTaskNodeReceipt({
        attemptId: admitted.attemptId,
        attemptNumber: admitted.attemptNumber,
        context: this.options.context,
        graph: execution.graph,
        node: admitted.node,
        result,
        terminalOverride: "pre_effect_infrastructure_failure",
        verificationGenerationId: null,
        workspaceSnapshotSha256: null,
      });
      const waitingBudget = Object.freeze({ ...result.budget, artifactBytes: result.budget.artifactBytes + receipt.artifactBytes });
      const terminalEvent = await writer.appendTaskGraphEvent("task_node.attempt.terminal", {
        ...exactFields(execution.graph),
        attempt_id: admitted.attemptId,
        budget: taskBudgetTerminal(waitingBudget, result.usageCompleteness),
        node_id: admitted.node.nodeId,
        receipt_artifact_id: receipt.artifactId,
        receipt_sha256: receipt.receipt.receiptSha256,
        run_id: admitted.runId,
        terminal: "pre_effect_infrastructure_failure",
      });
      if (execution.activeAttempt.workspaceBinding !== null) {
        await writer.appendTaskGraphEvent("task_worktree.lease.released", {
          ...exactFields(execution.graph),
          attempt_id: admitted.attemptId,
          node_id: admitted.node.nodeId,
          terminal_event_id: terminalEvent.eventId,
          workspace_id: execution.activeAttempt.workspaceBinding.workspace_id,
        });
      }
      await writer.appendTaskGraphEvent("task_scheduler.lease.recovered", {
        ...exactFields(execution.graph),
        evidence_sha256: sha256Canonical({
          attempt_id: admitted.attemptId,
          requested_action_ref: waiting.requestedActionRef,
          transition: "known_pre_effect_wait",
        }),
        previous_lease_nonce_sha256: admitted.schedulerLeaseNonceSha256,
        repository_id: this.options.repositoryId,
      });
      await writer.appendTaskGraphEvent("task_graph.waiting_for_user", {
        ...exactFields(execution.graph),
        attempt_id: admitted.attemptId,
        reason: waiting.reason,
        requested_action_ref: waiting.requestedActionRef,
      });
      const next = reconstructMultiRunSession(writer.events).taskExecution;
      if (next === null || next.activeAttempt !== null || next.status !== "waiting_for_user") {
        throw new TaskGraphError("task_graph_invalid", "known pre-effect wait did not release scheduler ownership");
      }
      return next;
    });
  }

  async run(signal: AbortSignal): Promise<TaskSchedulerRunResultV1> {
    await this.#ensureStarted();
    let execution: TaskExecutionProjectionV1;
    let startedAttempts = 0;
    for (let guard = 0; guard < 96; guard += 1) {
      await this.options.beforeTransition?.();
      execution = await this.#snapshot();
      if (signal.aborted) {
        if (execution.activeAttempt === null && execution.status === "cancelled") {
          return Object.freeze({ execution, startedAttempts, stopReason: "cancelled" });
        }
        if (execution.activeAttempt === null) {
          throw new TaskGraphError("task_waiting_for_user", "scheduler was cancelled before a clean attempt terminal");
        }
      }
      const admitted = await this.#admit(execution, signal);
      if (admitted === null) {
        execution = await this.#snapshot();
        const status = execution.status;
        return Object.freeze({
          execution,
          startedAttempts,
          stopReason: status === "completed" ? "completed"
            : status === "cancelled" ? "cancelled"
              : status === "failed" ? "failed"
                : status === "waiting_for_user" ? "waiting_for_user"
                  : "blocked",
        });
      }
      startedAttempts += 1;
      const held = reservationForTaskNode(admitted.node);
      let started: StartedTaskAttemptV1;
      try {
        started = await this.options.executor.start({
          ...admitted,
          graph: execution.graph,
          signal,
        });
      } catch {
        await this.#terminal(admitted, {
          budget: zeroConsumption(held),
          receiptArtifactId: null,
          receiptSha256: null,
          terminal: "pre_effect_infrastructure_failure",
          usageCompleteness: "none",
        });
        continue;
      }
      if (started.attemptStartedPersisted !== true) {
        await this.#mutate(async (writer, current) => {
          await writer.appendTaskGraphEvent("task_node.attempt.started", {
            ...exactFields(current.graph),
            attempt_id: admitted.attemptId,
            node_id: admitted.node.nodeId,
            run_id: admitted.runId,
            scheduler_lease_nonce_sha256: admitted.schedulerLeaseNonceSha256,
          });
        });
      }
      const result = await started.result;
      await this.options.beforeTransition?.();
      if (result.waitingForUser !== undefined) {
        execution = await this.#waiting(admitted, result, result.waitingForUser);
        return Object.freeze({ execution, startedAttempts, stopReason: "waiting_for_user" });
      }
      execution = await this.#terminal(admitted, result);
      if (["blocked", "cancelled", "completed", "failed", "waiting_for_user", "awaiting_integration"].includes(execution.status)) {
        return Object.freeze({
          execution,
          startedAttempts,
          stopReason: execution.status === "completed" ? "completed"
            : execution.status === "cancelled" ? "cancelled"
              : execution.status === "failed" ? "failed"
                : execution.status === "waiting_for_user" ? "waiting_for_user"
                  : "blocked",
        });
      }
    }
    throw new TaskGraphError("task_graph_invalid", "scheduler transition guard was exhausted");
  }

  /** Claims the exact scheduler lease without admitting a node yet. */
  async startOwnership(): Promise<TaskExecutionProjectionV1> {
    return this.#ensureStarted();
  }
}
