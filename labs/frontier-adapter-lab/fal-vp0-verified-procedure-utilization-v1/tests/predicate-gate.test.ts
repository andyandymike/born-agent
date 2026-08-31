import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { describe, expect, it } from "vitest";

import { evaluateFalVp0Applicability } from "../src/applicability-gate.js";
import {
  evaluateFalVp0Predicate,
  type FalVp0HostFactRegistryEntry,
} from "../src/host-fact-predicate.js";
import type { FalVp0Predicate } from "../src/procedure-schema.js";
import { buildTestProcedure } from "./fixture-builder.js";

const extractorSha256 = sha256Canonical({ label: "extractor" });

function predicate(
  operator: FalVp0Predicate["operator"],
  expected: FalVp0Predicate["expected"],
): FalVp0Predicate {
  return {
    evaluatorVersion: "fal-vp0-host-facts-v1",
    factSource: "case_manifest",
    factKey: "fact.value",
    extractorId: "fixture-extractor-v1",
    extractorSha256,
    operator,
    expected,
    missingPolicy: "reject",
  };
}

function registry(
  factKey = "fact.value",
  valueType: FalVp0HostFactRegistryEntry["valueType"] = "string",
): FalVp0HostFactRegistryEntry {
  return {
    factKey,
    factSource: "case_manifest",
    valueType,
    extractorId: "fixture-extractor-v1",
    extractorSha256,
  };
}

function evaluate(
  inputPredicate: unknown,
  facts: Readonly<Record<string, string | number | boolean | null>>,
  entry: FalVp0HostFactRegistryEntry | null = registry(),
) {
  return evaluateFalVp0Predicate({
    conditionId: "condition-test",
    evidenceSha256s: [sha256Canonical({ evidence: 1 })],
    facts,
    predicate: inputPredicate,
    registryEntry: entry,
    workspaceBeforeSha256: sha256Canonical({ workspace: "before" }),
  });
}

describe("FAL-VP0 typed host predicates", () => {
  it.each([
    ["exists", null, "anything"],
    ["equals", "alpha", "alpha"],
    ["not_equals", "beta", "alpha"],
    ["one_of", ["alpha", "beta"], "alpha"],
    ["none_of", ["beta", "gamma"], "alpha"],
    ["sha256_equals", "a".repeat(64), "a".repeat(64)],
    ["semver_satisfies", ">=1.0.0 <2.0.0", "1.4.2"],
  ] as const)("matches %s", (operator, expected, actual) => {
    const normalizedExpected = (Array.isArray(expected) ? [...expected] : expected) as FalVp0Predicate["expected"];
    expect(evaluate(predicate(operator, normalizedExpected), { "fact.value": actual })).toMatchObject({
      evaluationStatus: "matched",
      gateValue: true,
    });
  });

  it("keeps missing, type mismatch, malformed expected, and registry failure distinct", () => {
    expect(evaluate(predicate("equals", "alpha"), {})).toMatchObject({
      evaluationStatus: "missing",
      gateValue: "reject",
    });
    expect(evaluate(predicate("equals", "alpha"), { "fact.value": 1 })).toMatchObject({
      evaluationStatus: "type_mismatch",
      gateValue: "reject",
    });
    expect(evaluate({ ...predicate("one_of", ["alpha"]), expected: [] }, { "fact.value": "alpha" }))
      .toMatchObject({ evaluationStatus: "invalid_expected", gateValue: "reject" });
    expect(evaluate(predicate("equals", "alpha"), { "fact.value": "alpha" }, registry("other.fact")))
      .toMatchObject({ evaluationStatus: "extractor_failed", gateValue: "reject" });
  });
});

describe("FAL-VP0 applicability direction", () => {
  function gate(facts: Readonly<Record<string, string | number | boolean | null>>) {
    const procedure = buildTestProcedure();
    const entries = Object.fromEntries([
      ["runtime.version", "string"],
      ["target.present", "boolean"],
      ["state.unsafe", "boolean"],
      ["workspace.ready", "boolean"],
      ["state.safe", "boolean"],
    ].map(([factKey, valueType]) => [factKey, registry(
      factKey,
      valueType as FalVp0HostFactRegistryEntry["valueType"],
    )]));
    return evaluateFalVp0Applicability({
      adapterEnabled: true,
      context: {
        evidenceByFactKey: Object.fromEntries(Object.keys(entries).map((key) => [key, [sha256Canonical(key)]])),
        facts,
        registryByFactKey: entries,
        workspaceBeforeSha256: sha256Canonical({ before: true }),
      },
      deadlineExhausted: false,
      expectedScope: procedure.scope,
      procedure,
      sourceEligible: true,
    });
  }

  const applicableFacts = {
    "runtime.version": "22.0.0",
    "target.present": true,
    "state.unsafe": false,
    "workspace.ready": true,
    "state.safe": true,
  } as const;

  it("selects only after version, activation, negative, precondition and guards", () => {
    expect(gate(applicableFacts)).toMatchObject({
      applicability: "applicable",
      candidateInvoked: true,
      decisionStage: "selected",
    });
    expect(gate({ ...applicableFacts, "state.safe": false })).toMatchObject({
      applicability: "applicable_guarded",
      candidateInvoked: true,
      changedGuardConditionIds: ["guard-clean"],
    });
  });

  it("rejects missing facts and negative matches before candidate invocation", () => {
    const missingActivation = Object.fromEntries(Object.entries(applicableFacts).filter(([key]) =>
      key !== "target.present"));
    expect(gate(missingActivation)).toMatchObject({
      applicability: "fallback_error",
      candidateInvoked: false,
      decisionStage: "activation",
      fallbackReasonCode: "predicate_rejected",
    });
    expect(gate({ ...applicableFacts, "state.unsafe": true })).toMatchObject({
      applicability: "not_applicable",
      candidateInvoked: false,
      decisionStage: "negative",
      fallbackReasonCode: "negative_condition_matched",
    });
  });
});
