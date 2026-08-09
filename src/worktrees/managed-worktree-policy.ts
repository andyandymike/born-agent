import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { WorktreeError } from "./worktree-errors.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensureSafeDirectoryChain(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new WorktreeError("worktree_path_unsafe", `managed state parent is not a plain directory: ${cursor}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (creationError) {
        if (!isMissing(creationError) && !(typeof creationError === "object" && creationError !== null && "code" in creationError && creationError.code === "EEXIST")) {
          throw new WorktreeError("worktree_path_unsafe", `could not create managed state directory: ${cursor}`, { cause: creationError });
        }
      }
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new WorktreeError("worktree_path_unsafe", `managed state directory was replaced: ${cursor}`);
      }
    }
  }
}

function isStrictChild(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta !== "" && delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

export interface ManagedWorkspacePathsV1 {
  readonly archiveDirectory: string;
  readonly managedRelativeRef: string;
  readonly operationDirectory: string;
  readonly repositoryRoot: string;
  readonly worktreeParent: string;
  readonly worktreePath: string;
}

export class ManagedWorktreePolicy {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<ManagedWorktreePolicy> {
    await ensureSafeDirectoryChain(root);
    const canonical = await realpath(resolve(root));
    return new ManagedWorktreePolicy(canonical);
  }

  async paths(input: {
    readonly graphId: string;
    readonly repositoryId: string;
    readonly workspaceId: string;
  }): Promise<ManagedWorkspacePathsV1> {
    if (!/^[a-f0-9]{64}$/u.test(input.repositoryId) || !/^[0-9a-f-]{36}$/u.test(input.graphId) || !/^[0-9a-f-]{36}$/u.test(input.workspaceId)) {
      throw new WorktreeError("worktree_path_unsafe", "managed workspace identity is invalid");
    }
    const managedRelativeRef = `repositories/${input.repositoryId}/worktrees/${input.graphId}/${input.workspaceId}`;
    const repositoryRoot = join(this.root, "repositories", input.repositoryId);
    const operationDirectory = join(repositoryRoot, "operations");
    const worktreeParent = join(repositoryRoot, "worktrees", input.graphId);
    await ensureSafeDirectoryChain(operationDirectory);
    await ensureSafeDirectoryChain(join(repositoryRoot, "leases"));
    await ensureSafeDirectoryChain(worktreeParent);
    await ensureSafeDirectoryChain(join(repositoryRoot, "archives"));
    const archiveDirectory = join(repositoryRoot, "archives");
    const worktreePath = resolve(this.root, ...managedRelativeRef.split("/"));
    if (process.platform === "win32" && worktreePath.length > 240) {
      throw new WorktreeError("worktree_path_unsafe", "managed worktree path exceeds the Git 2.30 Windows safety bound");
    }
    if (!isStrictChild(this.root, worktreePath)) {
      throw new WorktreeError("worktree_path_unsafe", "managed workspace target escapes the trusted root");
    }
    for (const protectedPath of [this.root, repositoryRoot, worktreeParent]) {
      if (resolve(protectedPath) === worktreePath) {
        throw new WorktreeError("worktree_path_unsafe", "managed workspace target aliases a protected parent");
      }
    }
    return Object.freeze({ archiveDirectory, managedRelativeRef, operationDirectory, repositoryRoot, worktreeParent, worktreePath });
  }

  managedPathSha256(path: string): string {
    const resolved = resolve(path);
    if (!isStrictChild(this.root, resolved)) throw new WorktreeError("worktree_path_unsafe", "path is outside the managed root");
    return sha256(resolved);
  }
}

export function resolveWorktreeUserStateRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    const base = input.env.LOCALAPPDATA;
    if (base === undefined || base.length === 0) throw new WorktreeError("worktree_path_unsafe", "LOCALAPPDATA is required for managed worktree state");
    return join(base, "BornAgent", "task-worktrees", "v1");
  }
  const base = input.env.XDG_STATE_HOME;
  if (base === undefined || base.length === 0) throw new WorktreeError("worktree_path_unsafe", "XDG_STATE_HOME is required for managed worktree state");
  return join(base, "bornagent", "task-worktrees", "v1");
}
