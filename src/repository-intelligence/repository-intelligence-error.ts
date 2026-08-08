export type RepositoryIntelligenceErrorCode =
  | "repository_cursor_invalid"
  | "repository_cursor_stale"
  | "repository_engine_asset_invalid"
  | "repository_engine_decision_invalid"
  | "repository_engine_protocol_invalid"
  | "repository_engine_unavailable"
  | "repository_benchmark_harness_invalid"
  | "repository_benchmark_incompatible"
  | "repository_benchmark_manifest_invalid"
  | "repository_benchmark_regression"
  | "repository_inventory_partial"
  | "repository_index_budget_exceeded"
  | "repository_index_build_failed"
  | "repository_index_busy"
  | "repository_index_corrupt"
  | "repository_index_incremental_mismatch"
  | "repository_index_publish_failed"
  | "repository_index_stale"
  | "repository_language_unsupported"
  | "repository_navigation_cancelled"
  | "repository_query_partial"
  | "repository_query_timeout"
  | "repository_symbol_stale"
  | "repository_snapshot_invalid"
  | "repository_source_unstable"
  | "source_link_denied"
  | "source_too_large"
  | "source_unstable";

export class RepositoryIntelligenceError extends Error {
  constructor(
    readonly code: RepositoryIntelligenceErrorCode,
    message: string,
    readonly exitCode: 1 | 2 | 3 | 6 | 7 | 8 | 9 | 130 = 1,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "RepositoryIntelligenceError";
  }
}
