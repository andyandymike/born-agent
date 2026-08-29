import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LocalE5EmbeddingProvider, emR1PassageInput, emR1QueryInput } from "../src/local-e5-provider.js";

interface PendingAnchor {
  readonly anchorId: string;
  readonly expected: null;
  readonly passage: string;
  readonly query: string;
}

interface AnchorFile {
  readonly anchors: readonly PendingAnchor[];
  readonly experimentId: string;
  readonly provenance: string;
  readonly runtimeContract: Record<string, unknown>;
  readonly schemaVersion: 2;
  readonly status: string;
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index]! * right[index]!;
  return total;
}

function norm(vector: Float32Array): number {
  return Math.sqrt(dot(vector, vector));
}

export async function freezeReferenceAnchors(input: Readonly<{
  readonly fixtureDirectory: string;
  readonly labRoot: string;
}>): Promise<Record<string, unknown>> {
  const source = JSON.parse(await readFile(
    join(input.fixtureDirectory, "reference-anchors.json"),
    "utf8",
  )) as AnchorFile;
  if (source.status !== "inputs_frozen_outputs_pending") {
    throw new Error("EM-R1 anchors are not in the pending input-frozen state");
  }
  const loaded = await LocalE5EmbeddingProvider.load(input.labRoot);
  try {
    const frozen = [];
    for (const anchor of source.anchors) {
      const queryInput = emR1QueryInput(anchor.query);
      const passageInput = emR1PassageInput(anchor.passage, anchor.passage);
      const embedded = await loaded.provider.embed([queryInput, passageInput]);
      const queryVector = embedded.vectors[0];
      const passageVector = embedded.vectors[1];
      if (queryVector === undefined || passageVector === undefined) {
        throw new Error(`EM-R1 anchor ${anchor.anchorId} failed to embed`);
      }
      frozen.push({
        ...anchor,
        expected: {
          queryTokenization: loaded.provider.tokenize(queryInput),
          passageTokenization: loaded.provider.tokenize(passageInput),
          queryVector: Array.from(queryVector),
          passageVector: Array.from(passageVector),
          queryNorm: norm(queryVector),
          passageNorm: norm(passageVector),
          cosine: dot(queryVector, passageVector),
        },
      });
    }
    return {
      ...source,
      status: "frozen_reimplementation_reference",
      provenance: "self_frozen_reimplementation_reference_not_independent_historical_anchor",
      tolerance: {
        tokenIds: "exact",
        attentionMask: "exact",
        vectorAbsolute: 1e-6,
        normAbsolute: 1e-6,
        cosineAbsolute: 1e-6,
      },
      modelArtifactManifestSha256: loaded.provider.modelArtifactManifestSha256,
      reimplementationConfounded: loaded.reimplementationConfounded,
      anchors: frozen,
    };
  } finally {
    await loaded.provider.dispose();
  }
}
