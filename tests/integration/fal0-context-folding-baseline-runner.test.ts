import { describe, expect, it } from "vitest";

import { runFal0ContextFoldingLab } from "../../src/frontier-adapters/context-folding/fal0-runner.js";

describe("FAL-CF0 production baseline characterization", () => {
  it("passes all 24 cases through static or real verified receipt routes", async () => {
    const first = await runFal0ContextFoldingLab({
      repositoryRoot: process.cwd(),
      mode: "baseline",
    });
    const second = await runFal0ContextFoldingLab({
      actualFocusedMinutes: 99,
      repositoryRoot: process.cwd(),
      mode: "baseline",
    });

    expect(first.receipt.cases).toHaveLength(24);
    expect(first.receipt.cases.every((entry) => entry.status === "pass")).toBe(true);
    expect(first.receipt.aggregate.hardGateFailures).toBe(0);
    expect(first.cf1Permitted).toBe(true);
    expect(first.cf1Reasons).toEqual([
      "four_representative_cases_over_512_tokens",
      "representative_duplicate_payload_at_least_20_percent",
    ]);
    expect(first.receipt.outcome).toBe("inconclusive");
    expect(first.receipt.candidateImplementationSha256).toBeNull();
    expect(first.receipt.cases.every((entry) => entry.candidate === null)).toBe(true);
    expect(second.receipt.receiptSha256).toBe(first.receipt.receiptSha256);
  });

  it("filters unsafe receipt inputs before parent context and keeps exact fallback", async () => {
    const run = await runFal0ContextFoldingLab({
      repositoryRoot: process.cwd(),
      mode: "baseline",
    });
    const byId = new Map(run.receipt.cases.map((entry) => [entry.caseId, entry]));

    for (const id of [
      "security-wrong-goal-binding",
      "security-unaccepted-receipt",
      "security-forged-receipt-hash",
    ]) {
      expect(byId.get(id)?.baseline.receiptCount).toBe(0);
      expect(byId.get(id)?.correctness.forbiddenFactsAbsent).toBe(true);
    }
    expect(byId.get("security-unverified-stale")?.baseline.verifiedClaimCount).toBe(0);
    expect(byId.get("security-adapter-fault-fallback")?.correctness.authorityEquivalent).toBe(true);
  });

  it("refuses to resurrect the rejected CF1 candidate", async () => {
    await expect(runFal0ContextFoldingLab({
      repositoryRoot: process.cwd(),
      mode: "compare",
    })).rejects.toThrow("candidate failed the representative net-benefit gate");
  });
});
