import { ArtifactStore } from "../artifacts/artifact-store.js";
import { phase16RunBindingSchema, PHASE16_RUN_BINDING_KEYS } from "../events/phase16-run-event-extension.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { parseStrictJson } from "../system/strict-json.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import { taskNodeReceiptSchema } from "../task-graph/task-node-receipt.js";
import { assertGoalChangeWorkspaceMatches, projectGoalChangeLedger } from "./goal-change-ledger.js";
import type { TaskMutationContext } from "./task-control-plane.js";
import { TaskStateMachine } from "./task-state-machine.js";
import {
  originVerificationReceiptMatchesCompletedEvent,
  originVerificationReceiptSchema,
} from "../worktrees/origin-verification-receipt.js";

export interface TaskOrchestrationCompositionResultV1 {
  readonly appendedEventTypes: readonly string[];
  readonly status: "completed" | "none";
}

function runBinding(data: Readonly<Record<string, unknown>>) {
  return phase16RunBindingSchema.safeParse(Object.fromEntries(
    PHASE16_RUN_BINDING_KEYS.flatMap((key) => Object.hasOwn(data, key) ? [[key, data[key]]] : []),
  ));
}

/**
 * Composes the Phase 19 facts into existing Plan/Goal completion only after
 * every byte-changing workspace has an exact applied promotion and a
 * successful verification receipt for that same accepted workspace snapshot.
 */
export class TaskOrchestrationCompletionComposer {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly writer: V2SessionWriter;
  }) {}

  async compose(): Promise<TaskOrchestrationCompositionResultV1> {
    let session = reconstructMultiRunSession(this.options.writer.events);
    const execution = session.taskExecution;
    if (execution === null || execution.status !== "awaiting_integration") {
      return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });
    }
    if (
      execution.nodes.some((node) => node.status !== "succeeded") ||
      execution.activeAttempt !== null || session.background.current !== null ||
      session.worktrees.pendingOperationIds.length > 0
    ) {
      return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });
    }
    const graph = execution.graph;
    const goal = session.taskState.goals.find((candidate) =>
      candidate.content.goalId === graph.binding.goalId && candidate.content.revision === graph.binding.goalRevision
    );
    const plan = session.taskState.plans.find((candidate) =>
      candidate.content.planId === graph.binding.planId && candidate.content.revision === graph.binding.planRevision &&
      candidate.planSha256 === graph.binding.planSha256
    );
    if (goal?.status !== "active" || plan?.status !== "active" ||
        session.taskState.currentApprovedPlan?.planId !== graph.binding.planId) {
      throw new TaskGraphError("task_graph_binding_stale", "Graph integration no longer exact-matches the active Goal and approved Plan");
    }

    const accepted = [...session.runs].reverse().flatMap((run) => {
      const binding = runBinding(run.started.data);
      const nodeBinding = run.started.data.task_node_binding;
      if (
        !binding.success || binding.data.agent_mode !== "build" ||
        binding.data.goal_id !== graph.binding.goalId || binding.data.goal_revision !== graph.binding.goalRevision ||
        binding.data.plan_id !== graph.binding.planId || binding.data.plan_revision !== graph.binding.planRevision ||
        binding.data.plan_sha256 !== graph.binding.planSha256 || nodeBinding === undefined ||
        nodeBinding.graph_id !== graph.graphId || nodeBinding.graph_revision !== graph.revision || nodeBinding.graph_sha256 !== graph.graphSha256 ||
        !execution.nodes.some((node) => node.nodeId === nodeBinding.node_id && node.status === "succeeded")
      ) return [];
      const evaluation = [...run.events].reverse().find((event) => event.type === "completion.evaluated" && event.data.effect === "accept");
      return evaluation?.type === "completion.evaluated" ? [{ evaluation, run }] : [];
    })[0];
    // A model-free or partial lifecycle may still legitimately promote bytes;
    // it simply cannot compose Goal/Plan completion without an accepted node
    // completion identity.
    if (accepted === undefined) return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });

    const changedWorkspaces = session.worktrees.workspaces.filter((workspace) => (workspace.lastSnapshot?.changedFiles ?? 0) > 0);
    for (const workspace of changedWorkspaces) {
      const promotion = session.worktrees.promotions.find((candidate) =>
        candidate.status === "applied" && candidate.bundle.workspaceId === workspace.identity.workspaceId &&
        candidate.bundle.workspaceSnapshotSha256 === workspace.lastSnapshot?.sha256
      );
      if (promotion === undefined || promotion.goalChangeEventId === null) {
        return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });
      }
      const verification = execution.nodes.find((node) =>
        node.node.kind === "verification" && node.status === "succeeded" &&
        [...node.attempts].reverse().some((attempt) =>
          attempt.terminal === "succeeded" && attempt.workspaceBinding?.workspace_id === workspace.identity.workspaceId
        )
      );
      const attempt = [...(verification?.attempts ?? [])].reverse().find((candidate) =>
        candidate.terminal === "succeeded" && candidate.workspaceBinding?.workspace_id === workspace.identity.workspaceId
      );
      const terminal = attempt?.terminalEventId === null || attempt?.terminalEventId === undefined
        ? undefined
        : session.events.find((event) => event.eventId === attempt.terminalEventId);
      if (
        verification === undefined || attempt === undefined || terminal?.scope !== "session" || terminal.type !== "task_node.attempt.terminal" ||
        terminal.data.receipt_artifact_id === null || terminal.data.receipt_sha256 === null
      ) return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });
      const artifact = await (await ArtifactStore.create({ sessionId: session.sessionId, workspace: this.options.context.workspace }))
        .readVerified(terminal.data.receipt_artifact_id);
      const receipt = taskNodeReceiptSchema.parse(parseStrictJson(artifact.bytes.toString("utf8")));
      if (
        receipt.receiptSha256 !== terminal.data.receipt_sha256 || receipt.status !== "succeeded" ||
        receipt.workspaceSnapshotSha256 !== workspace.lastSnapshot?.sha256
      ) {
        throw new TaskGraphError("task_graph_artifact_invalid", "verification receipt is not bound to the promoted workspace snapshot");
      }
      const actionEvidence = receipt.structuredEvidence.find((evidence) => evidence.kind === "verification_action");
      const commandEvidence = receipt.structuredEvidence.find((evidence) => evidence.kind === "verification_command");
      const originVerification = [...session.worktrees.originVerifications].reverse().find((candidate) =>
        candidate.promotionOperationId === promotion.operationId &&
        candidate.bundleSha256 === promotion.bundle.bundleSha256 && candidate.workspaceId === workspace.identity.workspaceId &&
        candidate.verificationNodeId === verification.node.nodeId
      );
      if (actionEvidence === undefined || commandEvidence === undefined || originVerification === undefined ||
          originVerification.status !== "passed" || originVerification.completedEventId === null ||
          originVerification.receiptArtifactId === null || originVerification.receiptSha256 === null ||
          promotion.originSourceSnapshotSha256 === null) {
        return Object.freeze({ appendedEventTypes: Object.freeze([]), status: "none" });
      }
      const originCompleted = session.events.find((event) => event.eventId === originVerification.completedEventId);
      if (originCompleted?.scope !== "session" || originCompleted.type !== "task_origin_verification.completed") {
        throw new TaskGraphError("task_graph_artifact_invalid", "origin verification completion event is unavailable");
      }
      const originArtifact = await (await ArtifactStore.create({ sessionId: session.sessionId, workspace: this.options.context.workspace }))
        .readVerified(originVerification.receiptArtifactId);
      const originReceipt = originVerificationReceiptSchema.parse(parseStrictJson(originArtifact.bytes.toString("utf8")));
      if (
        !originVerificationReceiptMatchesCompletedEvent(originReceipt, originCompleted.data) ||
        originReceipt.receiptSha256 !== originVerification.receiptSha256 || originReceipt.status !== "passed" ||
        originReceipt.actionSha256 !== originVerification.actionSha256 ||
        originReceipt.commandSha256 !== originVerification.commandSha256 ||
        originReceipt.actionSha256 !== actionEvidence.sha256 || originReceipt.commandSha256 !== commandEvidence.sha256 ||
        originReceipt.graphId !== graph.graphId || originReceipt.graphRevision !== graph.revision || originReceipt.graphSha256 !== graph.graphSha256 ||
        originReceipt.promotionOperationId !== promotion.operationId || originReceipt.bundleSha256 !== promotion.bundle.bundleSha256 ||
        originReceipt.workspaceId !== workspace.identity.workspaceId || originReceipt.verificationNodeId !== verification.node.nodeId ||
        originReceipt.originSourceSnapshotSha256 !== promotion.originSourceSnapshotSha256 ||
        originReceipt.beforeSourceStateSha256 !== promotion.originSourceSnapshotSha256 ||
        originReceipt.afterSourceStateSha256 !== promotion.originSourceSnapshotSha256 ||
        !originReceipt.cleanupVerified || originReceipt.exitCode !== 0 || originReceipt.termination !== "exit"
      ) {
        throw new TaskGraphError("task_graph_artifact_invalid", "origin verification receipt is not bound to the current promoted target");
      }
    }
    if (changedWorkspaces.length > 0) {
      const ledger = projectGoalChangeLedger(this.options.writer.events, graph.binding.goalId, graph.binding.goalRevision);
      if (ledger === null) throw new TaskGraphError("task_effect_reconciliation_required", "promoted Graph has no Goal change ledger");
      await assertGoalChangeWorkspaceMatches(ledger, this.options.context.workspace);
    }

    const appended: string[] = [];
    for (const item of plan.items) {
      const evidence = execution.nodes
        .filter((node) => node.node.planItemIds.includes(item.content.id))
        .flatMap((node) => {
          const eventId = [...node.attempts].reverse().find((attempt) => attempt.terminal === "succeeded")?.terminalEventId;
          return eventId === null || eventId === undefined ? [] : [eventId];
        });
      if (item.content.required && evidence.length === 0) {
        throw new TaskGraphError("task_graph_plan_item_unknown", `required Plan item ${item.content.id} has no successful Graph node evidence`);
      }
      if (evidence.length > 16) throw new TaskGraphError("task_graph_bounds_exceeded", "Plan item Graph evidence exceeds 16 events");
      if (item.status === "completed" || (item.status === "skipped" && !item.content.required)) continue;
      if (evidence.length === 0) continue;
      const origin = {
        graph_id: graph.graphId,
        graph_revision: graph.revision,
        graph_sha256: graph.graphSha256,
        kind: "task_graph" as const,
      };
      if (item.status !== "in_progress") {
        await this.options.writer.appendTaskEvent("plan.item.status_changed", {
          evidence_event_ids: [],
          from: item.status,
          goal_id: graph.binding.goalId,
          goal_revision: graph.binding.goalRevision,
          item_id: item.content.id,
          note: "Task Graph integration admitted exact successful node evidence.",
          origin,
          plan_id: graph.binding.planId,
          plan_sha256: graph.binding.planSha256,
          revision: graph.binding.planRevision,
          to: "in_progress",
        });
        appended.push("plan.item.status_changed");
      }
      await this.options.writer.appendTaskEvent("plan.item.status_changed", {
        evidence_event_ids: evidence,
        from: "in_progress",
        goal_id: graph.binding.goalId,
        goal_revision: graph.binding.goalRevision,
        item_id: item.content.id,
        note: "Completed by exact Task Graph node receipts and promotion evidence.",
        origin,
        plan_id: graph.binding.planId,
        plan_sha256: graph.binding.planSha256,
        revision: graph.binding.planRevision,
        to: "completed",
      });
      appended.push("plan.item.status_changed");
    }
    await this.options.writer.appendTaskGraphEvent("task_graph.terminal", {
      graph_id: graph.graphId,
      graph_revision: graph.revision,
      graph_sha256: graph.graphSha256,
      reason: "all nodes succeeded; exact workspace snapshots were promoted and the latest origin verification matches each promoted target",
      status: "completed",
    });
    appended.push("task_graph.terminal");

    const task = TaskStateMachine.project(this.options.writer.events);
    if (!task.readyForCompletion) throw new TaskGraphError("task_graph_invalid", "Graph completion did not make the approved Plan ready");
    await this.options.writer.appendTaskEvent("plan.completed", {
      completion_evaluated_event_id: accepted.evaluation.eventId,
      finish_task_call_id: accepted.evaluation.data.call_id,
      goal_id: graph.binding.goalId,
      goal_revision: graph.binding.goalRevision,
      origin: { kind: "host_completion" },
      plan_id: graph.binding.planId,
      plan_sha256: graph.binding.planSha256,
      revision: graph.binding.planRevision,
    });
    appended.push("plan.completed");
    await this.options.writer.appendTaskEvent("goal.status.changed", {
      completion_evaluated_event_id: accepted.evaluation.eventId,
      finish_task_call_id: accepted.evaluation.data.call_id,
      from: "active",
      goal_id: graph.binding.goalId,
      origin: { kind: "host_completion" },
      revision: graph.binding.goalRevision,
      to: "completed",
    });
    appended.push("goal.status.changed");
    session = reconstructMultiRunSession(this.options.writer.events);
    if (session.taskExecution?.status !== "completed" ||
        session.taskState.goals.find((candidate) => candidate.content.goalId === graph.binding.goalId)?.status !== "completed") {
      throw new TaskGraphError("task_graph_invalid", "Task orchestration completion did not reach one exact terminal composition");
    }
    return Object.freeze({ appendedEventTypes: Object.freeze(appended), status: "completed" });
  }
}
