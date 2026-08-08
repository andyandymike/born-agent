import { resolve } from "node:path";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { RepositoryEngineIdentityV1 } from "../engine-identity.js";
import { createTypeScriptEngineIdentity } from "../engine-identity.js";
import { planRepositoryIncrementalUpdate, type RepositoryIncrementalPlan } from "../incremental-update-planner.js";
import { canonicalizeIndexRecords } from "../index-generation.js";
import type { RepositoryIndexRecords } from "../navigation-types.js";
import type { RepositorySourceSnapshotResult } from "../source-snapshot.js";
import {
  analyzeTypeScriptSnapshotWithState,
  type TypeScriptAnalysisState,
} from "./typescript-program-analysis.js";

export interface RepositoryEngineUpdateResult {
  readonly buildMode: "cold" | "incremental" | "reused";
  readonly incrementalPlan: RepositoryIncrementalPlan | null;
  readonly records: RepositoryIndexRecords;
}

export interface RepositoryIndexEngine {
  readonly identity: RepositoryEngineIdentityV1;
  build(
    workspace: string,
    snapshot: RepositorySourceSnapshotResult,
    signal: AbortSignal,
  ): Promise<RepositoryIndexRecords>;
  update(
    workspace: string,
    snapshot: RepositorySourceSnapshotResult,
    previousRecords: RepositoryIndexRecords,
    signal: AbortSignal,
  ): Promise<RepositoryEngineUpdateResult>;
}

export class TypeScriptLanguageServiceAdapter implements RepositoryIndexEngine {
  readonly identity = createTypeScriptEngineIdentity();
  private state: {
    readonly analysis: TypeScriptAnalysisState;
    readonly recordsSha256: string;
    readonly snapshot: RepositorySourceSnapshotResult;
  } | null = null;

  async build(
    workspace: string,
    snapshot: RepositorySourceSnapshotResult,
    signal: AbortSignal,
  ): Promise<RepositoryIndexRecords> {
    if (signal.aborted) throw signal.reason ?? new Error("repository index build cancelled");
    // PHASE17: capabilities are package-owned constants. Repository tsconfig plugins, package
    // scripts, custom server paths, and self-reported language-service capabilities are ignored.
    const analysis = analyzeTypeScriptSnapshotWithState(workspace, snapshot, { evidenceLevel: "semantic" });
    if (signal.aborted) throw signal.reason ?? new Error("repository index build cancelled");
    this.state = Object.freeze({
      analysis: analysis.state,
      recordsSha256: recordsIdentity(analysis.records),
      snapshot,
    });
    return analysis.records;
  }

  async update(
    workspace: string,
    snapshot: RepositorySourceSnapshotResult,
    previousRecords: RepositoryIndexRecords,
    signal: AbortSignal,
  ): Promise<RepositoryEngineUpdateResult> {
    if (signal.aborted) throw signal.reason ?? new Error("repository index build cancelled");
    const previous = this.state;
    if (
      previous === null ||
      previous.analysis.sourceStateSha256 !== previous.snapshot.snapshot.sourceStateSha256 ||
      previous.recordsSha256 !== recordsIdentity(previousRecords)
    ) {
      return Object.freeze({
        buildMode: "cold",
        incrementalPlan: null,
        records: await this.build(workspace, snapshot, signal),
      });
    }

    const incrementalPlan = planRepositoryIncrementalUpdate({
      newSnapshot: snapshot,
      oldRecords: previousRecords,
      oldSnapshot: previous.snapshot,
    });
    if (incrementalPlan.updateMode === "reused") {
      return Object.freeze({ buildMode: "reused", incrementalPlan, records: previousRecords });
    }
    if (incrementalPlan.updateMode === "full_rebuild_required") {
      return Object.freeze({
        buildMode: "cold",
        incrementalPlan,
        records: await this.build(workspace, snapshot, signal),
      });
    }

    // PHASE17: unchanged SourceFile objects are reused only when their exact content hash is
    // unchanged. TypeScript then rebinds the complete Program, so changed public declarations
    // cannot leave old cross-file semantic targets behind.
    const analysis = analyzeTypeScriptSnapshotWithState(
      workspace,
      snapshot,
      { evidenceLevel: "semantic" },
      previous.analysis,
    );
    if (signal.aborted) throw signal.reason ?? new Error("repository index build cancelled");
    const expectedReused = incrementalPlan.reusedUnits.filter((path) =>
      previous.analysis.sourceFiles.has(resolveWorkspacePath(workspace, path)) &&
      analysis.state.sourceFiles.has(resolveWorkspacePath(workspace, path))
    );
    if (expectedReused.some((path) => !analysis.reusedUnits.includes(path))) {
      return Object.freeze({
        buildMode: "cold",
        incrementalPlan: null,
        records: await this.build(workspace, snapshot, signal),
      });
    }
    this.state = Object.freeze({
      analysis: analysis.state,
      recordsSha256: recordsIdentity(analysis.records),
      snapshot,
    });
    return Object.freeze({ buildMode: "incremental", incrementalPlan, records: analysis.records });
  }
}

function resolveWorkspacePath(workspace: string, relativePath: string): string {
  return resolve(workspace, relativePath);
}

function recordsIdentity(records: RepositoryIndexRecords): string {
  return sha256Canonical(canonicalizeIndexRecords(records));
}
