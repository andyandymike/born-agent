import { sha256Canonical } from "../../completion/canonical-json.js";
import type { MemoryRecordV1 } from "../core/memory-record-v1.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";

// MEMORY-ML2: query grammar由Host生成，不把用户字符串当成FTS程序执行。
export const ML2_SEARCH_MAX_QUERY_BYTES = 1_024;
export const ML2_SEARCH_MAX_TERMS = 16;
export const ML2_SEARCH_MAX_CANDIDATES = 100;
export const ML2_SEARCH_DEFAULT_RESULTS = 5;
export const ML2_SEARCH_MAX_RESULTS = 20;
export const ML2_SEARCH_MAX_TEXT_BYTES = 16 * 1_024;
export const ML2_SEARCH_MAX_ESTIMATED_TOKENS = 4_096;
export const ML2_RETRIEVER_ID = "bornagent.lexical-memory-search";
export const ML2_RETRIEVER_VERSION = "ml2-v2";

export type Ml2SearchQueryKindV1 = "exact_id" | "lexical" | "quoted_phrase";
export type Ml2SearchAbstentionReasonV1 =
  | "no_available_match"
  | "no_searchable_terms"
  | "result_budget_exhausted";
export type Ml2SearchSelectionReasonV1 = "exact_id" | "exact_phrase" | "lexical_bm25";

export type Ml2ParsedSearchQueryV1 =
  | Readonly<{
      readonly exactRecordId: string;
      readonly ftsExpression: null;
      readonly kind: "exact_id";
      readonly normalized: string;
      readonly phrase: null;
      readonly querySha256: string;
      readonly terms: readonly string[];
    }>
  | Readonly<{
      readonly exactRecordId: null;
      readonly ftsExpression: string | null;
      readonly kind: "lexical" | "quoted_phrase";
      readonly normalized: string;
      readonly phrase: string | null;
      readonly querySha256: string;
      readonly terms: readonly string[];
    }>;

export interface Ml2SearchScoreV1 {
  readonly exactId: boolean;
  readonly exactPhrase: boolean;
  readonly lexicalBm25: number | null;
  readonly occurredAt: string;
}

export interface Ml2SearchHitV1 {
  readonly estimatedTokens: number;
  readonly reason: Ml2SearchSelectionReasonV1;
  readonly record: MemoryRecordV1;
  readonly score: Ml2SearchScoreV1;
  readonly sourceStatus: "available";
  readonly textBytes: number;
}

export interface Ml2SearchResultV1 {
  readonly abstentionReason: Ml2SearchAbstentionReasonV1 | null;
  readonly budget: Readonly<{
    readonly estimatedTokensLimit: number;
    readonly estimatedTokensUsed: number;
    readonly resultLimit: number;
    readonly textBytesLimit: number;
    readonly textBytesUsed: number;
  }>;
  readonly candidates: Readonly<{
    readonly available: number;
    readonly cap: number;
    readonly matched: number;
    readonly truncated: boolean;
  }>;
  readonly hits: readonly Ml2SearchHitV1[];
  readonly projection: Readonly<{
    readonly action: "not_required" | "rebuilt" | "reused";
    readonly canonicalLogicalSha256: string;
    readonly scopeSha256: string;
  }>;
  readonly query: Readonly<{
    readonly kind: Ml2SearchQueryKindV1;
    readonly normalized: string;
    readonly querySha256: string;
    readonly terms: readonly string[];
  }>;
  readonly retriever: Readonly<{
    readonly id: typeof ML2_RETRIEVER_ID;
    readonly version: typeof ML2_RETRIEVER_VERSION;
  }>;
  readonly schemaVersion: 1;
  readonly status: "abstained" | "matched";
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const term = match[0].toLocaleLowerCase("en-US");
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length === ML2_SEARCH_MAX_TERMS) break;
  }
  return Object.freeze(terms);
}

function quoteFtsTerm(value: string): string {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

export function parseMl2SearchQuery(input: string): Ml2ParsedSearchQueryV1 {
  if (Buffer.byteLength(input, "utf8") > ML2_SEARCH_MAX_QUERY_BYTES) {
    throw new Ml1MemoryError("memory_query_invalid", "memory search query exceeds its UTF-8 byte bound");
  }
  const normalized = normalizeSearchText(input);
  if (Buffer.byteLength(normalized, "utf8") > ML2_SEARCH_MAX_QUERY_BYTES) {
    throw new Ml1MemoryError("memory_query_invalid", "memory search query exceeds its UTF-8 byte bound");
  }
  const querySha256 = sha256Canonical({ normalized, schema_version: 1 });
  if (/^(?:episode|memory)_[a-f0-9]{64}$/u.test(normalized)) {
    return Object.freeze({
      exactRecordId: normalized,
      ftsExpression: null,
      kind: "exact_id",
      normalized,
      phrase: null,
      querySha256,
      terms: Object.freeze([]),
    });
  }
  const quoted = normalized.match(/^"([\s\S]*)"$/u);
  const phrase = quoted === null ? null : normalizeSearchText(quoted[1]!);
  const terms = tokenize(phrase ?? normalized);
  const ftsExpression = terms.length === 0
    ? null
    : phrase === null
      ? terms.map(quoteFtsTerm).join(" OR ")
      : quoteFtsTerm(terms.join(" "));
  return Object.freeze({
    exactRecordId: null,
    ftsExpression,
    kind: phrase === null ? "lexical" : "quoted_phrase",
    normalized,
    phrase,
    querySha256,
    terms,
  });
}

export function normalizedPhraseAppears(record: MemoryRecordV1, phrase: string): boolean {
  const expected = normalizeSearchText(phrase).toLocaleLowerCase("en-US");
  const title = record.kind === "episode" ? record.taskPreview : `${record.kind}: ${record.text}`;
  return normalizeSearchText(title).toLocaleLowerCase("en-US").includes(expected) ||
    normalizeSearchText(record.text).toLocaleLowerCase("en-US").includes(expected);
}
