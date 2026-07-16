import type { PreparedExecution } from "../execution/execution-types.js";
import { matchTrustedPhase7NodeFixture } from "../permissions/trusted-local-fixture-manifest.js";
import type { PreparedVerificationClassification } from "../completion/phase7-completion-runtime.js";

export async function classifyTrustedFixtureVerification(
  prepared: PreparedExecution,
): Promise<PreparedVerificationClassification | null> {
  const review = matchTrustedPhase7NodeFixture(prepared.actionIdentity);
  if (review?.verificationKind === undefined) return null;
  const inputPaths = review.requiredFileHashes
    .map((entry) => entry.canonicalPath)
    .filter((path) => !path.startsWith("@bornagent/"));
  // PHASE7: Eligibility comes from the same content-bound local review that
  // authorized execution; argv wording alone cannot turn arbitrary exit 0 into proof.
  return Object.freeze({
    inputPaths: Object.freeze(inputPaths),
    kind: review.verificationKind,
  });
}
