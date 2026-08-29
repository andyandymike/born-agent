import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

import { memoryRecordRevisionId } from "../../../../src/memory/core/memory-record-v1.js";
import { Fts5EpisodeProjection } from "../../../../src/memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../../../src/memory/retrieval/lexical-memory-search-service.js";
import {
  falEm0CaseQuery,
  materializeFalEm0Case,
} from "../../../../src/frontier-adapters/local-embedding/fal-em0-baseline-runner.js";
import { loadFalEm0Corpus } from "../../../../src/frontier-adapters/local-embedding/fal-em0-manifest.js";
import type { FalEm0ReceiptV1 } from "../../../../src/frontier-adapters/local-embedding/fal-em0-receipt.js";
import { EM_R1_HISTORICAL_THRESHOLD_MICROS } from "./experiment-schema.js";
import {
  prepareHybridQuery,
  prepareVectorCorpus,
  selectHybridAtThreshold,
  type HybridCorpusPort,
} from "./hybrid-retrieval.js";
import type { LocalEmbeddingPort } from "./local-e5-provider.js";

export interface FidelityReplayResult {
  readonly cases: readonly Readonly<{
    readonly abstentionMatched: boolean;
    readonly caseId: string;
    readonly expectedAbstained: boolean;
    readonly expectedOrderedRecordKeys: readonly string[];
    readonly expectedQueryKind: string;
    readonly observedAbstained: boolean;
    readonly observedOrderedRecordKeys: readonly string[];
    readonly observedQueryKind: string;
    readonly orderedRecordKeysMatched: boolean;
    readonly queryKindMatched: boolean;
  }>[];
  readonly matchedCases: number;
  readonly outputReplay: "matched" | "mismatched" | "inconclusive";
  readonly totalCases: 36;
}

export async function replayHistoricalEm1(input: Readonly<{
  readonly retainedRoot: string;
  readonly provider: LocalEmbeddingPort;
  readonly repositoryRoot: string;
}>): Promise<FidelityReplayResult> {
  const oldCorpus = await loadFalEm0Corpus(input.repositoryRoot);
  const oldReceipt = JSON.parse(await readFile(join(
    input.repositoryRoot,
    "fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1/experiment-receipt.json",
  ), "utf8")) as FalEm0ReceiptV1;
  await mkdir(input.retainedRoot, { recursive: true });
  const runRoot = await mkdtemp(join(input.retainedRoot, "replay-"));
  const cases = [];
  for (const [index, testCase] of oldCorpus.casePack.cases.entries()) {
    const expected = oldReceipt.cases[index]?.candidate;
    if (expected === undefined || expected === null || oldReceipt.cases[index]?.caseId !== testCase.caseId) {
      throw new Error(`EM-R1 historical receipt lacks candidate output for ${testCase.caseId}`);
    }
    const caseRoot = join(runRoot, `case-${String(index + 1).padStart(2, "0")}`);
    await mkdir(caseRoot, { recursive: false });
    const { SqliteEpisodeStore } = await import(
      "../../../../src/memory/store/sqlite-episode-store.js"
    );
    const store = await SqliteEpisodeStore.create({ stateRoot: caseRoot });
    let vectorProjection;
    try {
      const materialized = await materializeFalEm0Case(store, testCase);
      const projection = await Fts5EpisodeProjection.create({
        scope: materialized.currentScope,
        stateRoot: caseRoot,
      });
      const service = new LexicalMemorySearchService({
        inspectSource: async (record) => {
          const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record));
          if (fixture === undefined) throw new Error("EM-R1 fidelity source fixture is missing");
          return Object.freeze({ sourceStatus: fixture.sourceStatus });
        },
        projection,
        scope: materialized.currentScope,
        store,
      });
      const corpus: HybridCorpusPort = {
        currentScope: materialized.currentScope,
        keyByRevisionId: materialized.keyByRevisionId,
        projection,
        service,
        store,
        sourceAvailable: (record) =>
          materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record))?.sourceStatus ===
            "available",
        titleFor: (record) => {
          const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record));
          if (fixture === undefined) throw new Error("EM-R1 fidelity record title is missing");
          return fixture.text;
        },
      };
      const prepared = await prepareVectorCorpus({
        corpus,
        databasePath: join(caseRoot, "vectors.sqlite"),
        provider: input.provider,
      });
      vectorProjection = prepared.projection;
      const query = falEm0CaseQuery(testCase, materialized);
      const preparedQuery = await prepareHybridQuery({
        corpus,
        provider: input.provider,
        query,
        vectorProjection,
      });
      const observed = selectHybridAtThreshold(
        preparedQuery,
        EM_R1_HISTORICAL_THRESHOLD_MICROS,
      );
      const expectedAbstained = expected.abstained;
      const observedAbstained = !observed.accepted;
      cases.push(Object.freeze({
        abstentionMatched: expectedAbstained === observedAbstained,
        caseId: testCase.caseId,
        expectedAbstained,
        expectedOrderedRecordKeys: expected.orderedTopRecordKeys,
        expectedQueryKind: expected.queryKind,
        observedAbstained,
        observedOrderedRecordKeys: observed.orderedTopRecordKeys,
        observedQueryKind: observed.queryKind,
        orderedRecordKeysMatched:
          JSON.stringify(expected.orderedTopRecordKeys) === JSON.stringify(observed.orderedTopRecordKeys),
        queryKindMatched: expected.queryKind === observed.queryKind,
      }));
    } finally {
      vectorProjection?.close();
      store.close();
    }
  }
  const matchedCases = cases.filter((entry) =>
    entry.abstentionMatched && entry.orderedRecordKeysMatched && entry.queryKindMatched).length;
  return Object.freeze({
    cases: Object.freeze(cases),
    matchedCases,
    outputReplay: matchedCases === 36 ? "matched" : "mismatched",
    totalCases: 36,
  });
}
