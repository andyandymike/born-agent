import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { WorktreeError } from "./worktree-errors.js";
import { captureWorkspaceSnapshotManifest, type WorkspaceBaselineCaptureV1 } from "./workspace-baseline.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensurePlainParent(root: string, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new WorktreeError("worktree_path_unsafe", `baseline parent is unsafe: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(cursor, { mode: 0o700 });
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new WorktreeError("worktree_path_unsafe", `baseline parent was replaced: ${path}`);
      }
    }
  }
}

export async function materializeWorkspaceBaseline(input: {
  readonly baseline: WorkspaceBaselineCaptureV1;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}): Promise<void> {
  const initial = await readdir(input.workspaceRoot);
  if (initial.some((name) => name !== ".git")) {
    throw new WorktreeError("worktree_operation_incomplete", "new managed worktree contains unexpected material before seeding");
  }
  for (const file of input.baseline.files) {
    await ensurePlainParent(input.workspaceRoot, file.path);
    const target = join(input.workspaceRoot, ...file.path.split("/"));
    const handle = await open(target, "wx", file.mode === "100755" ? 0o755 : 0o644);
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
  }
  const captured = await captureWorkspaceSnapshotManifest({
    baselineManifestSha256: input.baseline.manifest.manifestSha256,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
  });
  const baselineEntries = input.baseline.manifest.entries;
  if (sha256Canonical(captured.manifest.entries) !== sha256Canonical(baselineEntries)) {
    throw new WorktreeError("worktree_operation_incomplete", "materialized workspace does not match the approved baseline");
  }
}
