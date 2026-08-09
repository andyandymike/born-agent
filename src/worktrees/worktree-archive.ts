import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { WorktreeError } from "./worktree-errors.js";
import type { WorkspaceSnapshotCaptureV1 } from "./workspace-baseline.js";

export interface WorktreeArchiveV1 {
  readonly archiveDirectory: string;
  readonly archiveId: string;
  readonly archiveSha256: string;
  readonly totalBytes: number;
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeObject(path: string, bytes: Buffer): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  } catch (error) {
    if (!isExists(error)) throw error;
    const metadata = await lstat(path);
    const existing = await readFile(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !existing.equals(bytes)) {
      throw new WorktreeError("worktree_operation_incomplete", "archive object identity collision is unsafe", { cause: error });
    }
  }
}

export async function createWorktreeArchive(input: {
  readonly archiveId: string;
  readonly archiveRoot: string;
  readonly baselinePaths: readonly string[];
  readonly graphId: string;
  readonly snapshot: WorkspaceSnapshotCaptureV1;
  readonly workspaceId: string;
}): Promise<WorktreeArchiveV1> {
  const archiveDirectory = join(input.archiveRoot, input.archiveId);
  await mkdir(archiveDirectory, { mode: 0o700 });
  const objectDirectory = join(archiveDirectory, "objects");
  await mkdir(objectDirectory, { mode: 0o700 });
  for (const file of input.snapshot.files) await writeObject(join(objectDirectory, file.sha256), file.bytes);
  const current = new Set(input.snapshot.files.map((file) => file.path));
  const identityContent = {
    baseline_manifest_sha256: input.snapshot.manifest.baselineManifestSha256,
    deleted_paths: input.baselinePaths.filter((path) => !current.has(path)).sort(),
    entries: input.snapshot.files.map((file) => ({ bytes: file.bytes.byteLength, mode: file.mode, object_sha256: file.sha256, path: file.path })),
    graph_id: input.graphId,
    schema_version: 1 as const,
    snapshot_sha256: input.snapshot.manifest.snapshotSha256,
    total_bytes: input.snapshot.manifest.totalBytes,
    workspace_id: input.workspaceId,
  };
  const archiveSha256 = sha256Canonical(identityContent);
  const manifest = { ...identityContent, archive_sha256: archiveSha256 };
  // A strict parse round-trip rejects duplicate keys or non-JSON values before
  // the manifest is treated as recovery authority.
  const encoded = `${JSON.stringify(manifest)}\n`;
  void parseStrictJson(encoded);
  const temporary = join(archiveDirectory, `.${input.archiveId}.tmp`);
  const target = join(archiveDirectory, "manifest.json");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new WorktreeError("worktree_operation_incomplete", "archive manifest could not be committed", { cause: error });
  }
  const verified = await readFile(target, "utf8");
  const parsed = parseStrictJson(verified) as Readonly<Record<string, unknown>>;
  const { archive_sha256: storedSha256, ...verifiedContent } = parsed;
  if (storedSha256 !== archiveSha256 || sha256Canonical(verifiedContent) !== archiveSha256) {
    throw new WorktreeError("worktree_operation_incomplete", "archive manifest verification failed");
  }
  return Object.freeze({ archiveDirectory, archiveId: input.archiveId, archiveSha256, totalBytes: input.snapshot.manifest.totalBytes });
}
