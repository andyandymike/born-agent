import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { memoryRecordRevisionId } from "../../../../src/memory/core/memory-record-v1.js";
import {
  loadSharedExecutorSplit,
  loadSharedScoringSplit,
} from "../src/benchmark-schema.js";
import { createRetrievalObservationPack } from "../src/observation-schema.js";
import { createReaderObservationPack, sharedReaderArms } from "../src/reader-schema.js";
import { scoreSharedReader } from "../src/reader-scorer.js";
import { scoreSharedRetrieval } from "../src/shared-scorer.js";
import {
  materializeSharedTimeline,
  sharedSourceAvailable,
} from "../src/shared-corpus-materializer.js";

const repositoryRoot = resolve(process.cwd());
const rawSha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("FAL shared memory runner and scorer", () => {
  test("materializes exactly the current-scope available active record set", async () => {
    const executor = await loadSharedExecutorSplit(repositoryRoot, "development");
    const timeline = executor.timelines[0]!;
    const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-shared-memory-"));
    const materialized = await materializeSharedTimeline(stateRoot, timeline);
    try {
      const dump = await materialized.store.logicalDump(materialized.currentScope);
      const actual = dump.records
        .filter((record) => sharedSourceAvailable(materialized, record))
        .map((record) => materialized.keyByRevisionId.get(memoryRecordRevisionId(record)))
        .filter((entry): entry is string => entry !== undefined)
        .sort();
      const expected = timeline.records.filter((record) =>
        record.repositoryId === timeline.repositoryId &&
        record.principalId === timeline.principalId &&
        record.sourceStatus === "available" &&
        record.lifecycle !== "explicit_retracted" &&
        record.lifecycle !== "explicit_superseded")
        .map((record) => record.recordId)
        .sort();
      expect(actual).toEqual(expected);
    } finally {
      materialized.store.close();
      await rm(stateRoot, { force: true, recursive: true });
    }
  });

  test("selects the only preregistered eligible threshold without reading goldens in the worker", async () => {
    const [executor, goldens] = await Promise.all([
      loadSharedExecutorSplit(repositoryRoot, "development"),
      loadSharedScoringSplit(repositoryRoot, "development"),
    ]);
    const observation = createRetrievalObservationPack({
      schemaVersion: 1,
      benchmarkId: executor.benchmarkId,
      split: executor.split,
      generatedAt: "2026-08-29T06:00:00.000Z",
      executionBoundary: "executor_inputs_plus_frozen_candidates_no_goldens_no_network",
      candidate: {
        embeddingModelArtifactManifestSha256: "0".repeat(64),
        embeddingProjectionSchemaSha256: "1".repeat(64),
        embeddingRrfK: 60,
        foldingEstimatorVersion: "fal-cf2-v2",
      },
      coldEmbeddingModelLoadMs: 1,
      timelines: executor.timelines.map((timeline, timelineIndex) => {
        const goldenTimeline = goldens.timelines[timelineIndex]!;
        return {
          timelineId: timeline.timelineId,
          recordPoolSha256: timeline.recordPoolSha256,
          projection: {
            eligibleVectorRecordKeys: [],
            buildDurationMs: 1,
            embeddingDurationMs: 1,
            inputSecurityFailures: 0,
            recordEmbeddingCalls: 0,
            rowSecurityFailures: 0,
          },
          folding: {
            baselineProviderContext: "x",
            selectedProviderContext: "x",
            baselineBytes: 1,
            baselineTokens: 1,
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
          probes: timeline.probes.map((probe, probeIndex) => {
            const golden = goldenTimeline.probes[probeIndex]!;
            const required = golden.requiredEvidenceGroups
              .flatMap((group) => group.filter((entry) => entry.startsWith("record:")))
              .map((entry) => entry.slice("record:".length));
            return {
              probeId: probe.probeId,
              queryKind: "lexical",
              baselineTop5RecordKeys: [],
              baselineTop10RecordKeys: [],
              canonicalRefetches: 0,
              revalidationFailures: 0,
              queryEmbeddingCalls: 1,
              queryEmbeddingDurationMs: 1,
              totalPreparationDurationMs: 1,
              top1SimilarityMicros: 500_000,
              top2SimilarityMicros: 400_000,
              marginMicros: 100_000,
              thresholdBehaviors: [
                {
                  thresholdSimilarityMicros: 1_000_001,
                  orderedTop5RecordKeys: [],
                  orderedTop10RecordKeys: [],
                  vectorAcceptedCount: 0,
                },
                {
                  thresholdSimilarityMicros: 500_000,
                  orderedTop5RecordKeys: required.slice(0, 5),
                  orderedTop10RecordKeys: required.slice(0, 10),
                  vectorAcceptedCount: Math.min(100, required.length),
                },
              ],
            };
          }),
        };
      }),
    });
    const report = await scoreSharedRetrieval({
      observationInput: observation,
      repositoryRoot,
      scoredAt: "2026-08-29T06:01:00.000Z",
      split: "development",
    });
    const selection = report.selection as {
      readonly eligiblePointCount: number;
      readonly selectedOperatingPoint: null | { readonly thresholdSimilarityMicros: number };
    };
    expect(selection.eligiblePointCount).toBe(1);
    expect(selection.selectedOperatingPoint?.thresholdSimilarityMicros).toBe(500_000);
  });

  test("scores a perfectly grounded four-arm reader pack at one", async () => {
    const goldens = await loadSharedScoringSplit(repositoryRoot, "development");
    const rawResponse = "{\"synthetic\":true}";
    const observation = createReaderObservationPack({
      schemaVersion: 1,
      benchmarkId: goldens.benchmarkId,
      split: goldens.split,
      generatedAt: "2026-08-29T06:02:00.000Z",
      executionBoundary: "executor_inputs_plus_retrieval_observations_no_goldens_local_model_only",
      retrievalObservationSha256: "2".repeat(64),
      thresholdRole: "eligible_operating_point",
      thresholdSimilarityMicros: 500_000,
      reader: {
        model: "qwen3.5:2b",
        modelDigest: "324d162be6ca5629ae4517c8710434d0bd2d665bc94dbad46e9af8fbf8a2f0df",
        ollamaVersion: "0.32.1",
        promptContractSha256: "3".repeat(64),
        temperature: 0,
        seed: 42,
        numCtx: 32_768,
        numPredict: 4_096,
        think: false,
        maximumAttempts: 1,
        externalNetworkCalls: 0,
      },
      timelines: goldens.timelines.map((timeline) => ({
        timelineId: timeline.timelineId,
        arms: sharedReaderArms.map((arm) => ({
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
          localModelCalls: 1,
          reusedFromArm: null,
        })),
      })),
    });
    const retrievalScoreContent = {
      benchmarkId: observation.benchmarkId,
      split: observation.split,
      observationSha256: observation.retrievalObservationSha256,
      selection: { selectedOperatingPoint: { thresholdSimilarityMicros: 500_000 } },
    } as const;
    const report = await scoreSharedReader({
      readerObservationInput: observation,
      repositoryRoot,
      retrievalScoreInput: {
        ...retrievalScoreContent,
        scoreSha256: sha256Canonical(retrievalScoreContent),
      },
      scoredAt: "2026-08-29T06:03:00.000Z",
      split: "development",
    });
    const arms = report.arms as Record<string, { readonly macroGroundedSuccessMicros: number }>;
    expect(Object.values(arms).every((arm) => arm.macroGroundedSuccessMicros === 1_000_000))
      .toBe(true);
    expect((report.gates as { readonly readerGatePassed: boolean }).readerGatePassed).toBe(true);
  });
});
