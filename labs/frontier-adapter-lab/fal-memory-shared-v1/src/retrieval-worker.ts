import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import { memoryRecordRevisionId } from "../../../../src/memory/core/memory-record-v1.js";
import {
  cf2ContextFoldingEstimator,
  selectAcceptedChildReceiptContext,
} from "../../fal-cf2-context-folding-v2/src/context-fold.js";
import { EM_R1_RRF_K } from "../../fal-em-r1/src/experiment-schema.js";
import {
  EM_R1_PROJECTION_SCHEMA_SHA256,
  prepareHybridQuery,
  prepareVectorCorpus,
  selectHybridAtThreshold,
  type HybridCorpusPort,
} from "../../fal-em-r1/src/hybrid-retrieval.js";
import { LocalE5EmbeddingProvider } from "../../fal-em-r1/src/local-e5-provider.js";

import {
  loadSharedExecutorSplit,
  type BenchmarkSplit,
} from "./benchmark-schema.js";
import { answerPolicyV2ExecutorPackSchema } from "./answer-policy-v2.js";
import {
  createAnswerPolicyV2RetrievalObservationPack,
  createRetrievalObservationPack,
  type RetrievalObservationPack,
} from "./observation-schema.js";
import {
  materializeSharedTimeline,
  sharedFixtureTitle,
  sharedSourceAvailable,
} from "./shared-corpus-materializer.js";

const REJECT_ALL_THRESHOLD_MICROS = 1_000_001;

export interface SharedRetrievalWorkerProgress {
  readonly completedTimelines: number;
  readonly split: BenchmarkSplit;
  readonly timelineId: string;
  readonly totalTimelines: number;
}

function baselineProviderContext(
  benchmarkId: string,
  timelineId: string,
  acceptedChildReceipts: readonly unknown[],
): Readonly<{
  readonly providerContext: string;
  readonly taskContext: Readonly<Record<string, unknown>>;
}> {
  const taskContext = Object.freeze({
    schemaVersion: 1,
    benchmarkId,
    timelineId,
    acceptedChildReceipts,
  });
  return Object.freeze({
    providerContext: `BORNAGENT_TASK_CONTEXT_V1\n${canonicalJson(taskContext)}`,
    taskContext,
  });
}

function behaviorThresholds(
  vectorRows: readonly Readonly<{ readonly similarityMicros: number }>[],
): readonly number[] {
  return Object.freeze([
    REJECT_ALL_THRESHOLD_MICROS,
    ...new Set(vectorRows.slice(0, 100).map((entry) => entry.similarityMicros)),
  ].sort((left, right) => right - left));
}

export async function runSharedRetrievalWorker(input: Readonly<{
  readonly answerPolicyV2ExecutorInput?: unknown;
  readonly generatedAt: string;
  readonly onProgress?: (progress: SharedRetrievalWorkerProgress) => void;
  readonly repositoryRoot: string;
  readonly split: BenchmarkSplit;
  readonly stateParent: string;
}>): Promise<RetrievalObservationPack> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const executor = input.answerPolicyV2ExecutorInput === undefined
    ? await loadSharedExecutorSplit(repositoryRoot, input.split)
    : answerPolicyV2ExecutorPackSchema.parse(input.answerPolicyV2ExecutorInput);
  if (executor.split !== input.split) {
    throw new Error("shared retrieval executor split mismatch");
  }
  if (executor.benchmarkId === "fal-memory-shared-v2" && executor.split === "evaluation") {
    throw new Error("answer-policy v2 evaluation is not sealed and cannot run");
  }
  const labRoot = join(repositoryRoot, "labs", "frontier-adapter-lab", "fal-em-r1");
  const loaded = await LocalE5EmbeddingProvider.load(labRoot);
  await mkdir(input.stateParent, { recursive: true });
  const timelines: unknown[] = [];

  try {
    for (const [timelineIndex, timeline] of executor.timelines.entries()) {
      const stateRoot = await mkdtemp(join(resolve(input.stateParent), `${timeline.timelineId}-`));
      let materialized: Awaited<ReturnType<typeof materializeSharedTimeline>> | undefined;
      let vectorProjection: Awaited<ReturnType<typeof prepareVectorCorpus>> | undefined;
      try {
        materialized = await materializeSharedTimeline(stateRoot, timeline);
        const corpus: HybridCorpusPort = {
          currentScope: materialized.currentScope,
          keyByRevisionId: materialized.keyByRevisionId,
          projection: materialized.projection,
          service: materialized.service,
          store: materialized.store,
          sourceAvailable: (record) => sharedSourceAvailable(materialized!, record),
          titleFor: (record) => sharedFixtureTitle(materialized!, record),
        };
        vectorProjection = await prepareVectorCorpus({
          corpus,
          databasePath: join(stateRoot, "shared-vector.sqlite3"),
          provider: loaded.provider,
        });
        const foldingBaseline = baselineProviderContext(
          executor.benchmarkId,
          timeline.timelineId,
          timeline.acceptedChildReceipts,
        );
        const folding = selectAcceptedChildReceiptContext({
          acceptedChildReceipts: timeline.acceptedChildReceipts,
          baselineProviderContext: foldingBaseline.providerContext,
          baselineTaskContext: foldingBaseline.taskContext,
          enabled: true,
        });
        const baselineBytes = Buffer.byteLength(foldingBaseline.providerContext, "utf8");
        const baselineTokens = cf2ContextFoldingEstimator
          .estimateText(foldingBaseline.providerContext).estimatedTokens;

        const probes: unknown[] = [];
        for (const probe of timeline.probes) {
          const prepared = await prepareHybridQuery({
            corpus,
            provider: loaded.provider,
            query: probe.query,
            vectorProjection: vectorProjection.projection,
          });
          const baselineTop5RecordKeys = prepared.baseline.hits.map((hit) => {
            const revisionId = memoryRecordRevisionId(hit.record);
            const key = materialized!.keyByRevisionId.get(revisionId);
            if (key === undefined) throw new Error("shared baseline hit lacks a fixture record key");
            return key;
          });
          const baselineTop10RecordKeys = prepared.lexicalRows.length > 0
            ? prepared.lexicalRows.slice(0, 10).map((entry) => entry.key)
            : baselineTop5RecordKeys;
          const thresholds = behaviorThresholds(prepared.vectorRows);
          const thresholdBehaviors = thresholds.map((thresholdSimilarityMicros) => {
            const selection = selectHybridAtThreshold(prepared, thresholdSimilarityMicros);
            return Object.freeze({
              thresholdSimilarityMicros,
              orderedTop5RecordKeys: selection.orderedTopRecordKeys,
              orderedTop10RecordKeys: selection.hybridOrderedRecordKeys.slice(0, 10),
              vectorAcceptedCount: selection.vectorAcceptedCount,
            });
          });
          const top1 = prepared.vectorRows[0]?.similarityMicros ?? null;
          const top2 = prepared.vectorRows[1]?.similarityMicros ?? null;
          probes.push(Object.freeze({
            probeId: probe.probeId,
            queryKind: prepared.parsed.kind,
            baselineTop5RecordKeys,
            baselineTop10RecordKeys,
            canonicalRefetches: prepared.canonicalRefetches,
            revalidationFailures: prepared.revalidationFailures,
            queryEmbeddingCalls: prepared.queryEmbeddingCalls,
            queryEmbeddingDurationMs: prepared.queryEmbeddingDurationMs,
            totalPreparationDurationMs: prepared.totalPreparationDurationMs,
            top1SimilarityMicros: top1,
            top2SimilarityMicros: top2,
            marginMicros: top1 === null || top2 === null ? null : top1 - top2,
            thresholdBehaviors,
          }));
        }

        timelines.push(Object.freeze({
          timelineId: timeline.timelineId,
          recordPoolSha256: timeline.recordPoolSha256,
          projection: Object.freeze({
            eligibleVectorRecordKeys: vectorProjection.projection.rows.map((entry) => entry.key),
            buildDurationMs: vectorProjection.buildDurationMs,
            embeddingDurationMs: vectorProjection.embeddingDurationMs,
            inputSecurityFailures: vectorProjection.inputSecurityFailures,
            recordEmbeddingCalls: vectorProjection.recordEmbeddingCalls,
            rowSecurityFailures: vectorProjection.rowSecurityFailures,
          }),
          folding: Object.freeze({
            baselineProviderContext: foldingBaseline.providerContext,
            selectedProviderContext: folding.providerContext,
            baselineBytes,
            baselineTokens,
            candidateBytes: folding.candidateBytes,
            candidateTokens: folding.candidateTokens,
            diagnosticCode: folding.diagnosticCode,
            foldSha256: folding.fold?.foldSha256 ?? null,
            losslessExpansion: folding.losslessExpansion,
            mode: folding.mode,
            reason: folding.reason,
            selected: folding.selected,
            modelCalls: folding.modelCalls,
            networkCalls: folding.networkCalls,
            toolCalls: folding.toolCalls,
          }),
          probes,
        }));
      } finally {
        try { vectorProjection?.projection.close(); } catch { /* observation is already isolated */ }
        try { materialized?.store.close(); } catch { /* observation is already isolated */ }
        await rm(stateRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
      }
      input.onProgress?.({
        completedTimelines: timelineIndex + 1,
        split: input.split,
        timelineId: timeline.timelineId,
        totalTimelines: executor.timelines.length,
      });
    }

    const observationContent = {
      benchmarkId: executor.benchmarkId,
      split: executor.split,
      generatedAt: input.generatedAt,
      executionBoundary: "executor_inputs_plus_frozen_candidates_no_goldens_no_network",
      candidate: {
        embeddingModelArtifactManifestSha256: loaded.provider.modelArtifactManifestSha256,
        embeddingProjectionSchemaSha256: EM_R1_PROJECTION_SCHEMA_SHA256,
        embeddingRrfK: EM_R1_RRF_K,
        foldingEstimatorVersion: "fal-cf2-v2",
      },
      coldEmbeddingModelLoadMs: loaded.coldLoadMs,
      timelines,
    } as const;
    return executor.benchmarkId === "fal-memory-shared-v2"
      ? createAnswerPolicyV2RetrievalObservationPack({
          ...observationContent,
          schemaVersion: 2,
          executorSha256: executor.executorSha256,
          answerPolicyProtocolSha256: executor.answerPolicyProtocolSha256,
        })
      : createRetrievalObservationPack({
          ...observationContent,
          schemaVersion: 1,
        });
  } finally {
    await loaded.provider.dispose();
  }
}
