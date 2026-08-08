import type { RepositoryIndexEngine } from "./engines/typescript-language-service-adapter.js";
import type { RepositoryIncrementalPlan } from "./incremental-update-planner.js";
import { buildIndexGeneration, type BuiltIndexGeneration } from "./index-generation.js";
import type { RepositoryIndexRecords } from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { RepositorySourceSnapshotResult } from "./source-snapshot.js";
import type { RepositorySourceSnapshotter } from "./source-snapshotter.js";

export class RepositoryIndexBuilder {
  constructor(
    private readonly workspace: string,
    private readonly engine: RepositoryIndexEngine,
    private readonly snapshotter: RepositorySourceSnapshotter,
  ) {}

  async build(
    snapshot: RepositorySourceSnapshotResult,
    ruleManifestSha256: string,
    signal: AbortSignal,
    previousRecords?: RepositoryIndexRecords,
  ): Promise<BuiltRepositoryIndexGeneration> {
    if (signal.aborted) throw new RepositoryIntelligenceError("repository_navigation_cancelled", "repository index build was cancelled", 130);
    try {
      const result = previousRecords === undefined
        ? Object.freeze({
          buildMode: "cold" as const,
          incrementalPlan: null,
          records: await this.engine.build(this.workspace, snapshot, signal),
        })
        : await this.engine.update(this.workspace, snapshot, previousRecords, signal);
      const current = await this.snapshotter.snapshot(signal);
      // PHASE17: parser completion is not freshness proof. A changed source invalidates the whole
      // build; no generation containing a mixture of old/new bytes is published.
      if (current.snapshot.sourceStateSha256 !== snapshot.snapshot.sourceStateSha256) {
        throw new RepositoryIntelligenceError("repository_index_stale", "repository source changed during index build", 8);
      }
      return Object.freeze({
        ...buildIndexGeneration({
        engineIdentitySha256: this.engine.identity.identitySha256,
        records: result.records,
        ruleManifestSha256,
        sourceCoverage: snapshot.snapshot.coverage,
        sourceStateSha256: snapshot.snapshot.sourceStateSha256,
        }),
        buildMode: result.buildMode,
        incrementalPlan: result.incrementalPlan,
      });
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError) throw error;
      if (signal.aborted) throw new RepositoryIntelligenceError("repository_navigation_cancelled", "repository index build was cancelled", 130, { cause: error });
      throw new RepositoryIntelligenceError("repository_index_build_failed", "repository index engine failed", 1, { cause: error });
    }
  }
}

export interface BuiltRepositoryIndexGeneration extends BuiltIndexGeneration {
  readonly buildMode: "cold" | "incremental" | "reused";
  readonly incrementalPlan: RepositoryIncrementalPlan | null;
}
