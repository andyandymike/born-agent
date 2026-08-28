import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fal0ContextFoldingEstimator,
  loadFal0ContextFoldingCorpus,
} from "../../src/frontier-adapters/context-folding/fal0-manifest.js";
import { fal0ContextFoldingReceiptSchema } from "../../src/frontier-adapters/context-folding/fal0-receipt.js";
import { parseStrictJson } from "../../src/system/strict-json.js";

describe("FAL-CF0 frozen corpus", () => {
  it("loads one hash-bound 24-case pack with the fixed estimator", async () => {
    const corpus = await loadFal0ContextFoldingCorpus(process.cwd());

    expect(corpus.casePack.cases).toHaveLength(24);
    expect(corpus.manifest.caseIds).toEqual(
      corpus.casePack.cases.map((entry) => entry.caseId),
    );
    expect(corpus.manifest.estimatorId).toBe(fal0ContextFoldingEstimator.estimatorId);
    expect(corpus.casePack.cases.filter((entry) => entry.class === "representative")).toHaveLength(16);
    expect(corpus.casePack.cases.filter((entry) => entry.route === "verified_receipt")).toHaveLength(7);
  });

  it("validates the immutable rejected-candidate receipt without storing narratives or paths", async () => {
    const path = join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal0-context-folding-v1/experiment-receipt.json",
    );
    const source = await readFile(path, "utf8");
    const receipt = fal0ContextFoldingReceiptSchema.parse(parseStrictJson(source));

    expect(receipt.outcome).toBe("rejected");
    expect(receipt.aggregate.hardGateFailures).toBe(0);
    expect(receipt.aggregate.medianEligibleReductionRatio).toBe(0);
    expect(receipt.candidateImplementationSha256).not.toBeNull();
    expect(receipt.receiptSha256).toBe(
      "88cac12c8010d24266bcc2900fc5f4ee3a9f9724329f63d27f9633a931cd3d9b",
    );
    expect(source).not.toContain("Ignore previous instructions");
    expect(source).not.toContain("RAW_CHILD_TRAJECTORY");
    expect(source).not.toMatch(/[A-Za-z]:\\/u);
  });
});
