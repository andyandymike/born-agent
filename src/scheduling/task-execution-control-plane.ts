import { taskMutationBlocker, taskUserOrigin, type TaskMutationContext, type TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { verifyTaskGraphRevisionArtifact } from "../task-graph/task-graph-control-plane.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import { observeTaskGraphBinding, type TaskGraphRevisionProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskExecutionProjectionV1 } from "./task-execution-projector.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

export interface TaskExecutionMutationResultV1 {
  readonly deduplicated: boolean;
  readonly execution: TaskExecutionProjectionV1;
  readonly graph: TaskGraphRevisionProjectionV1;
}

function exactApproved(
  session: ReturnType<typeof reconstructMultiRunSession>,
  input: { readonly revision: number; readonly sha256: string },
): TaskGraphRevisionProjectionV1 {
  const ref = session.taskGraph.currentApproved;
  const graph = session.taskGraph.revisions.find((candidate) =>
    candidate.graphId === ref?.graphId &&
    candidate.revision === input.revision &&
    candidate.graphSha256 === input.sha256
  );
  if (graph === undefined || ref?.revision !== input.revision || ref.graphSha256 !== input.sha256) {
    throw new TaskGraphError("task_graph_not_approved", "enqueue selector does not exact-match the current approved Graph");
  }
  if (observeTaskGraphBinding(graph, session.taskState) !== "current") {
    throw new TaskGraphError("task_graph_binding_stale", "Graph Goal/Plan binding is no longer current");
  }
  return graph;
}

export class TaskExecutionControlPlane {
  constructor(private readonly writerFactory: TaskMutationWriterFactory = defaultWriterFactory) {}

  async enqueue(input: {
    readonly context: TaskMutationContext;
    readonly requestedExecution: "background" | "foreground";
    readonly revision: number;
    readonly runtimeProfileId: string;
    readonly sha256: string;
  }): Promise<TaskExecutionMutationResultV1> {
    const writer = await this.writerFactory(input.context);
    try {
      let session = reconstructMultiRunSession(writer.events);
      const graph = exactApproved(session, input);
      const blocker = taskMutationBlocker(session);
      if (blocker !== null) {
        throw new TaskGraphError("task_effect_reconciliation_required", blocker.details.join(", "));
      }
      await verifyTaskGraphRevisionArtifact(input.context.workspace, input.context.sessionId, graph);
      if (session.taskExecution !== null) {
        const existing = session.taskExecution;
        if (
          existing.graph.graphSha256 === graph.graphSha256 &&
          existing.status !== "waiting_for_user" &&
          existing.enqueue.requestedExecution === input.requestedExecution &&
          existing.enqueue.runtimeProfileId === input.runtimeProfileId
        ) {
          return Object.freeze({ deduplicated: true, execution: existing, graph });
        }
        if (existing.graph.graphSha256 !== graph.graphSha256 || existing.status !== "waiting_for_user") {
          throw new TaskGraphError("task_scheduler_busy", "another Graph execution is already present");
        }
      }
      await writer.appendTaskGraphEvent("task_graph.enqueued", {
        binding: {
          goal_id: graph.binding.goalId,
          goal_revision: graph.binding.goalRevision,
          plan_id: graph.binding.planId,
          plan_revision: graph.binding.planRevision,
          plan_sha256: graph.binding.planSha256,
          session_id: graph.binding.sessionId,
        },
        enqueue_id: input.context.randomUuid(),
        graph_id: graph.graphId,
        graph_revision: graph.revision,
        graph_sha256: graph.graphSha256,
        requested_execution: input.requestedExecution,
        runtime_profile_id: input.runtimeProfileId,
        ...(input.context.authenticatedApplication === undefined ? {} : { origin: taskUserOrigin(input.context) }),
      });
      session = reconstructMultiRunSession(writer.events);
      if (session.taskExecution === null) throw new TaskGraphError("task_graph_invalid", "enqueue did not create an execution projection");
      return Object.freeze({ deduplicated: false, execution: session.taskExecution, graph });
    } finally {
      await writer.close();
    }
  }

  async cancel(input: {
    readonly context: TaskMutationContext;
    readonly reason: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<TaskExecutionMutationResultV1> {
    const writer = await this.writerFactory(input.context);
    try {
      let session = reconstructMultiRunSession(writer.events);
      const execution = session.taskExecution;
      if (
        execution === null ||
        execution.graph.revision !== input.revision ||
        execution.graph.graphSha256 !== input.sha256 ||
        !["queued", "running", "waiting_for_user", "awaiting_integration"].includes(execution.status)
      ) {
        throw new TaskGraphError("task_graph_revision_conflict", "cancel selector does not exact-match an active Graph");
      }
      await writer.appendTaskGraphEvent("task_graph.cancel.requested", {
        active_attempt_id: execution.activeAttempt?.attemptId ?? null,
        graph_id: execution.graph.graphId,
        graph_revision: execution.graph.revision,
        graph_sha256: execution.graph.graphSha256,
        reason: input.reason,
        request_id: input.context.randomUuid(),
        ...(input.context.authenticatedApplication === undefined ? {} : { origin: taskUserOrigin(input.context) }),
      });
      if (execution.activeAttempt === null) {
        await writer.appendTaskGraphEvent("task_graph.terminal", {
          graph_id: execution.graph.graphId,
          graph_revision: execution.graph.revision,
          graph_sha256: execution.graph.graphSha256,
          reason: "cancelled before another attempt was admitted",
          status: "cancelled",
        });
      }
      session = reconstructMultiRunSession(writer.events);
      const next = session.taskExecution;
      if (next === null) throw new TaskGraphError("task_graph_invalid", "cancel lost its execution projection");
      return Object.freeze({ deduplicated: false, execution: next, graph: next.graph });
    } finally {
      await writer.close();
    }
  }

  async retry(input: {
    readonly attemptNumber: number;
    readonly attemptTerminal: "cancelled_clean" | "known_failed" | "pre_effect_infrastructure_failure";
    readonly context: TaskMutationContext;
    readonly graphRevision: number;
    readonly graphSha256: string;
    readonly nodeId: string;
    readonly terminalEventId: string;
  }): Promise<TaskExecutionMutationResultV1> {
    const writer = await this.writerFactory(input.context);
    try {
      let session = reconstructMultiRunSession(writer.events);
      const execution = session.taskExecution;
      if (
        execution === null || !["failed", "cancelled"].includes(execution.status) || execution.activeAttempt !== null ||
        execution.graph.revision !== input.graphRevision || execution.graph.graphSha256 !== input.graphSha256
      ) {
        throw new TaskGraphError("task_graph_revision_conflict", "manual retry requires one exact failed or cancelled Graph with no active attempt");
      }
      const node = execution.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      const attempt = node?.attempts.at(input.attemptNumber - 1);
      const expectedNodeStatus = input.attemptTerminal === "cancelled_clean" ? "cancelled" : "failed";
      if (
        node === undefined || attempt === undefined || attempt.attemptNumber !== input.attemptNumber ||
        attempt.terminalEventId !== input.terminalEventId || attempt.status !== "terminal" ||
        attempt.terminal !== input.attemptTerminal || node.status !== expectedNodeStatus ||
        node.attempts.length >= node.node.budget.maxAttempts
      ) {
        throw new TaskGraphError("task_graph_revision_conflict", "manual retry selector is stale, is not a known failed/cancelled attempt, or exceeds the approved ceiling");
      }
      await writer.appendTaskGraphEvent("task_node.retry.requested", {
        attempt_number: input.attemptNumber,
        graph_id: execution.graph.graphId,
        graph_revision: execution.graph.revision,
        graph_sha256: execution.graph.graphSha256,
        node_id: input.nodeId,
        requested_by: "user",
        terminal_event_id: input.terminalEventId,
        ...(input.context.authenticatedApplication === undefined
          ? {}
          : { origin: taskUserOrigin(input.context), previous_terminal: input.attemptTerminal }),
      });
      session = reconstructMultiRunSession(writer.events);
      if (session.taskExecution === null || session.taskExecution.status !== "waiting_for_user") {
        throw new TaskGraphError("task_graph_invalid", "manual retry did not create a bounded resume boundary");
      }
      return Object.freeze({ deduplicated: false, execution: session.taskExecution, graph: session.taskExecution.graph });
    } finally {
      await writer.close();
    }
  }
}
