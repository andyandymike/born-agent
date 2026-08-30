import { describe, expect, test } from "vitest";

import {
  loadSharedAnswerPolicyV2ExecutorSplit,
  loadSharedAnswerPolicyV2Split,
} from "../src/answer-policy-v2.js";
import {
  calibrationAnswerPolicyV2QuerySeeds,
  developmentAnswerPolicyV2QuerySeeds,
} from "../src/answer-policy-v2-query-seeds.js";
import {
  ANSWER_POLICY_V2_READER_SYSTEM_PROMPT,
  DEEPSEEK_ANSWER_POLICY_V2_PROMPT_CONTRACT_SHA256,
  DEEPSEEK_READER_PROMPT_CONTRACT_SHA256,
  runSharedDeepSeekReaderWorker,
} from "../src/deepseek-reader-worker.js";
import { createAnswerPolicyV2RetrievalObservationPack } from "../src/observation-schema.js";
import { scoreSharedReader } from "../src/reader-scorer.js";
import { scoreSharedRetrieval } from "../src/shared-scorer.js";
import {
  calibrationScenarioSeeds,
  developmentScenarioSeeds,
} from "../tools/public-scenario-seeds.js";

const repositoryRoot = process.cwd();

type Executor = Awaited<ReturnType<typeof loadSharedAnswerPolicyV2ExecutorSplit>>;

function activePoisonRecordKey(timeline: Executor["timelines"][number]): string {
  const record = timeline.records.find((entry) =>
    entry.title.endsWith("instruction-shaped historical note"));
  if (record === undefined) throw new Error(`${timeline.timelineId} lacks its active poison record`);
  return record.recordId;
}

function syntheticRetrieval(executor: Executor) {
  const baselineProviderContext = "v2 synthetic baseline receipts";
  return createAnswerPolicyV2RetrievalObservationPack({
    schemaVersion: 2,
    benchmarkId: executor.benchmarkId,
    executorSha256: executor.executorSha256,
    answerPolicyProtocolSha256: executor.answerPolicyProtocolSha256,
    split: executor.split,
    generatedAt: "2026-08-30T08:00:00.000Z",
    executionBoundary: "executor_inputs_plus_frozen_candidates_no_goldens_no_network",
    candidate: {
      embeddingModelArtifactManifestSha256: "1".repeat(64),
      embeddingProjectionSchemaSha256: "2".repeat(64),
      embeddingRrfK: 60,
      foldingEstimatorVersion: "fal-cf2-v2",
    },
    coldEmbeddingModelLoadMs: 1,
    timelines: executor.timelines.map((timeline) => ({
      timelineId: timeline.timelineId,
      recordPoolSha256: timeline.recordPoolSha256,
      projection: {
        eligibleVectorRecordKeys: [activePoisonRecordKey(timeline)],
        buildDurationMs: 1,
        embeddingDurationMs: 1,
        inputSecurityFailures: 0,
        recordEmbeddingCalls: 0,
        rowSecurityFailures: 0,
      },
      folding: {
        baselineProviderContext,
        selectedProviderContext: baselineProviderContext,
        baselineBytes: Buffer.byteLength(baselineProviderContext, "utf8"),
        baselineTokens: 6,
        candidateBytes: null,
        candidateTokens: null,
        diagnosticCode: null,
        foldSha256: null,
        losslessExpansion: false,
        mode: "baseline",
        reason: "disabled",
        selected: false,
        modelCalls: 0,
        networkCalls: 0,
        toolCalls: 0,
      },
      probes: timeline.probes.map((probe) => ({
        probeId: probe.probeId,
        queryKind: "lexical",
        baselineTop5RecordKeys: [],
        baselineTop10RecordKeys: [],
        canonicalRefetches: 0,
        revalidationFailures: 0,
        queryEmbeddingCalls: 1,
        queryEmbeddingDurationMs: 1,
        totalPreparationDurationMs: 1,
        top1SimilarityMicros: null,
        top2SimilarityMicros: null,
        marginMicros: null,
        thresholdBehaviors: [{
          thresholdSimilarityMicros: 1_000_001,
          orderedTop5RecordKeys: [],
          orderedTop10RecordKeys: [],
          vectorAcceptedCount: 0,
        }],
      })),
    })),
  });
}

function deepSeekAbstentionResponse(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as {
    readonly input?: unknown;
    readonly instructions?: unknown;
  };
  if (body.instructions !== ANSWER_POLICY_V2_READER_SYSTEM_PROMPT ||
      typeof body.input !== "string") {
    throw new Error("v2 test received the wrong DeepSeek prompt contract");
  }
  const packet = JSON.parse(body.input.slice(body.input.lastIndexOf("\n") + 1)) as {
    readonly questions: readonly { readonly probeId: string }[];
  };
  const outputText = JSON.stringify({
    answers: packet.questions.map((question) => ({
      probeId: question.probeId,
      action: "abstain",
      answer: "",
      evidenceRefs: [],
    })),
  });
  return new Response(JSON.stringify({
    id: `response-${packet.questions[0]?.probeId ?? "missing"}`,
    status: "completed",
    model: "deepseek-v4-flash",
    output: [{ type: "message", content: [{ type: "output_text", text: outputText }] }],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      total_tokens: 120,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("FAL answer-policy v2 execution chain", () => {
  test("keeps executor query projections free of scorer-only seed fields", async () => {
    const pick = (seed: typeof developmentScenarioSeeds[number]) => ({
      absentFieldEn: seed.absentFieldEn,
      absentFieldZh: seed.absentFieldZh,
      stableKeyEn: seed.stableKeyEn,
      subjectEn: seed.subjectEn,
      subjectZh: seed.subjectZh,
    });
    expect(developmentAnswerPolicyV2QuerySeeds).toEqual(developmentScenarioSeeds.map(pick));
    expect(calibrationAnswerPolicyV2QuerySeeds).toEqual(calibrationScenarioSeeds.map(pick));
    for (const seed of [
      ...developmentAnswerPolicyV2QuerySeeds,
      ...calibrationAnswerPolicyV2QuerySeeds,
    ]) {
      expect(Object.keys(seed).sort()).toEqual([
        "absentFieldEn",
        "absentFieldZh",
        "stableKeyEn",
        "subjectEn",
        "subjectZh",
      ]);
    }

    const executorOnly = await loadSharedAnswerPolicyV2ExecutorSplit({
      repositoryRoot,
      seeds: developmentAnswerPolicyV2QuerySeeds,
      split: "development",
    });
    const scoring = await loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: developmentScenarioSeeds,
      split: "development",
    });
    expect(executorOnly.executorSha256).toBe(scoring.executor.executorSha256);
    expect(executorOnly.answerPolicyProtocolSha256)
      .toBe(scoring.goldens.answerPolicyProtocolSha256);
  });

  test("preflights the complete v2 lineage before the first paid call", async () => {
    const executor = await loadSharedAnswerPolicyV2ExecutorSplit({
      repositoryRoot,
      seeds: developmentAnswerPolicyV2QuerySeeds,
      split: "development",
    });
    const observation = syntheticRetrieval(executor);
    const { observationSha256: ignored, ...content } = observation;
    void ignored;
    const timelines = content.timelines.map((timeline, index) => index === 5
      ? { ...timeline, timelineId: "timeline-tampered" }
      : timeline);
    const tampered = createAnswerPolicyV2RetrievalObservationPack({ ...content, timelines });
    let fetchCalls = 0;
    await expect(runSharedDeepSeekReaderWorker({
      answerPolicyV2ExecutorInput: executor,
      apiKey: "test-api-key-123",
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        return deepSeekAbstentionResponse(init);
      },
      generatedAt: "2026-08-30T08:01:00.000Z",
      maxApiCalls: 12,
      maxEstimatedCostUsdMicros: 100_000,
      observationInput: tampered,
      repositoryRoot,
      split: "development",
      thresholdRole: "diagnostic_only",
      thresholdSimilarityMicros: 1_000_001,
    })).rejects.toThrow(/preflight/u);
    expect(fetchCalls).toBe(0);
  });

  test("runs and scores the v2 mock chain with separate policy and security accounting", async () => {
    const revised = await loadSharedAnswerPolicyV2Split({
      repositoryRoot,
      seeds: developmentScenarioSeeds,
      split: "development",
    });
    const retrieval = syntheticRetrieval(revised.executor);
    await expect(scoreSharedRetrieval({
      answerPolicyV2GoldensInput: {
        ...revised.goldens,
        sourceGoldensSha256: "0".repeat(64),
      },
      observationInput: retrieval,
      repositoryRoot,
      scoredAt: "2026-08-30T08:01:30.000Z",
      split: "development",
    })).rejects.toThrow(/source golden lineage mismatch/u);
    const retrievalScore = await scoreSharedRetrieval({
      answerPolicyV2GoldensInput: revised.goldens,
      observationInput: retrieval,
      repositoryRoot,
      scoredAt: "2026-08-30T08:02:00.000Z",
      split: "development",
    });
    expect(retrievalScore.projectionSecurity).toEqual({ count: 0, leakedRecordKeys: [] });
    for (const [timelineIndex, timeline] of revised.executor.timelines.entries()) {
      const filtered = revised.goldens.timelines[timelineIndex]!.probes.find((probe) =>
        probe.probeType === "filtered_scope_or_lifecycle");
      expect(filtered?.forbiddenEvidenceRefs)
        .toContain(`record:${activePoisonRecordKey(timeline)}`);
    }
    let fetchCalls = 0;
    const reader = await runSharedDeepSeekReaderWorker({
      answerPolicyV2ExecutorInput: revised.executor,
      apiKey: "test-api-key-123",
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        return deepSeekAbstentionResponse(init);
      },
      generatedAt: "2026-08-30T08:03:00.000Z",
      maxApiCalls: 12,
      maxEstimatedCostUsdMicros: 100_000,
      observationInput: retrieval,
      repositoryRoot,
      split: "development",
      thresholdRole: "diagnostic_only",
      thresholdSimilarityMicros: 1_000_001,
    });
    expect(reader.schemaVersion).toBe(3);
    expect(reader.reader.promptContractSha256)
      .toBe(DEEPSEEK_ANSWER_POLICY_V2_PROMPT_CONTRACT_SHA256);
    expect(reader.reader.promptContractSha256).not.toBe(DEEPSEEK_READER_PROMPT_CONTRACT_SHA256);
    expect(fetchCalls).toBe(12);
    expect(reader.reader.externalNetworkCalls).toBe(12);
    if (reader.schemaVersion !== 3) throw new Error("expected v2 reader observation");
    expect(reader.reader.plannedApiCalls).toBe(12);

    const readerScore = await scoreSharedReader({
      answerPolicyV2GoldensInput: revised.goldens,
      readerObservationInput: reader,
      repositoryRoot,
      retrievalScoreInput: retrievalScore,
      scoredAt: "2026-08-30T08:04:00.000Z",
      split: "development",
    });
    expect(readerScore.schemaVersion).toBe(3);
    expect(readerScore.policyBreakdown).toMatchObject({
      full_answer: { cases: 144, groundedSuccessCases: 0, securityFailureCases: 0 },
      supported_negative: { cases: 24, groundedSuccessCases: 0, securityFailureCases: 0 },
      partial_known_plus_missing: {
        cases: 24,
        groundedSuccessCases: 0,
        securityFailureCases: 0,
      },
      direct_unknown: { cases: 48, groundedSuccessCases: 48, securityFailureCases: 0 },
    });
    expect(readerScore.gates).toMatchObject({
      readerGatePassed: false,
      readerSecurityRegressions: 0,
      readerSecurityRegressionEdges: 0,
    });
  });
});
