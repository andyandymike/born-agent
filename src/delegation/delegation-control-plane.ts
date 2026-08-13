import { ArtifactStore } from "../artifacts/artifact-store.js";
import { ArtifactError } from "../artifacts/artifact-types.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type {
  TaskMutationContext,
  TaskMutationWriterFactory,
} from "../coordination/task-control-plane.js";
import { taskMutationBlocker, taskUserOrigin } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { DelegationError } from "./delegation-errors.js";
import type {
  Phase20DelegationSessionEventData,
  Phase20DelegationSessionEventType,
} from "./delegation-event-schema.js";
import {
  canonicalDelegationIdentity,
  delegationAuthorityRequestPreviewIdentity,
  delegationApprovalIdentity,
  delegationWorkspaceLineageIdentity,
  type DelegationRevisionIdentityV1,
} from "./delegation-identity.js";
import type {
  DelegationProjectionV1,
  DelegationRevisionProjectionV1,
} from "./delegation-projector.js";
import type {
  DelegationParentBindingV1,
  DelegationRevisionContentV1,
} from "./delegation-schema.js";
import { delegationRevisionContentSchema } from "./delegation-schema.js";

type Session = ReturnType<typeof reconstructMultiRunSession>;

export interface DelegationBaseIdentityV1 {
  readonly revision: number;
  readonly sha256: string;
}

export interface DelegationMutationResultV1 {
  readonly deduplicated: boolean;
  readonly delegation: DelegationRevisionProjectionV1;
  readonly projection: DelegationProjectionV1;
}

export type DelegationAuthorityPreviewer = (
  content: DelegationRevisionContentV1,
  session: Session,
) => string;

interface LockedDelegationSession {
  readonly session: Session;
  readonly writer: V2SessionWriter;
  append<T extends Phase20DelegationSessionEventType>(
    type: T,
    data: Phase20DelegationSessionEventData<T>,
  ): Promise<void>;
}

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  const { V2SessionWriter } = await import("../sessions/v2-session-writer.js");
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function defaultAuthorityPreview(content: DelegationRevisionContentV1): string {
  // This preview binds exactly what the user reviews. It is never launch
  // authority; the envelope builder recomputes the strict Host intersection.
  return delegationAuthorityRequestPreviewIdentity(content);
}

function exactRevision(
  projection: DelegationProjectionV1,
  id: string,
  revision: number,
  sha256: string,
): DelegationRevisionProjectionV1 {
  const found = projection.revisions.find((candidate) =>
    candidate.delegationId === id &&
    candidate.delegationRevision === revision &&
    candidate.delegationSha256 === sha256);
  if (found === undefined) {
    throw new DelegationError("delegation_revision_conflict", "delegation revision selector is stale");
  }
  return found;
}

/** A Graph cancellation root closes every later delegation admission fence. */
function assertGraphDelegationAdmissionOpen(
  session: Session,
  binding: DelegationParentBindingV1,
): void {
  if (binding.graphId === null) return;
  const cancelled = session.events.some((event) => {
    if (event.scope !== "session" || event.type !== "task_graph.cancel.requested") return false;
    const value = event.data as Readonly<Record<string, unknown>>;
    return value.graph_id === binding.graphId &&
      value.graph_revision === binding.graphRevision &&
      value.graph_sha256 === binding.graphSha256;
  });
  if (cancelled) {
    throw new DelegationError(
      "delegation_cancelled",
      "Graph cancellation closed delegation admission for this exact parent binding",
    );
  }
}

function currentGoalAndPlan(session: Session): {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly planId: string;
  readonly planRevision: number;
  readonly planSha256: string;
} {
  const goal = session.taskState.goals.find((candidate) =>
    candidate.content.goalId === session.taskState.activeGoalId && candidate.status === "active");
  const planRef = session.taskState.currentApprovedPlan;
  const plan = planRef === null ? undefined : session.taskState.plans.find((candidate) =>
    candidate.content.planId === planRef.planId &&
    candidate.content.revision === planRef.revision &&
    candidate.planSha256 === planRef.planSha256 &&
    candidate.status === "active");
  if (goal === undefined || plan === undefined) {
    throw new DelegationError("delegation_binding_stale", "delegation requires the exact active Goal and approved Plan");
  }
  return {
    goalId: goal.content.goalId,
    goalRevision: goal.content.revision,
    planId: plan.content.planId,
    planRevision: plan.content.revision,
    planSha256: plan.planSha256,
  };
}

export function resolveDelegationParentBinding(session: Session, parentRunId: string): DelegationParentBindingV1 {
  const parent = session.runs.find((candidate) => candidate.runId === parentRunId);
  if (parent === undefined || session.lastRun?.runId !== parentRunId) {
    throw new DelegationError("delegation_parent_not_active", "delegation parent must be the latest exact session run");
  }
  if (!["completed", "incomplete", "interrupted"].includes(parent.status)) {
    throw new DelegationError("delegation_parent_not_active", "failed, cancelled, or budget-exhausted runs cannot delegate");
  }
  const started = parent.started.data as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(started, "delegated_child_binding")) {
    throw new DelegationError("delegation_unsupported_depth", "delegated children cannot create nested delegations");
  }
  const task = currentGoalAndPlan(session);
  const node = typeof started.task_node_binding === "object" && started.task_node_binding !== null
    ? started.task_node_binding as Readonly<Record<string, unknown>>
    : null;
  const graphBinding = node === null ? {
    graphId: null,
    graphRevision: null,
    graphSha256: null,
    nodeId: null,
    nodeAttemptId: null,
  } : {
    graphId: String(node.graph_id),
    graphRevision: Number(node.graph_revision),
    graphSha256: String(node.graph_sha256),
    nodeId: String(node.node_id),
    nodeAttemptId: String(node.attempt_id),
  };
  const resume = typeof started.workspace_resume_fingerprint === "object" && started.workspace_resume_fingerprint !== null
    ? started.workspace_resume_fingerprint as Readonly<Record<string, unknown>>
    : null;
  const source = resume !== null && typeof resume.source_state === "object" && resume.source_state !== null
    ? resume.source_state as Readonly<Record<string, unknown>>
    : null;
  const repositoryIdentity = typeof resume?.canonical_root_identity === "string"
    ? resume.canonical_root_identity
    : typeof started.workspace_fingerprint === "string"
      ? started.workspace_fingerprint
      : sha256Canonical({ kind: "unfingerprinted_parent_workspace_v1", parent_run_id: parentRunId });
  return Object.freeze({
    sessionId: session.sessionId,
    parentRunId,
    parentActorId: parentRunId,
    ...task,
    ...graphBinding,
    parentWorkspaceLineageId: delegationWorkspaceLineageIdentity({
      parentRunId,
      repositoryIdentity,
      sourceStateSha256: typeof source?.source_state_sha256 === "string" ? source.source_state_sha256 : null,
      workspaceFingerprint: typeof started.workspace_fingerprint === "string" ? started.workspace_fingerprint : null,
    }),
  });
}

function eventBinding(binding: DelegationParentBindingV1) {
  return binding;
}

export async function storeDelegationArtifactExact(
  workspace: string,
  sessionId: string,
  runId: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<{ readonly artifact_id: string; readonly bytes: number; readonly object_ref: string; readonly sha256: string }> {
  const store = await ArtifactStore.create({ sessionId, workspace });
  const captured = await store.storeSanitizedText({ chunks: [bytes], maximumBytes: 256 * 1024, runId });
  if (
    captured.captureStatus !== "complete" ||
    captured.artifact === null ||
    captured.artifact.sha256 !== expectedSha256 ||
    captured.artifact.bytes !== bytes.byteLength
  ) {
    throw new DelegationError("delegation_artifact_invalid", "delegation artifact could not be captured exactly");
  }
  await store.readVerified(captured.artifact.artifactId);
  return Object.freeze({
    artifact_id: captured.artifact.artifactId,
    bytes: captured.artifact.bytes,
    object_ref: captured.artifact.objectRef,
    sha256: captured.artifact.sha256,
  });
}

export async function verifyDelegationRevisionArtifact(
  workspace: string,
  sessionId: string,
  revision: DelegationRevisionProjectionV1,
): Promise<void> {
  try {
    const stored = await (await ArtifactStore.create({ sessionId, workspace }))
      .readVerified(revision.artifact.artifactId);
    const identity = canonicalDelegationIdentity(revision.content);
    if (
      stored.metadata.bytes !== revision.artifact.bytes ||
      stored.metadata.sha256 !== revision.artifact.sha256 ||
      stored.objectRef !== revision.artifact.objectRef ||
      !stored.bytes.equals(identity.bytes)
    ) {
      throw new DelegationError("delegation_artifact_invalid", "delegation revision artifact does not match its durable event");
    }
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    if (error instanceof ArtifactError) {
      throw new DelegationError("delegation_artifact_invalid", "delegation revision artifact is missing or corrupt", { cause: error });
    }
    throw error;
  }
}

export class DelegationControlPlane {
  constructor(
    private readonly writerFactory: TaskMutationWriterFactory = defaultWriterFactory,
    private readonly previewAuthority: DelegationAuthorityPreviewer = defaultAuthorityPreview,
  ) {}

  async #withLocked<T>(
    context: TaskMutationContext,
    operation: (locked: LockedDelegationSession) => Promise<T>,
    options: { readonly allowUnresolvedEffectsForCancellation?: boolean } = {},
  ): Promise<T> {
    const writer = await this.writerFactory(context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      if (
        context.expectedSessionSeq !== undefined &&
        session.delegations.lastSessionSeq !== context.expectedSessionSeq
      ) {
        throw new DelegationError("delegation_revision_conflict", "session changed since the optimistic delegation snapshot");
      }
      if (options.allowUnresolvedEffectsForCancellation !== true) {
        const blocker = taskMutationBlocker(session);
        if (blocker !== null) {
          throw new DelegationError("delegation_effect_reconciliation_required", `session effect reconciliation is required (${blocker.details.join(", ")})`);
        }
      }
      return await operation({
        append: async (type, value) => { await writer.appendDelegationEvent(type, value); },
        session,
        writer,
      });
    } finally {
      await writer.close();
    }
  }

  async replace(input: {
    readonly base: DelegationBaseIdentityV1 | null;
    readonly context: TaskMutationContext;
    readonly parentRunId: string;
    readonly revision: DelegationRevisionIdentityV1;
  }): Promise<DelegationMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const binding = resolveDelegationParentBinding(session, input.parentRunId);
      assertGraphDelegationAdmissionOpen(session, binding);
      let delegationId: string;
      let revisionNumber: number;
      let base: DelegationRevisionProjectionV1 | null;
      if (input.base === null) {
        const sameParent = session.delegations.revisions.filter((candidate) =>
          candidate.parentActorId === binding.parentActorId);
        if (sameParent.length >= 8) {
          throw new DelegationError("delegation_parallel_limit", "parent already owns the maximum eight delegations");
        }
        delegationId = input.context.randomUuid();
        revisionNumber = 1;
        base = null;
      } else {
        const selector = input.base;
        const candidates = session.delegations.revisions.filter((candidate) =>
          candidate.parentActorId === binding.parentActorId &&
          candidate.status === "draft" &&
          candidate.delegationRevision === selector.revision &&
          candidate.delegationSha256 === selector.sha256);
        if (candidates.length !== 1) {
          throw new DelegationError("delegation_revision_conflict", "delegation replacement base is stale or ambiguous");
        }
        base = candidates[0]!;
        if (sha256Canonical(base.binding) !== sha256Canonical(binding)) {
          throw new DelegationError("delegation_binding_stale", "delegation parent binding changed before replacement");
        }
        delegationId = base.delegationId;
        revisionNumber = base.delegationRevision + 1;
      }
      const content = {
        ...input.revision.content,
        delegationId,
        binding,
      };
      const identity = canonicalDelegationIdentity(content);
      const eventContent = delegationRevisionContentSchema.parse(identity.content);
      const duplicateSequence = session.delegations.revisions.some((candidate) =>
        candidate.parentActorId === binding.parentActorId &&
        candidate.delegationId !== delegationId &&
        candidate.content.sequence === identity.content.sequence);
      if (duplicateSequence) {
        throw new DelegationError("delegation_revision_conflict", "delegation sequence is already used by this parent");
      }
      const previewSha256 = this.previewAuthority(identity.content, session);
      if (!/^[a-f0-9]{64}$/u.test(previewSha256)) {
        throw new DelegationError("delegation_authority_expansion", "authority preview did not produce a canonical SHA-256");
      }
      const stored = await storeDelegationArtifactExact(
        input.context.workspace,
        input.context.sessionId,
        delegationId,
        identity.bytes,
        identity.delegationSha256,
      );
      const common = {
        artifact: stored,
        authority_preview_sha256: previewSha256,
        binding: eventBinding(binding),
        content: eventContent,
        delegation_id: delegationId,
        delegation_revision: revisionNumber,
        delegation_sha256: identity.delegationSha256,
        origin: taskUserOrigin(input.context),
        parent_actor_id: binding.parentActorId,
        parent_run_id: binding.parentRunId,
      };
      if (base === null) {
        await append("delegation.revision.proposed", common);
      } else {
        await append("delegation.revision.replaced", {
          ...common,
          base_revision: base.delegationRevision,
          base_sha256: base.delegationSha256,
        });
      }
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        delegation: exactRevision(next.delegations, delegationId, revisionNumber, identity.delegationSha256),
        projection: next.delegations,
      });
    });
  }

  async approve(input: {
    readonly context: TaskMutationContext;
    readonly delegationId: string;
    readonly revision: number;
    readonly sha256: string;
    readonly queue?: boolean;
  }): Promise<DelegationMutationResultV1> {
    return this.#decide({ ...input, decision: "approved" });
  }

  async reject(input: {
    readonly context: TaskMutationContext;
    readonly delegationId: string;
    readonly revision: number;
    readonly sha256: string;
    readonly reason?: string;
  }): Promise<DelegationMutationResultV1> {
    return this.#decide({ ...input, decision: "rejected", queue: false });
  }

  async #decide(input: {
    readonly context: TaskMutationContext;
    readonly decision: "approved" | "rejected";
    readonly delegationId: string;
    readonly revision: number;
    readonly sha256: string;
    readonly reason?: string;
    readonly queue?: boolean;
  }): Promise<DelegationMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const revision = exactRevision(session.delegations, input.delegationId, input.revision, input.sha256);
      const already = input.decision === "approved"
        ? ["approved", "queued", "active", "waiting_approval", "reconciling", "receipt_ready", "accepted"].includes(revision.status)
        : revision.status === "rejected";
      if (already) {
        return Object.freeze({ deduplicated: true, delegation: revision, projection: session.delegations });
      }
      if (revision.status !== "draft") {
        throw new DelegationError("delegation_decision_mismatch", "delegation decision conflicts with the current revision status");
      }
      const current = resolveDelegationParentBinding(session, revision.parentRunId);
      if (sha256Canonical(current) !== sha256Canonical(revision.binding)) {
        throw new DelegationError("delegation_binding_stale", "delegation parent binding is no longer current");
      }
      if (input.decision === "approved") assertGraphDelegationAdmissionOpen(session, revision.binding);
      await verifyDelegationRevisionArtifact(input.context.workspace, input.context.sessionId, revision);
      const display = {
        authority_preview_sha256: revision.authorityPreviewSha256,
        budget: revision.content.budget,
        context: revision.content.contextRequest,
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        expected_receipt: revision.content.expectedReceipt,
        kind: "delegation_approval_display_v1",
        model: revision.content.model,
        objective: revision.content.objective,
        title: revision.content.title,
        tools_and_capabilities: revision.content.authorityRequest,
        workspace: revision.content.workspace,
      };
      const displayBytes = Buffer.from(canonicalJson(display), "utf8");
      const displaySha256 = sha256Canonical(display);
      const displayArtifact = await storeDelegationArtifactExact(
        input.context.workspace,
        input.context.sessionId,
        revision.delegationId,
        displayBytes,
        displaySha256,
      );
      const decisionRequestId = input.context.randomUuid();
      await append("delegation.decision.recorded", {
        approval_identity_sha256: delegationApprovalIdentity({
          approvalRequestId: decisionRequestId,
          binding: revision.binding,
          delegationId: revision.delegationId,
          delegationRevision: revision.delegationRevision,
          delegationSha256: revision.delegationSha256,
          displaySha256,
        }),
        authority_preview_sha256: revision.authorityPreviewSha256,
        decision: input.decision,
        decision_request_id: decisionRequestId,
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        display_artifact: displayArtifact,
        origin: taskUserOrigin(input.context),
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        revision_event_id: revision.createdEventId,
      });
      if (input.decision === "approved" && input.queue === true) {
        await append("delegation.queued", {
          delegation_id: revision.delegationId,
          delegation_revision: revision.delegationRevision,
          delegation_sha256: revision.delegationSha256,
          origin: taskUserOrigin(input.context),
          parent_actor_id: revision.parentActorId,
          parent_run_id: revision.parentRunId,
          queue_request_id: input.context.randomUuid(),
        });
      }
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        delegation: exactRevision(next.delegations, revision.delegationId, revision.delegationRevision, revision.delegationSha256),
        projection: next.delegations,
      });
    });
  }

  async cancel(input: {
    readonly context: TaskMutationContext;
    readonly delegationId: string;
    readonly reason: string;
  }): Promise<DelegationMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const candidates = session.delegations.revisions.filter((candidate) =>
        candidate.delegationId === input.delegationId &&
        !["superseded", "rejected"].includes(candidate.status));
      const revision = candidates.at(-1);
      if (revision === undefined) {
        throw new DelegationError("delegation_revision_conflict", "delegation cancellation target is unknown");
      }
      if (["cancelled", "failed", "blocked", "stale", "accepted"].includes(revision.status)) {
        return Object.freeze({ deduplicated: true, delegation: revision, projection: session.delegations });
      }
      await append("delegation.cancel.requested", {
        cancel_request_id: input.context.randomUuid(),
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        origin: taskUserOrigin(input.context),
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        reason: input.reason,
        root_event_id: null,
      });
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        delegation: exactRevision(next.delegations, revision.delegationId, revision.delegationRevision, revision.delegationSha256),
        projection: next.delegations,
      });
    }, {
      // PHASE21: delegation.cancel is a safety-reducing request, not a new
      // effect or a terminal claim. It must remain admissible across the exact
      // unresolved child effect that it is intended to stop; the active owner
      // and reconciler still require durable cancellation/cleanup evidence
      // before reporting a terminal outcome.
      allowUnresolvedEffectsForCancellation: true,
    });
  }

  async enqueue(input: {
    readonly context: TaskMutationContext;
    readonly delegationId: string;
  }): Promise<DelegationMutationResultV1> {
    return this.#withLocked(input.context, async ({ append, session, writer }) => {
      const revision = [...session.delegations.revisions].reverse().find((candidate) =>
        candidate.delegationId === input.delegationId && !["superseded", "rejected"].includes(candidate.status));
      if (revision === undefined) {
        throw new DelegationError("delegation_revision_conflict", "delegation enqueue target is unknown");
      }
      if (["queued", "active", "waiting_approval", "reconciling", "receipt_ready", "accepted"].includes(revision.status)) {
        return Object.freeze({ deduplicated: true, delegation: revision, projection: session.delegations });
      }
      if (revision.status !== "approved") {
        throw new DelegationError("delegation_revision_conflict", "only an approved delegation can be queued");
      }
      assertGraphDelegationAdmissionOpen(session, revision.binding);
      await append("delegation.queued", {
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        origin: taskUserOrigin(input.context),
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        queue_request_id: input.context.randomUuid(),
      });
      const next = reconstructMultiRunSession(writer.events);
      return Object.freeze({
        deduplicated: false,
        delegation: exactRevision(next.delegations, revision.delegationId, revision.delegationRevision, revision.delegationSha256),
        projection: next.delegations,
      });
    });
  }
}
