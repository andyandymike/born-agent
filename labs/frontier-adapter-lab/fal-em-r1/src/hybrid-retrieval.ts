import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { DeterministicTokenEstimator } from "../../../../src/context/token-estimator.js";
import {
  memoryRecordRevisionId,
  sameMemoryScope,
  type MemoryRecordV1,
} from "../../../../src/memory/core/memory-record-v1.js";
import type { Fts5EpisodeProjection, Ml2Fts5CandidateV1 } from "../../../../src/memory/retrieval/fts5-episode-projection.js";
import type { LexicalMemorySearchService } from "../../../../src/memory/retrieval/lexical-memory-search-service.js";
import {
  ML2_RETRIEVER_VERSION,
  ML2_SEARCH_MAX_CANDIDATES,
  ML2_SEARCH_MAX_ESTIMATED_TOKENS,
  ML2_SEARCH_MAX_TEXT_BYTES,
  parseMl2SearchQuery,
  type Ml2ParsedSearchQueryV1,
  type Ml2SearchResultV1,
} from "../../../../src/memory/retrieval/ml2-search-contract.js";
import type { MemoryStorePort } from "../../../../src/memory/store/sqlite-episode-store.js";
import type { Ml1MemoryScopeV1 } from "../../../../src/memory/core/ml1-episode-record.js";
import { EM_R1_RRF_K } from "./experiment-schema.js";
import {
  emR1PassageInput,
  emR1QueryInput,
  type LocalEmbeddingPort,
} from "./local-e5-provider.js";
import {
  SqliteVectorProjection,
  type EmR1ScoredVectorRow,
  type EmR1VectorProjectionIdentity,
  type EmR1VectorProjectionRow,
} from "./sqlite-vector-projection.js";

const TOKEN_ESTIMATOR = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "memory-search",
  provider: "bornagent",
  tokenizer: "utf8-conservative",
  version: ML2_RETRIEVER_VERSION,
});

export const EM_R1_PROJECTION_SCHEMA_SHA256 = sha256Canonical({
  dimensions: 384,
  l2Normalize: true,
  meanPooling: true,
  passagePrefix: "passage: ",
  queryPrefix: "query: ",
  schemaVersion: 1,
  tokenizerTruncationTokens: 512,
  vectorEncoding: "float32_le",
});

export interface HybridCorpusPort {
  readonly currentScope: Ml1MemoryScopeV1;
  readonly keyByRevisionId: ReadonlyMap<string, string>;
  readonly projection: Fts5EpisodeProjection;
  readonly service: LexicalMemorySearchService;
  readonly store: MemoryStorePort;
  sourceAvailable(record: MemoryRecordV1): boolean;
  titleFor(record: MemoryRecordV1): string;
}

interface LexicalRow {
  readonly key: string;
  readonly lexicalBm25: number;
  readonly occurredAt: string;
  readonly record: MemoryRecordV1;
  readonly recordId: string;
  readonly revisionId: string;
}

export interface PreparedVectorCorpus {
  readonly buildDurationMs: number;
  readonly embeddingDurationMs: number;
  readonly inputSecurityFailures: number;
  readonly projection: SqliteVectorProjection;
  readonly recordEmbeddingCalls: number;
  readonly rowSecurityFailures: number;
}

export interface PreparedHybridQuery {
  readonly baseline: Ml2SearchResultV1;
  readonly canonicalRefetches: number;
  readonly corpus: HybridCorpusPort;
  readonly lexicalRows: readonly LexicalRow[];
  readonly parsed: Ml2ParsedSearchQueryV1;
  readonly queryEmbeddingCalls: 0 | 1;
  readonly queryEmbeddingDurationMs: number | null;
  readonly queryInputSha256: string | null;
  readonly recordsByRevision: ReadonlyMap<string, MemoryRecordV1>;
  readonly revalidationFailures: number;
  readonly totalPreparationDurationMs: number;
  readonly vectorRows: readonly EmR1ScoredVectorRow[];
}

export interface HybridSelectionResult {
  readonly accepted: boolean;
  readonly abstentionReason: "no_available_match" | "no_searchable_terms" | "result_budget_exhausted" | null;
  readonly baselineOrderedRecordKeys: readonly string[];
  readonly canonicalRefetches: number;
  readonly eligibleVectorRowCount: number;
  readonly estimatedTokensUsed: number;
  readonly hybridOrderedRecordKeys: readonly string[];
  readonly lexicalOrderedRecordKeys: readonly string[];
  readonly marginMicros: number | null;
  readonly orderedTopRecordKeys: readonly string[];
  readonly queryEmbeddingCalls: 0 | 1;
  readonly queryEmbeddingDurationMs: number | null;
  readonly queryKind: Ml2ParsedSearchQueryV1["kind"];
  readonly queryRoute: "exact_bypass" | "lexical" | "hybrid";
  readonly revalidationFailures: number;
  readonly textBytesUsed: number;
  readonly thresholdSimilarityMicros: number | null;
  readonly top1SimilarityMicros: number | null;
  readonly top2SimilarityMicros: number | null;
  readonly vectorAcceptedCount: number;
  readonly vectorOrderedRecordKeys: readonly string[];
}

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareLexical(left: Ml2Fts5CandidateV1, right: Ml2Fts5CandidateV1): number {
  if (left.lexicalBm25 !== right.lexicalBm25) return left.lexicalBm25 - right.lexicalBm25;
  if (left.occurredAt !== right.occurredAt) return right.occurredAt.localeCompare(left.occurredAt);
  const byRecord = left.recordId.localeCompare(right.recordId);
  return byRecord !== 0 ? byRecord : left.revisionId.localeCompare(right.revisionId);
}

async function lexicalRowsFor(
  corpus: HybridCorpusPort,
  parsed: Ml2ParsedSearchQueryV1,
): Promise<readonly LexicalRow[]> {
  if (parsed.kind !== "lexical" || parsed.ftsExpression === null) return Object.freeze([]);
  const dump = await corpus.store.logicalDump(corpus.currentScope);
  const projected = await corpus.projection.search({
    candidateLimit: ML2_SEARCH_MAX_CANDIDATES,
    dump,
    ftsExpression: parsed.ftsExpression,
  });
  const rows: LexicalRow[] = [];
  for (const candidate of [...projected.candidates].sort(compareLexical)) {
    const record = await corpus.store.getActiveRecord({
      recordId: candidate.recordId,
      scope: corpus.currentScope,
    });
    if (
      record === null ||
      memoryRecordRevisionId(record) !== candidate.revisionId ||
      record.occurredAt !== candidate.occurredAt ||
      !corpus.sourceAvailable(record)
    ) continue;
    const key = corpus.keyByRevisionId.get(candidate.revisionId);
    if (key === undefined) throw new Error("EM-R1 lexical row lacks a fixture key");
    rows.push(Object.freeze({
      key,
      lexicalBm25: candidate.lexicalBm25,
      occurredAt: candidate.occurredAt,
      record,
      recordId: candidate.recordId,
      revisionId: candidate.revisionId,
    }));
  }
  return Object.freeze(rows);
}

export async function prepareVectorCorpus(input: Readonly<{
  readonly corpus: HybridCorpusPort;
  readonly databasePath: string;
  readonly provider: LocalEmbeddingPort;
}>): Promise<PreparedVectorCorpus> {
  const started = performance.now();
  const dump = await input.corpus.store.logicalDump(input.corpus.currentScope);
  const eligible = dump.records.filter((record) => input.corpus.sourceAvailable(record));
  let inputSecurityFailures = 0;
  for (const record of eligible) {
    if (!sameMemoryScope(record.scope, input.corpus.currentScope)) inputSecurityFailures += 1;
  }
  const rows: EmR1VectorProjectionRow[] = [];
  let embeddingDurationMs = 0;
  for (let offset = 0; offset < eligible.length; offset += 16) {
    const records = eligible.slice(offset, offset + 16);
    const passages = records.map((record) =>
      emR1PassageInput(input.corpus.titleFor(record), record.text));
    const embedded = await input.provider.embed(passages);
    embeddingDurationMs += embedded.durationMs;
    for (const [index, record] of records.entries()) {
      const revisionId = memoryRecordRevisionId(record);
      const key = input.corpus.keyByRevisionId.get(revisionId);
      const passage = passages[index];
      const vector = embedded.vectors[index];
      if (key === undefined || passage === undefined || vector === undefined) {
        throw new Error("EM-R1 projection build lost a row identity");
      }
      rows.push(Object.freeze({
        key,
        occurredAt: record.occurredAt,
        projectionInputSha256: rawSha256(passage),
        recordId: record.recordId,
        revisionId,
        vector,
      }));
    }
  }
  const identity: EmR1VectorProjectionIdentity = Object.freeze({
    activeRevisionSetSha256: sha256Canonical(dump.activeRevisionIds),
    canonicalLogicalSha256: dump.logicalSha256,
    modelArtifactManifestSha256: input.provider.modelArtifactManifestSha256,
    projectionSchemaSha256: EM_R1_PROJECTION_SCHEMA_SHA256,
    scopeSha256: sha256Canonical(input.corpus.currentScope),
  });
  const projection = await SqliteVectorProjection.build({
    identity,
    path: input.databasePath,
    rows,
  });
  let rowSecurityFailures = 0;
  for (const row of projection.rows) {
    const record = await input.corpus.store.getActiveRecord({
      recordId: row.recordId,
      scope: input.corpus.currentScope,
    });
    if (
      record === null ||
      memoryRecordRevisionId(record) !== row.revisionId ||
      !input.corpus.sourceAvailable(record)
    ) rowSecurityFailures += 1;
  }
  return Object.freeze({
    buildDurationMs: performance.now() - started,
    embeddingDurationMs,
    inputSecurityFailures,
    projection,
    recordEmbeddingCalls: rows.length,
    rowSecurityFailures,
  });
}

export async function prepareHybridQuery(input: Readonly<{
  readonly corpus: HybridCorpusPort;
  readonly provider: LocalEmbeddingPort;
  readonly query: string;
  readonly vectorProjection: SqliteVectorProjection;
}>): Promise<PreparedHybridQuery> {
  const started = performance.now();
  const parsed = parseMl2SearchQuery(input.query);
  const baseline = await input.corpus.service.search({ limit: 5, query: input.query });
  if (parsed.kind !== "lexical" || parsed.ftsExpression === null) {
    return Object.freeze({
      baseline,
      canonicalRefetches: baseline.hits.length,
      corpus: input.corpus,
      lexicalRows: Object.freeze([]),
      parsed,
      queryEmbeddingCalls: 0,
      queryEmbeddingDurationMs: null,
      queryInputSha256: null,
      recordsByRevision: new Map(baseline.hits.map((hit) => [
        memoryRecordRevisionId(hit.record),
        hit.record,
      ])),
      revalidationFailures: 0,
      totalPreparationDurationMs: performance.now() - started,
      vectorRows: Object.freeze([]),
    });
  }
  const lexicalRows = await lexicalRowsFor(input.corpus, parsed);
  const queryInput = emR1QueryInput(parsed.normalized);
  const embedded = await input.provider.embed([queryInput]);
  const queryVector = embedded.vectors[0];
  if (queryVector === undefined) throw new Error("EM-R1 query embedding is missing");
  const vectorRows = input.vectorProjection.scoreAll(queryVector);
  const identities = new Map<string, { readonly record: MemoryRecordV1; readonly valid: boolean }>();
  let canonicalRefetches = 0;
  let revalidationFailures = 0;
  for (const row of [...lexicalRows, ...vectorRows]) {
    if (identities.has(row.revisionId)) continue;
    canonicalRefetches += 1;
    const record = await input.corpus.store.getActiveRecord({
      recordId: row.recordId,
      scope: input.corpus.currentScope,
    });
    const valid = record !== null &&
      memoryRecordRevisionId(record) === row.revisionId &&
      record.occurredAt === row.occurredAt &&
      input.corpus.sourceAvailable(record);
    if (!valid) revalidationFailures += 1;
    if (record !== null) identities.set(row.revisionId, { record, valid });
  }
  return Object.freeze({
    baseline,
    canonicalRefetches,
    corpus: input.corpus,
    lexicalRows: Object.freeze(lexicalRows.filter((row) => identities.get(row.revisionId)?.valid)),
    parsed,
    queryEmbeddingCalls: 1,
    queryEmbeddingDurationMs: embedded.durationMs,
    queryInputSha256: rawSha256(queryInput),
    recordsByRevision: new Map([...identities.entries()]
      .filter(([, entry]) => entry.valid)
      .map(([revisionId, entry]) => [revisionId, entry.record])),
    revalidationFailures,
    totalPreparationDurationMs: performance.now() - started,
    vectorRows: Object.freeze(vectorRows.filter((row) => identities.get(row.revisionId)?.valid)),
  });
}

function baselineKeys(query: PreparedHybridQuery): readonly string[] {
  return Object.freeze(query.baseline.hits.map((hit) => {
    const key = query.corpus.keyByRevisionId.get(memoryRecordRevisionId(hit.record));
    if (key === undefined) throw new Error("EM-R1 baseline hit lacks a fixture key");
    return key;
  }));
}

export function selectHybridAtThreshold(
  query: PreparedHybridQuery,
  thresholdSimilarityMicros: number,
): HybridSelectionResult {
  const directKeys = baselineKeys(query);
  if (query.parsed.kind !== "lexical" || query.parsed.ftsExpression === null) {
    return Object.freeze({
      accepted: directKeys.length > 0,
      abstentionReason: query.baseline.abstentionReason,
      baselineOrderedRecordKeys: directKeys,
      canonicalRefetches: query.canonicalRefetches,
      eligibleVectorRowCount: 0,
      estimatedTokensUsed: query.baseline.budget.estimatedTokensUsed,
      hybridOrderedRecordKeys: directKeys,
      lexicalOrderedRecordKeys: directKeys,
      marginMicros: null,
      orderedTopRecordKeys: directKeys,
      queryEmbeddingCalls: 0,
      queryEmbeddingDurationMs: null,
      queryKind: query.parsed.kind,
      queryRoute: query.parsed.kind === "exact_id" ? "exact_bypass" : "lexical",
      revalidationFailures: query.revalidationFailures,
      textBytesUsed: query.baseline.budget.textBytesUsed,
      thresholdSimilarityMicros: null,
      top1SimilarityMicros: null,
      top2SimilarityMicros: null,
      vectorAcceptedCount: 0,
      vectorOrderedRecordKeys: Object.freeze([]),
    });
  }
  const vectorRows = query.vectorRows
    .filter((entry) => entry.similarityMicros >= thresholdSimilarityMicros)
    .slice(0, 100);
  const lexicalRank = new Map(query.lexicalRows.map((entry, index) => [entry.revisionId, index + 1]));
  const vectorRank = new Map(vectorRows.map((entry, index) => [entry.revisionId, index + 1]));
  const lexicalByRevision = new Map(query.lexicalRows.map((entry) => [entry.revisionId, entry]));
  const vectorByRevision = new Map(vectorRows.map((entry) => [entry.revisionId, entry]));
  const identities = new Set([...lexicalRank.keys(), ...vectorRank.keys()]);
  const fused = [...identities].map((revisionId) => {
    const lexical = lexicalByRevision.get(revisionId);
    const vector = vectorByRevision.get(revisionId);
    const key = lexical?.key ?? vector?.key;
    if (key === undefined) throw new Error("EM-R1 fusion candidate lacks a fixture key");
    const occurredAt = lexical?.occurredAt ?? vector!.occurredAt;
    const recordId = lexical?.recordId ?? vector!.recordId;
    return {
      key,
      lexicalPresent: lexical !== undefined,
      occurredAt,
      recordId,
      revisionId,
      rrfScore: (lexical === undefined ? 0 : 1 / (EM_R1_RRF_K + lexicalRank.get(revisionId)!)) +
        (vector === undefined ? 0 : 1 / (EM_R1_RRF_K + vectorRank.get(revisionId)!)),
      similarityMicros: vector?.similarityMicros ?? Number.NEGATIVE_INFINITY,
    };
  });
  fused.sort((left, right) =>
    right.rrfScore - left.rrfScore ||
    Number(right.lexicalPresent) - Number(left.lexicalPresent) ||
    right.similarityMicros - left.similarityMicros ||
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.recordId.localeCompare(right.recordId) ||
    left.revisionId.localeCompare(right.revisionId));

  const selectedKeys: string[] = [];
  let estimatedTokensUsed = 0;
  let textBytesUsed = 0;
  let stoppedForBudget = false;
  for (const candidate of fused) {
    if (selectedKeys.length === 5) break;
    const record = query.recordsByRevision.get(candidate.revisionId);
    if (record === undefined) throw new Error("EM-R1 fused candidate lacks canonical record text");
    const estimate = TOKEN_ESTIMATOR.estimateText(record.text);
    if (
      textBytesUsed + estimate.utf8Bytes > ML2_SEARCH_MAX_TEXT_BYTES ||
      estimatedTokensUsed + estimate.estimatedTokens > ML2_SEARCH_MAX_ESTIMATED_TOKENS
    ) {
      stoppedForBudget = true;
      break;
    }
    selectedKeys.push(candidate.key);
    textBytesUsed += estimate.utf8Bytes;
    estimatedTokensUsed += estimate.estimatedTokens;
  }
  const top1 = query.vectorRows[0]?.similarityMicros ?? null;
  const top2 = query.vectorRows[1]?.similarityMicros ?? null;
  return Object.freeze({
    accepted: selectedKeys.length > 0,
    abstentionReason: selectedKeys.length > 0
      ? null
      : stoppedForBudget ? "result_budget_exhausted" : "no_available_match",
    baselineOrderedRecordKeys: directKeys,
    canonicalRefetches: query.canonicalRefetches,
    eligibleVectorRowCount: query.vectorRows.length,
    estimatedTokensUsed,
    hybridOrderedRecordKeys: Object.freeze(fused.map((entry) => entry.key)),
    lexicalOrderedRecordKeys: Object.freeze(query.lexicalRows.map((entry) => entry.key)),
    marginMicros: top1 === null || top2 === null ? null : top1 - top2,
    orderedTopRecordKeys: Object.freeze(selectedKeys),
    queryEmbeddingCalls: 1,
    queryEmbeddingDurationMs: query.queryEmbeddingDurationMs,
    queryKind: query.parsed.kind,
    queryRoute: "hybrid",
    revalidationFailures: query.revalidationFailures,
    textBytesUsed,
    thresholdSimilarityMicros,
    top1SimilarityMicros: top1,
    top2SimilarityMicros: top2,
    vectorAcceptedCount: vectorRows.length,
    vectorOrderedRecordKeys: Object.freeze(vectorRows.map((entry) => entry.key)),
  });
}
