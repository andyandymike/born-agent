import { sha256Canonical } from "../../completion/canonical-json.js";
import type { ContextItem } from "../../context/context-item.js";
import type { Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import type {
  Ml2SearchAbstentionReasonV1,
  Ml2SearchSelectionReasonV1,
} from "../retrieval/ml2-search-contract.js";

export const ML3_MAX_SELECTED_RECORDS = 3;
export const ML3_MAX_INJECTED_TOKENS = 1_024;
export const ML3_CONTEXT_TARGET_RATIO = 0.08;
export const ML3_RECALL_VERSION = "ml3-v1";

export type Ml3RecallAbstentionReasonV1 =
  | Ml2SearchAbstentionReasonV1
  | "injected_budget_exhausted"
  | "source_revalidation_failed";

export interface Ml3RecallRequestIdentityV1 {
  readonly requestSha256: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly step: number;
}

export interface Ml3RecallSelectedRecordV1 {
  readonly activeStatus: "available";
  readonly estimatedTokens: number;
  readonly occurredAt: string;
  readonly reason: Ml2SearchSelectionReasonV1;
  readonly recordId: string;
  readonly recordSha256: string;
  readonly sourceRangeSha256: string;
  readonly sourceStatus: "available";
  readonly textBytes: number;
}

export interface RecallSelectionV1 {
  readonly abstentionReason: Ml3RecallAbstentionReasonV1 | null;
  readonly budget: Readonly<{
    readonly contextTargetTokens: number;
    readonly estimatedTokensUsed: number;
    readonly injectedTokenLimit: number;
    readonly textBytesUsed: number;
  }>;
  readonly query: Readonly<{
    readonly querySha256: string;
    readonly retrieverId: string;
    readonly retrieverVersion: string;
  }>;
  readonly request: Ml3RecallRequestIdentityV1;
  readonly schemaVersion: 1;
  readonly scope: Ml1MemoryScopeV1;
  readonly selectedRecords: readonly Ml3RecallSelectedRecordV1[];
  readonly selectionSha256: string;
  readonly status: "abstained" | "selected";
  readonly version: typeof ML3_RECALL_VERSION;
}

export interface Ml3PreparedRecallContextV1 {
  readonly items: readonly ContextItem[];
  readonly selection: RecallSelectionV1;
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function ml3InjectedTokenLimit(contextTargetTokens: number): number {
  if (!Number.isSafeInteger(contextTargetTokens) || contextTargetTokens <= 0) {
    throw new RangeError("ML3 context target must be a positive integer");
  }
  return Math.min(
    ML3_MAX_INJECTED_TOKENS,
    Math.floor(contextTargetTokens * ML3_CONTEXT_TARGET_RATIO),
  );
}

export function createMl3RequestSha256(input: Readonly<{
  readonly inputKind: string;
  readonly querySha256: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly step: number;
}>): string {
  if (
    input.inputKind.length === 0 ||
    input.runId.length === 0 ||
    input.sessionId.length === 0 ||
    !SHA256.test(input.querySha256) ||
    !Number.isSafeInteger(input.step) ||
    input.step <= 0
  ) {
    throw new TypeError("ML3 request identity is invalid");
  }
  return sha256Canonical({
    input_kind: input.inputKind,
    query_sha256: input.querySha256,
    run_id: input.runId,
    schema_version: 1,
    session_id: input.sessionId,
    step: input.step,
  });
}

interface RecallSelectionInputV1 {
  readonly abstentionReason: Ml3RecallAbstentionReasonV1 | null;
  readonly budget: RecallSelectionV1["budget"];
  readonly query: RecallSelectionV1["query"];
  readonly request: Ml3RecallRequestIdentityV1;
  readonly scope: Ml1MemoryScopeV1;
  readonly selectedRecords: readonly Ml3RecallSelectedRecordV1[];
}

function selectionCanonicalValue(input: RecallSelectionInputV1) {
  return {
    abstention_reason: input.abstentionReason,
    budget: {
      context_target_tokens: input.budget.contextTargetTokens,
      estimated_tokens_used: input.budget.estimatedTokensUsed,
      injected_token_limit: input.budget.injectedTokenLimit,
      text_bytes_used: input.budget.textBytesUsed,
    },
    query: {
      query_sha256: input.query.querySha256,
      retriever_id: input.query.retrieverId,
      retriever_version: input.query.retrieverVersion,
    },
    request: {
      request_sha256: input.request.requestSha256,
      run_id: input.request.runId,
      session_id: input.request.sessionId,
      step: input.request.step,
    },
    schema_version: 1,
    scope: input.scope,
    selected_records: input.selectedRecords.map((record) => ({
      active_status: record.activeStatus,
      estimated_tokens: record.estimatedTokens,
      occurred_at: record.occurredAt,
      reason: record.reason,
      record_id: record.recordId,
      record_sha256: record.recordSha256,
      source_range_sha256: record.sourceRangeSha256,
      source_status: record.sourceStatus,
      text_bytes: record.textBytes,
    })),
    status: input.selectedRecords.length === 0 ? "abstained" : "selected",
    version: ML3_RECALL_VERSION,
  } as const;
}

export function createRecallSelectionV1(
  input: RecallSelectionInputV1,
): RecallSelectionV1 {
  const selectedRecords = Object.freeze(input.selectedRecords.map((record) => Object.freeze({ ...record })));
  const expectedTokens = selectedRecords.reduce((total, record) => total + record.estimatedTokens, 0);
  const expectedBytes = selectedRecords.reduce((total, record) => total + record.textBytes, 0);
  if (
    !SHA256.test(input.query.querySha256) ||
    !SHA256.test(input.request.requestSha256) ||
    selectedRecords.length > ML3_MAX_SELECTED_RECORDS ||
    expectedTokens !== input.budget.estimatedTokensUsed ||
    expectedBytes !== input.budget.textBytesUsed ||
    expectedTokens > input.budget.injectedTokenLimit ||
    input.budget.injectedTokenLimit !== ml3InjectedTokenLimit(input.budget.contextTargetTokens) ||
    (selectedRecords.length === 0) !== (input.abstentionReason !== null)
  ) {
    throw new TypeError("ML3 recall selection violates its frozen bounds");
  }
  const frozenInput = Object.freeze({
    ...input,
    budget: Object.freeze({ ...input.budget }),
    query: Object.freeze({ ...input.query }),
    request: Object.freeze({ ...input.request }),
    scope: Object.freeze({ ...input.scope }),
    selectedRecords,
  });
  const canonical = selectionCanonicalValue(frozenInput);
  return Object.freeze({
    ...frozenInput,
    schemaVersion: 1,
    selectionSha256: sha256Canonical(canonical),
    status: selectedRecords.length === 0 ? "abstained" : "selected",
    version: ML3_RECALL_VERSION,
  });
}
