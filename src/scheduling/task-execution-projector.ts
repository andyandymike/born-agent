import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { Phase19TaskGraphSessionEventData } from "../task-graph/task-graph-event-schema.js";
import {
  TaskGraphProjector,
  type TaskGraphRevisionProjectionV1,
  type TaskGraphStatus,
} from "../task-graph/task-graph-projector.js";
import type { TaskGraphBudgetV1, TaskNodeSpecV1 } from "../task-graph/task-graph-schema.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";

export const TASK_BUDGET_COUNTERS = Object.freeze([
  "attempts",
  "durationMs",
  "modelSteps",
  "commandExecutions",
  "commandOutputBytes",
  "changedFiles",
  "changedBytes",
  "artifactBytes",
  "reportedTokens",
] as const);

export interface TaskBudgetCountersV1 {
  readonly attempts: number;
  readonly durationMs: number;
  readonly modelSteps: number;
  readonly commandExecutions: number;
  readonly commandOutputBytes: number;
  readonly changedFiles: number;
  readonly changedBytes: number;
  readonly artifactBytes: number;
  readonly reportedTokens: number | null;
}

export interface TaskBudgetProjectionV1 {
  readonly consumed: TaskBudgetCountersV1;
  readonly limits: TaskBudgetCountersV1;
  readonly remaining: TaskBudgetCountersV1;
  readonly reserved: TaskBudgetCountersV1;
  readonly usageCompleteness: "complete" | "none" | "partial";
}

export type TaskNodeExecutionStatus =
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped";

export interface TaskAttemptProjectionV1 {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly nodeId: string;
  readonly requestEventId: string;
  readonly reservation: TaskBudgetCountersV1;
  readonly retryOrigin: "automatic" | "initial" | "user";
  readonly runId: string | null;
  readonly startEventId: string | null;
  readonly status: "requested" | "running" | "waiting_for_user" | "terminal";
  readonly terminal: Phase19TaskGraphSessionEventData<"task_node.attempt.terminal">["terminal"] | null;
  readonly terminalEventId: string | null;
  readonly workspaceBinding: NonNullable<Phase19TaskGraphSessionEventData<"task_node.attempt.requested">["workspace_binding"]> | null;
}

export interface TaskNodeExecutionProjectionV1 {
  readonly attempts: readonly TaskAttemptProjectionV1[];
  readonly nextAttemptOrigin: "automatic" | "initial" | "user" | null;
  readonly node: TaskNodeSpecV1;
  readonly nodeId: string;
  readonly status: TaskNodeExecutionStatus;
  readonly terminalEventId: string | null;
}

export interface TaskExecutionBlockerV1 {
  readonly code: string;
  readonly eventId: string;
  readonly nodeId: string | null;
}

export interface TaskExecutionProjectionV1 {
  readonly activeAttempt: TaskAttemptProjectionV1 | null;
  readonly blocker: TaskExecutionBlockerV1 | null;
  readonly budget: TaskBudgetProjectionV1;
  readonly enqueue: {
    readonly enqueueId: string;
    readonly eventId: string;
    readonly requestedExecution: "background" | "foreground";
    readonly runtimeProfileId: string;
  };
  readonly graph: TaskGraphRevisionProjectionV1;
  readonly lastSessionSeq: number;
  readonly nodes: readonly TaskNodeExecutionProjectionV1[];
  readonly readyNodeIds: readonly string[];
  readonly schedulerLeaseNonceSha256: string | null;
  readonly status: TaskGraphStatus;
}

interface MutableAttempt {
  attemptId: string;
  attemptNumber: number;
  nodeId: string;
  requestEventId: string;
  reservation: TaskBudgetCountersV1;
  retryOrigin: "automatic" | "initial" | "user";
  runId: string | null;
  startEventId: string | null;
  status: TaskAttemptProjectionV1["status"];
  terminal: TaskAttemptProjectionV1["terminal"];
  terminalEventId: string | null;
  workspaceBinding: TaskAttemptProjectionV1["workspaceBinding"];
}

interface MutableNode {
  attempts: MutableAttempt[];
  nextAttemptOrigin: "automatic" | "initial" | "user" | null;
  node: TaskNodeSpecV1;
  status: TaskNodeExecutionStatus;
  terminalEventId: string | null;
}

function zero(tokens: number | null = 0): TaskBudgetCountersV1 {
  return {
    artifactBytes: 0,
    attempts: 0,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: 0,
    commandOutputBytes: 0,
    durationMs: 0,
    modelSteps: 0,
    reportedTokens: tokens,
  };
}

function limits(budget: TaskGraphBudgetV1): TaskBudgetCountersV1 {
  return Object.freeze({
    artifactBytes: budget.maxArtifactBytes,
    attempts: budget.maxAttempts,
    changedBytes: budget.maxChangedBytes,
    changedFiles: budget.maxChangedFiles,
    commandExecutions: budget.maxCommandExecutions,
    commandOutputBytes: budget.maxCommandOutputBytes,
    durationMs: budget.maxDurationMs,
    modelSteps: budget.maxModelSteps,
    reportedTokens: budget.maxReportedTokens,
  });
}

function reservation(
  value: Phase19TaskGraphSessionEventData<"task_node.attempt.requested">["reservation"],
): TaskBudgetCountersV1 {
  return Object.freeze({
    artifactBytes: value.artifact_bytes,
    attempts: value.attempts,
    changedBytes: value.changed_bytes,
    changedFiles: value.changed_files,
    commandExecutions: value.command_executions,
    commandOutputBytes: value.command_output_bytes,
    durationMs: value.duration_ms,
    modelSteps: value.model_steps,
    reportedTokens: value.reported_tokens,
  });
}

function consumption(
  value: Phase19TaskGraphSessionEventData<"task_node.attempt.terminal">["budget"],
): TaskBudgetCountersV1 {
  return Object.freeze({
    artifactBytes: value.artifact_bytes,
    attempts: value.attempts,
    changedBytes: value.changed_bytes,
    changedFiles: value.changed_files,
    commandExecutions: value.command_executions,
    commandOutputBytes: value.command_output_bytes,
    durationMs: value.duration_ms,
    modelSteps: value.model_steps,
    reportedTokens: value.reported_tokens,
  });
}

function add(target: TaskBudgetCountersV1, value: TaskBudgetCountersV1): TaskBudgetCountersV1 {
  const tokens = target.reportedTokens === null || value.reportedTokens === null
    ? null
    : target.reportedTokens + value.reportedTokens;
  return {
    artifactBytes: target.artifactBytes + value.artifactBytes,
    attempts: target.attempts + value.attempts,
    changedBytes: target.changedBytes + value.changedBytes,
    changedFiles: target.changedFiles + value.changedFiles,
    commandExecutions: target.commandExecutions + value.commandExecutions,
    commandOutputBytes: target.commandOutputBytes + value.commandOutputBytes,
    durationMs: target.durationMs + value.durationMs,
    modelSteps: target.modelSteps + value.modelSteps,
    reportedTokens: tokens,
  };
}

function subtract(limit: TaskBudgetCountersV1, consumed: TaskBudgetCountersV1, reserved: TaskBudgetCountersV1): TaskBudgetCountersV1 {
  const result = {
    artifactBytes: limit.artifactBytes - consumed.artifactBytes - reserved.artifactBytes,
    attempts: limit.attempts - consumed.attempts - reserved.attempts,
    changedBytes: limit.changedBytes - consumed.changedBytes - reserved.changedBytes,
    changedFiles: limit.changedFiles - consumed.changedFiles - reserved.changedFiles,
    commandExecutions: limit.commandExecutions - consumed.commandExecutions - reserved.commandExecutions,
    commandOutputBytes: limit.commandOutputBytes - consumed.commandOutputBytes - reserved.commandOutputBytes,
    durationMs: limit.durationMs - consumed.durationMs - reserved.durationMs,
    modelSteps: limit.modelSteps - consumed.modelSteps - reserved.modelSteps,
    reportedTokens: limit.reportedTokens === null || consumed.reportedTokens === null || reserved.reportedTokens === null
      ? null
      : limit.reportedTokens - consumed.reportedTokens - reserved.reportedTokens,
  };
  if (Object.entries(result).some(([, value]) => value !== null && value < 0)) {
    throw new TaskGraphError("task_graph_invalid", "Task budget ledger exceeded an approved ceiling");
  }
  return Object.freeze(result);
}

function within(consumed: TaskBudgetCountersV1, reserved: TaskBudgetCountersV1, limit: TaskBudgetCountersV1): boolean {
  return TASK_BUDGET_COUNTERS.every((counter) => {
    const maximum = limit[counter];
    const used = consumed[counter];
    const held = reserved[counter];
    return maximum === null || (used !== null && held !== null && used + held <= maximum);
  });
}

function exactGraphEvent(event: DecodedStoredEvent, graph: TaskGraphRevisionProjectionV1): boolean {
  if (event.scope !== "session" || event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) return false;
  const data = event.data as Readonly<Record<string, unknown>>;
  return data.graph_id === graph.graphId && data.graph_revision === graph.revision && data.graph_sha256 === graph.graphSha256;
}

function terminalNodeStatus(terminal: NonNullable<TaskAttemptProjectionV1["terminal"]>): TaskNodeExecutionStatus {
  switch (terminal) {
    case "succeeded": return "succeeded";
    case "known_failed":
    case "pre_effect_infrastructure_failure": return "failed";
    case "cancelled_clean": return "cancelled";
    case "blocked_reconciliation":
    case "blocked_unknown_effect": return "blocked";
  }
}

function mergeCompleteness(
  current: TaskBudgetProjectionV1["usageCompleteness"],
  next: TaskBudgetProjectionV1["usageCompleteness"],
): TaskBudgetProjectionV1["usageCompleteness"] {
  if (current === "none" || next === "none") return "none";
  if (current === "partial" || next === "partial") return "partial";
  return "complete";
}

function immutableAttempt(attempt: MutableAttempt): TaskAttemptProjectionV1 {
  return Object.freeze({ ...attempt, reservation: Object.freeze({ ...attempt.reservation }) });
}

function executionGraph(events: readonly DecodedStoredEvent[]): TaskGraphRevisionProjectionV1 | null {
  const graphProjection = TaskGraphProjector.project(events);
  const enqueue = [...events].reverse().find((event) => event.scope === "session" && event.type === "task_graph.enqueued");
  if (enqueue === undefined) return null;
  const data = enqueue.data as Phase19TaskGraphSessionEventData<"task_graph.enqueued">;
  return graphProjection.revisions.find((candidate) =>
    candidate.graphId === data.graph_id &&
    candidate.revision === data.graph_revision &&
    candidate.graphSha256 === data.graph_sha256
  ) ?? null;
}

export class TaskExecutionProjector {
  static project(events: readonly DecodedStoredEvent[]): TaskExecutionProjectionV1 | null {
    const graph = executionGraph(events);
    if (graph === null) return null;
    const nodes = new Map<string, MutableNode>(graph.content.nodes.map((node) => [node.nodeId, {
      attempts: [],
      nextAttemptOrigin: "initial",
      node,
      status: "pending",
      terminalEventId: null,
    }]));
    const attempts = new Map<string, MutableAttempt>();
    let active: MutableAttempt | null = null;
    let blocker: TaskExecutionBlockerV1 | null = null;
    let enqueue: TaskExecutionProjectionV1["enqueue"] | null = null;
    let schedulerLeaseNonceSha256: string | null = null;
    let consumed = zero(graph.content.graphBudget.maxReportedTokens === null ? null : 0);
    let reserved = zero(graph.content.graphBudget.maxReportedTokens === null ? null : 0);
    let completeness: TaskBudgetProjectionV1["usageCompleteness"] = "complete";
    let cancelRequested = false;

    const isReady = (node: MutableNode): boolean =>
      node.status === "pending" &&
      node.node.dependsOn.every((dependency) => nodes.get(dependency)?.status === "succeeded");

    for (const event of events) {
      if (!exactGraphEvent(event, graph)) continue;
      switch (event.type) {
        case "task_graph.enqueued": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_graph.enqueued">;
          enqueue = Object.freeze({
            enqueueId: data.enqueue_id,
            eventId: event.eventId,
            requestedExecution: data.requested_execution,
            runtimeProfileId: data.runtime_profile_id,
          });
          blocker = null;
          break;
        }
        case "task_scheduler.lease.acquired": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_scheduler.lease.acquired">;
          if (schedulerLeaseNonceSha256 !== null) throw new TaskGraphError("task_graph_invalid", "Graph has multiple active scheduler leases");
          schedulerLeaseNonceSha256 = data.lease_nonce_sha256;
          break;
        }
        case "task_scheduler.lease.recovered": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_scheduler.lease.recovered">;
          if (schedulerLeaseNonceSha256 !== data.previous_lease_nonce_sha256) {
            throw new TaskGraphError("task_graph_invalid", "scheduler lease recovery does not match its predecessor");
          }
          schedulerLeaseNonceSha256 = null;
          break;
        }
        case "task_graph.started": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_graph.started">;
          if (schedulerLeaseNonceSha256 !== data.scheduler_lease_nonce_sha256) {
            throw new TaskGraphError("task_graph_invalid", "Graph start is not bound to the active scheduler lease");
          }
          break;
        }
        case "task_graph.cancel.requested":
          cancelRequested = true;
          break;
        case "task_node.attempt.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.attempt.requested">;
          const node = nodes.get(data.node_id);
          if (
            node === undefined || active !== null || cancelRequested || !isReady(node) ||
            data.attempt_number !== node.attempts.length + 1 || attempts.has(data.attempt_id)
          ) {
            throw new TaskGraphError("task_graph_invalid", "node attempt violated deterministic admission ordering");
          }
          const held = reservation(data.reservation);
          if (!within(consumed, add(reserved, held), limits(graph.content.graphBudget))) {
            throw new TaskGraphError("task_graph_invalid", "node attempt was admitted without sufficient Graph budget");
          }
          const attempt: MutableAttempt = {
            attemptId: data.attempt_id,
            attemptNumber: data.attempt_number,
            nodeId: data.node_id,
            requestEventId: event.eventId,
            reservation: held,
            retryOrigin: data.retry_origin,
            runId: null,
            startEventId: null,
            status: "requested",
            terminal: null,
            terminalEventId: null,
            workspaceBinding: data.workspace_binding ?? null,
          };
          if ((node.node.workspace.mode === "origin_read_only") !== (attempt.workspaceBinding === null)) {
            throw new TaskGraphError("task_graph_invalid", "node attempt workspace binding contradicts the approved Graph mode");
          }
          node.attempts.push(attempt);
          node.status = "leased";
          attempts.set(attempt.attemptId, attempt);
          active = attempt;
          reserved = add(reserved, held);
          break;
        }
        case "task_node.attempt.started": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.attempt.started">;
          if (
            active === null || active.attemptId !== data.attempt_id || active.nodeId !== data.node_id ||
            active.status !== "requested" || schedulerLeaseNonceSha256 !== data.scheduler_lease_nonce_sha256
          ) {
            throw new TaskGraphError("task_graph_invalid", "node attempt start is not bound to the active request and lease");
          }
          active.status = "running";
          active.runId = data.run_id;
          active.startEventId = event.eventId;
          nodes.get(active.nodeId)!.status = "running";
          break;
        }
        case "task_node.attempt.waiting_for_user": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.attempt.waiting_for_user">;
          if (active === null || active.attemptId !== data.attempt_id || active.nodeId !== data.node_id) {
            throw new TaskGraphError("task_graph_invalid", "waiting event targets no active attempt");
          }
          active.status = "waiting_for_user";
          nodes.get(active.nodeId)!.status = "waiting_for_user";
          break;
        }
        case "task_node.attempt.terminal": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.attempt.terminal">;
          if (active === null || active.attemptId !== data.attempt_id || active.nodeId !== data.node_id) {
            throw new TaskGraphError("task_graph_invalid", "attempt terminal targets no active attempt");
          }
          const used = consumption(data.budget);
          if (!within(used, zero(used.reportedTokens === null ? null : 0), active.reservation)) {
            const attemptReservation = active.reservation;
            const exceeded = TASK_BUDGET_COUNTERS.filter((counter) => {
              const maximum = attemptReservation[counter];
              const actual = used[counter];
              return maximum !== null && (actual === null || actual > maximum);
            }).map((counter) => `${counter}=${String(used[counter])}/${String(attemptReservation[counter])}`);
            throw new TaskGraphError(
              "task_graph_invalid",
              `attempt consumption exceeds its reservation: ${exceeded.join(", ")}`,
            );
          }
          reserved = {
            artifactBytes: reserved.artifactBytes - active.reservation.artifactBytes,
            attempts: reserved.attempts - active.reservation.attempts,
            changedBytes: reserved.changedBytes - active.reservation.changedBytes,
            changedFiles: reserved.changedFiles - active.reservation.changedFiles,
            commandExecutions: reserved.commandExecutions - active.reservation.commandExecutions,
            commandOutputBytes: reserved.commandOutputBytes - active.reservation.commandOutputBytes,
            durationMs: reserved.durationMs - active.reservation.durationMs,
            modelSteps: reserved.modelSteps - active.reservation.modelSteps,
            reportedTokens: reserved.reportedTokens === null || active.reservation.reportedTokens === null
              ? null
              : reserved.reportedTokens - active.reservation.reportedTokens,
          };
          consumed = add(consumed, used);
          completeness = mergeCompleteness(completeness, data.budget.usage_completeness);
          const wasWaitingForUser = active.status === "waiting_for_user";
          active.status = "terminal";
          active.terminal = data.terminal;
          active.terminalEventId = event.eventId;
          const node = nodes.get(active.nodeId)!;
          const automaticRetry = data.terminal === "pre_effect_infrastructure_failure" && (
            (wasWaitingForUser && node.attempts.length < 3) ||
            (node.attempts.length < node.node.retry.maxAttempts &&
              node.node.retry.automaticOn.includes("pre_effect_infrastructure_failure"))
          );
          node.status = automaticRetry ? "pending" : terminalNodeStatus(data.terminal);
          node.nextAttemptOrigin = automaticRetry ? (wasWaitingForUser ? "user" : "automatic") : null;
          node.terminalEventId = automaticRetry ? null : event.eventId;
          active = null;
          break;
        }
        case "task_node.retry.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.retry.requested">;
          const node = nodes.get(data.node_id);
          const previous = node?.attempts.at(data.attempt_number - 1);
          const previousTerminal = "previous_terminal" in data ? data.previous_terminal : previous?.terminal;
          const expectedNodeStatus = previousTerminal === "cancelled_clean" ? "cancelled" : "failed";
          if (
            active !== null || node === undefined || previous === undefined ||
            previous.attemptNumber !== data.attempt_number || previous.terminalEventId !== data.terminal_event_id ||
            previous.status !== "terminal" || previous.terminal !== previousTerminal ||
            !["known_failed", "pre_effect_infrastructure_failure", "cancelled_clean"].includes(previousTerminal ?? "") ||
            node.status !== expectedNodeStatus || node.attempts.length >= node.node.budget.maxAttempts
          ) {
            throw new TaskGraphError("task_graph_invalid", "manual retry does not exact-match one retryable failed or cancelled attempt");
          }
          node.status = "pending";
          node.nextAttemptOrigin = "user";
          node.terminalEventId = null;
          blocker = null;
          break;
        }
        case "task_node.skipped": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_node.skipped">;
          const node = nodes.get(data.node_id);
          if (node === undefined || node.status !== "pending" || data.root_blocker_node_ids.some((id) => {
            const status = nodes.get(id)?.status;
            return status !== "failed" && status !== "blocked" && status !== "cancelled" && status !== "skipped";
          })) {
            throw new TaskGraphError("task_graph_invalid", "node skip has no exact terminal dependency blocker");
          }
          node.status = "skipped";
          node.terminalEventId = event.eventId;
          break;
        }
        case "task_budget.exhausted": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_budget.exhausted">;
          blocker = Object.freeze({ code: `task_budget_exhausted:${data.counter}`, eventId: event.eventId, nodeId: data.node_id });
          break;
        }
        case "task_graph.waiting_for_user": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_graph.waiting_for_user">;
          blocker = Object.freeze({ code: `task_waiting_for_user:${data.reason}`, eventId: event.eventId, nodeId: active?.nodeId ?? null });
          break;
        }
        case "task_graph.terminal": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_graph.terminal">;
          if (data.status === "completed" && [...nodes.values()].some((node) => node.status !== "succeeded")) {
            throw new TaskGraphError("task_graph_invalid", "Graph completed before every node succeeded");
          }
          if (data.blocker_code !== undefined) {
            blocker = Object.freeze({ code: data.blocker_code, eventId: event.eventId, nodeId: null });
          }
          schedulerLeaseNonceSha256 = null;
          break;
        }
        default:
          break;
      }
    }
    if (enqueue === null) throw new TaskGraphError("task_graph_invalid", "execution projection has no enqueue fact");
    const graphStatus = graph.status;
    const canQueue = active === null && blocker === null && !cancelRequested && ["queued", "running"].includes(graphStatus);
    const ready = canQueue
      ? [...nodes.values()].filter(isReady)
        .sort((left, right) => left.node.sequence - right.node.sequence || left.node.nodeId.localeCompare(right.node.nodeId, "en"))
        .map((node) => node.node.nodeId)
      : [];
    for (const nodeId of ready) nodes.get(nodeId)!.status = "ready";
    const budgetLimits = limits(graph.content.graphBudget);
    const projectedNodes = graph.content.nodes.map((spec) => {
      const node = nodes.get(spec.nodeId)!;
      return Object.freeze({
        attempts: Object.freeze(node.attempts.map(immutableAttempt)),
        nextAttemptOrigin: node.nextAttemptOrigin,
        node: spec,
        nodeId: spec.nodeId,
        status: node.status,
        terminalEventId: node.terminalEventId,
      });
    });
    return Object.freeze({
      activeAttempt: active === null ? null : immutableAttempt(active),
      blocker,
      budget: Object.freeze({
        consumed: Object.freeze({ ...consumed }),
        limits: budgetLimits,
        remaining: subtract(budgetLimits, consumed, reserved),
        reserved: Object.freeze({ ...reserved }),
        usageCompleteness: completeness,
      }),
      enqueue,
      graph,
      lastSessionSeq: events.at(-1)?.sessionSeq ?? 0,
      nodes: Object.freeze(projectedNodes),
      readyNodeIds: Object.freeze(ready),
      schedulerLeaseNonceSha256,
      status: graphStatus,
    });
  }
}
