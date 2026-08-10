import { ArtifactStore } from "../../artifacts/artifact-store.js";
import { ArtifactError } from "../../artifacts/artifact-types.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { DelegationError } from "../delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "../delegation-projector.js";
import { childReceiptSchema, type ChildReceiptV1 } from "./child-receipt-schema.js";

export async function readVerifiedChildReceipt(input: {
  readonly workspace: string;
  readonly sessionId: string;
  readonly revision: DelegationRevisionProjectionV1;
}): Promise<ChildReceiptV1> {
  const projected = input.revision.receipt;
  if (projected === null) {
    throw new DelegationError("delegation_receipt_invalid", "delegation has no projected receipt");
  }
  try {
    const stored = await (await ArtifactStore.create({ sessionId: input.sessionId, workspace: input.workspace }))
      .readVerified(projected.artifact.artifactId);
    const receipt = childReceiptSchema.parse(parseStrictJson(stored.bytes.toString("utf8")));
    if (
      receipt.receiptSha256 !== projected.sha256 ||
      receipt.delegationId !== input.revision.delegationId ||
      receipt.delegationRevision !== input.revision.delegationRevision ||
      receipt.delegationSha256 !== input.revision.delegationSha256 ||
      receipt.status !== projected.status ||
      stored.metadata.sha256 !== projected.artifact.sha256 ||
      stored.metadata.bytes !== projected.artifact.bytes
    ) {
      throw new DelegationError("delegation_receipt_invalid", "receipt artifact does not match durable delegation facts");
    }
    const required = new Set(input.revision.content.expectedReceipt.requiredClaims
      .filter((claim) => claim.required).map((claim) => claim.claimId));
    if (receipt.status === "succeeded" && [...required].some((id) =>
      !receipt.claims.some((claim) => claim.claimId === id && claim.status === "verified"))) {
      throw new DelegationError("delegation_receipt_invalid", "succeeded receipt is missing a verified required claim");
    }
    return Object.freeze(receipt);
  } catch (error) {
    if (error instanceof DelegationError) throw error;
    if (error instanceof ArtifactError) {
      throw new DelegationError("delegation_artifact_invalid", "receipt artifact is missing or corrupt", { cause: error });
    }
    throw new DelegationError("delegation_receipt_invalid", "receipt artifact is not strict canonical data", { cause: error });
  }
}
