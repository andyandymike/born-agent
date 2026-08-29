import { readFile } from "node:fs/promises";

import { emR1PassageInput, emR1QueryInput, type LocalEmbeddingPort } from "./local-e5-provider.js";

interface ExpectedAnchor {
  readonly anchorId: string;
  readonly passage: string;
  readonly query: string;
  readonly expected: {
    readonly cosine: number;
    readonly passageNorm: number;
    readonly passageTokenization: {
      readonly attentionMask: readonly number[];
      readonly inputIds: readonly number[];
    };
    readonly passageVector: readonly number[];
    readonly queryNorm: number;
    readonly queryTokenization: {
      readonly attentionMask: readonly number[];
      readonly inputIds: readonly number[];
    };
    readonly queryVector: readonly number[];
  };
}

interface FrozenAnchorFile {
  readonly anchors: readonly ExpectedAnchor[];
  readonly modelArtifactManifestSha256: string;
  readonly status: "frozen_reimplementation_reference";
  readonly tolerance: {
    readonly cosineAbsolute: number;
    readonly normAbsolute: number;
    readonly vectorAbsolute: number;
  };
}

export interface AnchorVerificationResult {
  readonly anchorsChecked: number;
  readonly failedAnchors: readonly string[];
  readonly maximumCosineDifference: number;
  readonly maximumNormDifference: number;
  readonly maximumVectorDifference: number;
  readonly modelManifestMatched: boolean;
  readonly status: "passed" | "failed";
  readonly tokenizationMismatches: number;
}

function maximumDifference(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(Number(left[index]) - Number(right[index])));
  }
  return maximum;
}

function exact(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index]! * right[index]!;
  return total;
}

export async function verifyReferenceAnchors(input: Readonly<{
  readonly anchorPath: string;
  readonly provider: LocalEmbeddingPort;
}>): Promise<AnchorVerificationResult> {
  const frozen = JSON.parse(await readFile(input.anchorPath, "utf8")) as FrozenAnchorFile;
  if (frozen.status !== "frozen_reimplementation_reference") {
    throw new Error("EM-R1 reference anchors are not frozen");
  }
  let maximumCosineDifference = 0;
  let maximumNormDifference = 0;
  let maximumVectorDifference = 0;
  let tokenizationMismatches = 0;
  const failedAnchors: string[] = [];
  for (const anchor of frozen.anchors) {
    const queryInput = emR1QueryInput(anchor.query);
    const passageInput = emR1PassageInput(anchor.passage, anchor.passage);
    const embedded = await input.provider.embed([queryInput, passageInput]);
    const queryVector = embedded.vectors[0];
    const passageVector = embedded.vectors[1];
    if (queryVector === undefined || passageVector === undefined) {
      failedAnchors.push(anchor.anchorId);
      continue;
    }
    const queryTokens = input.provider.tokenize(queryInput);
    const passageTokens = input.provider.tokenize(passageInput);
    const tokenizationMatches =
      exact(queryTokens.inputIds, anchor.expected.queryTokenization.inputIds) &&
      exact(queryTokens.attentionMask, anchor.expected.queryTokenization.attentionMask) &&
      exact(passageTokens.inputIds, anchor.expected.passageTokenization.inputIds) &&
      exact(passageTokens.attentionMask, anchor.expected.passageTokenization.attentionMask);
    if (!tokenizationMatches) tokenizationMismatches += 1;
    const vectorDifference = Math.max(
      maximumDifference(queryVector, anchor.expected.queryVector),
      maximumDifference(passageVector, anchor.expected.passageVector),
    );
    const queryNorm = Math.sqrt(dot(queryVector, queryVector));
    const passageNorm = Math.sqrt(dot(passageVector, passageVector));
    const normDifference = Math.max(
      Math.abs(queryNorm - anchor.expected.queryNorm),
      Math.abs(passageNorm - anchor.expected.passageNorm),
    );
    const cosineDifference = Math.abs(
      dot(queryVector, passageVector) - anchor.expected.cosine,
    );
    maximumVectorDifference = Math.max(maximumVectorDifference, vectorDifference);
    maximumNormDifference = Math.max(maximumNormDifference, normDifference);
    maximumCosineDifference = Math.max(maximumCosineDifference, cosineDifference);
    if (
      !tokenizationMatches ||
      vectorDifference > frozen.tolerance.vectorAbsolute ||
      normDifference > frozen.tolerance.normAbsolute ||
      cosineDifference > frozen.tolerance.cosineAbsolute
    ) failedAnchors.push(anchor.anchorId);
  }
  const modelManifestMatched = frozen.modelArtifactManifestSha256 ===
    input.provider.modelArtifactManifestSha256;
  return Object.freeze({
    anchorsChecked: frozen.anchors.length,
    failedAnchors: Object.freeze(failedAnchors),
    maximumCosineDifference,
    maximumNormDifference,
    maximumVectorDifference,
    modelManifestMatched,
    status: failedAnchors.length === 0 && modelManifestMatched ? "passed" : "failed",
    tokenizationMismatches,
  });
}
