export type RepositoryCoverageState = "complete" | "partial" | "unsupported";

export type RepositoryJobState =
  | { readonly kind: "idle" }
  | { readonly kind: "dirty"; readonly reasons: readonly string[] }
  | {
      readonly jobId: string;
      readonly kind: "building";
      readonly phase: "snapshot" | "rules" | "index" | "verify";
    }
  | {
      readonly coverage: RepositoryCoverageState;
      readonly generationSha256: string;
      readonly kind: "ready";
    }
  | { readonly code: string; readonly kind: "blocked" }
  | { readonly code: string; readonly kind: "degraded" };
