import { sha256Canonical } from "../../completion/canonical-json.js";
import type { TaskGraphBudgetV1 } from "../../task-graph/task-graph-schema.js";
import type { DelegationAuthorityDecisionV1 } from "../delegable-authority.js";
import { DelegationError } from "../delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "../delegation-projector.js";
import type { ContextCapsuleV1 } from "./context-capsule-schema.js";
import { delegationAuthorityRequestPreviewIdentity } from "../delegation-identity.js";
import type { ChildEnvironmentPolicyV1 } from "./child-environment-policy.js";
import type { ChildToolProfileV1 } from "./child-tool-profile.js";
import {
  createBudgetReservationPlan,
  createDelegationModelEnvelope,
  createPreparedChildEnvelope,
  type PreparedChildEnvelopeV1,
} from "./child-envelope-schema.js";

type NumericBudgetKey = Exclude<keyof TaskGraphBudgetV1, "maxReportedTokens">;

function minimumBudget(values: readonly TaskGraphBudgetV1[]): TaskGraphBudgetV1 {
  const numeric = (key: NumericBudgetKey) => Math.min(...values.map((value) => value[key]));
  const tokens = values.map((value) => value.maxReportedTokens).filter((value): value is number => value !== null);
  return Object.freeze({
    maxAttempts: numeric("maxAttempts"),
    maxDurationMs: numeric("maxDurationMs"),
    maxModelSteps: numeric("maxModelSteps"),
    maxCommandExecutions: numeric("maxCommandExecutions"),
    maxCommandOutputBytes: numeric("maxCommandOutputBytes"),
    maxChangedFiles: numeric("maxChangedFiles"),
    maxChangedBytes: numeric("maxChangedBytes"),
    maxArtifactBytes: numeric("maxArtifactBytes"),
    maxReportedTokens: tokens.length === 0 ? null : Math.min(...tokens),
  });
}

export interface BuildPreparedChildEnvelopeInputV1 {
  readonly approvedDelegation: DelegationRevisionProjectionV1;
  readonly actor: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly attemptNumber: 1 | 2;
  };
  readonly capsule: ContextCapsuleV1;
  readonly capsuleRef: string;
  readonly authority: DelegationAuthorityDecisionV1;
  readonly toolProfile: ChildToolProfileV1;
  readonly capabilitySnapshot: { readonly ref: string; readonly sha256: string };
  readonly model: {
    readonly executionBackend?: "provider" | "canonical_fake";
    readonly policyProfileId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly qualificationId: string;
    readonly qualificationSha256: string;
    readonly contextCapacity: number | null;
    readonly networkEligibility: "local_only" | "remote_explicit";
  };
  readonly budget: {
    readonly parentLedgerRevision: number;
    readonly graphLedgerRevision: number | null;
    readonly parentRemaining: TaskGraphBudgetV1;
    readonly graphRemaining: TaskGraphBudgetV1 | null;
  };
  readonly environmentPolicy: ChildEnvironmentPolicyV1;
  readonly parentProjectionSha256: string;
  readonly policySha256: string;
  readonly preparedAt: string;
  readonly systemAndResponseReserveBytes: number;
}

export class ChildEnvelopeBuilder {
  build(input: BuildPreparedChildEnvelopeInputV1): PreparedChildEnvelopeV1 {
    const delegation = input.approvedDelegation;
    if (!["approved", "queued"].includes(delegation.status) || !input.authority.eligible) {
      throw new DelegationError("delegation_authority_expansion", "prepared envelope requires an approved delegation and eligible strict authority intersection");
    }
    if (
      delegationAuthorityRequestPreviewIdentity(delegation.content) !== delegation.authorityPreviewSha256 ||
      input.authority.effectiveTaskProfile !== delegation.content.authorityRequest.taskProfile ||
      input.authority.effectiveWorkspaceMode !== delegation.content.workspace.mode ||
      sha256Canonical([...input.authority.effectiveCapabilityIds].sort()) !== sha256Canonical([...delegation.content.authorityRequest.capabilityIds].sort()) ||
      input.toolProfile.profileSha256 === "" ||
      sha256Canonical([...input.toolProfile.toolIds].sort()) !== sha256Canonical([...input.authority.effectiveToolIds].sort())
    ) {
      throw new DelegationError("delegation_authority_expansion", "current effective authority differs from the approved authority preview");
    }
    if (
      input.capsule.delegationSha256 !== delegation.delegationSha256 ||
      input.capsule.childActorId !== input.actor.actorId ||
      input.capsule.workspace.lineageId !== delegation.binding.parentWorkspaceLineageId
    ) {
      throw new DelegationError("delegation_context_unavailable", "context capsule identity does not match the planned child actor");
    }
    if (
      input.model.contextCapacity !== null &&
      Buffer.byteLength(JSON.stringify(input.capsule), "utf8") + input.systemAndResponseReserveBytes > input.model.contextCapacity
    ) {
      throw new DelegationError("delegation_context_too_large", "capsule and delegated system reserve exceed exact model context capacity");
    }
    const budgetPlan = createBudgetReservationPlan({
      parentBudgetLedgerRevision: input.budget.parentLedgerRevision,
      graphBudgetLedgerRevision: input.budget.graphLedgerRevision,
      ceiling: minimumBudget([
        delegation.content.budget,
        input.authority.effectiveBudget,
        input.budget.parentRemaining,
        ...(input.budget.graphRemaining === null ? [] : [input.budget.graphRemaining]),
      ]),
    });
    const model = createDelegationModelEnvelope({
      ...input.model,
      executionBackend: input.model.executionBackend ?? "provider",
      delegatedToolProfileSha256: input.toolProfile.profileSha256,
    });
    const approvalNamespace = sha256Canonical({
      actor_id: input.actor.actorId,
      attempt_id: input.actor.attemptId,
      attempt_number: input.actor.attemptNumber,
      delegation_id: delegation.delegationId,
      delegation_revision: delegation.delegationRevision,
      delegation_sha256: delegation.delegationSha256,
      kind: "delegated_child_approval_namespace_v1",
      workspace: input.capsule.workspace,
    });
    // PHASE20: this artifact is intentionally non-executable. Live budget CAS,
    // operation identity, and a fresh staleness check belong to 20C launch.
    return createPreparedChildEnvelope({
      schemaVersion: 1,
      actor: {
        actorKind: "delegated_child",
        actorId: input.actor.actorId,
        delegationId: delegation.delegationId,
        delegationRevision: delegation.delegationRevision,
        delegationSha256: delegation.delegationSha256,
        attemptId: input.actor.attemptId,
        attemptNumber: input.actor.attemptNumber,
        parentActorId: delegation.parentActorId,
        parentRunId: delegation.parentRunId,
      },
      contextCapsuleRef: input.capsuleRef,
      contextCapsuleSha256: input.capsule.capsuleSha256,
      effectiveAuthority: {
        taskProfile: input.authority.effectiveTaskProfile!,
        toolIds: input.authority.effectiveToolIds,
        capabilitySnapshotRef: input.capabilitySnapshot.ref,
        capabilitySnapshotSha256: input.capabilitySnapshot.sha256,
      },
      model,
      budgetReservationPlan: budgetPlan,
      workspace: {
        logicalWorkspaceId: input.capsule.workspace.logicalWorkspaceId,
        lineageId: input.capsule.workspace.lineageId,
        mode: input.capsule.workspace.mode,
        sourceSnapshotSha256: input.capsule.repository.sourceSnapshotSha256,
        declaredPathPrefixes: input.capsule.workspace.declaredPathPrefixes,
      },
      approvalNamespace,
      environmentPolicy: input.environmentPolicy,
      preparation: {
        executable: false,
        preparedAt: input.preparedAt,
        parentProjectionSha256: input.parentProjectionSha256,
        policySha256: input.policySha256,
        toolProfileSha256: input.toolProfile.profileSha256,
        budgetPlanSha256: budgetPlan.planSha256,
      },
    });
  }
}
