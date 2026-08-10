import type { DelegationProjectionV1 } from "../delegation-projector.js";
import { readVerifiedChildReceipt } from "./child-receipt-verifier.js";

export interface AcceptedChildReceiptContextItemV1 {
  readonly kind: "accepted_child_receipt";
  readonly delegationId: string;
  readonly childAttemptId: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled";
  readonly objective: string;
  readonly verifiedClaims: readonly {
    readonly claimId: string;
    readonly kind: string;
    readonly narrative: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly changeBundleRef: string | null;
  readonly verificationGenerationIds: readonly string[];
  readonly receiptSha256: string;
}

export async function projectAcceptedChildReceipts(input: {
  readonly workspace: string;
  readonly sessionId: string;
  readonly projection: DelegationProjectionV1;
  readonly parentActorId?: string;
  readonly goalBinding?: {
    readonly goalId: string;
    readonly goalRevision: number;
    readonly planId: string;
    readonly planRevision: number;
    readonly planSha256: string;
  };
}): Promise<readonly AcceptedChildReceiptContextItemV1[]> {
  const accepted = input.projection.revisions.filter((revision) =>
    revision.status === "accepted" &&
    revision.receipt?.acceptedEventId !== null &&
    (input.parentActorId === undefined || revision.parentActorId === input.parentActorId) &&
    (input.goalBinding === undefined || (
      revision.binding.goalId === input.goalBinding.goalId &&
      revision.binding.goalRevision === input.goalBinding.goalRevision &&
      revision.binding.planId === input.goalBinding.planId &&
      revision.binding.planRevision === input.goalBinding.planRevision &&
      revision.binding.planSha256 === input.goalBinding.planSha256)))
    .sort((left, right) =>
      left.content.sequence - right.content.sequence ||
      left.delegationId.localeCompare(right.delegationId, "en"));
  const result: AcceptedChildReceiptContextItemV1[] = [];
  for (const revision of accepted) {
    const receipt = await readVerifiedChildReceipt({
      workspace: input.workspace,
      sessionId: input.sessionId,
      revision,
    });
    result.push(Object.freeze({
      kind: "accepted_child_receipt",
      delegationId: receipt.delegationId,
      childAttemptId: receipt.childAttemptId,
      status: receipt.status,
      objective: revision.content.objective,
      verifiedClaims: Object.freeze(receipt.claims.filter((claim) => claim.status === "verified").map((claim) => Object.freeze({
        claimId: claim.claimId,
        kind: claim.kind,
        narrative: claim.narrative,
        evidenceRefs: Object.freeze(claim.evidence.map((evidence) => evidence.artifactRef)),
      }))),
      changeBundleRef: receipt.workspace.changeBundleRef,
      verificationGenerationIds: Object.freeze([...receipt.verificationGenerationIds]),
      receiptSha256: receipt.receiptSha256,
    }));
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024) {
      throw new Error("accepted child receipt context exceeds the 64 KiB parent projection limit");
    }
  }
  return Object.freeze(result);
}
