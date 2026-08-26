/** ML1 对外只暴露稳定错误码，不把 SQLite、路径或敏感输入反射给用户。 */
export type Ml1MemoryErrorCode =
  | "memory_capacity_reached"
  | "memory_cursor_invalid"
  | "memory_episode_not_admitted"
  | "memory_fts_unavailable"
  | "memory_projection_failed"
  | "memory_query_invalid"
  | "memory_record_invalid"
  | "memory_record_too_large"
  | "memory_repository_unregistered"
  | "memory_scope_ambiguous"
  | "memory_source_stale"
  | "memory_store_busy"
  | "memory_store_corrupt";

export class Ml1MemoryError extends Error {
  override readonly name = "Ml1MemoryError";

  constructor(
    readonly code: Ml1MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
