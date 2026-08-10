import { randomUUID } from "node:crypto";

import { createCapabilitySnapshot } from "../../capabilities/capability-snapshot.js";
import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { EventPublisher } from "../../events/event-publisher.js";
import { RepositorySourceSnapshotter } from "../../repository-intelligence/source-snapshotter.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import type { TaskGraphBudgetV1 } from "../../task-graph/task-graph-schema.js";
import { NodeGitWorktreePort } from "../../worktrees/git-worktree-port.js";
import { computeDelegationAuthority, delegationAuthorityCeiling } from "../delegable-authority.js";
import { storeDelegationArtifactExact } from "../delegation-control-plane.js";
import { DelegationError } from "../delegation-errors.js";
import {
  canonicalDelegationIdentity,
  delegationApprovalIdentity,
  delegationAuthorityRequestPreviewIdentity,
  delegationWorkspaceLineageIdentity,
} from "../delegation-identity.js";
import {
  delegationRevisionContentSchema,
  normalizeDelegationRevision,
} from "../delegation-schema.js";
import { ChildEnvelopeBuilder } from "../context/child-envelope-builder.js";
import { buildChildEnvironmentPolicy } from "../context/child-environment-policy.js";
import { buildChildToolProfile } from "../context/child-tool-profile.js";
import { createContextCapsule } from "../context/context-capsule-schema.js";
import { delegatedBuiltinToolCatalog } from "../context/delegated-tool-catalog.js";
import {
  PHASE20_CANONICAL_FAKE_MODEL_ID,
  PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID,
  PHASE20_CANONICAL_FAKE_PROVIDER_ID,
  PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
} from "./canonical-fake-child-backend.js";

const FIXTURE_ID = "m11-controlled-subagents-v1" as const;
const CAPSULE_LIMIT_BYTES = 32 * 1024;

function fixtureBudget(): TaskGraphBudgetV1 {
  return Object.freeze({
    maxArtifactBytes: 64 * 1024,
    maxAttempts: 1,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 30_000,
    maxModelSteps: 2,
    maxReportedTokens: 256,
  });
}

function exactArtifact(value: unknown): { readonly bytes: Buffer; readonly sha256: string } {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return Object.freeze({ bytes, sha256: sha256Canonical(value) });
}

export interface CanonicalPhase20FixtureInputV1 {
  readonly count?: 1 | 2;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly randomUuid?: () => string;
  readonly timestamp?: () => string;
  readonly workspace: string;
}

export interface CanonicalPhase20FixtureResultV1 {
  readonly schemaVersion: 1;
  readonly fixtureId: typeof FIXTURE_ID;
  readonly sessionId: string;
  readonly parentRunId: string;
  readonly repositoryId: string;
  readonly sourceSnapshotSha256: string;
  readonly delegationIds: readonly string[];
  readonly envelopeSha256s: readonly string[];
  readonly networkRequired: false;
  readonly remoteProvidersAllowed: false;
}

/**
 * Create the package-owned, offline M11 fixture at the exact queued/prepared
 * boundary. The regular CLI still owns launch, process handshakes, receipts,
 * and scheduling; this helper never creates a child or bypasses those gates.
 */
export async function createCanonicalPhase20Fixture(
  input: CanonicalPhase20FixtureInputV1,
): Promise<CanonicalPhase20FixtureResultV1> {
  const count = input.count ?? 2;
  const randomUuid = input.randomUuid ?? randomUUID;
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const sessionId = randomUuid();
  const parentRunId = randomUuid();
  const goalId = randomUuid();
  const planId = randomUuid();
  const snapshot = await (
    await RepositorySourceSnapshotter.create(input.workspace, { environment })
  ).snapshot();
  const sourceSnapshotSha256 = snapshot.snapshot.sourceStateSha256;
  const repository = await new NodeGitWorktreePort({ environment }).observe(input.workspace);
  const parentWorkspaceLineageId = delegationWorkspaceLineageIdentity({
    parentRunId,
    repositoryIdentity: repository.identity.repositoryId,
    sourceStateSha256: sourceSnapshotSha256,
    workspaceFingerprint: null,
  });
  const budget = fixtureBudget();
  const capabilitySnapshot = await createCapabilitySnapshot({
    catalog: {
      diagnostics: [],
      enablementRevision: 0,
      plugins: [],
      sourceRevisions: { builtin: 0, user_install: 0, workspace: 0 },
    },
    platform,
    timestamp: timestamp(),
    workspace: input.workspace,
  });
  const capabilityArtifactContent = exactArtifact(capabilitySnapshot);
  const capabilityArtifact = await storeDelegationArtifactExact(
    input.workspace,
    sessionId,
    parentRunId,
    capabilityArtifactContent.bytes,
    capabilityArtifactContent.sha256,
  );
  const writer = await V2SessionWriter.createNew(input.workspace, sessionId, {
    createEventId: randomUuid,
    timestamp,
  });
  const delegationIds: string[] = [];
  const envelopeSha256s: string[] = [];
  try {
    const parentPublisher = new EventPublisher({
      randomUUID: randomUuid,
      renderer: { render: () => undefined },
      runId: parentRunId,
      sessionId,
      timestamp,
      writer,
    });
    await parentPublisher.publish({
      data: {
        command: "chat",
        input: {
          role: "user",
          text: "Prepare the package-owned controlled-subagent contract fixture.",
        },
        model: PHASE20_CANONICAL_FAKE_MODEL_ID,
        provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
        timeout_ms: 1_000,
        workspace: input.workspace,
      },
      type: "run.started",
    });
    await parentPublisher.publish({
      data: {
        adapter: "bornagent-phase20-canonical-fixture-parent",
        adapter_version: "phase20-v1",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "none",
          usage: "complete",
        },
        config_fingerprint: PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
        model: PHASE20_CANONICAL_FAKE_MODEL_ID,
        provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    await parentPublisher.publish({
      data: { delta: "Canonical parent fixture prepared." },
      type: "text.delta",
    });
    await parentPublisher.publish({
      data: { duration_ms: 1, output_chars: 34 },
      type: "run.completed",
    });
    for (let index = 0; index < count; index += 1) {
      const delegationId = randomUuid();
      const content = normalizeDelegationRevision({
        schemaVersion: 1,
        sequence: index + 1,
        title: `Canonical read-only child ${String(index + 1)}`,
        objective: `Return the bounded Phase 20 contract result for fixture child ${String(index + 1)}.`,
        expectedReceipt: {
          kind: "analysis",
          requiredClaims: [{
            claimId: "answer",
            kind: "answer",
            description: "A Host-verifiable bounded answer artifact",
            required: true,
          }],
        },
        contextRequest: {
          includeGoal: true,
          includeApprovedPlanItems: [],
          includeParentFacts: [],
          requestedPaths: ["src"],
          maximumCapsuleBytes: CAPSULE_LIMIT_BYTES,
        },
        authorityRequest: {
          taskProfile: "read-only",
          toolIds: [],
          capabilityIds: [],
        },
        budget,
        workspace: {
          mode: "origin_read_only",
          sourceSnapshotSha256,
          managedWorkspaceId: null,
          declaredPathPrefixes: ["src"],
        },
        model: {
          strategy: "exact_qualified_model",
          exactProfileId: PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID,
          exactProviderId: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
          exactModelId: PHASE20_CANONICAL_FAKE_MODEL_ID,
        },
        retry: { maxAttempts: 1, automaticOn: [] },
        delegationId,
        binding: {
          sessionId,
          parentRunId,
          parentActorId: parentRunId,
          goalId,
          goalRevision: 1,
          planId,
          planRevision: 1,
          planSha256: sha256Canonical({ fixtureId: FIXTURE_ID, kind: "approved_plan" }),
          graphId: null,
          graphRevision: null,
          graphSha256: null,
          nodeId: null,
          nodeAttemptId: null,
          parentWorkspaceLineageId,
        },
      });
      const identity = canonicalDelegationIdentity(content);
      const revisionArtifact = await storeDelegationArtifactExact(
        input.workspace,
        sessionId,
        delegationId,
        identity.bytes,
        identity.delegationSha256,
      );
      const proposed = await writer.appendDelegationEvent("delegation.revision.proposed", {
        artifact: revisionArtifact,
        authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
        binding: content.binding,
        content: delegationRevisionContentSchema.parse(content),
        delegation_id: delegationId,
        delegation_revision: 1,
        delegation_sha256: identity.delegationSha256,
        origin: { input_surface: "cli", kind: "user" },
        parent_actor_id: parentRunId,
        parent_run_id: parentRunId,
      });
      const display = exactArtifact({
        schemaVersion: 1,
        fixtureId: FIXTURE_ID,
        delegationId,
        delegationSha256: identity.delegationSha256,
        authorityPreviewSha256: delegationAuthorityRequestPreviewIdentity(content),
      });
      const displayArtifact = await storeDelegationArtifactExact(
        input.workspace,
        sessionId,
        delegationId,
        display.bytes,
        display.sha256,
      );
      const decisionRequestId = randomUuid();
      await writer.appendDelegationEvent("delegation.decision.recorded", {
        approval_identity_sha256: delegationApprovalIdentity({
          approvalRequestId: decisionRequestId,
          binding: content.binding,
          delegationId,
          delegationRevision: 1,
          delegationSha256: identity.delegationSha256,
          displaySha256: display.sha256,
        }),
        authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
        decision: "approved",
        decision_request_id: decisionRequestId,
        delegation_id: delegationId,
        delegation_revision: 1,
        delegation_sha256: identity.delegationSha256,
        display_artifact: displayArtifact,
        origin: { input_surface: "cli", kind: "user" },
        parent_actor_id: parentRunId,
        parent_run_id: parentRunId,
        revision_event_id: proposed.eventId,
      });
      await writer.appendDelegationEvent("delegation.queued", {
        delegation_id: delegationId,
        delegation_revision: 1,
        delegation_sha256: identity.delegationSha256,
        origin: { input_surface: "cli", kind: "user" },
        parent_actor_id: parentRunId,
        parent_run_id: parentRunId,
        queue_request_id: randomUuid(),
      });
      const approved = reconstructMultiRunSession(writer.events).delegations.revisions.find(
        (candidate) => candidate.delegationId === delegationId,
      );
      if (approved === undefined || approved.status !== "queued") {
        throw new DelegationError(
          "delegation_revision_conflict",
          "canonical fixture could not project its exact queued revision",
        );
      }
      const toolProfile = buildChildToolProfile({
        taskProfile: "read-only",
        requestedToolIds: [],
        policyToolIds: [],
        parentDelegableToolIds: [],
        catalog: delegatedBuiltinToolCatalog(),
      });
      const ceiling = delegationAuthorityCeiling({
        taskProfiles: ["read-only"],
        toolIds: [],
        capabilityIds: [],
        modelProfileIds: [PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID],
        workspaceModes: ["origin_read_only"],
        maximumBudget: budget,
        maximumContextBytes: CAPSULE_LIMIT_BYTES,
        maximumAttempts: 1,
      });
      const authority = computeDelegationAuthority({
        request: content.authorityRequest,
        workspace: content.workspace,
        requestedBudget: budget,
        requestedContextBytes: CAPSULE_LIMIT_BYTES,
        requestedMaximumAttempts: 1,
        requestedModelProfileId: PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID,
        ceilings: [ceiling],
      });
      if (!authority.eligible) {
        throw new DelegationError(
          "delegation_authority_expansion",
          "canonical fixture authority intersection unexpectedly failed",
        );
      }
      const actorId = randomUuid();
      const attemptId = randomUuid();
      const capsule = createContextCapsule({
        schemaVersion: 1,
        childActorId: actorId,
        delegationId,
        delegationRevision: 1,
        delegationSha256: identity.delegationSha256,
        objective: content.objective,
        expectedReceipt: content.expectedReceipt,
        goal: {
          goalId,
          revision: 1,
          objective: "Prove the packaged controlled-subagent contract without network access.",
          constraints: ["No remote provider requests", "No workspace mutation"],
        },
        planItems: [],
        facts: [],
        repository: {
          repositoryId: repository.identity.repositoryId,
          sourceSnapshotSha256,
          ruleManifestRef: null,
          ruleManifestSha256: null,
          indexGenerationId: null,
          indexSourceSnapshotSha256: null,
        },
        workspace: {
          logicalWorkspaceId: repository.identity.repositoryId,
          lineageId: parentWorkspaceLineageId,
          mode: "origin_read_only",
          baselineSha256: sourceSnapshotSha256,
          declaredPathPrefixes: ["src"],
        },
        constraints: {
          taskProfile: "read-only",
          toolIds: [],
          capabilityIds: [],
          maximumBudget: budget,
          delegationDepth: 1,
        },
        omittedFacts: [],
      }, CAPSULE_LIMIT_BYTES);
      const capsuleContent = exactArtifact(capsule);
      const capsuleArtifact = await storeDelegationArtifactExact(
        input.workspace,
        sessionId,
        delegationId,
        capsuleContent.bytes,
        capsuleContent.sha256,
      );
      const envelope = new ChildEnvelopeBuilder().build({
        approvedDelegation: approved,
        actor: { actorId, attemptId, attemptNumber: 1 },
        capsule,
        capsuleRef: capsuleArtifact.object_ref,
        authority,
        toolProfile,
        capabilitySnapshot: {
          ref: capabilityArtifact.object_ref,
          sha256: capabilityArtifact.sha256,
        },
        model: {
          executionBackend: "canonical_fake",
          policyProfileId: PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID,
          providerId: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
          modelId: PHASE20_CANONICAL_FAKE_MODEL_ID,
          qualificationId: `qualification:${PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256}`,
          qualificationSha256: PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
          contextCapacity: 32 * 1024,
          networkEligibility: "local_only",
        },
        budget: {
          parentLedgerRevision: 0,
          graphLedgerRevision: null,
          parentRemaining: budget,
          graphRemaining: null,
        },
        environmentPolicy: buildChildEnvironmentPolicy({ requestedVariableNames: [] }),
        parentProjectionSha256: sha256Canonical({
          fixtureId: FIXTURE_ID,
          sessionEventCount: writer.events.length,
        }),
        policySha256: sha256Canonical({
          fixtureId: FIXTURE_ID,
          policyProfileId: PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID,
        }),
        preparedAt: timestamp(),
        systemAndResponseReserveBytes: 8 * 1024,
      });
      const envelopeContent = exactArtifact(envelope);
      const envelopeArtifact = await storeDelegationArtifactExact(
        input.workspace,
        sessionId,
        delegationId,
        envelopeContent.bytes,
        envelopeContent.sha256,
      );
      await writer.appendDelegationEvent("delegation.envelope.prepared", {
        context_capsule_artifact: capsuleArtifact,
        context_capsule_sha256: capsule.capsuleSha256,
        delegation_id: delegationId,
        delegation_revision: 1,
        delegation_sha256: identity.delegationSha256,
        envelope_artifact: envelopeArtifact,
        envelope_sha256: envelope.envelopeSha256,
        executable: false,
        parent_actor_id: parentRunId,
        parent_run_id: parentRunId,
      });
      delegationIds.push(delegationId);
      envelopeSha256s.push(envelope.envelopeSha256);
    }
  } finally {
    await writer.close();
  }
  return Object.freeze({
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    sessionId,
    parentRunId,
    repositoryId: repository.identity.repositoryId,
    sourceSnapshotSha256,
    delegationIds: Object.freeze(delegationIds),
    envelopeSha256s: Object.freeze(envelopeSha256s),
    networkRequired: false,
    remoteProvidersAllowed: false,
  });
}
