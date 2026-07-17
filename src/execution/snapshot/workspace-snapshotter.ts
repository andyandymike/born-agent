import { createHash } from "node:crypto";

import {
  assertMatchingSnapshotManifest,
  createSnapshotManifest,
  type SnapshotManifest,
  type SnapshotModeClass,
} from "./snapshot-manifest.js";
import {
  WorkspaceSnapshotPlanner,
  type SnapshotSourceEntry,
  type WorkspaceSnapshotPlan,
  type WorkspaceSnapshotPlanningAdapter,
} from "./workspace-snapshot-planner.js";
import { SnapshotPolicyError } from "./snapshot-filter.js";

export interface SnapshotSourceAdapter
  extends WorkspaceSnapshotPlanningAdapter {
  readFile(relativePath: string): Promise<Uint8Array>;
  withMutationLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface SnapshotSinkHandle {
  /** Opaque internal identity. It must not be rendered as a host path. */
  readonly opaqueId: string;
}

export interface SnapshotSinkAdapter {
  complete(
    handle: SnapshotSinkHandle,
    manifest: SnapshotManifest,
  ): Promise<void>;
  createExclusive(plan: WorkspaceSnapshotPlan): Promise<SnapshotSinkHandle>;
  discard(handle: SnapshotSinkHandle): Promise<void>;
  writeFile(
    handle: SnapshotSinkHandle,
    relativePath: string,
    bytes: Uint8Array,
    mode: SnapshotModeClass,
  ): Promise<void>;
}

export interface MaterializedWorkspaceSnapshot {
  readonly manifest: SnapshotManifest;
  readonly opaqueSinkId: string;
  readonly sourceStateSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceEntryForPlan(
  entry: WorkspaceSnapshotPlan["entries"][number],
): SnapshotSourceEntry {
  return {
    bytes: entry.bytes,
    contentSha256: entry.sha256,
    ignored: false,
    kind: "file",
    mode: entry.mode,
    relativePath: entry.path,
    tracked: entry.tracked,
  };
}

export class WorkspaceSnapshotter {
  public constructor(
    private readonly source: SnapshotSourceAdapter,
    private readonly sink: SnapshotSinkAdapter,
  ) {}

  public async materializeApproved(
    approved: WorkspaceSnapshotPlan,
    signal?: AbortSignal,
  ): Promise<MaterializedWorkspaceSnapshot> {
    // PHASE13: Commands receive a disposable copy, never the real workspace.
    // Replanning and source digests on both sides of the copy close the race
    // where approved bytes change before or during materialization.
    return this.source.withMutationLock(async () => {
      const current = await new WorkspaceSnapshotPlanner(this.source).plan();
      if (
        current.sourceStateSha256 !== approved.sourceStateSha256 ||
        current.manifest.sha256 !== approved.manifest.sha256
      ) {
        throw new SnapshotPolicyError(
          "approved_snapshot_stale",
          "workspace no longer matches the approved snapshot plan",
        );
      }
      const handle = await this.sink.createExclusive(approved);
      try {
        const actualEntries: SnapshotSourceEntry[] = [];
        for (const entry of approved.entries) {
          const bytes = await this.source.readFile(entry.path);
          if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
            throw new SnapshotPolicyError(
              "source_file_changed_during_copy",
              "workspace file changed while copying the approved snapshot",
            );
          }
          await this.sink.writeFile(handle, entry.path, bytes, entry.mode);
          actualEntries.push(sourceEntryForPlan(entry));
        }
        const actualManifest = createSnapshotManifest({
          entries: actualEntries.map((entry) => ({
            bytes: entry.bytes,
            mode: entry.mode,
            path: entry.relativePath,
            sha256: entry.contentSha256,
          })),
          omitted: approved.manifest.omitted,
        });
        assertMatchingSnapshotManifest(approved.manifest, actualManifest);
        const after = await this.source.readSourceStateSha256();
        if (after !== approved.sourceStateSha256) {
          throw new SnapshotPolicyError(
            "source_state_changed_during_copy",
            "workspace changed while copying the approved snapshot",
          );
        }
        await this.sink.complete(handle, actualManifest);
        // PHASE13: The sink has no promotion/copy-back method. Ephemeral command
        // outputs stay in the snapshot; host changes require the existing patch
        // approval boundary instead of an implicit sync.
        return Object.freeze({
          manifest: actualManifest,
          opaqueSinkId: handle.opaqueId,
          sourceStateSha256: approved.sourceStateSha256,
        });
      } catch (error) {
        try {
          await this.sink.discard(handle);
        } catch {
          throw new SnapshotPolicyError(
            "snapshot_cleanup_unknown",
            "partial snapshot cleanup could not be proven",
          );
        }
        throw error;
      }
    }, signal);
  }
}
