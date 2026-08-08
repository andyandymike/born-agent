import { SensitivePathPolicy } from "../tools/sensitive-path-policy.js";
import { WorkspacePathPolicy } from "../tools/workspace-path-policy.js";
import type { IndexGenerationV1 } from "./index-generation-schema.js";
import type { SourceRange } from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { RepositorySourceSnapshotResult } from "./source-snapshot.js";
import type { RepositorySourceSnapshotter } from "./source-snapshotter.js";
import { StableSourceReader } from "./stable-source-reader.js";

export interface NavigationFreshnessLocation {
  readonly path: string;
  readonly range: SourceRange;
  readonly sourceSha256: string;
}

export interface NavigationFreshnessResult {
  readonly locations: readonly NavigationFreshnessLocation[];
}

export interface RepositoryFreshnessGuard {
  verifyGeneration(generation: IndexGenerationV1): Promise<
    | { readonly status: "current" }
    | { readonly changedPaths: readonly string[]; readonly currentSourceStateSha256: string; readonly status: "stale" }
  >;
  verifyResultSources(result: NavigationFreshnessResult, signal?: AbortSignal): Promise<void>;
}

function changedPaths(oldSnapshot: RepositorySourceSnapshotResult, current: RepositorySourceSnapshotResult): readonly string[] {
  const oldByPath = new Map(oldSnapshot.snapshot.entries.map((entry) => [entry.relativePath, entry.contentSha256]));
  const currentByPath = new Map(current.snapshot.entries.map((entry) => [entry.relativePath, entry.contentSha256]));
  return Object.freeze(
    [...new Set([...oldByPath.keys(), ...currentByPath.keys()])]
      .filter((path) => oldByPath.get(path) !== currentByPath.get(path))
      .sort()
      .slice(0, 64),
  );
}

function assertUtf8Boundary(bytes: Uint8Array, range: SourceRange): void {
  if (range.startByte > range.endByte || range.endByte > bytes.byteLength) throw new Error("navigation result range exceeds current source bytes");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(bytes.slice(0, range.startByte));
  decoder.decode(bytes.slice(range.startByte, range.endByte));
  decoder.decode(bytes.slice(range.endByte));
}

export class RepositorySourceFreshnessGuard implements RepositoryFreshnessGuard {
  private constructor(
    private readonly baseline: RepositorySourceSnapshotResult,
    private readonly snapshotter: RepositorySourceSnapshotter,
    private readonly reader: StableSourceReader,
  ) {}

  static async create(
    workspace: string,
    baseline: RepositorySourceSnapshotResult,
    snapshotter: RepositorySourceSnapshotter,
  ): Promise<RepositorySourceFreshnessGuard> {
    const paths = await WorkspacePathPolicy.create(workspace, { sensitive: new SensitivePathPolicy() });
    return new RepositorySourceFreshnessGuard(baseline, snapshotter, new StableSourceReader(paths));
  }

  async verifyGeneration(generation: IndexGenerationV1): Promise<
    | { readonly status: "current" }
    | { readonly changedPaths: readonly string[]; readonly currentSourceStateSha256: string; readonly status: "stale" }
  > {
    const current = await this.snapshotter.snapshot();
    if (
      generation.sourceStateSha256 === this.baseline.snapshot.sourceStateSha256 &&
      current.snapshot.sourceStateSha256 === generation.sourceStateSha256
    ) return Object.freeze({ status: "current" as const });
    return Object.freeze({
      changedPaths: changedPaths(this.baseline, current),
      currentSourceStateSha256: current.snapshot.sourceStateSha256,
      status: "stale" as const,
    });
  }

  async verifyResultSources(
    result: NavigationFreshnessResult,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const byPath = new Map<string, NavigationFreshnessLocation[]>();
    for (const location of result.locations) {
      const values = byPath.get(location.path) ?? [];
      values.push(location);
      byPath.set(location.path, values);
    }
    try {
      for (const [path, locations] of byPath) {
        const expected = this.baseline.snapshot.entries.find((entry) => entry.relativePath === path);
        if (expected === undefined) throw new Error("navigation result references an unknown source unit");
        const stable = await this.reader.read(path, { maxBytes: Math.max(expected.byteLength, 1), signal });
        for (const location of locations) {
          if (stable.contentSha256 !== location.sourceSha256 || stable.contentSha256 !== expected.contentSha256) {
            throw new Error("navigation result source hash is stale");
          }
          assertUtf8Boundary(stable.bytes, location.range);
        }
      }
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError && error.exitCode === 130) throw error;
      throw new RepositoryIntelligenceError("repository_index_stale", "repository navigation result is not current", 8, { cause: error });
    }
  }
}
