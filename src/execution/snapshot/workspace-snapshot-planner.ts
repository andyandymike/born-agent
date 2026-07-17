import {
  filterSnapshotEntry,
  SnapshotPolicyError,
  type SnapshotEntryKind,
  type SnapshotOmissionCategory,
} from "./snapshot-filter.js";
import {
  createSnapshotManifest,
  type SnapshotLimits,
  type SnapshotManifest,
  type SnapshotManifestEntry,
  type SnapshotModeClass,
} from "./snapshot-manifest.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export interface SnapshotSourceEntry {
  readonly bytes: number;
  readonly contentSha256: string;
  readonly ignored: boolean;
  readonly kind: SnapshotEntryKind;
  readonly mode: SnapshotModeClass;
  readonly relativePath: string;
  readonly tracked: boolean;
}

export interface PlannedSnapshotEntry extends SnapshotManifestEntry {
  readonly tracked: boolean;
}

export interface WorkspaceSnapshotPlan {
  readonly entries: readonly PlannedSnapshotEntry[];
  readonly manifest: SnapshotManifest;
  readonly sourceStateSha256: string;
}

export interface WorkspaceSnapshotPlanningAdapter {
  enumerateSourceEntries(): Promise<readonly SnapshotSourceEntry[]>;
  readSourceStateSha256(): Promise<string>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function planSnapshotEntries(input: {
  readonly entries: readonly SnapshotSourceEntry[];
  readonly limits?: Partial<SnapshotLimits>;
  readonly sourceStateSha256: string;
}): WorkspaceSnapshotPlan {
  if (!SHA256.test(input.sourceStateSha256)) {
    throw new SnapshotPolicyError(
      "invalid_source_state_digest",
      "source state must be a lowercase SHA-256 digest",
    );
  }
  const entries: PlannedSnapshotEntry[] = [];
  const omissionCounts = new Map<SnapshotOmissionCategory, number>();
  for (const source of input.entries) {
    const decision = filterSnapshotEntry(source);
    if (decision.disposition === "omit") {
      omissionCounts.set(
        decision.category,
        (omissionCounts.get(decision.category) ?? 0) + 1,
      );
      continue;
    }
    if (decision.disposition === "directory") continue;
    if (
      !Number.isSafeInteger(source.bytes) ||
      source.bytes < 0 ||
      !SHA256.test(source.contentSha256)
    ) {
      throw new SnapshotPolicyError(
        "invalid_source_entry",
        "snapshot source file has invalid byte length or content digest",
      );
    }
    entries.push(
      Object.freeze({
        bytes: source.bytes,
        mode: source.mode,
        path: decision.path,
        sha256: source.contentSha256,
        tracked: source.tracked,
      }),
    );
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  const manifest = createSnapshotManifest({
    entries,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    omitted: [...omissionCounts.entries()].map(([category, count]) => ({
      category,
      count,
    })),
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    manifest,
    sourceStateSha256: input.sourceStateSha256,
  });
}

export class WorkspaceSnapshotPlanner {
  public constructor(
    private readonly adapter: WorkspaceSnapshotPlanningAdapter,
    private readonly limits?: Partial<SnapshotLimits>,
  ) {}

  public async plan(): Promise<WorkspaceSnapshotPlan> {
    const before = await this.adapter.readSourceStateSha256();
    const entries = await this.adapter.enumerateSourceEntries();
    const after = await this.adapter.readSourceStateSha256();
    if (before !== after) {
      throw new SnapshotPolicyError(
        "source_state_changed_during_plan",
        "workspace changed while planning the disposable snapshot",
      );
    }
    return planSnapshotEntries({
      entries,
      ...(this.limits === undefined ? {} : { limits: this.limits }),
      sourceStateSha256: before,
    });
  }
}
