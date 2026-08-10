import type { ExecutableChildEnvelopeV1 } from "../runtime/executable-child-envelope.js";
import type { DelegationRevisionProjectionV1 } from "../delegation-projector.js";
import { DelegationError } from "../delegation-errors.js";
import {
  childReceiptEvidenceSchema,
  createChildReceipt,
  type ChildReceiptBudgetUsageV1,
  type ChildReceiptClaimV1,
  type ChildReceiptEvidenceV1,
  type ChildReceiptV1,
} from "./child-receipt-schema.js";

export interface CandidateChildReceiptClaimV1 {
  readonly claimId: string;
  readonly kind: "answer" | "file_observation" | "symbol_observation" | "change_bundle" | "verification_result";
  readonly narrative: string;
  readonly evidence: readonly ChildReceiptEvidenceV1[];
}

export interface ChildReceiptEvidenceVerifierV1 {
  verify(input: {
    readonly claim: CandidateChildReceiptClaimV1;
    readonly evidence: ChildReceiptEvidenceV1;
    readonly sourceSnapshotSha256: string;
    readonly logicalWorkspaceId: string;
  }): Promise<"verified" | "unverified" | "stale">;
}

export interface BuildChildReceiptInputV1 {
  readonly delegation: DelegationRevisionProjectionV1;
  readonly envelope: ExecutableChildEnvelopeV1;
  readonly runTerminal: "succeeded" | "known_failed" | "blocked" | "cancelled";
  readonly terminalEventId: string;
  readonly summary: string;
  readonly candidateClaims: readonly CandidateChildReceiptClaimV1[];
  readonly evidenceVerifier: ChildReceiptEvidenceVerifierV1;
  readonly workspace: {
    readonly logicalWorkspaceId: string;
    readonly sourceSnapshotSha256: string;
    readonly resultSnapshotSha256: string | null;
    readonly changeBundleRef: string | null;
    readonly changeBundleSha256: string | null;
  };
  readonly verificationGenerationIds: readonly string[];
  readonly unresolvedEffects: readonly string[];
  readonly budgetUsage: ChildReceiptBudgetUsageV1;
}

export class ChildReceiptBuilder {
  async build(input: BuildChildReceiptInputV1): Promise<ChildReceiptV1> {
    const actor = input.envelope.prepared.actor;
    if (
      actor.delegationId !== input.delegation.delegationId ||
      actor.delegationRevision !== input.delegation.delegationRevision ||
      actor.delegationSha256 !== input.delegation.delegationSha256 ||
      input.envelope.execution.sessionId !== input.delegation.binding.sessionId ||
      input.workspace.logicalWorkspaceId !== input.envelope.prepared.workspace.logicalWorkspaceId ||
      input.workspace.sourceSnapshotSha256 !== input.envelope.prepared.workspace.sourceSnapshotSha256
    ) {
      throw new DelegationError("delegation_receipt_invalid", "receipt inputs do not share one exact delegation/envelope/workspace lineage");
    }
    const expected = new Map(input.delegation.content.expectedReceipt.requiredClaims.map((claim) => [claim.claimId, claim]));
    const candidates = new Map<string, CandidateChildReceiptClaimV1>();
    for (const candidate of input.candidateClaims) {
      const contract = expected.get(candidate.claimId);
      if (contract === undefined || contract.kind !== candidate.kind || candidates.has(candidate.claimId)) continue;
      candidates.set(candidate.claimId, candidate);
    }
    const claims: ChildReceiptClaimV1[] = [];
    for (const contract of input.delegation.content.expectedReceipt.requiredClaims) {
      const candidate = candidates.get(contract.claimId);
      if (candidate === undefined) continue;
      const evidence = candidate.evidence.slice(0, 16).map((value) => childReceiptEvidenceSchema.parse(value));
      const observations = await Promise.all(evidence.map((value) => input.evidenceVerifier.verify({
        claim: candidate,
        evidence: value,
        sourceSnapshotSha256: input.workspace.sourceSnapshotSha256,
        logicalWorkspaceId: input.workspace.logicalWorkspaceId,
      })));
      const status = observations.length === 0 || observations.some((value) => value === "unverified")
        ? "unverified" as const
        : observations.some((value) => value === "stale")
          ? "stale" as const
          : "verified" as const;
      claims.push({
        claimId: candidate.claimId,
        kind: candidate.kind,
        status,
        narrative: candidate.narrative,
        evidence,
      });
    }
    const requiredSatisfied = input.delegation.content.expectedReceipt.requiredClaims
      .filter((claim) => claim.required)
      .every((contract) => claims.some((claim) => claim.claimId === contract.claimId && claim.status === "verified"));
    let status: ChildReceiptV1["status"];
    if (input.unresolvedEffects.length > 0 || input.runTerminal === "blocked") status = "blocked";
    else if (input.runTerminal === "cancelled") status = "cancelled";
    else if (input.runTerminal === "known_failed" || !requiredSatisfied) status = "failed";
    else status = "succeeded";
    // PHASE20: model narrative can nominate bounded claims, but only Host
    // evidence verification and durable terminal/effect facts decide success.
    return createChildReceipt({
      schemaVersion: 1,
      delegationId: input.delegation.delegationId,
      delegationRevision: input.delegation.delegationRevision,
      delegationSha256: input.delegation.delegationSha256,
      childActorId: actor.actorId,
      childAttemptId: actor.attemptId,
      status,
      summary: input.summary,
      claims,
      workspace: input.workspace,
      verificationGenerationIds: [...input.verificationGenerationIds],
      unresolvedEffects: [...input.unresolvedEffects],
      budgetUsage: input.budgetUsage,
      terminalEventId: input.terminalEventId,
    });
  }
}
