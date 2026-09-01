import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  MEM_E0_CASE_IDS,
  type MemE0CaseId,
} from "../src/fixture.js";
import {
  createMemE0MechanicsReceipt,
  parseMemE0MechanicsReceipt,
  scoreMemE0MechanicsPairs,
  type MemE0MechanicsArmEvidenceInput,
  type MemE0MechanicsPairInput,
  type MemE0MechanicsReceipt,
} from "../src/receipt.js";

function hash(label: string): string {
  return sha256Canonical(label);
}

function hashes(...labels: readonly string[]): readonly string[] {
  return labels.map(hash).sort();
}

function arm(input: Readonly<{
  readonly armContractObserved?: boolean;
  readonly caseId: MemE0CaseId;
  readonly freshVerifierPassed: boolean;
  readonly historicalItemCount: 0 | 1;
  readonly label: "off" | "on";
}>): MemE0MechanicsArmEvidenceInput {
  const admittedRecordIdSha256 = hash(`${input.caseId}:${input.label}:admitted-record-id`);
  const toolNames = input.freshVerifierPassed
    ? ["apply_patch", "finish_task", "read_file", "run_command"] as const
    : [] as const;
  return Object.freeze({
    admittedRecordIdSha256,
    admittedRecordLogicalSha256: hash(`${input.caseId}:logical-memory`),
    armContractObserved: input.armContractObserved ?? true,
    freshVerifierPassed: input.freshVerifierPassed,
    historicalItemCount: input.historicalItemCount,
    observationSha256s: hashes(
      `${input.caseId}:${input.label}:actor-observation`,
      `${input.caseId}:${input.label}:fresh-verifier-observation`,
    ),
    productPathObserved: true,
    selectedMemoryValueSha256s: input.historicalItemCount === 1
      ? hashes(`${input.caseId}:selected-memory-value`)
      : [],
    selectedRecordIdSha256s: input.historicalItemCount === 1
      ? [admittedRecordIdSha256]
      : [],
    toolArgumentSha256s: input.freshVerifierPassed
      ? hashes(
          `${input.caseId}:${input.label}:finish-arguments`,
          `${input.caseId}:${input.label}:patch-arguments`,
          `${input.caseId}:${input.label}:read-arguments`,
          `${input.caseId}:${input.label}:verify-arguments`,
        )
      : [],
    toolNames,
  });
}

function validPairs(): readonly MemE0MechanicsPairInput[] {
  return Object.freeze(MEM_E0_CASE_IDS.map((caseId) => {
    const harmControl = caseId === "mem-e0-harm-control";
    return Object.freeze({
      caseClass: harmControl ? "harm_control" as const : "memory_dependent" as const,
      caseId,
      distinctOsProcesses: true,
      off: arm({
        caseId,
        freshVerifierPassed: harmControl,
        historicalItemCount: 0,
        label: "off",
      }),
      on: arm({
        caseId,
        freshVerifierPassed: true,
        historicalItemCount: harmControl ? 0 : 1,
        label: "on",
      }),
      processBoundaryObservationSha256: hash(`${caseId}:process-boundary`),
    });
  }));
}

function createReceipt(pairs = validPairs()): MemE0MechanicsReceipt {
  return createMemE0MechanicsReceipt({
    implementationSha256s: hashes("actor-source", "receipt-source", "runner-source"),
    pairs,
    protocolSha256: hash("frozen-protocol"),
  });
}

function reseal(value: Record<string, unknown>): void {
  const content = { ...value };
  delete content.receiptSha256;
  value.receiptSha256 = sha256Canonical(content);
}

describe("FAL MEM-E0 deterministic mechanics receipt", () => {
  it("derives a supported structural score from four eligible pairs without an effect claim", () => {
    const receipt = createReceipt();
    const { receiptSha256, ...content } = receipt;

    expect(receipt).toMatchObject({
      actorClass: "deterministic_mechanics_only",
      effectClaimAllowed: false,
      evidenceClass: "product_path_structural_causal_mechanics",
      liveModelConsumptionObserved: false,
      providerCalls: 0,
      receiptType: "mechanics-receipt-v1",
    });
    expect(receipt.aggregate).toEqual({
      armCount: 8,
      eligibleArmCount: 8,
      eligiblePairCount: 4,
      harmControlPairCount: 1,
      memoryDependentPairCount: 3,
      observationHashCount: 16,
      outcomeCounts: {
        baselineOnlyRegression: 0,
        bothFail: 0,
        bothPass: 1,
        candidateOnlyWin: 3,
        inconclusiveInvalidPair: 0,
      },
      pairCount: 4,
      selectedRecordHashCount: 6,
      toolArgumentHashCount: 20,
    });
    expect(receipt.claims).toEqual({
      liveEffect: {
        reasonCode: "deterministic_mechanics_only",
        result: "not_run",
      },
      structuralMechanics: {
        reasonCode: "all_pairs_eligible_expected_outcomes_observed",
        result: "supported",
      },
    });
    expect(receipt.pairs.map((pair) => pair.caseId)).toEqual(MEM_E0_CASE_IDS);
    expect(receipt.pairs.every((pair) =>
      pair.distinctOsProcesses &&
      pair.sameLogicalMemory &&
      pair.productPathObserved
    )).toBe(true);
    expect(receiptSha256).toBe(sha256Canonical(content));
    expect(parseMemE0MechanicsReceipt(JSON.parse(JSON.stringify(receipt))))
      .toEqual(receipt);
  });

  it("keeps valid but wrong outcomes separate from invalid evidence", () => {
    const mismatchedPairs = validPairs().map((pair, index) => index === 0
      ? Object.freeze({
          ...pair,
          on: arm({
            caseId: pair.caseId,
            freshVerifierPassed: false,
            historicalItemCount: 1,
            label: "on",
          }),
        })
      : pair);
    const refuted = scoreMemE0MechanicsPairs(mismatchedPairs);
    expect(refuted.aggregate.eligiblePairCount).toBe(4);
    expect(refuted.aggregate.outcomeCounts.bothFail).toBe(1);
    expect(refuted.claims.structuralMechanics).toEqual({
      reasonCode: "eligible_pair_outcome_mismatch",
      result: "refuted",
    });

    const invalidPairs = validPairs().map((pair, index) => index === 0
      ? Object.freeze({ ...pair, distinctOsProcesses: false })
      : pair);
    const inconclusive = scoreMemE0MechanicsPairs(invalidPairs);
    expect(inconclusive.aggregate.eligiblePairCount).toBe(3);
    expect(inconclusive.aggregate.outcomeCounts.inconclusiveInvalidPair).toBe(1);
    expect(inconclusive.claims.structuralMechanics).toEqual({
      reasonCode: "one_or_more_pairs_ineligible",
      result: "inconclusive",
    });
    expect(inconclusive.claims.liveEffect.result).toBe("not_run");
  });

  it("makes a failed arm contract or a recalled record mismatch ineligible", () => {
    const contractFailure = validPairs().map((pair, index) => index === 0
      ? Object.freeze({
          ...pair,
          on: Object.freeze({ ...pair.on, armContractObserved: false }),
        })
      : pair);
    const contractScore = scoreMemE0MechanicsPairs(contractFailure);
    expect(contractScore.pairs[0]).toMatchObject({
      eligible: false,
      on: { eligible: false },
      outcome: "inconclusive_invalid_pair",
    });
    expect(contractScore.claims.structuralMechanics.result).toBe("inconclusive");

    const wrongRecall = validPairs().map((pair, index) => index === 0
      ? Object.freeze({
          ...pair,
          on: Object.freeze({
            ...pair.on,
            selectedRecordIdSha256s: hashes("wrong-admitted-record-id"),
          }),
        })
      : pair);
    const recallScore = scoreMemE0MechanicsPairs(wrongRecall);
    expect(recallScore.pairs[0]).toMatchObject({
      eligible: false,
      on: { eligible: false },
      outcome: "inconclusive_invalid_pair",
    });
    expect(recallScore.claims.structuralMechanics.result).toBe("inconclusive");
  });

  it("allows harm-control recall only when it binds to that arm's admitted record", () => {
    const harmRecall = validPairs().map((pair) => pair.caseClass === "harm_control"
      ? Object.freeze({
          ...pair,
          on: arm({
            caseId: pair.caseId,
            freshVerifierPassed: true,
            historicalItemCount: 1,
            label: "on",
          }),
        })
      : pair);
    const score = scoreMemE0MechanicsPairs(harmRecall);
    const harm = score.pairs.find((pair) => pair.caseClass === "harm_control");
    expect(harm).toMatchObject({
      eligible: true,
      on: { eligible: true, historicalItemCount: 1 },
      outcome: "both_pass",
    });
  });

  it("rejects nested scorer tampering even when an attacker recomputes the outer hash", () => {
    const tampered = structuredClone(createReceipt()) as unknown as Record<string, unknown>;
    const pairs = tampered.pairs as Record<string, unknown>[];
    const first = pairs[0]!;
    first.outcome = "both_pass";
    reseal(tampered);

    expect(() => parseMemE0MechanicsReceipt(tampered)).toThrow();
  });

  it("rejects unsorted evidence and any raw path, pid, task, or provider-output field", () => {
    const unsorted = structuredClone(createReceipt()) as unknown as Record<string, unknown>;
    (unsorted.implementationSha256s as string[]).reverse();
    reseal(unsorted);
    expect(() => parseMemE0MechanicsReceipt(unsorted)).toThrow(
      /sorted and unique/u,
    );

    for (const [field, value] of [
      ["workspace", "D:\\private\\repo"],
      ["childPid", 42],
      ["rawTask", "private task bytes"],
      ["rawMemory", "private memory bytes"],
      ["providerOutput", "raw provider response"],
    ] as const) {
      const leaked = structuredClone(createReceipt()) as unknown as Record<string, unknown>;
      const pairs = leaked.pairs as Record<string, unknown>[];
      const off = pairs[0]!.off as Record<string, unknown>;
      off[field] = value;
      reseal(leaked);
      expect(() => parseMemE0MechanicsReceipt(leaked), field).toThrow();
    }
  });

  it("requires the frozen four-case order instead of silently changing the denominator", () => {
    const reordered = [...validPairs()];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => createReceipt(reordered)).toThrow(/frozen case order/u);
  });
});
