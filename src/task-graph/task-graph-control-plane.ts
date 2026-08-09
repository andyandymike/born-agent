import { ArtifactStore } from "../artifacts/artifact-store.js";
import { ArtifactError } from "../artifacts/artifact-types.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { taskMutationBlocker } from "../coordination/task-control-plane.js";
import type { PlanRevisionProjection } from "../coordination/task-state-types.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import {
  canonicalTaskGraphIdentity,
  taskGraphApprovalIdentity,
  type TaskGraphRevisionIdentityV1,
} from "./task-graph-identity.js";
import { TaskGraphError } from "./task-graph-errors.js";
import type {
  Phase19TaskGraphSessionEventData,
  Phase19TaskGraphSessionEventType,
} from "./task-graph-event-schema.js";
import {
  observeTaskGraphBinding,
  type TaskGraphProjectionV1,
  type TaskGraphRevisionProjectionV1,
} from "./task-graph-projector.js";
import {
  taskGraphRevisionContentSchema,
  validateTaskGraphPlanItems,
} from "./task-graph-schema.js";

export interface TaskGraphBaseIdentityV1 {
  readonly revision: number;
  readonly sha256: string;
}

export interface TaskGraphMutationResultV1 {
  readonly deduplicated: boolean;
  readonly graph: TaskGraphRevisionProjectionV1;
  readonly projection: TaskGraphProjectionV1;
}

interface LockedGraphSession {
  readonly writer: V2SessionWriter;
  readonly session: ReturnType<typeof reconstructMultiRunSession>;
  append<TType extends Phase19TaskGraphSessionEventType>(
    type: TType,
    data: Phase19TaskGraphSessionEventData<TType>,
  ): Promise<void>;
}

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  const { V2SessionWriter } = await import("../sessions/v2-session-writer.js");
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function exactRevision(
  projection: TaskGraphProjectionV1,
  graphId: string,
  revision: number,
  sha256: string,
): TaskGraphRevisionProjectionV1 {
  const found = projection.revisions.find((candidate) =>
    candidate.graphId === graphId &&
    candidate.revision === revision &&
    candidate.graphSha256 === sha256
  );
  if (found === undefined) {
    throw new TaskGraphError("task_graph_revision_conflict", "Graph revision selector is stale");
  }
  return found;
}

function currentPlan(session: ReturnType<typeof reconstructMultiRunSession>): PlanRevisionProjection {
  const ref = session.taskState.currentApprovedPlan;
  if (ref === null) {
    throw new TaskGraphError("task_graph_binding_stale", "Graph requires a current approved Plan");
  }
  const plan = session.taskState.plans.find((candidate) =>
    candidate.content.planId === ref.planId &&
    candidate.content.revision === ref.revision &&
    candidate.planSha256 === ref.planSha256
  );
  if (plan === undefined || plan.status !== "active") {
    throw new TaskGraphError("task_graph_binding_stale", "current approved Plan projection is unavailable");
  }
  return plan;
}

function assertCurrentBinding(
  graph: TaskGraphRevisionProjectionV1,
  session: ReturnType<typeof reconstructMultiRunSession>,
): void {
  if (observeTaskGraphBinding(graph, session.taskState) !== "current") {
    throw new TaskGraphError("task_graph_binding_stale", "Graph Goal/Plan binding is no longer current");
  }
}

async function graphStore(context: TaskMutationContext): Promise<ArtifactStore> {
  return ArtifactStore.create({ sessionId: context.sessionId, workspace: context.workspace });
}

export async function verifyTaskGraphRevisionArtifact(
  workspace: string,
  sessionId: string,
  revision: TaskGraphRevisionProjectionV1,
): Promise<void> {
  try {
    const stored = await (await ArtifactStore.create({ sessionId, workspace }))
      .readVerified(revision.artifact.artifactId);
    const identity = canonicalTaskGraphIdentity(revision.content);
    if (
      stored.metadata.bytes !== revision.artifact.bytes ||
      stored.metadata.sha256 !== revision.artifact.sha256 ||
      stored.objectRef !== revision.artifact.objectRef ||
      !stored.bytes.equals(identity.bytes)
    ) {
      throw new TaskGraphError("task_graph_artifact_invalid", "Graph revision artifact does not match its durable event");
    }
  } catch (error) {
    if (error instanceof TaskGraphError) throw error;
    if (error instanceof ArtifactError) {
      throw new TaskGraphError("task_graph_artifact_invalid", "Graph revision artifact is missing or corrupt", { cause: error });
    }
    throw error;
  }
}

export class TaskGraphControlPlane {
  constructor(private readonly writerFactory: TaskMutationWriterFactory = defaultWriterFactory) {}

  async #withLocked<T>(
    context: TaskMutationContext,
    operation: (locked: LockedGraphSession) => Promise<T>,
  ): Promise<T> {
    const writer = await this.writerFactory(context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (
        context.expectedSessionSeq !== undefined &&
        session.taskGraph.lastSessionSeq !== context.expectedSessionSeq
      ) {
        throw new TaskGraphError("task_graph_revision_conflict", "session changed since the optimistic Graph snapshot");
      }
      const blocker = taskMutationBlocker(session);
      if (blocker !== null) {
        throw new TaskGraphError("task_graph_busy", `session effect reconciliation is required (${blocker.details.join(", ")})`);
      }
      return await operation({
        append: async (type, data) => {
          await writer.appendTaskGraphEvent(type, data);
        },
        session,
        writer,
      });
    } finally {
      await writer.close();
    }
  }

  async replace(input: {
    readonly base: TaskGraphBaseIdentityV1 | null;
    readonly context: TaskMutationContext;
    readonly graph: TaskGraphRevisionIdentityV1;
  }): Promise<TaskGraphMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const plan = currentPlan(session);
      const activeGoal = session.taskState.goals.find((candidate) =>
        candidate.content.goalId === session.taskState.activeGoalId
      );
      if (activeGoal === undefined || activeGoal.status !== "active") {
        throw new TaskGraphError("task_graph_binding_stale", "Graph requires an exact active Goal");
      }
      const graphProjection = session.taskGraph;
      let graphId: string;
      let revision: number;
      let baseRevision: TaskGraphRevisionProjectionV1 | null;
      if (input.base === null) {
        if (graphProjection.currentDraft !== null || graphProjection.currentApproved !== null || graphProjection.currentExecution !== null) {
          throw new TaskGraphError("task_graph_revision_conflict", "a current Graph already exists; an exact base is required");
        }
        graphId = input.context.randomUuid();
        revision = 1;
        baseRevision = null;
      } else {
        const candidate = graphProjection.currentDraft ?? graphProjection.currentApproved;
        if (
          candidate === null ||
          candidate.revision !== input.base.revision ||
          candidate.graphSha256 !== input.base.sha256 ||
          graphProjection.currentExecution !== null
        ) {
          throw new TaskGraphError("task_graph_revision_conflict", "Graph replacement base does not exact-match the current revision");
        }
        baseRevision = exactRevision(graphProjection, candidate.graphId, candidate.revision, candidate.graphSha256);
        assertCurrentBinding(baseRevision, session);
        graphId = candidate.graphId;
        revision = candidate.revision + 1;
      }

      const content = {
        ...input.graph.content,
        binding: {
          sessionId: input.context.sessionId,
          goalId: activeGoal.content.goalId,
          goalRevision: activeGoal.content.revision,
          planId: plan.content.planId,
          planRevision: plan.content.revision,
          planSha256: plan.planSha256,
        },
        graphId,
      };
      // PHASE19: Graph remains a scheduling contract over approved Plan items;
      // it cannot add an orphan requirement or replace the Plan itself.
      const identity = canonicalTaskGraphIdentity(content);
      validateTaskGraphPlanItems(identity.content, new Set(plan.items.map((item) => item.content.id)));
      const eventContent = taskGraphRevisionContentSchema.parse(identity.content);
      const store = await graphStore(input.context);
      const captured = await store.storeSanitizedText({
        chunks: [identity.bytes],
        maximumBytes: 256 * 1024,
        runId: graphId,
      });
      if (
        captured.captureStatus !== "complete" ||
        captured.artifact === null ||
        captured.artifact.sha256 !== identity.graphSha256 ||
        captured.artifact.bytes !== identity.byteLength
      ) {
        throw new TaskGraphError("task_graph_artifact_invalid", "Graph revision artifact could not be captured exactly");
      }
      await store.readVerified(captured.artifact.artifactId);
      const artifact = {
        artifact_id: captured.artifact.artifactId,
        bytes: captured.artifact.bytes,
        object_ref: captured.artifact.objectRef,
        sha256: captured.artifact.sha256,
      } as const;
      const binding = {
        session_id: identity.content.binding.sessionId,
        goal_id: identity.content.binding.goalId,
        goal_revision: identity.content.binding.goalRevision,
        plan_id: identity.content.binding.planId,
        plan_revision: identity.content.binding.planRevision,
        plan_sha256: identity.content.binding.planSha256,
      } as const;
      const origin = { input_surface: input.context.inputSurface, kind: "user" as const };
      if (baseRevision === null) {
        await append("task_graph.proposed", {
          artifact,
          binding,
          content: eventContent,
          graph_id: graphId,
          graph_revision: revision,
          graph_sha256: identity.graphSha256,
          origin,
        });
      } else {
        await append("task_graph.replaced", {
          artifact,
          base_revision: baseRevision.revision,
          base_sha256: baseRevision.graphSha256,
          binding,
          content: eventContent,
          graph_id: graphId,
          graph_revision: revision,
          graph_sha256: identity.graphSha256,
          origin,
        });
      }
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        graph: exactRevision(next.taskGraph, graphId, revision, identity.graphSha256),
        projection: next.taskGraph,
      });
    });
  }

  async approve(input: {
    readonly context: TaskMutationContext;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<TaskGraphMutationResultV1> {
    return this.#decide({ ...input, decision: "approve" });
  }

  async reject(input: {
    readonly context: TaskMutationContext;
    readonly reason?: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<TaskGraphMutationResultV1> {
    return this.#decide({ ...input, decision: "reject" });
  }

  async #decide(input: {
    readonly context: TaskMutationContext;
    readonly decision: "approve" | "reject";
    readonly reason?: string;
    readonly revision: number;
    readonly sha256: string;
  }): Promise<TaskGraphMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const existing = session.taskGraph.revisions.find((candidate) =>
        candidate.revision === input.revision && candidate.graphSha256 === input.sha256
      );
      if (existing === undefined) {
        throw new TaskGraphError("task_graph_revision_conflict", "Graph decision selector is stale");
      }
      if (
        (input.decision === "approve" && ["approved", "queued", "running", "waiting_for_user", "awaiting_integration", "completed"].includes(existing.status)) ||
        (input.decision === "reject" && existing.status === "rejected")
      ) {
        return Object.freeze({ deduplicated: true, graph: existing, projection: session.taskGraph });
      }
      if (existing.status !== "draft" || session.taskGraph.currentDraft?.graphSha256 !== existing.graphSha256) {
        throw new TaskGraphError("task_graph_decision_conflict", "Graph decision conflicts with the revision's current status");
      }
      assertCurrentBinding(existing, session);
      await verifyTaskGraphRevisionArtifact(input.context.workspace, input.context.sessionId, existing);
      const requestId = input.context.randomUuid();
      const binding = {
        session_id: existing.binding.sessionId,
        goal_id: existing.binding.goalId,
        goal_revision: existing.binding.goalRevision,
        plan_id: existing.binding.planId,
        plan_revision: existing.binding.planRevision,
        plan_sha256: existing.binding.planSha256,
      } as const;
      const approvalIdentity = taskGraphApprovalIdentity({
        approvalRequestId: requestId,
        binding: existing.binding,
        graphId: existing.graphId,
        graphRevision: existing.revision,
        graphSha256: existing.graphSha256,
        sessionId: input.context.sessionId,
      });
      const common = {
        approval_identity_sha256: approvalIdentity,
        binding,
        decision_request_id: requestId,
        graph_id: existing.graphId,
        graph_revision: existing.revision,
        graph_sha256: existing.graphSha256,
        origin: { input_surface: input.context.inputSurface, kind: "user" as const },
        revision_event_id: existing.createdEventId,
      };
      if (input.decision === "approve") {
        // PHASE19: Graph approval authorizes scheduling intent only. Every
        // patch, command, MCP call, worktree allocation, and promotion keeps
        // its existing independent authority boundary.
        await append("task_graph.approved", common);
      } else {
        await append("task_graph.rejected", {
          ...common,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
      }
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        graph: exactRevision(next.taskGraph, existing.graphId, existing.revision, existing.graphSha256),
        projection: next.taskGraph,
      });
    });
  }
}
