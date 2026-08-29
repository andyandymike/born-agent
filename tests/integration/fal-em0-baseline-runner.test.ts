import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runFalEm0Baseline } from "../../src/frontier-adapters/local-embedding/fal-em0-baseline-runner.js";

describe("FAL-EM0 live lexical baseline characterization", () => {
  it("passes all 36 cases and opens EM1 only for the frozen semantic gap", async () => {
    const first = await runFalEm0Baseline({ repositoryRoot: process.cwd() });
    const tracked = JSON.parse(await readFile(join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/experiment-receipt.json",
    ), "utf8")) as {
      readonly baseline: { readonly implementationSha256: string };
      readonly manifestSha256: string;
      readonly outcome: string;
    };

    expect(first.receipt.cases).toHaveLength(36);
    expect(first.receipt.cases.every((entry) => entry.status === "pass")).toBe(true);
    expect(first.receipt.aggregate).toMatchObject({
      calibrationCases: 8,
      evaluationCases: 28,
      hardGateFailures: 0,
      securityLeaks: 0,
      vectorAddedForbiddenHits: 0,
      fallbackMismatches: 0,
    });
    expect(first.candidatePermitted).toBe(true);
    expect(first.receipt.outcome).toBe("inconclusive");
    expect(first.receipt.baseline.semanticRecallAt5).toBe(0);
    expect(first.receipt.baseline.semanticMrrAt5).toBe(0);
    expect(first.receipt.baseline.entryGateReasons).toEqual([
      "semantic_recall_below_75_percent",
      "at_least_five_semantic_top5_misses",
      "misses_have_no_literal_term_overlap",
    ]);
    expect(first.receipt.candidate).toBeNull();
    expect(first.receipt.cases.every((entry) =>
      entry.cost.localQueryEmbeddingCalls === 0 &&
      entry.cost.localRecordEmbeddingCalls === 0 &&
      entry.cost.remoteModelCalls === 0 &&
      entry.cost.toolCalls === 0 &&
      entry.cost.networkCallsDuringSearch === 0)).toBe(true);
    expect(tracked.outcome).toBe("rejected");
    expect(first.receipt.manifestSha256).toBe(tracked.manifestSha256);
    expect(first.receipt.baseline.implementationSha256).toBe(
      tracked.baseline.implementationSha256,
    );
  });

  it("keeps exact and phrase controls while filtering scope, source, and lifecycle hazards", async () => {
    const run = await runFalEm0Baseline({ repositoryRoot: process.cwd() });
    const byId = new Map(run.receipt.cases.map((entry) => [entry.caseId, entry]));

    expect(byId.get("control-exact-record")?.baseline.queryKind).toBe("exact_id");
    expect(byId.get("control-exact-record")?.correctness.requiredTop1).toBe(true);
    expect(byId.get("control-quoted-phrase")?.baseline.queryKind).toBe("quoted_phrase");
    expect(byId.get("control-quoted-phrase")?.correctness.requiredTop1).toBe(true);
    for (const id of [
      "security-wrong-repository",
      "security-wrong-principal",
      "security-stale-source",
      "security-tampered-source",
      "security-retracted-record",
    ]) {
      expect(byId.get(id)?.baseline.abstained, id).toBe(true);
      expect(byId.get(id)?.correctness.forbiddenTop5Count, id).toBe(0);
      expect(byId.get(id)?.correctness.scopeExact, id).toBe(true);
      expect(byId.get(id)?.correctness.sourceFresh, id).toBe(true);
    }
    for (const id of [
      "temporal-deployment-region",
      "temporal-verification-command",
      "temporal-release-channel",
      "temporal-cache-policy",
    ]) {
      expect(byId.get(id)?.correctness.requiredTop1, id).toBe(true);
      expect(byId.get(id)?.correctness.forbiddenTop5Count, id).toBe(0);
      expect(byId.get(id)?.correctness.actionParameterSupported, id).toBe(true);
    }
  });
});
