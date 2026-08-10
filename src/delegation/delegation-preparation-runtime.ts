import { ArtifactStore } from "../artifacts/artifact-store.js";
import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import type { DelegationAuthorityDecisionV1 } from "./delegable-authority.js";
import { DelegationError } from "./delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "./delegation-projector.js";
import {
  ChildEnvelopeBuilder,
  type BuildPreparedChildEnvelopeInputV1,
} from "./context/child-envelope-builder.js";
import type { ChildEnvironmentPolicyV1 } from "./context/child-environment-policy.js";
import type { ChildToolProfileV1 } from "./context/child-tool-profile.js";
import {
  ContextCapsuleBuilder,
  type ContextFactReaderV1,
} from "./context/context-capsule-builder.js";
import type { PreparedChildEnvelopeV1 } from "./context/child-envelope-schema.js";
import type { ContextCapsuleV1 } from "./context/context-capsule-schema.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

async function storeExact(input: {
  readonly workspace: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly value: unknown;
  readonly semanticSha256: string;
}) {
  const bytes = Buffer.from(canonicalJson(input.value), "utf8");
  const record = input.value !== null && typeof input.value === "object"
    ? input.value as Readonly<Record<string, unknown>>
    : null;
  const embeddedIdentity = record?.capsuleSha256 ?? record?.envelopeSha256;
  if (embeddedIdentity !== input.semanticSha256) {
    throw new DelegationError(
      "delegation_artifact_invalid",
      "prepared artifact semantic identity does not match its strict object",
    );
  }
  const store = await ArtifactStore.create({ sessionId: input.sessionId, workspace: input.workspace });
  const captured = await store.storeSanitizedText({ chunks: [bytes], maximumBytes: 512 * 1024, runId: input.runId });
  if (
    captured.captureStatus !== "complete" || captured.artifact === null ||
    captured.artifact.bytes !== bytes.byteLength
  ) {
    throw new DelegationError("delegation_artifact_invalid", "prepared delegation artifact could not be captured exactly");
  }
  await store.readVerified(captured.artifact.artifactId);
  return Object.freeze({
    artifact_id: captured.artifact.artifactId,
    bytes: captured.artifact.bytes,
    object_ref: captured.artifact.objectRef,
    sha256: captured.artifact.sha256,
  });
}

export interface PrepareDelegationInputV1 {
  readonly context: TaskMutationContext;
  readonly delegationId: string;
  readonly authority: DelegationAuthorityDecisionV1;
  readonly toolProfile: ChildToolProfileV1;
  readonly factReader: ContextFactReaderV1;
  readonly repository: {
    readonly repositoryId: string;
    readonly sourceSnapshotSha256: string;
    readonly ruleManifestRef: string | null;
    readonly ruleManifestSha256: string | null;
    readonly indexGenerationId: string | null;
    readonly indexSourceSnapshotSha256: string | null;
  };
  readonly workspace: {
    readonly logicalWorkspaceId: string;
    readonly lineageId: string;
    readonly mode: "origin_read_only" | "managed_worktree";
    readonly baselineSha256: string;
  };
  readonly runtimeMaximumContextBytes: number;
  readonly capabilitySnapshot: { readonly ref: string; readonly sha256: string };
  readonly model: BuildPreparedChildEnvelopeInputV1["model"];
  readonly budget: {
    readonly parentLedgerRevision: number;
    readonly graphLedgerRevision: number | null;
    readonly parentRemaining: TaskGraphBudgetV1;
    readonly graphRemaining: TaskGraphBudgetV1 | null;
  };
  readonly environmentPolicy: ChildEnvironmentPolicyV1;
  readonly policySha256: string;
  readonly systemAndResponseReserveBytes: number;
}

export interface PreparedDelegationResultV1 {
  readonly capsule: ContextCapsuleV1;
  readonly envelope: PreparedChildEnvelopeV1;
  readonly delegation: DelegationRevisionProjectionV1;
}

export class DelegationPreparationRuntime {
  constructor(private readonly writerFactory: TaskMutationWriterFactory = defaultWriterFactory) {}

  async prepare(input: PrepareDelegationInputV1): Promise<PreparedDelegationResultV1> {
    const writer = await this.writerFactory(input.context);
    try {
      const session = reconstructMultiRunSession(writer.events);
      const delegation = session.delegations.revisions.find((candidate) =>
        candidate.delegationId === input.delegationId && ["approved", "queued"].includes(candidate.status));
      if (delegation === undefined || delegation.envelope !== null) {
        throw new DelegationError("delegation_revision_conflict", "delegation is not an unprepared exact approved revision");
      }
      const actorId = input.context.randomUuid();
      const attemptId = input.context.randomUuid();
      const capsule = await new ContextCapsuleBuilder().build({
        approvedDelegation: delegation,
        childActorId: actorId,
        taskProjection: session.taskState,
        factReader: input.factReader,
        repository: input.repository,
        workspace: input.workspace,
        effectiveAuthority: {
          taskProfile: input.authority.effectiveTaskProfile ?? (() => { throw new DelegationError("delegation_authority_expansion", "effective task profile is absent"); })(),
          toolIds: input.authority.effectiveToolIds,
          capabilityIds: input.authority.effectiveCapabilityIds,
          maximumBudget: input.authority.effectiveBudget,
        },
        runtimeMaximumBytes: input.runtimeMaximumContextBytes,
      });
      const capsuleArtifact = await storeExact({
        workspace: input.context.workspace,
        sessionId: input.context.sessionId,
        runId: delegation.delegationId,
        value: capsule,
        semanticSha256: capsule.capsuleSha256,
      });
      const envelope = new ChildEnvelopeBuilder().build({
        approvedDelegation: delegation,
        actor: { actorId, attemptId, attemptNumber: 1 },
        capsule,
        capsuleRef: capsuleArtifact.object_ref,
        authority: input.authority,
        toolProfile: input.toolProfile,
        capabilitySnapshot: input.capabilitySnapshot,
        model: input.model,
        budget: input.budget,
        environmentPolicy: input.environmentPolicy,
        parentProjectionSha256: sha256CanonicalProjection(session),
        policySha256: input.policySha256,
        preparedAt: input.context.now(),
        systemAndResponseReserveBytes: input.systemAndResponseReserveBytes,
      });
      const envelopeArtifact = await storeExact({
        workspace: input.context.workspace,
        sessionId: input.context.sessionId,
        runId: delegation.delegationId,
        value: envelope,
        semanticSha256: envelope.envelopeSha256,
      });
      await writer.appendDelegationEvent("delegation.envelope.prepared", {
        context_capsule_artifact: capsuleArtifact,
        context_capsule_sha256: capsule.capsuleSha256,
        delegation_id: delegation.delegationId,
        delegation_revision: delegation.delegationRevision,
        delegation_sha256: delegation.delegationSha256,
        envelope_artifact: envelopeArtifact,
        envelope_sha256: envelope.envelopeSha256,
        executable: false,
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
      });
      const next = reconstructMultiRunSession(writer.events);
      const projected = next.delegations.revisions.find((candidate) =>
        candidate.delegationId === delegation.delegationId && candidate.delegationRevision === delegation.delegationRevision)!;
      return Object.freeze({ capsule, envelope, delegation: projected });
    } finally {
      await writer.close();
    }
  }
}

function sha256CanonicalProjection(session: ReturnType<typeof reconstructMultiRunSession>): string {
  return importProjectionHash({
    delegation: session.delegations,
    taskGraph: session.taskGraph,
    taskState: session.taskState,
    worktrees: session.worktrees,
  });
}

function importProjectionHash(value: unknown): string {
  // Kept local to avoid making the complete mutable session object part of an
  // envelope. Only stable projector outputs enter the parent projection hash.
  return sha256Canonical(value);
}
