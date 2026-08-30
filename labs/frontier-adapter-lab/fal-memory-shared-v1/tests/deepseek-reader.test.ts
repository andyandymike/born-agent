import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  callDeepSeekReader,
  DEEPSEEK_DOCUMENTED_MODEL_VERSION,
  DEEPSEEK_MODEL_ALIAS,
  DEEPSEEK_OUTPUT_SCHEMA_SHA256,
  DEEPSEEK_PRICING_SNAPSHOT,
  DEEPSEEK_READER_PROMPT_CONTRACT_SHA256,
  DEEPSEEK_RESPONSES_ENDPOINT,
  deepSeekBillingWindow,
  estimateDeepSeekCostUsdMicros,
} from "../src/deepseek-reader-worker.js";
import { runDeepSeekReaderSmoke } from "../src/deepseek-reader-smoke.js";
import { loadSharedScoringSplit } from "../src/benchmark-schema.js";
import {
  createDeepSeekReaderObservationPack,
  sharedReaderArms,
} from "../src/reader-schema.js";
import { scoreSharedReader } from "../src/reader-scorer.js";

const repositoryRoot = resolve(process.cwd());
const rawSha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function deepSeekResponse(outputText: string, inputTokens = 1_000): Response {
  return new Response(JSON.stringify({
    id: "response-test-1",
    status: "completed",
    model: DEEPSEEK_MODEL_ALIAS,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: outputText }],
    }],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 250 },
      output_tokens: 100,
      total_tokens: inputTokens + 100,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("FAL shared memory DeepSeek reader", () => {
  test("classifies the official peak windows and computes frozen V4 Flash pricing", () => {
    expect(deepSeekBillingWindow(new Date("2026-08-31T01:30:00.000Z"))).toBe("peak");
    expect(deepSeekBillingWindow(new Date("2026-08-31T04:30:00.000Z"))).toBe("off_peak");
    expect(deepSeekBillingWindow(new Date("2026-08-30T07:00:00.000Z"))).toBe("off_peak");
    expect(estimateDeepSeekCostUsdMicros({
      billingWindow: "off_peak",
      cachedInputTokens: 250,
      inputTokens: 1_000,
      outputTokens: 100,
    })).toBe(233);
    expect(estimateDeepSeekCostUsdMicros({
      billingWindow: "peak",
      cachedInputTokens: 250,
      inputTokens: 1_000,
      outputTokens: 100,
    })).toBe(466);
  });

  test("calls only the allowlisted Responses endpoint with non-thinking JSON Schema", async () => {
    const expectedProbeIds = ["probe-a", "probe-b", "probe-c", "probe-d", "probe-e"];
    const outputText = JSON.stringify({
      answers: expectedProbeIds.map((probeId, index) => ({
        probeId,
        action: index === 0 ? "answer" : "abstain",
        answer: index === 0 ? "cobalt-blue" : "",
        evidenceRefs: index === 0 ? ["record:test-a"] : [],
      })),
    });
    let requestUrl = "";
    let requestBody: Readonly<Record<string, unknown>> | undefined;
    let authorization = "";
    const result = await callDeepSeekReader({
      apiKey: "test-api-key-123",
      expectedProbeIds,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return deepSeekResponse(outputText);
      },
      now: () => new Date("2026-08-30T07:00:00.000Z"),
      prompt: "Return valid json for this fixed synthetic packet.",
    });
    expect(requestUrl).toBe(DEEPSEEK_RESPONSES_ENDPOINT);
    expect(authorization).toBe("Bearer test-api-key-123");
    expect(requestBody?.model).toBe(DEEPSEEK_MODEL_ALIAS);
    expect(requestBody?.reasoning).toEqual({ effort: "none" });
    expect(requestBody?.temperature).toBe(0);
    expect(requestBody?.text).toMatchObject({ format: { type: "json_schema" } });
    expect(result.parseState).toBe("parsed");
    expect(result.answers).toHaveLength(5);
    expect(result.receipt.estimatedCostUsdMicros).toBe(233);
  });

  test("scores the fixed one-call smoke without exposing credentials", async () => {
    const outputText = JSON.stringify({
      answers: [
        {
          probeId: "smoke-probe-1",
          action: "answer",
          answer: "cobalt-blue",
          evidenceRefs: ["record:smoke-record-1"],
        },
        {
          probeId: "smoke-probe-2",
          action: "answer",
          answer: "alpha -> beta",
          evidenceRefs: ["record:smoke-record-2-old", "record:smoke-record-2-current"],
        },
        { probeId: "smoke-probe-3", action: "abstain", answer: "", evidenceRefs: [] },
        {
          probeId: "smoke-probe-4",
          action: "answer",
          answer: "48000Hz",
          evidenceRefs: ["record:smoke-record-4"],
        },
        { probeId: "smoke-probe-5", action: "abstain", answer: "", evidenceRefs: [] },
      ],
    });
    const receipt = await runDeepSeekReaderSmoke({
      apiKey: "test-api-key-123",
      fetchImpl: async () => deepSeekResponse(outputText),
      generatedAt: "2026-08-30T07:01:00.000Z",
      now: () => new Date("2026-08-30T07:01:00.000Z"),
    });
    expect(receipt.passed).toBe(true);
    expect(receipt.failureReasons).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain("test-api-key-123");
  });

  test("scores schema-v2 remote observations and preserves token/cost evidence", async () => {
    const goldens = await loadSharedScoringSplit(repositoryRoot, "development");
    const rawResponse = "{\"synthetic\":true}";
    let responseOrdinal = 0;
    const observation = createDeepSeekReaderObservationPack({
      schemaVersion: 2,
      benchmarkId: goldens.benchmarkId,
      split: goldens.split,
      generatedAt: "2026-08-30T07:02:00.000Z",
      executionBoundary:
        "executor_inputs_plus_retrieval_observations_no_goldens_allowlisted_remote_model_only",
      retrievalObservationSha256: "2".repeat(64),
      thresholdRole: "eligible_operating_point",
      thresholdSimilarityMicros: 500_000,
      reader: {
        provider: "deepseek",
        api: "responses",
        endpoint: DEEPSEEK_RESPONSES_ENDPOINT,
        modelAlias: DEEPSEEK_MODEL_ALIAS,
        documentedModelVersion: DEEPSEEK_DOCUMENTED_MODEL_VERSION,
        reportedModels: [DEEPSEEK_MODEL_ALIAS],
        promptContractSha256: DEEPSEEK_READER_PROMPT_CONTRACT_SHA256,
        outputSchemaSha256: DEEPSEEK_OUTPUT_SCHEMA_SHA256,
        temperature: 0,
        seed: null,
        maxOutputTokens: 4_096,
        reasoningEffort: "none",
        maximumAttempts: 1,
        externalNetworkCalls: goldens.timelines.length * sharedReaderArms.length,
        inputPolicy: "public_synthetic_development_calibration_only",
        pricing: DEEPSEEK_PRICING_SNAPSHOT,
      },
      timelines: goldens.timelines.map((timeline) => ({
        timelineId: timeline.timelineId,
        arms: sharedReaderArms.map((arm) => {
          responseOrdinal += 1;
          return {
            arm,
            retrievalMode: arm.startsWith("fts_") ? "fts_recency" : "local_embedding",
            receiptProjectionMode: arm.endsWith("context_fold") ? "context_fold" : "baseline",
            thresholdSimilarityMicros: arm.startsWith("fts_") ? null : 500_000,
            promptSha256: "4".repeat(64),
            promptBytes: 1,
            receiptContextSha256: "5".repeat(64),
            availableEvidenceRefs: [...new Set(timeline.probes.flatMap((probe) =>
              probe.requiredEvidenceGroups.flat()))],
            parseState: "parsed",
            rawResponse,
            rawResponseSha256: rawSha256(rawResponse),
            answers: timeline.probes.map((probe) => ({
              probeId: probe.probeId,
              action: probe.expectedAction,
              answer: probe.answerAtoms.map((atom) => atom.value).join("; "),
              evidenceRefs: probe.requiredEvidenceGroups.map((group) => group[0]!),
            })),
            durationMs: 1,
            modelCalls: 1,
            callReceipts: [{
              requestStartedAt: "2026-08-30T07:02:00.000Z",
              responseId: `response-${responseOrdinal}`,
              reportedModel: DEEPSEEK_MODEL_ALIAS,
              responseStatus: "completed",
              outputTextSha256: rawSha256(rawResponse),
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 20,
              totalTokens: 120,
              billingWindow: "off_peak",
              estimatedCostUsdMicros: 31,
              durationMs: 1,
            }],
            reusedFromArm: null,
          };
        }),
      })),
    });
    const report = await scoreSharedReader({
      readerObservationInput: observation,
      repositoryRoot,
      retrievalScoreInput: {
        scoreSha256: "6".repeat(64),
        selection: { selectedOperatingPoint: { thresholdSimilarityMicros: 500_000 } },
      },
      scoredAt: "2026-08-30T07:03:00.000Z",
      split: "development",
    });
    expect(report.schemaVersion).toBe(2);
    expect((report.gates as { readonly readerGatePassed: boolean }).readerGatePassed).toBe(true);
    expect(report.execution).toMatchObject({
      modelCalls: 24,
      externalNetworkCalls: 24,
      inputTokens: 2_400,
      cachedInputTokens: 480,
      outputTokens: 480,
      totalTokens: 2_880,
      estimatedCostUsdMicros: 744,
    });
  });
});
