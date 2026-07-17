import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { normalizeSnapshotRelativePath, SnapshotPolicyError } from "./snapshot-filter.js";
import { MAXIMUM_SNAPSHOT_LIMITS, type SnapshotManifest } from "./snapshot-manifest.js";

interface PostEntry {
  readonly bytes: number;
  readonly kind: "file" | "special";
  readonly mode: "executable" | "regular" | "special";
  readonly path: string;
  readonly sha256: string;
}

export interface SnapshotDiffEvidence {
  readonly afterSha256: string;
  readonly beforeSha256: string;
  readonly created: number;
  readonly deleted: number;
  readonly modified: number;
  readonly paths: readonly string[];
  readonly specialEntries: number;
  readonly truncated: boolean;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function enumeratePostState(root: string): Promise<readonly PostEntry[]> {
  const entries: PostEntry[] = [];
  let totalBytes = 0;
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const names = await readdir(absolute);
    names.sort(compare);
    for (const name of names) {
      const path = normalizeSnapshotRelativePath(
        relative.length === 0 ? name : `${relative}/${name}`,
      );
      const target = join(absolute, name);
      const metadata = await lstat(target);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        await visit(target, path);
        continue;
      }
      if (entries.length >= MAXIMUM_SNAPSHOT_LIMITS.maxFiles) {
        throw new SnapshotPolicyError("snapshot_diff_file_count_exceeded", "sandbox post-state exceeds the bounded evidence file count");
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        entries.push(Object.freeze({
          bytes: 0,
          kind: "special",
          mode: "special",
          path,
          sha256: sha256Canonical({ kind: "special", mode: metadata.mode, path }),
        }));
        continue;
      }
      totalBytes += metadata.size;
      if (totalBytes > MAXIMUM_SNAPSHOT_LIMITS.maxTotalBytes) {
        throw new SnapshotPolicyError("snapshot_diff_total_bytes_exceeded", "sandbox post-state exceeds the bounded evidence byte limit");
      }
      const contentSha256 =
        metadata.size > MAXIMUM_SNAPSHOT_LIMITS.maxFileBytes
          ? sha256Canonical({ bytes: metadata.size, kind: "oversized_file", path })
          : createHash("sha256").update(await readFile(target)).digest("hex");
      entries.push(Object.freeze({
        bytes: metadata.size,
        kind: "file",
        mode: (metadata.mode & 0o111) !== 0 ? "executable" : "regular",
        path,
        sha256: contentSha256,
      }));
    }
  };
  await visit(root, "");
  return Object.freeze(entries.sort((left, right) => compare(left.path, right.path)));
}

export async function inspectSnapshotDiff(
  workspacePath: string,
  before: SnapshotManifest,
): Promise<SnapshotDiffEvidence> {
  const after = await enumeratePostState(workspacePath);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const entry of after) {
    const prior = beforeByPath.get(entry.path);
    if (prior === undefined) created.push(entry.path);
    else if (
      entry.kind !== "file" ||
      entry.bytes !== prior.bytes ||
      entry.mode !== prior.mode ||
      entry.sha256 !== prior.sha256
    ) {
      modified.push(entry.path);
    }
  }
  for (const entry of before.entries) {
    if (!afterByPath.has(entry.path)) deleted.push(entry.path);
  }
  const allChanged = [...created, ...modified, ...deleted].sort(compare);
  // PHASE13: Container writes are evidence only. The diff has no promotion or
  // copy-back path; durable host mutations still require Phase 5 patch approval.
  return Object.freeze({
    afterSha256: sha256Canonical({ entries: after, schema_version: 1 }),
    beforeSha256: before.sha256,
    created: created.length,
    deleted: deleted.length,
    modified: modified.length,
    paths: Object.freeze(allChanged.slice(0, 256)),
    specialEntries: after.filter(({ kind }) => kind === "special").length,
    truncated: allChanged.length > 256,
  });
}
