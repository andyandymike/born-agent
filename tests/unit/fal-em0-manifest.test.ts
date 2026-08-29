import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FAL_EM0_CORPUS_CONTRACT,
  FAL_EM0_CORPUS_CONTRACT_SHA256,
  loadFalEm0Corpus,
} from "../../src/frontier-adapters/local-embedding/fal-em0-manifest.js";
import { falEm0ReceiptSchema } from "../../src/frontier-adapters/local-embedding/fal-em0-receipt.js";
import { parseStrictJson } from "../../src/system/strict-json.js";

describe("FAL-EM0 frozen retrieval corpus", () => {
  it("loads one hash-bound 36-case pack with the exact category and blind split contract", async () => {
    const corpus = await loadFalEm0Corpus(process.cwd());

    expect(corpus.casePack.cases).toHaveLength(36);
    expect(corpus.manifest.caseIds).toEqual(
      corpus.casePack.cases.map((entry) => entry.caseId),
    );
    expect(corpus.manifest.corpusContractSha256).toBe(FAL_EM0_CORPUS_CONTRACT_SHA256);
    expect(corpus.casePack.cases.filter((entry) => entry.split === "calibration")).toHaveLength(8);
    expect(corpus.casePack.cases.filter((entry) => entry.split === "evaluation")).toHaveLength(28);
    expect(corpus.casePack.cases.filter((entry) =>
      entry.expected.entryGateEligible)).toHaveLength(
        FAL_EM0_CORPUS_CONTRACT.evaluationSemanticCases,
      );
    expect(corpus.casePack.cases.filter((entry) =>
      entry.expected.actionParameter !== null)).toHaveLength(4);
    expect(corpus.casePack.cases.filter((entry) => entry.class === "security")).toHaveLength(6);
  });

  it("validates the tracked rejected EM1 receipt without retaining queries, records, vectors, or paths", async () => {
    const path = join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/experiment-receipt.json",
    );
    const source = await readFile(path, "utf8");
    const receipt = falEm0ReceiptSchema.parse(parseStrictJson(source));

    expect(receipt.outcome).toBe("rejected");
    expect(receipt.baseline.candidatePermitted).toBe(true);
    expect(receipt.aggregate.hardGateFailures).toBe(3);
    expect(receipt.aggregate.securityLeaks).toBe(0);
    expect(receipt.aggregate.vectorAddedForbiddenHits).toBe(0);
    expect(receipt.aggregate.fallbackMismatches).toBe(0);
    expect(receipt.candidate).toMatchObject({
      thresholdFrozenBeforeEvaluation: true,
      thresholdSimilarityMicros: 780_000,
      semanticRecallAt5: 1,
    });
    expect(receipt.cost).toMatchObject({
      modelArtifactBytes: 135_138_424,
      dependencyInstallDeltaBytes: 356_256_406,
      packedArtifactDeltaBytes: 18_305,
      vectorStoreBytesAt10000: 23_461_888,
    });
    expect(receipt.actualFocusedMinutes).toBe(60);
    expect(source).not.toContain("怎样确认安装包断网也能运行");
    expect(source).not.toContain("Historical approval bypass note");
    expect(source).not.toContain("model_int8.onnx");
    expect(source).not.toMatch(/[A-Za-z]:\\/u);
  });
});
