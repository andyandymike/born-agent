import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { TaskStateProjection } from "../../coordination/task-state-types.js";
import type { TaskGraphBudgetV1 } from "../../task-graph/task-graph-schema.js";
import { DelegationError } from "../delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "../delegation-projector.js";
import { MAX_DELEGATION_CAPSULE_BYTES } from "../delegation-schema.js";
import {
  contextCapsuleFactSchema,
  createContextCapsule,
  type ContextCapsuleFactV1,
  type ContextCapsuleV1,
} from "./context-capsule-schema.js";

export type ContextFactOmissionReasonV1 =
  | "artifact_missing"
  | "hash_mismatch"
  | "index_stale"
  | "path_denied"
  | "sensitive"
  | "source_stale"
  | "too_large"
  | "unsupported_kind"
  | "unverified";

export type ContextFactReadResultV1 =
  | { readonly kind: "available"; readonly fact: ContextCapsuleFactV1 }
  | { readonly kind: "omitted"; readonly reason: ContextFactOmissionReasonV1 };

export interface ContextFactReaderV1 {
  read(request: DelegationRevisionProjectionV1["content"]["contextRequest"]["includeParentFacts"][number]):
    Promise<ContextFactReadResultV1>;
}

export interface BuildContextCapsuleInputV1 {
  readonly approvedDelegation: DelegationRevisionProjectionV1;
  readonly childActorId: string;
  readonly taskProjection: TaskStateProjection;
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
  readonly effectiveAuthority: {
    readonly taskProfile: "read-only" | "coding";
    readonly toolIds: readonly string[];
    readonly capabilityIds: readonly string[];
    readonly maximumBudget: TaskGraphBudgetV1;
  };
  readonly runtimeMaximumBytes: number;
}

function omissionRef(ref: string): string {
  return sha256Canonical({ kind: "omitted_context_ref_v1", ref });
}

function priority(kind: string): number {
  switch (kind) {
    case "receipt": return 0;
    case "repository_snapshot": return 1;
    case "rule_manifest": return 2;
    default: return 3;
  }
}

export class ContextCapsuleBuilder {
  async build(input: BuildContextCapsuleInputV1): Promise<ContextCapsuleV1> {
    const delegation = input.approvedDelegation;
    if (!["approved", "queued"].includes(delegation.status) || delegation.decisionEventId === null) {
      throw new DelegationError("delegation_revision_conflict", "context requires an exact approved delegation");
    }
    if (
      input.repository.sourceSnapshotSha256 !== delegation.content.workspace.sourceSnapshotSha256 ||
      input.workspace.baselineSha256 !== delegation.content.workspace.sourceSnapshotSha256 ||
      input.workspace.mode !== delegation.content.workspace.mode ||
      input.workspace.lineageId !== delegation.binding.parentWorkspaceLineageId
    ) {
      throw new DelegationError("delegation_binding_stale", "workspace or source snapshot changed before context freeze");
    }
    const goal = input.taskProjection.goals.find((candidate) =>
      candidate.content.goalId === delegation.binding.goalId &&
      candidate.content.revision === delegation.binding.goalRevision &&
      candidate.status === "active");
    const plan = input.taskProjection.plans.find((candidate) =>
      candidate.content.planId === delegation.binding.planId &&
      candidate.content.revision === delegation.binding.planRevision &&
      candidate.planSha256 === delegation.binding.planSha256 &&
      candidate.status === "active");
    if (goal === undefined || plan === undefined) {
      throw new DelegationError("delegation_binding_stale", "Goal or approved Plan is no longer current");
    }
    const planItems = delegation.content.contextRequest.includeApprovedPlanItems.map((id) => {
      const item = plan.items.find((candidate) => candidate.content.id === id);
      if (item === undefined) {
        throw new DelegationError("delegation_context_unavailable", `approved Plan item ${id} is unavailable`);
      }
      return Object.freeze({
        planItemId: id,
        statusAtFreeze: item.status,
        title: item.content.title,
      });
    });
    const maximumBytes = Math.min(
      input.runtimeMaximumBytes,
      delegation.content.contextRequest.maximumCapsuleBytes,
      MAX_DELEGATION_CAPSULE_BYTES,
    );
    if (maximumBytes < 16 * 1024) {
      throw new DelegationError("delegation_context_too_large", "runtime delegated context limit is below the minimum capsule size");
    }
    const requests = [...delegation.content.contextRequest.includeParentFacts].sort((left, right) =>
      Number(right.required) - Number(left.required) ||
      priority(left.kind) - priority(right.kind) ||
      (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
    const facts: ContextCapsuleFactV1[] = [];
    const omittedFacts: { requestedRef: string; reasonCode: ContextFactOmissionReasonV1 }[] = [];

    const base = () => ({
      schemaVersion: 1 as const,
      childActorId: input.childActorId,
      delegationId: delegation.delegationId,
      delegationRevision: delegation.delegationRevision,
      delegationSha256: delegation.delegationSha256,
      objective: delegation.content.objective,
      expectedReceipt: delegation.content.expectedReceipt,
      goal: {
        goalId: goal.content.goalId,
        revision: goal.content.revision,
        objective: goal.content.objective,
        constraints: [] as string[],
      },
      planItems,
      facts,
      repository: input.repository,
      workspace: {
        ...input.workspace,
        declaredPathPrefixes: delegation.content.workspace.declaredPathPrefixes,
      },
      constraints: {
        taskProfile: input.effectiveAuthority.taskProfile,
        toolIds: [...input.effectiveAuthority.toolIds],
        capabilityIds: [...input.effectiveAuthority.capabilityIds],
        maximumBudget: input.effectiveAuthority.maximumBudget,
        delegationDepth: 1 as const,
      },
      omittedFacts,
    });

    if (Buffer.byteLength(canonicalJson({ ...base(), capsuleSha256: "0".repeat(64) }), "utf8") > maximumBytes) {
      throw new DelegationError("delegation_context_too_large", "required identity, Goal, Plan, and constraints exceed the capsule limit");
    }
    for (const request of requests) {
      let result: ContextFactReadResultV1;
      try {
        result = await input.factReader.read(request);
      } catch (error) {
        if (request.required) {
          throw new DelegationError("delegation_context_unavailable", "required parent fact reader failed", { cause: error });
        }
        result = { kind: "omitted", reason: "artifact_missing" };
      }
      if (result.kind === "omitted") {
        if (request.required) {
          throw new DelegationError("delegation_context_unavailable", `required parent fact is unavailable (${result.reason})`);
        }
        omittedFacts.push({ requestedRef: omissionRef(request.ref), reasonCode: result.reason });
        continue;
      }
      const fact = contextCapsuleFactSchema.parse(result.fact);
      if (fact.artifactSha256 !== request.sha256) {
        if (request.required) {
          throw new DelegationError("delegation_context_unavailable", "required parent fact hash does not match the approved request");
        }
        omittedFacts.push({ requestedRef: omissionRef(request.ref), reasonCode: "hash_mismatch" });
        continue;
      }
      facts.push(fact);
      const size = Buffer.byteLength(canonicalJson({ ...base(), capsuleSha256: "0".repeat(64) }), "utf8");
      if (size > maximumBytes) {
        facts.pop();
        if (request.required) {
          throw new DelegationError("delegation_context_too_large", "required parent facts exceed the capsule limit");
        }
        omittedFacts.push({ requestedRef: omissionRef(request.ref), reasonCode: "too_large" });
      }
    }
    // PHASE20: there is deliberately no transcript, environment, approval, or
    // model object input. Parent facts cross this boundary only through an
    // allowlisted, hash-bound projection.
    return createContextCapsule(base(), maximumBytes);
  }
}
