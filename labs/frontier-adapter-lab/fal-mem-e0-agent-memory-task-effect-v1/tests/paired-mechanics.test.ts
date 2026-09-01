import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMemE0Fixture } from "../src/fixture.js";
import {
  memE0MechanicsReceiptSchema,
  parseMemE0MechanicsReceipt,
} from "../src/receipt.js";
import { runMemE0OfflineMechanics } from "../src/runner.js";

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

describe("FAL MEM-E0 full paired offline mechanics", () => {
  it("runs all four pairs through eight arms without promoting deterministic mechanics to live effect", async () => {
    const repositoryRoot = resolve(".");
    const fixture = await loadMemE0Fixture(repositoryRoot);
    const receipt = await runMemE0OfflineMechanics(repositoryRoot);

    expect(receipt.claims.structuralMechanics).toEqual({
      reasonCode: "all_pairs_eligible_expected_outcomes_observed",
      result: "supported",
    });
    expect(receipt.claims.liveEffect).toEqual({
      reasonCode: "deterministic_mechanics_only",
      result: "not_run",
    });
    expect(receipt.effectClaimAllowed).toBe(false);
    expect(receipt.providerCalls).toBe(0);
    expect(receipt.aggregate).toMatchObject({
      armCount: 8,
      eligibleArmCount: 8,
      eligiblePairCount: 4,
      harmControlPairCount: 1,
      memoryDependentPairCount: 3,
      outcomeCounts: {
        baselineOnlyRegression: 0,
        bothFail: 0,
        bothPass: 1,
        candidateOnlyWin: 3,
        inconclusiveInvalidPair: 0,
      },
      pairCount: 4,
    });
    expect(receipt.pairs).toHaveLength(4);
    expect(receipt.pairs.filter((pair) => pair.outcome === "candidate_only_win"))
      .toHaveLength(3);
    expect(receipt.pairs.filter((pair) => pair.outcome === "both_pass"))
      .toHaveLength(1);
    expect(receipt.pairs.every((pair) =>
      pair.eligible &&
      pair.distinctOsProcesses &&
      pair.productPathObserved &&
      pair.sameLogicalMemory &&
      pair.off.eligible &&
      pair.on.eligible
    )).toBe(true);

    const serialized = JSON.stringify(receipt);
    const decoded = JSON.parse(serialized) as unknown;
    expect(memE0MechanicsReceiptSchema.parse(decoded)).toEqual(receipt);
    expect(parseMemE0MechanicsReceipt(decoded)).toEqual(receipt);
    expect(JSON.stringify(parseMemE0MechanicsReceipt(decoded))).toBe(serialized);

    for (const forbiddenField of [
      "childPid",
      "processId",
      "workspace",
      "stateRoot",
      "apiKey",
      "DEEPSEEK_API_KEY",
      "authorizationHeader",
      "rawMemory",
      "rawTask",
      "rawValue",
      "providerOutput",
    ]) {
      expect(serialized, forbiddenField).not.toContain(`"${forbiddenField}"`);
    }
    expect(serialized).not.toContain(repositoryRoot);
    expect(serialized).not.toMatch(/\b[A-Za-z]:[\\/]/u);
    expect(serialized).not.toMatch(/(?:\/Users\/|\/home\/)[^\s"]+/u);
    expect(serialized).not.toMatch(/\bBearer\s+[A-Za-z0-9._~-]+/iu);
    expect(serialized).not.toMatch(/\bsk-[A-Za-z0-9_-]{12,}\b/u);

    for (const loadedCase of fixture.cases) {
      for (const absolutePath of [
        loadedCase.directory,
        loadedCase.hiddenVerifierPath,
        loadedCase.publicRoot,
      ]) {
        expect(serialized, absolutePath).not.toContain(absolutePath);
      }
      for (const rawValue of [
        loadedCase.definition.task.text,
        loadedCase.definition.memory.recordText,
        loadedCase.definition.memory.requiredAcceptanceValue,
      ]) {
        expect(serialized, loadedCase.definition.caseId)
          .not.toContain(jsonStringFragment(rawValue));
      }
    }
  }, 600_000);
});
