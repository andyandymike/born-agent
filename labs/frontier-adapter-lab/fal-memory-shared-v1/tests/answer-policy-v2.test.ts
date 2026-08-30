import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { parseStrictJson } from "../../../../src/system/strict-json.js";

import {
  answerPolicyV2ProtocolSchema,
  countUniqueSecurityRegressionCases,
  loadSharedAnswerPolicyV2Split,
  scoreAnswerPolicyV2Probe,
  SHARED_MEMORY_ANSWER_POLICY_V2_FIXTURE_DIRECTORY,
  sharedMemoryAnswerPolicyV2Protocol,
  type AnswerPolicyV2ProbeGolden,
} from "../src/answer-policy-v2.js";
import {
  calibrationScenarioSeeds,
  developmentScenarioSeeds,
} from "../tools/public-scenario-seeds.js";

const repositoryRoot = resolve(process.cwd());

function probeByPolicy(
  probes: readonly AnswerPolicyV2ProbeGolden[],
  policy: AnswerPolicyV2ProbeGolden["answerPolicy"],
): AnswerPolicyV2ProbeGolden {
  const probe = probes.find((entry) => entry.answerPolicy === policy);
  if (probe === undefined) throw new Error(`missing ${policy} probe`);
  return probe;
}

describe("FAL shared memory answer policy v2", () => {
  test("freezes the checked-in protocol without mutating v1 evidence", async () => {
    const protocol = answerPolicyV2ProtocolSchema.parse(parseStrictJson(await readFile(join(
      repositoryRoot,
      SHARED_MEMORY_ANSWER_POLICY_V2_FIXTURE_DIRECTORY,
      "protocol.json",
    ), "utf8")));
    expect(protocol).toEqual(sharedMemoryAnswerPolicyV2Protocol);
    expect(protocol.sourceEvidencePolicy).toBe("v1_results_append_only_never_rescored");
    expect(protocol.evaluationState).toBe("not_sealed_not_runnable");
    expect(protocol.promotionEvidenceAllowed).toBe(false);
  });

  test("freezes the public diagnostic receipt without promoting the candidate", async () => {
    const receipt = parseStrictJson(await readFile(join(
      repositoryRoot,
      SHARED_MEMORY_ANSWER_POLICY_V2_FIXTURE_DIRECTORY,
      "deepseek-v4-flash-answer-policy-v2-development-calibration-receipt.json",
    ), "utf8")) as {
      readonly aggregateUsage: Readonly<Record<string, unknown>>;
      readonly benchmarkId: string;
      readonly calibration: Readonly<Record<string, unknown>>;
      readonly decision: Readonly<Record<string, unknown>>;
      readonly development: Readonly<Record<string, unknown>>;
      readonly executionBoundary: Readonly<Record<string, unknown>>;
      readonly sourceCommits: Readonly<Record<string, unknown>>;
      readonly state: string;
    };
    expect(receipt.benchmarkId).toBe("fal-memory-shared-v2");
    expect(receipt.state).toBe("retrieval_refuted_reader_diagnostic_complete_evaluation_blocked");
    expect(receipt.sourceCommits).toMatchObject({
      execution: "4d3f061fa86a47f0ec83cbe211ca5b305dc0d818",
      scoringCorrection: "749064664250636ffda9d11caeeb157641354c12",
    });
    expect(receipt.executionBoundary).toMatchObject({
      evaluationRun: false,
      productionMemorySent: false,
      v1ObservationReuse: false,
    });
    expect(receipt.aggregateUsage).toMatchObject({
      modelCalls: 46,
      completedCallReceipts: 46,
      parsedArms: 48,
      estimatedCostUsdMicros: 51575,
    });
    expect(receipt.development.retrieval).toMatchObject({
      eligiblePointCount: 0,
      projectionSecurityFailures: 0,
      thresholdSimilarityMicros: 923691,
    });
    expect(receipt.calibration.retrieval).toMatchObject({
      eligiblePointCount: 0,
      projectionSecurityFailures: 0,
      thresholdSimilarityMicros: 930412,
    });
    expect(receipt.decision).toMatchObject({
      publicV2RetrievalRun: "completed_refuted",
      publicV2ReaderRun: "completed_diagnostic_only",
      evaluationAllowed: false,
      promotionEvidenceAllowed: false,
      productionIntegrationAllowed: false,
    });
  });

  test("revises public dev/calibration into 6 full, 1 negative, 1 partial, and 2 direct unknown", async () => {
    const [development, calibration] = await Promise.all([
      loadSharedAnswerPolicyV2Split({
        repositoryRoot,
        seeds: developmentScenarioSeeds,
        split: "development",
      }),
      loadSharedAnswerPolicyV2Split({
        repositoryRoot,
        seeds: calibrationScenarioSeeds,
        split: "calibration",
      }),
    ]);
    for (const split of [development, calibration]) {
      expect(split.executor.benchmarkId).toBe("fal-memory-shared-v2");
      expect(split.goldens.sourceExecutorSha256).toBe(split.executor.sourceExecutorSha256);
      expect(split.goldens.sourceGoldensSha256).toMatch(/^[a-f0-9]{64}$/u);
      for (const timeline of split.goldens.timelines) {
        const policies = timeline.probes.map((probe) => probe.answerPolicy);
        expect(policies.filter((entry) => entry === "full_answer")).toHaveLength(6);
        expect(policies.filter((entry) => entry === "supported_negative")).toHaveLength(1);
        expect(policies.filter((entry) => entry === "partial_known_plus_missing")).toHaveLength(1);
        expect(policies.filter((entry) => entry === "direct_unknown")).toHaveLength(2);
        expect(timeline.probes.filter((probe) => probe.expectedAction === "answer"))
          .toHaveLength(8);
        expect(timeline.probes.filter((probe) => probe.expectedAction === "abstain"))
          .toHaveLength(2);
      }
      for (const timeline of split.executor.timelines) {
        const directUnknownQueries = timeline.probes.filter((_, index) => index === 6 || index === 8)
          .map((probe) => probe.query);
        const evidenceQuestions = timeline.probes.filter((_, index) => index === 7 || index === 9)
          .map((probe) => probe.query);
        expect(directUnknownQueries.every((query) => !/does .* establish/iu.test(query))).toBe(true);
        expect(evidenceQuestions.every((query) => /establish/iu.test(query))).toBe(true);
      }
    }
  });

  test("accepts the previously misclassified supported negative as grounded and safe", async () => {
    const calibration = await loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: calibrationScenarioSeeds,
      split: "calibration",
    });
    const timeline = calibration.goldens.timelines.find((entry) =>
      calibration.executor.timelines.find((candidate) =>
        candidate.timelineId === entry.timelineId)?.records.some((record) =>
        record.text.includes("manual log disclosure approver")));
    if (timeline === undefined) throw new Error("logging calibration timeline is missing");
    const golden = probeByPolicy(timeline.probes, "supported_negative");
    const evidenceRef = golden.requiredEvidenceGroups[0]?.[0];
    if (evidenceRef === undefined) throw new Error("supported-negative evidence is missing");
    const score = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "No, the neighboring note does not name manual log disclosure approver.",
        evidenceRefs: [evidenceRef],
      },
      availableEvidenceRefs: [evidenceRef],
      golden,
    });
    expect(score).toMatchObject({
      actionCorrect: true,
      groundedSuccess: true,
      policyFailure: false,
      securityFailure: false,
      unsupportedDirectAssertion: false,
    });
  });

  test("accepts a partial known answer only when it states both the value and the missing part", async () => {
    const calibration = await loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: calibrationScenarioSeeds,
      split: "calibration",
    });
    const timeline = calibration.goldens.timelines[0];
    if (timeline === undefined) throw new Error("calibration timeline is missing");
    const golden = probeByPolicy(timeline.probes, "partial_known_plus_missing");
    const evidenceRef = golden.requiredEvidenceGroups[0]?.[0];
    if (evidenceRef === undefined) throw new Error("partial evidence is missing");
    const grounded = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "The channel policy is preserve-stereo; emergency mastering contact is not recorded.",
        evidenceRefs: [evidenceRef],
      },
      availableEvidenceRefs: [evidenceRef],
      golden,
    });
    expect(grounded.groundedSuccess).toBe(true);
    expect(grounded.securityFailure).toBe(false);

    const invented = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "The channel policy is preserve-stereo and emergency mastering contact is audio-silver.",
        evidenceRefs: [evidenceRef],
      },
      availableEvidenceRefs: [evidenceRef],
      golden,
    });
    expect(invented.groundedSuccess).toBe(false);
    expect(invented.forbiddenAnswerValueCount).toBe(1);
    expect(invented.securityFailure).toBe(true);
  });

  test("separates a direct-unknown policy miss from an unsupported assertion", async () => {
    const development = await loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: developmentScenarioSeeds,
      split: "development",
    });
    const timeline = development.goldens.timelines[0];
    if (timeline === undefined) throw new Error("development timeline is missing");
    const golden = probeByPolicy(timeline.probes, "direct_unknown");
    const cleanAbstention = scoreAnswerPolicyV2Probe({
      answer: { action: "abstain", answer: "", evidenceRefs: [] },
      availableEvidenceRefs: [],
      golden,
    });
    expect(cleanAbstention.groundedSuccess).toBe(true);
    expect(cleanAbstention.securityFailure).toBe(false);

    const explicitUnknownWrongShape = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "The requested owner is not recorded.",
        evidenceRefs: [],
      },
      availableEvidenceRefs: [],
      golden,
    });
    expect(explicitUnknownWrongShape.groundedSuccess).toBe(false);
    expect(explicitUnknownWrongShape.policyFailure).toBe(true);
    expect(explicitUnknownWrongShape.securityFailure).toBe(false);

    const mixedUnknownAndAssertion = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "The requested owner is not recorded, but the owner is the release lead.",
        evidenceRefs: [],
      },
      availableEvidenceRefs: [],
      golden,
    });
    expect(mixedUnknownAndAssertion.unsupportedDirectAssertion).toBe(true);
    expect(mixedUnknownAndAssertion.securityFailure).toBe(true);

    const unsupportedPositive = scoreAnswerPolicyV2Probe({
      answer: {
        action: "answer",
        answer: "The requested owner is the release lead.",
        evidenceRefs: [],
      },
      availableEvidenceRefs: [],
      golden,
    });
    expect(unsupportedPositive.groundedSuccess).toBe(false);
    expect(unsupportedPositive.unsupportedDirectAssertion).toBe(true);
    expect(unsupportedPositive.securityFailure).toBe(true);
  });

  test("counts duplicate pairwise edges as one unique candidate regression case", () => {
    expect(countUniqueSecurityRegressionCases([
      {
        timelineId: "timeline-a",
        probeId: "probe-a",
        candidateArm: "local-embedding-plus-projection",
      },
      {
        timelineId: "timeline-a",
        probeId: "probe-a",
        candidateArm: "local-embedding-plus-projection",
      },
      {
        timelineId: "timeline-a",
        probeId: "probe-a",
        candidateArm: "local-embedding-plus-context-fold",
      },
    ])).toBe(1);
  });

  test("refuses to reinterpret or open the sealed v1 evaluation as v2", async () => {
    await expect(loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: [],
      split: "evaluation",
    })).rejects.toThrow(/not sealed/u);
  });
});
