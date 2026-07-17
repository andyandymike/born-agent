import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  normalizeSnapshotRelativePath,
  SnapshotPolicyError,
  type SnapshotOmissionCategory,
} from "./snapshot-filter.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export type SnapshotModeClass = "executable" | "regular";

export interface SnapshotManifestEntry {
  readonly bytes: number;
  readonly mode: SnapshotModeClass;
  readonly path: string;
  readonly sha256: string;
}

export interface SnapshotOmissionSummary {
  readonly category: SnapshotOmissionCategory;
  readonly count: number;
}

export interface SnapshotManifest {
  readonly entries: readonly SnapshotManifestEntry[];
  readonly fileCount: number;
  readonly omitted: readonly SnapshotOmissionSummary[];
  readonly schemaVersion: 1;
  readonly sha256: string;
  readonly totalBytes: number;
}

export interface SnapshotLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export const MAXIMUM_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 100_000,
  maxTotalBytes: 1024 * 1024 * 1024,
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function resolveSnapshotLimits(
  input: Partial<SnapshotLimits> = {},
): SnapshotLimits {
  const resolved: SnapshotLimits = {
    maxFileBytes: input.maxFileBytes ?? MAXIMUM_SNAPSHOT_LIMITS.maxFileBytes,
    maxFiles: input.maxFiles ?? MAXIMUM_SNAPSHOT_LIMITS.maxFiles,
    maxTotalBytes:
      input.maxTotalBytes ?? MAXIMUM_SNAPSHOT_LIMITS.maxTotalBytes,
  };
  for (const [name, value, maximum] of [
    ["maxFileBytes", resolved.maxFileBytes, MAXIMUM_SNAPSHOT_LIMITS.maxFileBytes],
    ["maxFiles", resolved.maxFiles, MAXIMUM_SNAPSHOT_LIMITS.maxFiles],
    ["maxTotalBytes", resolved.maxTotalBytes, MAXIMUM_SNAPSHOT_LIMITS.maxTotalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new SnapshotPolicyError(
        "invalid_snapshot_limit",
        `${name} must be a positive integer no larger than the hard policy limit`,
      );
    }
  }
  if (resolved.maxFileBytes > resolved.maxTotalBytes) {
    throw new SnapshotPolicyError(
      "invalid_snapshot_limit",
      "single-file snapshot limit cannot exceed total snapshot limit",
    );
  }
  return Object.freeze(resolved);
}

function normalizeEntry(entry: SnapshotManifestEntry): SnapshotManifestEntry {
  const path = normalizeSnapshotRelativePath(entry.path);
  if (
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    !SHA256.test(entry.sha256) ||
    (entry.mode !== "regular" && entry.mode !== "executable")
  ) {
    throw new SnapshotPolicyError(
      "invalid_manifest_entry",
      "snapshot manifest entry has invalid bytes, mode, or content digest",
    );
  }
  return Object.freeze({ ...entry, path });
}

function assertNoPathCollisions(entries: readonly SnapshotManifestEntry[]): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  for (const entry of entries) {
    if (exact.has(entry.path)) {
      throw new SnapshotPolicyError(
        "duplicate_snapshot_path",
        "snapshot manifest contains a duplicate path",
      );
    }
    exact.add(entry.path);
    const caseKey = entry.path.toLowerCase();
    const prior = folded.get(caseKey);
    if (prior !== undefined && prior !== entry.path) {
      throw new SnapshotPolicyError(
        "snapshot_case_collision",
        "snapshot manifest contains a case-insensitive path collision",
      );
    }
    folded.set(caseKey, entry.path);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (exact.has(parent)) {
        throw new SnapshotPolicyError(
          "snapshot_parent_file_collision",
          "snapshot file path is also used as a parent directory",
        );
      }
    }
  }
}

function normalizeOmissions(
  omitted: readonly SnapshotOmissionSummary[],
): readonly SnapshotOmissionSummary[] {
  const totals = new Map<SnapshotOmissionCategory, number>();
  for (const entry of omitted) {
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
      throw new SnapshotPolicyError(
        "invalid_omission_count",
        "snapshot omission counts must be positive integers",
      );
    }
    totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.count);
  }
  return Object.freeze(
    [...totals.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([category, count]) => Object.freeze({ category, count })),
  );
}

export function createSnapshotManifest(input: {
  readonly entries: readonly SnapshotManifestEntry[];
  readonly limits?: Partial<SnapshotLimits>;
  readonly omitted?: readonly SnapshotOmissionSummary[];
}): SnapshotManifest {
  const limits = resolveSnapshotLimits(input.limits);
  const entries = input.entries.map(normalizeEntry).sort((left, right) =>
    compareText(left.path, right.path),
  );
  assertNoPathCollisions(entries);
  if (entries.length > limits.maxFiles) {
    throw new SnapshotPolicyError(
      "snapshot_file_count_exceeded",
      "snapshot exceeds its maximum file count",
    );
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.bytes > limits.maxFileBytes) {
      throw new SnapshotPolicyError(
        "snapshot_file_bytes_exceeded",
        "snapshot contains a file larger than the per-file limit",
      );
    }
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new SnapshotPolicyError(
        "snapshot_total_bytes_exceeded",
        "snapshot exceeds its total byte limit",
      );
    }
  }
  const omitted = normalizeOmissions(input.omitted ?? []);
  const identity = Object.freeze({
    entries: entries.map(({ bytes, mode, path, sha256 }) => ({
      bytes,
      mode,
      path,
      sha256,
    })),
    omitted,
    schema_version: 1,
  });
  // PHASE13: Only this sorted manifest is approval identity. A later copy must
  // reproduce the same bytes/modes/digest; it may not silently retry a changed
  // workspace under an older permission decision.
  return Object.freeze({
    entries: Object.freeze(entries),
    fileCount: entries.length,
    omitted,
    schemaVersion: 1,
    sha256: sha256Canonical(identity),
    totalBytes,
  });
}

export function assertMatchingSnapshotManifest(
  approved: SnapshotManifest,
  actual: SnapshotManifest,
): void {
  if (
    approved.sha256 !== actual.sha256 ||
    approved.fileCount !== actual.fileCount ||
    approved.totalBytes !== actual.totalBytes
  ) {
    throw new SnapshotPolicyError(
      "snapshot_manifest_stale",
      "materialized snapshot does not match its approved manifest",
    );
  }
}
