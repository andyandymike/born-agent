import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import { createMl1EpisodeRecordV1, type Ml1EpisodeRecordV1, type Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import type { Ml1EpisodeViewV1 } from "../../src/memory/product/memory-service.js";
import { Fts5EpisodeProjection } from "../../src/memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../src/memory/retrieval/lexical-memory-search-service.js";
import { parseMl2SearchQuery } from "../../src/memory/retrieval/ml2-search-contract.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";

interface CorpusDocument {
  readonly key: string;
  readonly occurredAt: string;
  readonly taskPreview: string;
}

interface CorpusQuery {
  readonly expectedFirst: string;
  readonly id: string;
  readonly query?: string;
  readonly queryKind?: "exact_id";
  readonly relevant: readonly string[];
  readonly target?: string;
}

interface Ml2Corpus {
  readonly abstentionQueries: readonly { readonly id: string; readonly query: string; readonly reason: string }[];
  readonly documents: readonly CorpusDocument[];
  readonly queries: readonly CorpusQuery[];
  readonly scope: Ml1MemoryScopeV1;
  readonly thresholds: Readonly<{ readonly abstentionAccuracy: number; readonly mrr: number; readonly recallAt5: number }>;
}

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixtureRecord(document: CorpusDocument, scope: Ml1MemoryScopeV1): Ml1EpisodeRecordV1 {
  const source = {
    endEventId: `end-${document.key}`,
    endRawSha256: hashText(`end:${document.key}`),
    endSequence: 2,
    kind: "session_run_range" as const,
    rangeSha256: hashText(`range:${document.key}`),
    runId: `run-${document.key}`,
    sessionId: `session-${document.key}`,
    startEventId: `start-${document.key}`,
    startRawSha256: hashText(`start:${document.key}`),
    startSequence: 1,
  };
  const completion = {
    evidenceSha256: null,
    mode: "model_final" as const,
    reportSha256: null,
    steps: 1,
    toolCalls: 0,
  };
  const text = [
    `Task: ${document.taskPreview}`,
    "Outcome: completed",
    "Completion mode: model_final",
    "Steps: 1",
    "Tool calls: 0",
    "Evidence: none",
  ].join("\n");
  return createMl1EpisodeRecordV1({
    completion,
    kind: "episode",
    occurredAt: document.occurredAt,
    origin: "deterministic_episode",
    recordId: `episode_${sha256Canonical({ schema_version: 1, scope, source })}`,
    schemaVersion: 1,
    scope,
    source,
    taskInputSha256: hashText(document.taskPreview),
    taskPreview: document.taskPreview,
    text,
  });
}

async function corpus(): Promise<Ml2Corpus> {
  return JSON.parse(await readFile(resolve("fixtures/agent-memory/ml2/corpus.json"), "utf8")) as Ml2Corpus;
}

async function stateRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function available(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeViewV1> {
  return Promise.resolve(Object.freeze({ record, sourceStatus: "available", staleReason: null }));
}

async function searchHarness(input: Readonly<{
  readonly records: readonly Ml1EpisodeRecordV1[];
  readonly scope: Ml1MemoryScopeV1;
  readonly stateRoot: string;
}>) {
  const store = await SqliteEpisodeStore.create({ stateRoot: input.stateRoot });
  for (const record of input.records) await store.ingestEpisode(record);
  const projection = await Fts5EpisodeProjection.create({ scope: input.scope, stateRoot: input.stateRoot });
  const service = new LexicalMemorySearchService({
    inspectSource: available,
    projection,
    scope: input.scope,
    store,
  });
  return { projection, service, store };
}

describe("Agent memory ML2 deterministic retrieval", () => {
  it("ML2 fixed coding-memory corpus meets frozen Recall@5 MRR and abstention thresholds", async () => {
    const frozen = await corpus();
    const records = new Map(frozen.documents.map((document) => [document.key, fixtureRecord(document, frozen.scope)]));
    const root = await stateRoot("bornagent-ml2-corpus-");
    const harness = await searchHarness({ records: [...records.values()], scope: frozen.scope, stateRoot: root });
    try {
      let relevantFound = 0;
      let relevantTotal = 0;
      let reciprocalRank = 0;
      for (const queryCase of frozen.queries) {
        const query = queryCase.queryKind === "exact_id"
          ? records.get(queryCase.target!)!.recordId
          : queryCase.query!;
        const result = await harness.service.search({ limit: 5, query });
        const keys = result.hits.map((hit) => frozen.documents.find(
          (document) => records.get(document.key)!.recordId === hit.record.recordId,
        )!.key);
        expect(keys[0], queryCase.id).toBe(queryCase.expectedFirst);
        relevantTotal += queryCase.relevant.length;
        relevantFound += queryCase.relevant.filter((key) => keys.includes(key)).length;
        const firstRelevant = keys.findIndex((key) => queryCase.relevant.includes(key));
        reciprocalRank += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
      }
      let abstentions = 0;
      for (const queryCase of frozen.abstentionQueries) {
        const result = await harness.service.search({ limit: 5, query: queryCase.query });
        expect(result).toMatchObject({ abstentionReason: queryCase.reason, hits: [], status: "abstained" });
        abstentions += 1;
      }
      expect(relevantFound / relevantTotal).toBeGreaterThanOrEqual(frozen.thresholds.recallAt5);
      expect(reciprocalRank / frozen.queries.length).toBeGreaterThanOrEqual(frozen.thresholds.mrr);
      expect(abstentions / frozen.abstentionQueries.length).toBeGreaterThanOrEqual(
        frozen.thresholds.abstentionAccuracy,
      );
    } finally {
      harness.store.close();
    }
  });

  it("ML2 bounded search never exceeds candidate result text or token caps", async () => {
    const frozen = await corpus();
    const documents = Array.from({ length: 120 }, (_, index): CorpusDocument => ({
      key: `bounded-${String(index).padStart(3, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      taskPreview: `Shared lexical memory search candidate ${String(index).padStart(3, "0")}`,
    }));
    const root = await stateRoot("bornagent-ml2-bounds-");
    const harness = await searchHarness({
      records: documents.map((document) => fixtureRecord(document, frozen.scope)),
      scope: frozen.scope,
      stateRoot: root,
    });
    try {
      const result = await harness.service.search({ limit: 20, query: "shared lexical memory search candidate" });
      expect(result.candidates).toMatchObject({ cap: 100, matched: 100, truncated: true });
      expect(result.hits.length).toBeLessThanOrEqual(20);
      expect(result.budget.textBytesUsed).toBeLessThanOrEqual(result.budget.textBytesLimit);
      expect(result.budget.estimatedTokensUsed).toBeLessThanOrEqual(result.budget.estimatedTokensLimit);
      expect(() => parseMl2SearchQuery("x".repeat(1_025))).toThrowError(
        expect.objectContaining({ code: "memory_query_invalid" }),
      );
      expect(parseMl2SearchQuery("cache OR scope NOT memory").ftsExpression).toBe(
        '"cache" OR "or" OR "scope" OR "not" OR "memory"',
      );
    } finally {
      harness.store.close();
    }
  });

  it("ML2 scope filtering happens before FTS scoring and foreign scope returns zero hits", async () => {
    const frozen = await corpus();
    const root = await stateRoot("bornagent-ml2-scope-");
    const current = fixtureRecord(frozen.documents[0]!, frozen.scope);
    const foreignScope = Object.freeze({
      ...frozen.scope,
      canonicalRootIdentitySha256: "f".repeat(64),
    });
    const foreign = fixtureRecord({
      key: "foreign-only",
      occurredAt: "2026-02-01T00:00:00.000Z",
      taskPreview: "Foreign-only quasar retrieval secret",
    }, foreignScope);
    const store = await SqliteEpisodeStore.create({ stateRoot: root });
    try {
      await store.ingestEpisode(current);
      await store.ingestEpisode(foreign);
      const currentProjection = await Fts5EpisodeProjection.create({ scope: frozen.scope, stateRoot: root });
      const currentService = new LexicalMemorySearchService({
        inspectSource: available,
        projection: currentProjection,
        scope: frozen.scope,
        store,
      });
      expect(await currentService.search({ limit: 5, query: "quasar" })).toMatchObject({
        candidates: { matched: 0 },
        hits: [],
        status: "abstained",
      });
      const foreignProjection = await Fts5EpisodeProjection.create({ scope: foreignScope, stateRoot: root });
      const foreignService = new LexicalMemorySearchService({
        inspectSource: available,
        projection: foreignProjection,
        scope: foreignScope,
        store,
      });
      expect((await foreignService.search({ limit: 5, query: "quasar" })).hits[0]?.record.recordId)
        .toBe(foreign.recordId);
      expect(currentProjection.paths.databasePath).not.toBe(foreignProjection.paths.databasePath);
    } finally {
      store.close();
    }
  });

  it("ML2 deleted or corrupt FTS projection rebuilds with identical logical hit order", async () => {
    const frozen = await corpus();
    const records = frozen.documents.map((document) => fixtureRecord(document, frozen.scope));
    const root = await stateRoot("bornagent-ml2-rebuild-");
    const harness = await searchHarness({ records, scope: frozen.scope, stateRoot: root });
    try {
      const beforeDump = await harness.store.logicalDump(frozen.scope);
      const first = await harness.service.search({ limit: 5, query: "memory search scope" });
      expect(first.projection.action).toBe("rebuilt");
      const expectedHits = canonicalJson(first.hits);

      await rm(harness.projection.paths.retrievalRoot, { force: true, recursive: true });
      const afterDelete = await harness.service.search({ limit: 5, query: "memory search scope" });
      expect(afterDelete.projection.action).toBe("rebuilt");
      expect(canonicalJson(afterDelete.hits)).toBe(expectedHits);

      await writeFile(harness.projection.paths.databasePath, Buffer.from("not sqlite", "utf8"));
      const afterCorruption = await harness.service.search({ limit: 5, query: "memory search scope" });
      expect(afterCorruption.projection.action).toBe("rebuilt");
      expect(canonicalJson(afterCorruption.hits)).toBe(expectedHits);
      expect((await harness.store.logicalDump(frozen.scope)).logicalSha256).toBe(beforeDump.logicalSha256);

      const added = fixtureRecord({
        key: "projection-refresh",
        occurredAt: "2026-03-01T00:00:00.000Z",
        taskPreview: "Projection refresh sentinel episode",
      }, frozen.scope);
      await harness.store.ingestEpisode(added);
      const afterCanonicalChange = await harness.service.search({ limit: 5, query: "refresh sentinel" });
      expect(afterCanonicalChange.projection.action).toBe("rebuilt");
      expect(afterCanonicalChange.hits[0]?.record.recordId).toBe(added.recordId);
    } finally {
      harness.store.close();
    }
  });
});
