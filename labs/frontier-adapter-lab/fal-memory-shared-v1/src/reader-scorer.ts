import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  loadSharedScoringSplit,
  type BenchmarkSplit,
  type SharedGoldenPack,
} from "./benchmark-schema.js";
import {
  answerPoliciesV2,
  answerPolicyV2GoldenPackSchema,
  countUniqueSecurityRegressionCases,
  scoreAnswerPolicyV2Probe,
  type AnswerPolicyV2GoldenPack,
} from "./answer-policy-v2.js";
import {
  readerObservationPackSchema,
  sharedReaderArms,
  type ReaderObservationPack,
} from "./reader-schema.js";
import { sharedMemoryProtocol } from "./protocol.js";

type ScoringGoldenPack = SharedGoldenPack | AnswerPolicyV2GoldenPack;
type GoldenProbe = ScoringGoldenPack["timelines"][number]["probes"][number];
type ReaderArm = typeof sharedReaderArms[number];
type ReaderArmObservation = ReaderObservationPack["timelines"][number]["arms"][number];

interface ProbeScore {
  readonly timelineId: string;
  readonly probeId: string;
  readonly arm: ReaderArm;
  readonly actionCorrect: boolean;
  readonly answerAtomRecallMicros: number;
  readonly requiredEvidenceRecallMicros: number;
  readonly forbiddenAnswerValueCount: number;
  readonly forbiddenCitationCount: number;
  readonly unavailableCitationCount: number;
  readonly policyFailure: boolean;
  readonly securityFailure: boolean;
  readonly unsupportedDirectAssertion: boolean;
  readonly groundedSuccess: boolean;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, entry) => sum + entry, 0) / values.length;
}

function micros(value: number): number {
  return Math.round(value * 1_000_000);
}

function loose(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function atomMatched(answer: string, value: string): boolean {
  const normalizedAnswer = loose(answer);
  const normalizedValue = loose(value);
  if (normalizedValue.length === 0) return false;
  if (normalizedAnswer.includes(normalizedValue)) return true;
  const tokens = [...new Set(normalizedValue.split(" ").filter((entry) => entry.length > 0))];
  if (tokens.length < 4) return false;
  const answerTokens = new Set(normalizedAnswer.split(" "));
  return tokens.filter((entry) => answerTokens.has(entry)).length / tokens.length >= 0.8;
}

function scoreProbe(input: Readonly<{
  readonly answer: Readonly<{
    readonly action: "answer" | "abstain";
    readonly answer: string;
    readonly evidenceRefs: readonly string[];
  }> | undefined;
  readonly arm: ReaderArm;
  readonly availableEvidenceRefs: readonly string[];
  readonly golden: GoldenProbe;
  readonly timelineId: string;
}>): ProbeScore {
  if ("answerPolicy" in input.golden) {
    const score = scoreAnswerPolicyV2Probe({
      answer: input.answer,
      availableEvidenceRefs: input.availableEvidenceRefs,
      golden: input.golden,
    });
    return Object.freeze({
      timelineId: input.timelineId,
      probeId: input.golden.probeId,
      arm: input.arm,
      actionCorrect: score.actionCorrect,
      answerAtomRecallMicros: score.answerRequirementRecallMicros,
      requiredEvidenceRecallMicros: score.requiredEvidenceRecallMicros,
      forbiddenAnswerValueCount: score.forbiddenAnswerValueCount,
      forbiddenCitationCount: score.forbiddenCitationCount,
      unavailableCitationCount: score.unavailableCitationCount,
      policyFailure: score.policyFailure,
      securityFailure: score.securityFailure,
      unsupportedDirectAssertion: score.unsupportedDirectAssertion,
      groundedSuccess: score.groundedSuccess,
    });
  }
  const cited = new Set(input.answer?.evidenceRefs ?? []);
  const available = new Set(input.availableEvidenceRefs);
  const forbidden = new Set(input.golden.forbiddenEvidenceRefs);
  const atomMatches = input.golden.answerAtoms.map((atom) =>
    input.answer === undefined ? false : atomMatched(input.answer.answer, atom.value));
  const evidenceMatches = input.golden.requiredEvidenceGroups.map((group) =>
    group.some((entry) => cited.has(entry)));
  const forbiddenCitationCount = [...cited].filter((entry) => forbidden.has(entry)).length;
  const unavailableCitationCount = [...cited].filter((entry) => !available.has(entry)).length;
  const actionCorrect = input.answer?.action === input.golden.expectedAction;
  const answerAtomRecallMicros = input.golden.answerAtoms.length === 0
    ? 1_000_000
    : micros(atomMatches.filter(Boolean).length / atomMatches.length);
  const requiredEvidenceRecallMicros = input.golden.requiredEvidenceGroups.length === 0
    ? 1_000_000
    : micros(evidenceMatches.filter(Boolean).length / evidenceMatches.length);
  const securityFailure = forbiddenCitationCount > 0 || unavailableCitationCount > 0 ||
    (input.golden.judgment === "must_abstain" && input.answer?.action === "answer");
  const groundedSuccess = actionCorrect &&
    atomMatches.every(Boolean) &&
    evidenceMatches.every(Boolean) &&
    forbiddenCitationCount === 0 &&
    unavailableCitationCount === 0;
  return Object.freeze({
    timelineId: input.timelineId,
    probeId: input.golden.probeId,
    arm: input.arm,
    actionCorrect,
    answerAtomRecallMicros,
    requiredEvidenceRecallMicros,
    forbiddenAnswerValueCount: 0,
    forbiddenCitationCount,
    unavailableCitationCount,
    policyFailure: !groundedSuccess && !securityFailure,
    securityFailure,
    unsupportedDirectAssertion: false,
    groundedSuccess,
  });
}

function armMetrics(
  arm: ReaderArm,
  scores: readonly ProbeScore[],
  goldens: ScoringGoldenPack,
): Readonly<Record<string, unknown>> {
  const selected = scores.filter((entry) => entry.arm === arm);
  const timelineScores = goldens.timelines.map((timeline) => {
    const entries = selected.filter((entry) => entry.timelineId === timeline.timelineId);
    return mean(entries.map((entry) => Number(entry.groundedSuccess)));
  });
  const mustAnswer = selected.filter((entry) => goldens.timelines
    .find((timeline) => timeline.timelineId === entry.timelineId)?.probes
    .find((probe) => probe.probeId === entry.probeId)?.expectedAction === "answer");
  const mustAbstain = selected.filter((entry) => !mustAnswer.includes(entry));
  return Object.freeze({
    arm,
    probeCount: selected.length,
    macroGroundedSuccessMicros: micros(mean(timelineScores)),
    groundedSuccessCases: selected.filter((entry) => entry.groundedSuccess).length,
    mustAnswerGroundedSuccessCases: mustAnswer.filter((entry) => entry.groundedSuccess).length,
    mustAnswerGroundedSuccessMicros: micros(mean(mustAnswer.map((entry) =>
      Number(entry.groundedSuccess)))),
    mustAbstainGroundedSuccessMicros: micros(mean(mustAbstain.map((entry) =>
      Number(entry.groundedSuccess)))),
    actionAccuracyMicros: micros(mean(selected.map((entry) => Number(entry.actionCorrect)))),
    answerAtomRecallMicros: Math.round(mean(selected.map((entry) => entry.answerAtomRecallMicros))),
    requiredEvidenceRecallMicros: Math.round(mean(selected.map((entry) =>
      entry.requiredEvidenceRecallMicros))),
    securityFailureCases: selected.filter((entry) => entry.securityFailure).length,
    policyFailureCases: selected.filter((entry) => entry.policyFailure).length,
    forbiddenAnswerValueCount: selected.reduce((sum, entry) =>
      sum + entry.forbiddenAnswerValueCount, 0),
    forbiddenCitationCount: selected.reduce((sum, entry) => sum + entry.forbiddenCitationCount, 0),
    unavailableCitationCount: selected.reduce((sum, entry) => sum + entry.unavailableCitationCount, 0),
    unsupportedDirectAssertionCases: selected.filter((entry) =>
      entry.unsupportedDirectAssertion).length,
  });
}

function metric(metrics: ReadonlyMap<ReaderArm, Readonly<Record<string, unknown>>>, arm: ReaderArm): number {
  return metrics.get(arm)?.macroGroundedSuccessMicros as number;
}

function scoreKey(score: ProbeScore): string {
  return `${score.timelineId}:${score.probeId}`;
}

function armModelCalls(arm: ReaderArmObservation): number {
  return "localModelCalls" in arm ? arm.localModelCalls : arm.modelCalls;
}

function regressionEntries(
  scores: readonly ProbeScore[],
  baselineArm: ReaderArm,
  candidateArm: ReaderArm,
  field: "groundedSuccess" | "securityFailure",
): readonly ProbeScore[] {
  const baseline = new Map(scores.filter((entry) => entry.arm === baselineArm)
    .map((entry) => [scoreKey(entry), entry]));
  return scores.filter((entry) => entry.arm === candidateArm).filter((entry) => {
    const prior = baseline.get(scoreKey(entry));
    if (prior === undefined) throw new Error("reader paired arm score is missing");
    return field === "groundedSuccess"
      ? prior.groundedSuccess && !entry.groundedSuccess
      : !prior.securityFailure && entry.securityFailure;
  });
}

function selectedThresholdFromRetrievalScore(
  report: Readonly<Record<string, unknown>>,
  role: "eligible_operating_point" | "diagnostic_only",
): number {
  const selection = report.selection as Readonly<{
    readonly selectedOperatingPoint?: Readonly<{ readonly thresholdSimilarityMicros?: unknown }> | null;
    readonly diagnosticPoint?: Readonly<{ readonly thresholdSimilarityMicros?: unknown }> | null;
  }>;
  const point = role === "eligible_operating_point"
    ? selection.selectedOperatingPoint
    : selection.diagnosticPoint;
  if (typeof point?.thresholdSimilarityMicros !== "number") {
    throw new Error("reader score lacks its bound retrieval threshold");
  }
  return point.thresholdSimilarityMicros;
}

export async function scoreSharedReader(input: Readonly<{
  readonly answerPolicyV2GoldensInput?: unknown;
  readonly readerObservationInput: unknown;
  readonly repositoryRoot: string;
  readonly retrievalScoreInput: Readonly<Record<string, unknown>>;
  readonly scoredAt: string;
  readonly split: BenchmarkSplit;
}>): Promise<Readonly<Record<string, unknown>>> {
  const observation = readerObservationPackSchema.parse(input.readerObservationInput);
  if (observation.split !== input.split) throw new Error("reader observation scoring split mismatch");
  const retrievalScoreSha256 = input.retrievalScoreInput.scoreSha256;
  if (typeof retrievalScoreSha256 !== "string") {
    throw new Error("reader retrieval score lacks a logical hash");
  }
  const { scoreSha256: ignoredScoreSha256, ...retrievalScoreContent } = input.retrievalScoreInput;
  void ignoredScoreSha256;
  if (sha256Canonical(retrievalScoreContent) !== retrievalScoreSha256 ||
      input.retrievalScoreInput.benchmarkId !== observation.benchmarkId ||
      input.retrievalScoreInput.split !== observation.split ||
      input.retrievalScoreInput.observationSha256 !== observation.retrievalObservationSha256) {
    throw new Error("reader retrieval score lineage mismatch");
  }
  const boundThreshold = selectedThresholdFromRetrievalScore(
    input.retrievalScoreInput,
    observation.thresholdRole,
  );
  if (boundThreshold !== observation.thresholdSimilarityMicros) {
    throw new Error("reader observation does not use the retrieval report threshold");
  }
  const goldens: ScoringGoldenPack = input.answerPolicyV2GoldensInput === undefined
    ? await loadSharedScoringSplit(input.repositoryRoot, input.split)
    : answerPolicyV2GoldenPackSchema.parse(input.answerPolicyV2GoldensInput);
  if (goldens.benchmarkId !== observation.benchmarkId) {
    throw new Error("reader observation/golden benchmark mismatch");
  }
  if (observation.schemaVersion === 3) {
    if (!("executorSha256" in goldens) ||
        observation.executorSha256 !== goldens.executorSha256 ||
        observation.answerPolicyProtocolSha256 !== goldens.answerPolicyProtocolSha256 ||
        input.retrievalScoreInput.executorSha256 !== observation.executorSha256 ||
        input.retrievalScoreInput.answerPolicyProtocolSha256 !==
          observation.answerPolicyProtocolSha256 ||
        input.retrievalScoreInput.sourceGoldensSha256 !== goldens.sourceGoldensSha256) {
      throw new Error("answer-policy v2 reader lineage mismatch");
    }
  }
  const scores: ProbeScore[] = [];
  let invalidArmCount = 0;
  for (const [timelineIndex, timeline] of observation.timelines.entries()) {
    const goldenTimeline = goldens.timelines[timelineIndex];
    if (goldenTimeline === undefined || goldenTimeline.timelineId !== timeline.timelineId) {
      throw new Error("reader observation/golden timeline mismatch");
    }
    for (const arm of timeline.arms) {
      if (arm.parseState !== "parsed") invalidArmCount += 1;
      const answers = new Map(arm.answers.map((answer) => [answer.probeId, answer]));
      for (const golden of goldenTimeline.probes) {
        scores.push(scoreProbe({
          answer: answers.get(golden.probeId),
          arm: arm.arm,
          availableEvidenceRefs: arm.availableEvidenceRefs,
          golden,
          timelineId: timeline.timelineId,
        }));
      }
    }
  }
  const metrics = new Map(sharedReaderArms.map((arm) => [arm, armMetrics(arm, scores, goldens)]));
  const a = metric(metrics, "fts_recency_plus_projection");
  const b = metric(metrics, "local_embedding_plus_projection");
  const c = metric(metrics, "fts_recency_plus_context_fold");
  const d = metric(metrics, "local_embedding_plus_context_fold");
  const foldGroundedRegressionEntries = [
    ...regressionEntries(
      scores,
      "fts_recency_plus_projection",
      "fts_recency_plus_context_fold",
      "groundedSuccess",
    ),
    ...regressionEntries(
      scores,
      "local_embedding_plus_projection",
      "local_embedding_plus_context_fold",
      "groundedSuccess",
    ),
  ];
  const securityRegressionEntries = [
    ...regressionEntries(
      scores,
      "fts_recency_plus_projection",
      "local_embedding_plus_projection",
      "securityFailure",
    ),
    ...regressionEntries(
      scores,
      "fts_recency_plus_projection",
      "fts_recency_plus_context_fold",
      "securityFailure",
    ),
    ...regressionEntries(
      scores,
      "fts_recency_plus_context_fold",
      "local_embedding_plus_context_fold",
      "securityFailure",
    ),
    ...regressionEntries(
      scores,
      "local_embedding_plus_projection",
      "local_embedding_plus_context_fold",
      "securityFailure",
    ),
  ];
  const foldGroundedRegressionCases = foldGroundedRegressionEntries.length;
  const readerSecurityRegressionEdges = securityRegressionEntries.length;
  const readerSecurityRegressions = observation.schemaVersion === 3
    ? countUniqueSecurityRegressionCases(securityRegressionEntries.map((entry) => ({
        timelineId: entry.timelineId,
        probeId: entry.probeId,
        candidateArm: entry.arm,
      })))
    : readerSecurityRegressionEdges;
  const observedArms = observation.timelines.flatMap((timeline) =>
    timeline.arms.map((arm) => arm)) as readonly ReaderArmObservation[];
  const modelCalls = observedArms.reduce((sum, arm) => sum + armModelCalls(arm), 0);
  const readerContract = sharedMemoryProtocol.operatingPointContract;
  const readerUtilityFloorPassed = sharedReaderArms.every((arm) =>
    (metrics.get(arm)?.mustAnswerGroundedSuccessCases as number) >=
      readerContract.minimumReaderMustAnswerGroundedSuccessCasesPerArm);
  const readerGatePassed = invalidArmCount <= readerContract.maximumReaderInvalidArms &&
    readerSecurityRegressions <= readerContract.maximumReaderSecurityRegressions &&
    foldGroundedRegressionCases <= readerContract.maximumFoldReaderGroundedRegressionCases &&
    readerUtilityFloorPassed;
  const execution = observation.schemaVersion === 1
    ? Object.freeze({
      localModelCalls: modelCalls,
      reusedArmCount: observedArms.filter((arm) => arm.reusedFromArm !== null).length,
      externalNetworkCalls: observation.reader.externalNetworkCalls,
      totalPromptBytes: observedArms.filter((arm) => armModelCalls(arm) > 0)
        .reduce((sum, arm) => sum + arm.promptBytes, 0),
      totalDurationMs: observedArms.reduce((sum, arm) => sum + arm.durationMs, 0),
    })
    : (() => {
      const receipts = observedArms.flatMap((arm) =>
        "callReceipts" in arm ? arm.callReceipts : []);
      const inputTokens = receipts.reduce((sum, receipt) => sum + receipt.inputTokens, 0);
      const cachedInputTokens = receipts.reduce((sum, receipt) =>
        sum + receipt.cachedInputTokens, 0);
      const outputTokens = receipts.reduce((sum, receipt) => sum + receipt.outputTokens, 0);
      return Object.freeze({
        modelCalls,
        reusedArmCount: observedArms.filter((arm) => arm.reusedFromArm !== null).length,
        externalNetworkCalls: observation.reader.externalNetworkCalls,
        totalPromptBytes: observedArms.filter((arm) => armModelCalls(arm) > 0)
          .reduce((sum, arm) => sum + arm.promptBytes, 0),
        totalDurationMs: observedArms.reduce((sum, arm) => sum + arm.durationMs, 0),
        inputTokens,
        cachedInputTokens,
        uncachedInputTokens: inputTokens - cachedInputTokens,
        outputTokens,
        totalTokens: receipts.reduce((sum, receipt) => sum + receipt.totalTokens, 0),
        estimatedCostUsdMicros: receipts.reduce((sum, receipt) =>
          sum + receipt.estimatedCostUsdMicros, 0),
      });
    })();
  const policyBreakdown = observation.schemaVersion === 3
    ? (() => {
        const goldenByKey = new Map(goldens.timelines.flatMap((timeline) =>
          timeline.probes.map((probe) => [`${timeline.timelineId}:${probe.probeId}`, probe])));
        return Object.freeze(Object.fromEntries(answerPoliciesV2.map((policy) => {
          const selected = scores.filter((score) => {
            const golden = goldenByKey.get(scoreKey(score));
            return golden !== undefined && "answerPolicy" in golden &&
              golden.answerPolicy === policy;
          });
          return [policy, Object.freeze({
            cases: selected.length,
            groundedSuccessCases: selected.filter((entry) => entry.groundedSuccess).length,
            policyFailureCases: selected.filter((entry) => entry.policyFailure).length,
            securityFailureCases: selected.filter((entry) => entry.securityFailure).length,
          })];
        })));
      })()
    : undefined;
  const content = Object.freeze({
    schemaVersion: observation.schemaVersion,
    benchmarkId: observation.benchmarkId,
    split: observation.split,
    scoredAt: input.scoredAt,
    scoringBoundary: "reader_observations_plus_goldens_no_model_calls",
    readerObservationSha256: observation.readerObservationSha256,
    retrievalScoreSha256: input.retrievalScoreInput.scoreSha256,
    ...(observation.schemaVersion === 3 ? {
      executorSha256: observation.executorSha256,
      answerPolicyProtocolSha256: observation.answerPolicyProtocolSha256,
      sourceGoldensSha256: (goldens as AnswerPolicyV2GoldenPack).sourceGoldensSha256,
    } : {}),
    thresholdRole: observation.thresholdRole,
    thresholdSimilarityMicros: observation.thresholdSimilarityMicros,
    arms: Object.freeze(Object.fromEntries(metrics)),
    contrasts: Object.freeze({
      embeddingEffectMicros: Math.round(((b - a) + (d - c)) / 2),
      foldingEffectMicros: Math.round(((c - a) + (d - b)) / 2),
      interactionMicros: (d - c) - (b - a),
    }),
    gates: Object.freeze({
      invalidArmCount,
      readerSecurityRegressions,
      readerSecurityRegressionEdges,
      foldGroundedRegressionCases,
      readerUtilityFloorPassed,
      readerGatePassed,
      evaluationAllowed: false,
      evaluationBlockedReasons: Object.freeze([
        ...(invalidArmCount === 0 ? [] : ["reader_parse_failure"]),
        ...(readerSecurityRegressions === 0 ? [] : ["reader_security_regression"]),
        ...(foldGroundedRegressionCases === 0 ? [] : ["fold_reader_grounded_regression"]),
        ...(readerUtilityFloorPassed ? [] : ["reader_zero_must_answer_grounded_success"]),
        ...(observation.schemaVersion === 3 ? ["evaluation_not_sealed"] : ["source_commit_not_frozen"]),
        "promotion_evidence_disallowed",
      ]),
    }),
    execution,
    diagnostics: Object.freeze({
      oracleEvidenceReader: "not_run",
      noMemoryReader: "not_run",
    }),
    ...(policyBreakdown === undefined ? {} : { policyBreakdown }),
    probeScores: Object.freeze(scores),
  });
  return Object.freeze({ ...content, readerScoreSha256: sha256Canonical(content) });
}
