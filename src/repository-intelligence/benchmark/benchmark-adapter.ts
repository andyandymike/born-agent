import type { RepositoryVisibleQuery } from "./benchmark-schema.js";
import type { RepositoryBenchmarkAttempt } from "./benchmark-report-schema.js";

export interface RepositoryBenchmarkObservation {
  readonly attempt: Omit<RepositoryBenchmarkAttempt, "grading">;
}

/**
 * A benchmark adapter sees only the copied workspace and the visible query.
 * Hidden gold remains owned by the supervisor in benchmark-runner.ts.
 */
export interface RepositoryBenchmarkAdapter {
  readonly identity: Readonly<Record<string, unknown>>;
  run(
    caseId: string,
    category: RepositoryBenchmarkAttempt["category"],
    workspace: string,
    query: RepositoryVisibleQuery,
    signal: AbortSignal,
  ): Promise<RepositoryBenchmarkObservation>;
}
