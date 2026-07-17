import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { withWorkspaceMutationLock } from "../../changes/workspace-mutation-mutex.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { NodeGitArgvRunner, type GitArgvRunner } from "../../verification/git-argv-runner.js";
import { SourceStateDigestBuilder } from "../../verification/source-state-digest.js";
import {
  filterSnapshotEntry,
  normalizeSnapshotRelativePath,
  SnapshotPolicyError,
  type SnapshotEntryKind,
} from "./snapshot-filter.js";
import { MAXIMUM_SNAPSHOT_LIMITS, type SnapshotManifest } from "./snapshot-manifest.js";
import type { SnapshotSourceEntry } from "./workspace-snapshot-planner.js";
import type {
  SnapshotSinkAdapter,
  SnapshotSinkHandle,
  SnapshotSourceAdapter,
} from "./workspace-snapshotter.js";

const ZERO_SHA256 = "0".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function decodeNulStrings(value: Buffer): readonly string[] {
  if (value.byteLength === 0) return [];
  if (value.at(-1) !== 0) {
    throw new SnapshotPolicyError("git_path_list_unterminated", "Git snapshot path list is not NUL terminated");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(value.subarray(0, -1))
      .split("\0");
  } catch (error) {
    if (error instanceof SnapshotPolicyError) throw error;
    throw new SnapshotPolicyError("git_path_invalid_utf8", "Git snapshot path is not valid UTF-8");
  }
}

function decodeNulList(value: Buffer): readonly string[] {
  return decodeNulStrings(value).map(normalizeSnapshotRelativePath);
}

function decodeStageEntries(value: Buffer): ReadonlyMap<string, string> {
  const stages = new Map<string, string>();
  for (const record of decodeNulStrings(value)) {
    const tab = record.indexOf("\t");
    const header = tab < 0 ? "" : record.slice(0, tab);
    const path = tab < 0 ? "" : record.slice(tab + 1);
    const mode = header.split(" ")[0] ?? "";
    if (!/^(?:100644|100755|120000|160000)$/u.test(mode) || path.length === 0) {
      throw new SnapshotPolicyError("git_stage_invalid", "Git returned an invalid staged snapshot entry");
    }
    stages.set(normalizeSnapshotRelativePath(path), mode);
  }
  return stages;
}

function kindFor(metadata: Awaited<ReturnType<typeof lstat>>, gitMode: string | undefined): SnapshotEntryKind {
  if (gitMode === "160000") return "submodule";
  if (metadata.isSymbolicLink()) return process.platform === "win32" ? "junction" : "symlink";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  if (metadata.isSocket()) return "socket";
  if (metadata.isCharacterDevice() || metadata.isBlockDevice()) return "device";
  return "other";
}

export class NodeWorkspaceSnapshotSource implements SnapshotSourceAdapter {
  private constructor(
    readonly workspaceRealPath: string,
    private readonly git: GitArgvRunner,
  ) {}

  static async create(
    workspace: string,
    git: GitArgvRunner = new NodeGitArgvRunner(),
  ): Promise<NodeWorkspaceSnapshotSource> {
    const root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) {
      throw new SnapshotPolicyError("workspace_not_directory", "snapshot workspace must be a directory");
    }
    return new NodeWorkspaceSnapshotSource(root, git);
  }

  async enumerateSourceEntries(): Promise<readonly SnapshotSourceEntry[]> {
    const [trackedResult, untrackedResult, stageResult] = await Promise.all([
      this.git.run(this.workspaceRealPath, ["ls-files", "-z", "--cached"]),
      this.git.run(this.workspaceRealPath, ["ls-files", "-z", "--others", "--exclude-standard"]),
      this.git.run(this.workspaceRealPath, ["ls-files", "--stage", "-z"]),
    ]);
    if ([trackedResult, untrackedResult, stageResult].some(({ exitCode }) => exitCode !== 0)) {
      throw new SnapshotPolicyError("git_snapshot_enumeration_failed", "could not enumerate the current Git worktree snapshot");
    }
    const tracked = new Set(decodeNulList(trackedResult.stdout));
    const paths = [...new Set([...tracked, ...decodeNulList(untrackedResult.stdout)])].sort();
    if (paths.length > MAXIMUM_SNAPSHOT_LIMITS.maxFiles) {
      throw new SnapshotPolicyError("snapshot_file_count_exceeded", "snapshot exceeds its maximum file count");
    }
    const stages = decodeStageEntries(stageResult.stdout);
    let includedBytes = 0;
    const entries: SnapshotSourceEntry[] = [];
    for (const path of paths) {
      const absolute = resolve(this.workspaceRealPath, ...path.split("/"));
      if (!inside(this.workspaceRealPath, absolute)) {
        throw new SnapshotPolicyError("snapshot_path_escape", "snapshot source path escaped its workspace");
      }
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
      const gitMode = stages.get(path);
      const kind = kindFor(metadata, gitMode);
      const decision = filterSnapshotEntry({ ignored: false, kind, relativePath: path });
      let bytes = 0;
      let contentSha256 = ZERO_SHA256;
      if (decision.disposition === "include") {
        if (metadata.size > MAXIMUM_SNAPSHOT_LIMITS.maxFileBytes) {
          throw new SnapshotPolicyError("snapshot_file_bytes_exceeded", "snapshot contains a file larger than the per-file limit");
        }
        includedBytes += metadata.size;
        if (includedBytes > MAXIMUM_SNAPSHOT_LIMITS.maxTotalBytes) {
          throw new SnapshotPolicyError("snapshot_total_bytes_exceeded", "snapshot exceeds its total byte limit");
        }
        const fileBytes = await readFile(absolute);
        bytes = fileBytes.byteLength;
        contentSha256 = createHash("sha256").update(fileBytes).digest("hex");
      }
      entries.push(Object.freeze({
        bytes,
        contentSha256,
        ignored: false,
        kind,
        mode: gitMode === "100755" || (gitMode === undefined && (metadata.mode & 0o111) !== 0)
          ? "executable"
          : "regular",
        relativePath: path,
        tracked: tracked.has(path),
      }));
    }
    return Object.freeze(entries);
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    const path = normalizeSnapshotRelativePath(relativePath);
    const absolute = resolve(this.workspaceRealPath, ...path.split("/"));
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SnapshotPolicyError("snapshot_source_not_file", "approved snapshot source is no longer a regular file");
    }
    const canonical = await realpath(absolute);
    if (!inside(this.workspaceRealPath, canonical)) {
      throw new SnapshotPolicyError("snapshot_source_escape", "approved snapshot source resolves outside the workspace");
    }
    return readFile(canonical);
  }

  async readSourceStateSha256(): Promise<string> {
    const state = await new SourceStateDigestBuilder(this.git).build(this.workspaceRealPath);
    return sha256Canonical({
      git_head_sha256: state.gitHeadSha256,
      git_index_sha256: state.gitIndexSha256,
      source_state_sha256: state.sourceStateSha256,
      version: 1,
    });
  }

  async withMutationLock<T>(
    operation: () => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    return withWorkspaceMutationLock(this.workspaceRealPath, signal, operation);
  }
}

interface NodeSnapshotHandle extends SnapshotSinkHandle {
  readonly executionRoot: string;
  readonly workspacePath: string;
}

async function assertDirectoryWithoutLink(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SnapshotPolicyError("snapshot_storage_link_denied", "snapshot storage cannot traverse a link or non-directory");
  }
}

async function existingDirectoryWithoutLink(path: string): Promise<boolean> {
  try {
    await assertDirectoryWithoutLink(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export class NodeWorkspaceSnapshotSink implements SnapshotSinkAdapter {
  readonly executionRoot: string;
  readonly sandboxRoot: string;
  readonly workspacePath: string;
  readonly #opaqueId: string;
  #handle: NodeSnapshotHandle | null = null;

  public constructor(
    private readonly workspaceRealPath: string,
    readonly runId: string,
    readonly executionId: string,
  ) {
    if (!UUID.test(runId) || !UUID.test(executionId)) {
      throw new SnapshotPolicyError("invalid_snapshot_identity", "snapshot run and execution ids must be UUIDs");
    }
    this.sandboxRoot = join(workspaceRealPath, ".bornagent", "sandboxes");
    this.executionRoot = join(this.sandboxRoot, runId, executionId);
    this.workspacePath = join(this.executionRoot, "workspace");
    this.#opaqueId = `sandbox:${runId}:${executionId}`;
  }

  async createExclusive(): Promise<SnapshotSinkHandle> {
    const internal = join(this.workspaceRealPath, ".bornagent");
    await mkdir(internal, { recursive: true });
    await assertDirectoryWithoutLink(internal);
    await mkdir(this.sandboxRoot, { recursive: true });
    await assertDirectoryWithoutLink(this.sandboxRoot);
    const runRoot = join(this.sandboxRoot, this.runId);
    await mkdir(runRoot, { recursive: true });
    await assertDirectoryWithoutLink(runRoot);
    await mkdir(this.executionRoot, { recursive: false });
    try {
      await mkdir(this.workspacePath, { recursive: false });
    } catch (error) {
      try {
        await rm(this.executionRoot, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "snapshot creation and partial cleanup both failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
    const handle: NodeSnapshotHandle = Object.freeze({
      executionRoot: this.executionRoot,
      opaqueId: this.#opaqueId,
      workspacePath: this.workspacePath,
    });
    this.#handle = handle;
    return handle;
  }

  async writeFile(
    handle: SnapshotSinkHandle,
    relativePath: string,
    bytes: Uint8Array,
    mode: "executable" | "regular",
  ): Promise<void> {
    const current = this.requireHandle(handle);
    const path = normalizeSnapshotRelativePath(relativePath);
    const target = resolve(current.workspacePath, ...path.split("/"));
    if (!inside(current.workspacePath, target)) {
      throw new SnapshotPolicyError("snapshot_write_escape", "snapshot write escaped the disposable workspace");
    }
    const parentParts = path.split("/").slice(0, -1);
    let parent = current.workspacePath;
    for (const part of parentParts) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: false }).catch(async (error: unknown) => {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
      });
      await assertDirectoryWithoutLink(parent);
    }
    await writeFile(target, bytes, { flag: "wx", mode: mode === "executable" ? 0o755 : 0o644 });
    if (process.platform !== "win32") await chmod(target, mode === "executable" ? 0o755 : 0o644);
  }

  async complete(handle: SnapshotSinkHandle, manifest: SnapshotManifest): Promise<void> {
    const current = this.requireHandle(handle);
    await writeFile(
      join(current.executionRoot, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  async discard(handle: SnapshotSinkHandle): Promise<void> {
    this.requireHandle(handle);
    await this.cleanupAndVerify();
  }

  async cleanupAndVerify(): Promise<void> {
    if (!inside(this.sandboxRoot, this.executionRoot)) {
      throw new SnapshotPolicyError("snapshot_cleanup_escape", "snapshot cleanup target escaped sandbox storage");
    }
    const internal = join(this.workspaceRealPath, ".bornagent");
    const runRoot = join(this.sandboxRoot, this.runId);
    for (const parent of [internal, this.sandboxRoot, runRoot]) {
      if (!(await existingDirectoryWithoutLink(parent))) {
        this.#handle = null;
        return;
      }
    }
    if (!(await existingDirectoryWithoutLink(this.executionRoot))) {
      this.#handle = null;
      return;
    }
    await rm(this.executionRoot, { force: true, recursive: true });
    try {
      await lstat(this.executionRoot);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#handle = null;
        return;
      }
      throw error;
    }
    throw new SnapshotPolicyError("snapshot_cleanup_unknown", "snapshot cleanup could not prove absence");
  }

  private requireHandle(handle: SnapshotSinkHandle): NodeSnapshotHandle {
    const current = this.#handle;
    if (current === null || handle.opaqueId !== this.#opaqueId) {
      throw new SnapshotPolicyError("snapshot_handle_mismatch", "snapshot sink handle does not match this execution");
    }
    return current;
  }
}
