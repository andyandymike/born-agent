import { sha256Canonical } from "../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import { canonicalTaskGraphIdentity } from "./task-graph-identity.js";
import type {
  Phase19TaskGraphSessionEventData,
  Phase19TaskGraphSessionEventType,
} from "./task-graph-event-schema.js";
import type { TaskGraphBindingV1, TaskGraphRevisionContentV1 } from "./task-graph-schema.js";
import { TaskGraphError } from "./task-graph-errors.js";

export type TaskGraphStatus =
  | "draft"
  | "approved"
  | "queued"
  | "running"
  | "waiting_for_user"
  | "awaiting_integration"
  | "completed"
  | "blocked"
  | "cancelled"
  | "failed"
  | "rejected"
  | "stale"
  | "superseded";

export interface TaskGraphRevisionRefV1 {
  readonly graphId: string;
  readonly revision: number;
  readonly graphSha256: string;
  readonly binding: TaskGraphBindingV1;
}

export interface TaskGraphRevisionProjectionV1 extends TaskGraphRevisionRefV1 {
  readonly approvedEventId: string | null;
  readonly artifact: {
    readonly artifactId: string;
    readonly bytes: number;
    readonly objectRef: string;
    readonly sha256: string;
  };
  readonly content: TaskGraphRevisionContentV1;
  readonly createdEventId: string;
  readonly decisionEventId: string | null;
  readonly status: TaskGraphStatus;
  readonly terminalEventId: string | null;
}

export interface TaskGraphProjectionV1 {
  readonly trackingMode: "none" | "phase19";
  readonly currentDraft: TaskGraphRevisionRefV1 | null;
  readonly currentApproved: TaskGraphRevisionRefV1 | null;
  readonly currentExecution: TaskGraphRevisionRefV1 | null;
  readonly revisions: readonly TaskGraphRevisionProjectionV1[];
  readonly lastSessionSeq: number;
}

interface MutableRevision {
  approvedEventId: string | null;
  artifact: TaskGraphRevisionProjectionV1["artifact"];
  binding: TaskGraphBindingV1;
  content: TaskGraphRevisionContentV1;
  createdEventId: string;
  decisionEventId: string | null;
  graphId: string;
  graphSha256: string;
  revision: number;
  status: TaskGraphStatus;
  terminalEventId: string | null;
}

const GRAPH_EVENT_TYPES = new Set<Phase19TaskGraphSessionEventType>([
  "task_graph.proposed",
  "task_graph.replaced",
  "task_graph.approved",
  "task_graph.rejected",
  "task_graph.stale",
  "task_graph.enqueued",
  "task_graph.started",
  "task_graph.waiting_for_user",
  "task_graph.cancel.requested",
  "task_graph.terminal",
  "task_scheduler.lease.acquired",
  "task_scheduler.lease.recovered",
  "task_node.attempt.requested",
  "task_node.attempt.started",
  "task_node.attempt.waiting_for_user",
  "task_node.attempt.terminal",
  "task_node.retry.requested",
  "task_node.skipped",
  "task_budget.exhausted",
]);

function key(graphId: string, revision: number): string {
  return `${graphId}\0${String(revision)}`;
}

function ref(revision: MutableRevision | null): TaskGraphRevisionRefV1 | null {
  return revision === null ? null : Object.freeze({
    binding: Object.freeze({ ...revision.binding }),
    graphId: revision.graphId,
    graphSha256: revision.graphSha256,
    revision: revision.revision,
  });
}

function bindingFromEvent(value: {
  readonly session_id: string;
  readonly goal_id: string;
  readonly goal_revision: number;
  readonly plan_id: string;
  readonly plan_revision: number;
  readonly plan_sha256: string;
}): TaskGraphBindingV1 {
  return Object.freeze({
    sessionId: value.session_id,
    goalId: value.goal_id,
    goalRevision: value.goal_revision,
    planId: value.plan_id,
    planRevision: value.plan_revision,
    planSha256: value.plan_sha256,
  });
}

function projection(revision: MutableRevision): TaskGraphRevisionProjectionV1 {
  return Object.freeze({
    approvedEventId: revision.approvedEventId,
    artifact: Object.freeze({ ...revision.artifact }),
    binding: Object.freeze({ ...revision.binding }),
    content: revision.content,
    createdEventId: revision.createdEventId,
    decisionEventId: revision.decisionEventId,
    graphId: revision.graphId,
    graphSha256: revision.graphSha256,
    revision: revision.revision,
    status: revision.status,
    terminalEventId: revision.terminalEventId,
  });
}

function eventData<TType extends Phase19TaskGraphSessionEventType>(
  event: DecodedStoredEvent,
  type: TType,
): Phase19TaskGraphSessionEventData<TType> {
  if (event.scope !== "session" || event.type !== type) {
    throw new TaskGraphError("task_graph_invalid", "Graph projector received an inconsistent event type");
  }
  return event.data as Phase19TaskGraphSessionEventData<TType>;
}

export class TaskGraphProjector {
  static project(events: readonly DecodedStoredEvent[]): TaskGraphProjectionV1 {
    const revisions: MutableRevision[] = [];
    const byKey = new Map<string, MutableRevision>();
    let currentDraft: MutableRevision | null = null;
    let currentApproved: MutableRevision | null = null;
    let currentExecution: MutableRevision | null = null;

    const exact = (event: DecodedStoredEvent): MutableRevision => {
      const data = event.data as { readonly graph_id?: unknown; readonly graph_revision?: unknown; readonly graph_sha256?: unknown };
      if (typeof data.graph_id !== "string" || typeof data.graph_revision !== "number" || typeof data.graph_sha256 !== "string") {
        throw new TaskGraphError("task_graph_invalid", `Graph event ${event.type} has no exact target`);
      }
      const found = byKey.get(key(data.graph_id, data.graph_revision));
      if (found === undefined || found.graphSha256 !== data.graph_sha256) {
        throw new TaskGraphError("task_graph_revision_conflict", `Graph event ${event.type} targets an unknown revision`);
      }
      return found;
    };

    for (const event of events) {
      if (event.scope !== "session" || !GRAPH_EVENT_TYPES.has(event.type as Phase19TaskGraphSessionEventType)) continue;
      switch (event.type) {
        case "task_graph.proposed": {
          const data = eventData(event, "task_graph.proposed");
          if (byKey.has(key(data.graph_id, data.graph_revision))) {
            throw new TaskGraphError("task_graph_revision_conflict", "duplicate Graph revision identity");
          }
          if (revisions.some((item) => item.graphId === data.graph_id)) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph proposal reused an existing Graph ID");
          }
          const identity = canonicalTaskGraphIdentity(data.content);
          if (identity.graphSha256 !== data.graph_sha256 || data.binding.session_id !== event.sessionId) {
            throw new TaskGraphError("task_graph_artifact_invalid", "Graph proposal identity is inconsistent");
          }
          const created: MutableRevision = {
            approvedEventId: null,
            artifact: {
              artifactId: data.artifact.artifact_id,
              bytes: data.artifact.bytes,
              objectRef: data.artifact.object_ref,
              sha256: data.artifact.sha256,
            },
            binding: bindingFromEvent(data.binding),
            content: identity.content,
            createdEventId: event.eventId,
            decisionEventId: null,
            graphId: data.graph_id,
            graphSha256: data.graph_sha256,
            revision: data.graph_revision,
            status: "draft",
            terminalEventId: null,
          };
          revisions.push(created);
          byKey.set(key(created.graphId, created.revision), created);
          currentDraft = created;
          break;
        }
        case "task_graph.replaced": {
          const data = eventData(event, "task_graph.replaced");
          const base = byKey.get(key(data.graph_id, data.base_revision));
          if (
            base === undefined || base.graphSha256 !== data.base_sha256 ||
            !["draft", "approved"].includes(base.status) || currentExecution !== null
          ) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph replacement base is stale or executing");
          }
          if (data.graph_revision !== base.revision + 1 || byKey.has(key(data.graph_id, data.graph_revision))) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph replacement revision is not the next unique revision");
          }
          const identity = canonicalTaskGraphIdentity(data.content);
          const nextBinding = bindingFromEvent(data.binding);
          if (
            identity.graphSha256 !== data.graph_sha256 ||
            nextBinding.sessionId !== base.binding.sessionId ||
            nextBinding.goalId !== base.binding.goalId ||
            nextBinding.goalRevision !== base.binding.goalRevision ||
            nextBinding.planId !== base.binding.planId ||
            nextBinding.planRevision !== base.binding.planRevision ||
            nextBinding.planSha256 !== base.binding.planSha256
          ) {
            throw new TaskGraphError("task_graph_binding_stale", "Graph replacement changed its authority binding");
          }
          base.status = "superseded";
          if (currentApproved === base) currentApproved = null;
          const created: MutableRevision = {
            approvedEventId: null,
            artifact: {
              artifactId: data.artifact.artifact_id,
              bytes: data.artifact.bytes,
              objectRef: data.artifact.object_ref,
              sha256: data.artifact.sha256,
            },
            binding: nextBinding,
            content: identity.content,
            createdEventId: event.eventId,
            decisionEventId: null,
            graphId: data.graph_id,
            graphSha256: data.graph_sha256,
            revision: data.graph_revision,
            status: "draft",
            terminalEventId: null,
          };
          revisions.push(created);
          byKey.set(key(created.graphId, created.revision), created);
          currentDraft = created;
          break;
        }
        case "task_graph.approved": {
          const revision = exact(event);
          if (revision.status !== "draft" || currentDraft !== revision || revision.decisionEventId !== null) {
            throw new TaskGraphError("task_graph_decision_conflict", "Graph approval does not target the current draft");
          }
          const data = eventData(event, "task_graph.approved");
          if (data.revision_event_id !== revision.createdEventId) {
            throw new TaskGraphError("task_graph_decision_conflict", "Graph approval references a different revision event");
          }
          revision.status = "approved";
          revision.approvedEventId = event.eventId;
          revision.decisionEventId = event.eventId;
          currentDraft = null;
          currentApproved = revision;
          break;
        }
        case "task_graph.rejected": {
          const revision = exact(event);
          if (revision.status !== "draft" || currentDraft !== revision || revision.decisionEventId !== null) {
            throw new TaskGraphError("task_graph_decision_conflict", "Graph rejection does not target the current draft");
          }
          const data = eventData(event, "task_graph.rejected");
          if (data.revision_event_id !== revision.createdEventId) {
            throw new TaskGraphError("task_graph_decision_conflict", "Graph rejection references a different revision event");
          }
          revision.status = "rejected";
          revision.decisionEventId = event.eventId;
          currentDraft = null;
          break;
        }
        case "task_graph.stale": {
          const revision = exact(event);
          if (["completed", "cancelled", "failed", "rejected", "superseded"].includes(revision.status)) {
            throw new TaskGraphError("task_graph_revision_conflict", "terminal Graph revision cannot become stale");
          }
          revision.status = "stale";
          revision.terminalEventId = event.eventId;
          if (currentDraft === revision) currentDraft = null;
          if (currentApproved === revision) currentApproved = null;
          if (currentExecution === revision) currentExecution = null;
          break;
        }
        case "task_graph.enqueued": {
          const revision = exact(event);
          if (
            !["approved", "waiting_for_user"].includes(revision.status) ||
            currentApproved !== revision ||
            (revision.status === "waiting_for_user" && currentExecution !== revision)
          ) {
            throw new TaskGraphError("task_graph_not_approved", "only the current approved or waiting Graph can be enqueued");
          }
          revision.status = "queued";
          currentExecution = revision;
          break;
        }
        case "task_graph.started": {
          const revision = exact(event);
          if (revision.status !== "queued" || currentExecution !== revision) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph start requires the exact queued revision");
          }
          revision.status = "running";
          break;
        }
        case "task_graph.waiting_for_user": {
          const revision = exact(event);
          if (!["queued", "running"].includes(revision.status)) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph cannot wait from its current status");
          }
          revision.status = "waiting_for_user";
          break;
        }
        case "task_graph.cancel.requested": {
          const revision = exact(event);
          if (!["queued", "running", "waiting_for_user", "awaiting_integration"].includes(revision.status)) {
            throw new TaskGraphError("task_graph_decision_conflict", "Graph cancellation target is not active");
          }
          break;
        }
        case "task_graph.terminal": {
          const revision = exact(event);
          const data = eventData(event, "task_graph.terminal");
          if (!["queued", "running", "waiting_for_user", "awaiting_integration"].includes(revision.status)) {
            throw new TaskGraphError("task_graph_revision_conflict", "Graph terminal event follows a terminal or draft state");
          }
          revision.status = data.status;
          revision.terminalEventId = event.eventId;
          currentExecution = null;
          break;
        }
        case "task_node.retry.requested": {
          const revision = exact(event);
          if (revision.status !== "failed" || currentApproved !== revision || currentExecution !== null) {
            throw new TaskGraphError("task_graph_revision_conflict", "manual retry requires the exact failed approved Graph with no active execution");
          }
          revision.status = "waiting_for_user";
          revision.terminalEventId = null;
          currentExecution = revision;
          break;
        }
        default:
          // Node, budget, and scheduler events are validated by the execution projector.
          break;
      }
    }

    return Object.freeze({
      trackingMode: revisions.length === 0 ? "none" : "phase19",
      currentApproved: ref(currentApproved),
      currentDraft: ref(currentDraft),
      currentExecution: ref(currentExecution),
      lastSessionSeq: events.at(-1)?.sessionSeq ?? 0,
      revisions: Object.freeze(revisions.map(projection)),
    });
  }
}

export function observeTaskGraphBinding(
  graph: TaskGraphRevisionRefV1,
  state: TaskStateProjection,
): "current" | "stale" | "unavailable" {
  if (state.trackingMode !== "phase16") return "unavailable";
  const goal = state.goals.find((candidate) => candidate.content.goalId === state.activeGoalId);
  const plan = state.currentApprovedPlan;
  if (goal === undefined || plan === null) return "stale";
  return goal.content.goalId === graph.binding.goalId &&
      goal.content.revision === graph.binding.goalRevision &&
      plan.planId === graph.binding.planId &&
      plan.revision === graph.binding.planRevision &&
      plan.planSha256 === graph.binding.planSha256
    ? "current"
    : "stale";
}

export function taskGraphProjectionSha256(projection: TaskGraphProjectionV1): string {
  return sha256Canonical(projection);
}
