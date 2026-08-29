import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCf2Lab } from "../runner/run-cf2.js";
import { cf2ReceiptSchema } from "../src/experiment-schema.js";

function rawSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("CF2 lab-only mechanical runner", () => {
  it("verifies mechanics while keeping product-fit inconclusive", async () => {
    const first = await runCf2Lab({ repositoryRoot: process.cwd() });
    const second = await runCf2Lab({
      actualFocusedMinutes: 99,
      repositoryRoot: process.cwd(),
    });

    expect(cf2ReceiptSchema.parse(first.receipt)).toEqual(first.receipt);
    expect(first.receipt.receiptSha256).toBe(second.receipt.receiptSha256);
    expect(first.receipt.implementationFidelity).toBe("verified");
    expect(first.receipt.evidenceValidity).toBe("limited");
    expect(first.receipt.productFit).toBe("inconclusive");
    expect(first.receipt.promotion).toBe("blocked");
    expect(first.receipt.candidateLifecycle).toBe("retained_disabled");
    expect(first.receipt.aggregate).toMatchObject({
      mechanicalCases: 20,
      mechanicalFailures: 0,
      verifiedRouteCases: 7,
      securityCases: 5,
      candidateInvocations: 14,
      naturalisticTraceCount: 0,
      modelQualityTaskCount: 0,
    });
    expect(first.receipt.cases.every((entry) => entry.status === "pass")).toBe(true);
    expect(first.receipt.cases.filter((entry) =>
      entry.candidateSelected === true).map((entry) => entry.caseId)).toEqual([
        "generated-two-duplicate",
        "verified-multi-duplicate",
      ]);
  });

  it("keeps every fallback byte-equivalent and never calls model/tool/network", async () => {
    const run = await runCf2Lab({ repositoryRoot: process.cwd() });
    for (const result of run.receipt.cases) {
      if (result.candidateSelected !== true) {
        expect(result.selectedProviderContextSha256).toBe(
          result.baselineProviderContextSha256,
        );
      }
      expect(result.modelCalls).toBe(0);
      expect(result.toolCalls).toBe(0);
      expect(result.networkCalls).toBe(0);
    }
    for (const caseId of [
      "security-wrong-goal-binding",
      "security-unaccepted-receipt",
      "security-unverified-stale",
      "security-forged-receipt-hash",
    ]) {
      expect(run.receipt.cases.find((entry) => entry.caseId === caseId))
        .toMatchObject({ candidateInvoked: false, candidateSelected: null, status: "pass" });
    }
  });

  it("retains the candidate source unchanged after execution", async () => {
    const candidatePath = join(
      process.cwd(),
      "labs/frontier-adapter-lab/fal-cf2-context-folding-v2/src/context-fold.ts",
    );
    const before = rawSha256(await readFile(candidatePath));
    await runCf2Lab({ repositoryRoot: process.cwd() });
    const after = rawSha256(await readFile(candidatePath));
    expect(after).toBe(before);
  });

  it("rebuilds the stored packed receipt byte-for-byte", async () => {
    const receiptPath = join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal-cf2-context-folding-v2/experiment-receipt.json",
    );
    const storedBytes = await readFile(receiptPath, "utf8");
    const stored = cf2ReceiptSchema.parse(JSON.parse(storedBytes));
    const regenerated = await runCf2Lab({
      repositoryRoot: process.cwd(),
    });

    expect(regenerated.receipt).toEqual(stored);
    expect(`${JSON.stringify(regenerated.receipt, null, 2)}\n`).toBe(storedBytes);
  });
});
