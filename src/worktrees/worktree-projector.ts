import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { Phase19TaskGraphSessionEventData } from "../task-graph/task-graph-event-schema.js";
import { WorktreeError } from "./worktree-errors.js";
import type {
  ManagedWorktreeIdentityV1,
  PromotionBundleV1,
  WorkspaceAllocationPlanV1,
  WorkspaceBaselineManifestV1,
} from "./worktree-schema.js";

export type ManagedWorkspaceStatusV1 =
  | "active"
  | "retained_clean"
  | "retained_dirty"
  | "archived"
  | "removed"
  | "reconciliation_required";

export interface ManagedWorkspaceProjectionV1 {
  readonly activeAttemptId: string | null;
  readonly baseline: WorkspaceBaselineManifestV1;
  readonly identity: ManagedWorktreeIdentityV1;
  readonly lastSnapshot: {
    readonly attemptId: string;
    readonly changedBytes: number;
    readonly changedFiles: number;
    readonly nodeId: string;
    readonly sha256: string;
  } | null;
  readonly nodeIds: readonly string[];
  readonly operationId: string;
  readonly plan: WorkspaceAllocationPlanV1;
  readonly status: ManagedWorkspaceStatusV1;
}

export interface WorktreePromotionProjectionV1 {
  readonly appliedEventId: string | null;
  readonly approvalRequestId: string | null;
  readonly bundle: PromotionBundleV1;
  readonly operationId: string | null;
  readonly proposalEventId: string;
  readonly status: "proposed" | "approved" | "requested" | "applied";
}

export interface WorktreeProjectionV1 {
  readonly lastSessionSeq: number;
  readonly pendingOperationIds: readonly string[];
  readonly promotions: readonly WorktreePromotionProjectionV1[];
  readonly workspaces: readonly ManagedWorkspaceProjectionV1[];
}

interface MutableWorkspace {
  activeAttemptId: string | null;
  baseline: WorkspaceBaselineManifestV1;
  identity: ManagedWorktreeIdentityV1;
  lastSnapshot: ManagedWorkspaceProjectionV1["lastSnapshot"];
  nodeIds: readonly string[];
  operationId: string;
  plan: WorkspaceAllocationPlanV1;
  status: ManagedWorkspaceStatusV1;
}

interface MutablePromotion {
  appliedEventId: string | null;
  approvalRequestId: string | null;
  bundle: PromotionBundleV1;
  operationId: string | null;
  proposalEventId: string;
  status: WorktreePromotionProjectionV1["status"];
}

function fail(message: string): never {
  throw new WorktreeError("worktree_operation_incomplete", message);
}

function exactGraph(left: { readonly graphId: string; readonly graphRevision: number; readonly graphSha256: string }, data: {
  readonly graph_id: string; readonly graph_revision: number; readonly graph_sha256: string;
}): boolean {
  return left.graphId === data.graph_id && left.graphRevision === data.graph_revision && left.graphSha256 === data.graph_sha256;
}

export class WorktreeProjector {
  static project(events: readonly DecodedStoredEvent[]): WorktreeProjectionV1 {
    const prepared = new Map<string, { readonly eventId: string; readonly plan: WorkspaceAllocationPlanV1 }>();
    const approvedPlans = new Map<string, string>();
    const requestedCreates = new Map<string, { readonly planSha256: string; readonly workspaceId: string }>();
    const workspaces = new Map<string, MutableWorkspace>();
    const attempts = new Map<string, string>();
    const proposals = new Map<string, MutablePromotion>();
    const requestedPromotions = new Map<string, MutablePromotion>();
    const pending = new Set<string>();
    let lastSessionSeq = 0;

    for (const event of events) {
      lastSessionSeq = Math.max(lastSessionSeq, event.sessionSeq);
      if (event.scope !== "session") continue;
      switch (event.type) {
        case "task_worktree.allocation.prepared": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.allocation.prepared">;
          if (prepared.has(data.allocation_plan_sha256)) fail("duplicate worktree allocation plan identity");
          prepared.set(data.allocation_plan_sha256, { eventId: event.eventId, plan: data.allocation_plan });
          break;
        }
        case "task_worktree.allocation.approved": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.allocation.approved">;
          const plan = prepared.get(data.allocation_plan_sha256)?.plan;
          if (plan === undefined || plan.workspaceId !== data.workspace_id || !exactGraph(plan.graph, data) || approvedPlans.has(data.allocation_plan_sha256)) {
            fail("worktree allocation approval has no exact unique prepared plan");
          }
          approvedPlans.set(data.allocation_plan_sha256, data.approval_request_id);
          break;
        }
        case "task_worktree.create.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.create.requested">;
          const plan = prepared.get(data.allocation_plan_sha256)?.plan;
          if (plan === undefined || !approvedPlans.has(data.allocation_plan_sha256) || plan.operationId !== data.operation_id || plan.workspaceId !== data.workspace_id || !exactGraph(plan.graph, data)) {
            fail("worktree create request is not bound to one approved allocation");
          }
          if (pending.has(data.operation_id)) fail("worktree operation id was reused");
          pending.add(data.operation_id);
          requestedCreates.set(data.operation_id, { planSha256: data.allocation_plan_sha256, workspaceId: data.workspace_id });
          break;
        }
        case "task_worktree.created": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.created">;
          const request = requestedCreates.get(data.operation_id);
          const plan = request === undefined ? undefined : prepared.get(request.planSha256)?.plan;
          if (request === undefined || plan === undefined || request.workspaceId !== data.identity.workspaceId ||
              data.identity.allocationPlanSha256 !== request.planSha256 || data.identity.repositoryId !== plan.repository.repositoryId ||
              data.identity.baseCommit !== plan.baseCommit || data.identity.graphId !== plan.graph.graphId || !exactGraph(plan.graph, data) ||
              workspaces.has(data.identity.workspaceId)) {
            fail("created worktree does not match its requested allocation");
          }
          // Baseline becomes authoritative only at baseline.seeded. Hold the
          // request until that event arrives rather than inventing bytes.
          break;
        }
        case "task_worktree.baseline.seeded": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.baseline.seeded">;
          const createdEvent = [...events].reverse().find((candidate) => candidate.sessionSeq < event.sessionSeq && candidate.scope === "session" && candidate.type === "task_worktree.created" && candidate.data.identity.workspaceId === data.workspace_id);
          if (createdEvent === undefined || createdEvent.scope !== "session" || createdEvent.type !== "task_worktree.created") fail("seeded baseline has no created workspace");
          const request = requestedCreates.get(createdEvent.data.operation_id);
          const plan = request === undefined ? undefined : prepared.get(request.planSha256)?.plan;
          if (request === undefined || plan === undefined || data.baseline.manifestSha256 !== plan.baselineManifestSha256 ||
              data.baseline.originStatusSha256 !== plan.originStatusSha256 || !exactGraph(plan.graph, data)) {
            fail("seeded baseline does not match its allocation plan");
          }
          workspaces.set(data.workspace_id, {
            activeAttemptId: null,
            baseline: data.baseline,
            identity: createdEvent.data.identity,
            lastSnapshot: null,
            nodeIds: Object.freeze([...plan.nodeIds]),
            operationId: createdEvent.data.operation_id,
            plan,
            status: "retained_clean",
          });
          pending.delete(createdEvent.data.operation_id);
          break;
        }
        case "task_worktree.lease.acquired": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.lease.acquired">;
          const workspace = workspaces.get(data.workspace_id);
          if (workspace === undefined || workspace.activeAttemptId !== null || !workspace.nodeIds.includes(data.node_id) || !exactGraph(workspace.plan.graph, data)) {
            fail("workspace lease is not bound to one idle allocated lineage");
          }
          workspace.activeAttemptId = data.attempt_id;
          workspace.status = "active";
          attempts.set(data.attempt_id, data.workspace_id);
          break;
        }
        case "task_worktree.snapshot.accepted": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.snapshot.accepted">;
          const workspace = workspaces.get(data.workspace_id);
          if (workspace === undefined || workspace.activeAttemptId !== data.attempt_id || attempts.get(data.attempt_id) !== data.workspace_id || !workspace.nodeIds.includes(data.node_id)) {
            fail("accepted workspace snapshot is not bound to its active lease");
          }
          workspace.lastSnapshot = Object.freeze({ attemptId: data.attempt_id, changedBytes: data.changed_bytes, changedFiles: data.changed_files, nodeId: data.node_id, sha256: data.snapshot_sha256 });
          break;
        }
        case "task_worktree.lease.released": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.lease.released">;
          const workspace = workspaces.get(data.workspace_id);
          const terminal = events.find((candidate) => candidate.eventId === data.terminal_event_id);
          if (workspace === undefined || workspace.activeAttemptId !== data.attempt_id || terminal?.type !== "task_node.attempt.terminal") {
            fail("workspace lease release has no exact terminal attempt");
          }
          workspace.activeAttemptId = null;
          workspace.status = (workspace.lastSnapshot?.changedFiles ?? 0) === 0 ? "retained_clean" : "retained_dirty";
          attempts.delete(data.attempt_id);
          break;
        }
        case "task_worktree.promotion.proposed": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.promotion.proposed">;
          const workspace = workspaces.get(data.bundle.workspaceId);
          if (workspace === undefined || workspace.lastSnapshot?.sha256 !== data.bundle.workspaceSnapshotSha256 ||
              data.bundle.bundleSha256 !== data.bundle_sha256 || !exactGraph(workspace.plan.graph, data) || proposals.has(data.bundle_sha256)) {
            fail("promotion proposal is not bound to an accepted workspace snapshot");
          }
          proposals.set(data.bundle_sha256, {
            appliedEventId: null, approvalRequestId: null, bundle: data.bundle, operationId: null,
            proposalEventId: event.eventId, status: "proposed",
          });
          break;
        }
        case "task_worktree.promotion.approved": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.promotion.approved">;
          const proposal = proposals.get(data.bundle_sha256);
          if (proposal === undefined || proposal.status !== "proposed" || proposal.bundle.targetSnapshotSha256 !== data.target_snapshot_sha256) {
            fail("promotion approval has no exact proposal");
          }
          proposal.approvalRequestId = data.approval_request_id;
          proposal.status = "approved";
          break;
        }
        case "task_worktree.promotion.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.promotion.requested">;
          const proposal = proposals.get(data.bundle_sha256);
          if (proposal === undefined || proposal.status !== "approved" || proposal.approvalRequestId !== data.approval_request_id ||
              proposal.bundle.targetSnapshotSha256 !== data.target_snapshot_sha256 || pending.has(data.operation_id)) {
            fail("promotion request has no exact fresh approval");
          }
          proposal.operationId = data.operation_id;
          proposal.status = "requested";
          requestedPromotions.set(data.operation_id, proposal);
          pending.add(data.operation_id);
          break;
        }
        case "task_worktree.promotion.applied": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.promotion.applied">;
          const proposal = requestedPromotions.get(data.operation_id);
          if (proposal === undefined || proposal.status !== "requested" || proposal.bundle.bundleSha256 !== data.bundle_sha256 ||
              data.changed_paths.length !== proposal.bundle.entries.length || data.changed_paths.some((path, index) => path !== proposal.bundle.entries[index]?.path)) {
            fail("applied promotion does not match its requested bundle");
          }
          proposal.appliedEventId = event.eventId;
          proposal.status = "applied";
          pending.delete(data.operation_id);
          break;
        }
        case "task_worktree.cleanup.requested": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.cleanup.requested">;
          const workspace = workspaces.get(data.workspace_id);
          if (workspace === undefined || workspace.activeAttemptId !== null || pending.has(data.operation_id)) fail("cleanup request targets an unavailable workspace");
          pending.add(data.operation_id);
          break;
        }
        case "task_worktree.cleanup.completed": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.cleanup.completed">;
          const workspace = workspaces.get(data.workspace_id);
          if (workspace === undefined || !pending.has(data.operation_id)) fail("cleanup completion has no request");
          workspace.status = data.status === "archived" ? "archived" : data.status === "removed" ? "removed" : workspace.status;
          pending.delete(data.operation_id);
          break;
        }
        case "task_worktree.reconciled": {
          const data = event.data as Phase19TaskGraphSessionEventData<"task_worktree.reconciled">;
          const workspace = workspaces.get(data.workspace_id);
          if (data.observed === "not_applied" || data.observed === "applied_exact") pending.delete(data.operation_id);
          else {
            if (workspace !== undefined) workspace.status = "reconciliation_required";
            pending.add(data.operation_id);
          }
          break;
        }
        default:
          break;
      }
    }

    return Object.freeze({
      lastSessionSeq,
      pendingOperationIds: Object.freeze([...pending].sort()),
      promotions: Object.freeze([...proposals.values()].map((promotion) => Object.freeze({ ...promotion }))),
      workspaces: Object.freeze([...workspaces.values()].map((workspace) => Object.freeze({ ...workspace }))),
    });
  }
}
