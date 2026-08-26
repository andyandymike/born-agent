import { sha256Canonical } from "../../completion/canonical-json.js";
import { DeterministicTokenEstimator, type TokenEstimator } from "../../context/token-estimator.js";
import type { Ml1EpisodeRecordV1, Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import type { Ml1EpisodeViewV1 } from "../product/memory-service.js";
import type { Ml1EpisodeStorePort } from "../store/sqlite-episode-store.js";
import type { Fts5EpisodeProjection, Ml2Fts5CandidateV1 } from "./fts5-episode-projection.js";
import {
  ML2_RETRIEVER_ID,
  ML2_RETRIEVER_VERSION,
  ML2_SEARCH_MAX_CANDIDATES,
  ML2_SEARCH_MAX_ESTIMATED_TOKENS,
  ML2_SEARCH_MAX_RESULTS,
  ML2_SEARCH_MAX_TEXT_BYTES,
  normalizedPhraseAppears,
  parseMl2SearchQuery,
  type Ml2ParsedSearchQueryV1,
  type Ml2SearchAbstentionReasonV1,
  type Ml2SearchHitV1,
  type Ml2SearchResultV1,
} from "./ml2-search-contract.js";

const SEARCH_ESTIMATOR = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "memory-search",
  provider: "bornagent",
  tokenizer: "utf8-conservative",
  version: ML2_RETRIEVER_VERSION,
});

interface AvailableCandidate {
  readonly lexicalBm25: number | null;
  readonly reason: Ml2SearchHitV1["reason"];
  readonly record: Ml1EpisodeRecordV1;
}

function compareCandidates(left: Ml2Fts5CandidateV1, right: Ml2Fts5CandidateV1): number {
  if (left.lexicalBm25 !== right.lexicalBm25) return left.lexicalBm25 - right.lexicalBm25;
  if (left.occurredAt !== right.occurredAt) return right.occurredAt.localeCompare(left.occurredAt);
  return left.recordId.localeCompare(right.recordId);
}

export class LexicalMemorySearchService {
  constructor(private readonly input: Readonly<{
    readonly inspectSource: (record: Ml1EpisodeRecordV1) => Promise<Ml1EpisodeViewV1>;
    readonly projection: Fts5EpisodeProjection;
    readonly scope: Ml1MemoryScopeV1;
    readonly store: Ml1EpisodeStorePort;
    readonly tokenEstimator?: TokenEstimator;
  }>) {}

  async search(input: Readonly<{ readonly limit: number; readonly query: string }>): Promise<Ml2SearchResultV1> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ML2_SEARCH_MAX_RESULTS) {
      throw new Ml1MemoryError("memory_query_invalid", "memory search result limit must be between 1 and 20");
    }
    const parsed = parseMl2SearchQuery(input.query);
    const dump = await this.input.store.logicalDump(this.input.scope);
    const scopeSha256 = sha256Canonical(this.input.scope);
    if (parsed.kind !== "exact_id" && parsed.ftsExpression === null) {
      return this.result({
        abstentionReason: "no_searchable_terms",
        availableCandidates: [],
        canonicalLogicalSha256: dump.logicalSha256,
        candidateMatched: 0,
        candidateTruncated: false,
        limit: input.limit,
        parsed,
        projectionAction: "not_required",
        scopeSha256,
      });
    }

    if (parsed.kind === "exact_id") {
      const record = await this.input.store.getEpisode({
        recordId: parsed.exactRecordId,
        scope: this.input.scope,
      });
      const availableCandidates: AvailableCandidate[] = [];
      if (record !== null) {
        const view = await this.input.inspectSource(record);
        if (view.sourceStatus === "available") {
          availableCandidates.push({ lexicalBm25: null, reason: "exact_id", record });
        }
      }
      return this.result({
        abstentionReason: availableCandidates.length === 0 ? "no_available_match" : null,
        availableCandidates,
        canonicalLogicalSha256: dump.logicalSha256,
        candidateMatched: record === null ? 0 : 1,
        candidateTruncated: false,
        limit: input.limit,
        parsed,
        projectionAction: "not_required",
        scopeSha256,
      });
    }

    const projected = await this.input.projection.search({
      candidateLimit: ML2_SEARCH_MAX_CANDIDATES,
      dump,
      ftsExpression: parsed.ftsExpression!,
    });
    const ordered = [...projected.candidates].sort(compareCandidates);
    const availableCandidates: AvailableCandidate[] = [];
    for (const candidate of ordered) {
      const record = await this.input.store.getEpisode({
        recordId: candidate.recordId,
        scope: this.input.scope,
      });
      if (record === null) continue;
      if (record.occurredAt !== candidate.occurredAt) {
        throw new Ml1MemoryError("memory_projection_failed", "retrieval projection disagrees with canonical time");
      }
      const exactPhrase = parsed.kind === "quoted_phrase" && parsed.phrase !== null &&
        normalizedPhraseAppears(record, parsed.phrase);
      if (parsed.kind === "quoted_phrase" && !exactPhrase) continue;
      // MEMORY-ML2: projection只给candidate ID；返回前必须回到canonical row并重验source。
      const view = await this.input.inspectSource(record);
      if (view.sourceStatus !== "available") continue;
      availableCandidates.push({
        lexicalBm25: candidate.lexicalBm25,
        reason: exactPhrase ? "exact_phrase" : "lexical_bm25",
        record,
      });
    }
    return this.result({
      abstentionReason: availableCandidates.length === 0 ? "no_available_match" : null,
      availableCandidates,
      canonicalLogicalSha256: dump.logicalSha256,
      candidateMatched: projected.candidates.length,
      candidateTruncated: projected.truncated,
      limit: input.limit,
      parsed,
      projectionAction: projected.action,
      scopeSha256: projected.scopeSha256,
    });
  }

  private result(input: Readonly<{
    readonly abstentionReason: Ml2SearchAbstentionReasonV1 | null;
    readonly availableCandidates: readonly AvailableCandidate[];
    readonly canonicalLogicalSha256: string;
    readonly candidateMatched: number;
    readonly candidateTruncated: boolean;
    readonly limit: number;
    readonly parsed: Ml2ParsedSearchQueryV1;
    readonly projectionAction: Ml2SearchResultV1["projection"]["action"];
    readonly scopeSha256: string;
  }>): Ml2SearchResultV1 {
    const estimator = this.input.tokenEstimator ?? SEARCH_ESTIMATOR;
    const hits: Ml2SearchHitV1[] = [];
    let estimatedTokensUsed = 0;
    let textBytesUsed = 0;
    let stoppedForBudget = false;
    for (const candidate of input.availableCandidates) {
      if (hits.length === input.limit) break;
      const estimate = estimator.estimateText(candidate.record.text);
      if (
        textBytesUsed + estimate.utf8Bytes > ML2_SEARCH_MAX_TEXT_BYTES ||
        estimatedTokensUsed + estimate.estimatedTokens > ML2_SEARCH_MAX_ESTIMATED_TOKENS
      ) {
        stoppedForBudget = true;
        break;
      }
      textBytesUsed += estimate.utf8Bytes;
      estimatedTokensUsed += estimate.estimatedTokens;
      hits.push(Object.freeze({
        estimatedTokens: estimate.estimatedTokens,
        reason: candidate.reason,
        record: candidate.record,
        score: Object.freeze({
          exactId: candidate.reason === "exact_id",
          exactPhrase: candidate.reason === "exact_phrase",
          lexicalBm25: candidate.lexicalBm25,
          occurredAt: candidate.record.occurredAt,
        }),
        sourceStatus: "available",
        textBytes: estimate.utf8Bytes,
      }));
    }
    const abstentionReason = hits.length > 0
      ? null
      : stoppedForBudget
        ? "result_budget_exhausted"
        : input.abstentionReason ?? "no_available_match";
    return Object.freeze({
      abstentionReason,
      budget: Object.freeze({
        estimatedTokensLimit: ML2_SEARCH_MAX_ESTIMATED_TOKENS,
        estimatedTokensUsed,
        resultLimit: input.limit,
        textBytesLimit: ML2_SEARCH_MAX_TEXT_BYTES,
        textBytesUsed,
      }),
      candidates: Object.freeze({
        available: input.availableCandidates.length,
        cap: ML2_SEARCH_MAX_CANDIDATES,
        matched: input.candidateMatched,
        truncated: input.candidateTruncated,
      }),
      hits: Object.freeze(hits),
      projection: Object.freeze({
        action: input.projectionAction,
        canonicalLogicalSha256: input.canonicalLogicalSha256,
        scopeSha256: input.scopeSha256,
      }),
      query: Object.freeze({
        kind: input.parsed.kind,
        normalized: input.parsed.normalized,
        querySha256: input.parsed.querySha256,
        terms: input.parsed.terms,
      }),
      retriever: Object.freeze({ id: ML2_RETRIEVER_ID, version: ML2_RETRIEVER_VERSION }),
      schemaVersion: 1,
      status: hits.length === 0 ? "abstained" : "matched",
    });
  }
}
