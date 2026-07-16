export interface ContextCapacity {
  readonly contextWindowTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly source: "pinned_catalog" | "user_conservative_limit";
}
