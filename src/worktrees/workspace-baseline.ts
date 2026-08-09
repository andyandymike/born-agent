import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { GitRepositoryObservationV1, GitTrackedEntryV1, GitWorktreePort } from "./git-worktree-port.js";
import { WorktreeError } from "./worktree-errors.js";
import {
  baselineOverlaySchema,
  workspaceBaselineManifestSchema,
  workspaceSnapshotManifestSchema,
  type BaselineOverlayV1,
  type WorkspaceBaselineManifestV1,
  type WorkspaceSnapshotManifestV1,
} from "./worktree-schema.js";

const MAX_FILES = 25_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_PATH_BYTES = 1024;

export interface CapturedWorkspaceFileV1 {
  readonly bytes: Buffer;
  readonly mode: "100644" | "100755";
  readonly path: string;
  readonly sha256: string;
}

export interface WorkspaceBaselineCaptureV1 {
  readonly files: readonly CapturedWorkspaceFileV1[];
  readonly manifest: WorkspaceBaselineManifestV1;
  readonly observation: GitRepositoryObservationV1;
  readonly overlay: BaselineOverlayV1 | null;
}

export interface WorkspaceSnapshotCaptureV1 {
  readonly files: readonly CapturedWorkspaceFileV1[];
  readonly manifest: WorkspaceSnapshotManifestV1;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameStats(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function assertPortablePath(path: string): void {
  if (
    path.length === 0 || path.includes("\\") || path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES || path.split("/").length > MAX_DEPTH ||
    path.split("/").some((part) => part === "" || part === "." || part === ".." || containsControlCharacter(part))
  ) {
    throw new WorktreeError("worktree_path_unsafe", `workspace path is unsupported: ${path}`);
  }
  const first = path.split("/")[0]?.toLocaleLowerCase("en-US");
  if (first === ".git" || first === ".bornagent") {
    throw new WorktreeError("worktree_path_unsafe", `internal path cannot enter a managed baseline: ${path}`);
  }
}

async function stableReadRegular(root: string, path: string, mode: "100644" | "100755"): Promise<CapturedWorkspaceFileV1> {
  assertPortablePath(path);
  const absolute = resolve(root, ...path.split("/"));
  const delta = relative(root, absolute);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new WorktreeError("worktree_path_unsafe", `workspace path escapes its root: ${path}`);
  }
  let before: Stats;
  try {
    before = await lstat(absolute);
  } catch (error) {
    throw new WorktreeError("worktree_allocation_stale", `baseline file is missing: ${path}`, { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    throw new WorktreeError("worktree_promotion_unsupported", `baseline entry is not a bounded unique regular file: ${path}`);
  }
  const handle = await open(absolute, "r");
  try {
    const handleBefore = await handle.stat();
    const bytes = await handle.readFile();
    const handleAfter = await handle.stat();
    const after = await lstat(absolute);
    if (
      bytes.byteLength !== handleAfter.size || !sameStats(before, handleBefore) ||
      !sameStats(handleBefore, handleAfter) || !sameStats(handleAfter, after)
    ) {
      throw new WorktreeError("worktree_allocation_stale", `baseline file changed while being read: ${path}`);
    }
    return Object.freeze({ bytes: Buffer.from(bytes), mode, path, sha256: hash(bytes) });
  } finally {
    await handle.close();
  }
}

interface StatusEntry { readonly code: string; readonly path: string }

function parseStatus(bytes: Buffer): readonly StatusEntry[] {
  const records = bytes.toString("utf8").split("\0");
  const result: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new WorktreeError("worktree_promotion_unsupported", "Git status record is malformed");
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    assertPortablePath(path);
    if (code.includes("R") || code.includes("C")) {
      throw new WorktreeError("worktree_promotion_unsupported", "rename/copy origin state is unsupported for baseline capture");
    }
    if (code === "!!") continue;
    if (code !== "??" && !/^[ MADU?!]{2}$/u.test(code)) {
      throw new WorktreeError("worktree_promotion_unsupported", `unsupported Git status ${code}`);
    }
    if (code.includes("U") || code.includes("A")) {
      throw new WorktreeError("worktree_promotion_unsupported", `unmerged/index-added origin entry is unsupported: ${path}`);
    }
    result.push(Object.freeze({ code, path }));
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path, "en")));
}

function sameObservation(left: GitRepositoryObservationV1, right: GitRepositoryObservationV1): boolean {
  return sha256Canonical(left.identity) === sha256Canonical(right.identity) &&
    left.originRoot === right.originRoot && left.commonDir === right.commonDir &&
    left.statusBytes.equals(right.statusBytes) &&
    sha256Canonical(left.tracked) === sha256Canonical(right.tracked);
}

function manifest(baseCommit: string, statusSha256: string, files: readonly CapturedWorkspaceFileV1[]): WorkspaceBaselineManifestV1 {
  const entries = files.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.byteLength }));
  const content = {
    baseCommit,
    entries,
    originStatusSha256: statusSha256,
    schemaVersion: 1 as const,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  return Object.freeze(workspaceBaselineManifestSchema.parse({ ...content, manifestSha256: sha256Canonical(content) }));
}

function trackedMap(entries: readonly GitTrackedEntryV1[]): ReadonlyMap<string, GitTrackedEntryV1> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

export async function captureOriginBaseline(input: {
  readonly allowDirty: boolean;
  readonly git: GitWorktreePort;
  readonly originRoot: string;
}): Promise<WorkspaceBaselineCaptureV1> {
  const first = await input.git.observe(input.originRoot);
  const gitMetadata = await lstat(join(first.originRoot, ".git")).catch(() => null);
  if (gitMetadata === null || !gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new WorktreeError("worktree_git_unavailable", "write Graph origin must be the primary non-submodule worktree");
  }
  const common = await realpath(first.commonDir);
  const dotGit = await realpath(join(first.originRoot, ".git"));
  if (common !== dotGit) throw new WorktreeError("worktree_git_unavailable", "linked worktree cannot be used as a write Graph origin");
  const status = parseStatus(first.statusBytes);
  if (status.length > 0 && !input.allowDirty) {
    throw new WorktreeError("worktree_source_dirty_unapproved", "origin has tracked or untracked changes; explicit inclusion approval is required");
  }
  const byTracked = trackedMap(first.tracked);
  const deleted = new Set(status.filter((entry) => entry.code.includes("D")).map((entry) => entry.path));
  const candidates = first.tracked.filter((entry) => !deleted.has(entry.path));
  const untracked = status.filter((entry) => entry.code === "??").map((entry) => ({ mode: "100644" as const, objectId: "", path: entry.path }));
  const all = [...candidates, ...(input.allowDirty ? untracked : [])].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (all.length > MAX_FILES) throw new WorktreeError("worktree_promotion_unsupported", "baseline file count exceeds 25,000");
  const files: CapturedWorkspaceFileV1[] = [];
  let total = 0;
  for (const entry of all) {
    const captured = await stableReadRegular(first.originRoot, entry.path, entry.mode);
    total += captured.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new WorktreeError("worktree_promotion_unsupported", "baseline bytes exceed 512 MiB");
    files.push(captured);
  }
  const second = await input.git.observe(first.originRoot);
  if (!sameObservation(first, second)) {
    throw new WorktreeError("worktree_allocation_stale", "repository identity or status changed during baseline capture");
  }
  const statusSha256 = hash(first.statusBytes);
  const baseline = manifest(first.identity.baseCommit, statusSha256, files);
  const overlayEntries = status.map((entry) => {
    const captured = files.find((file) => file.path === entry.path);
    const tracked = byTracked.get(entry.path);
    const statusKind = entry.code === "??" ? "untracked" as const
      : entry.code.includes("D") ? "tracked_deleted" as const
        : "tracked_modified" as const;
    return Object.freeze({
      baseSha256: statusKind === "untracked" ? null : tracked === undefined ? null : hash(`${first.identity.objectFormat}:${tracked.objectId}`),
      bytes: captured?.bytes.byteLength ?? 0,
      currentSha256: captured?.sha256 ?? null,
      path: entry.path,
      status: statusKind,
    });
  });
  const overlay = overlayEntries.length === 0 ? null : (() => {
    const identityContent = {
      baseCommit: first.identity.baseCommit,
      entries: overlayEntries,
      originSnapshotSha256: baseline.manifestSha256,
      schemaVersion: 1 as const,
    };
    return Object.freeze(baselineOverlaySchema.parse({ ...identityContent, overlaySha256: sha256Canonical(identityContent) }));
  })();
  return Object.freeze({ files: Object.freeze(files), manifest: baseline, observation: first, overlay });
}

async function walkRegular(root: string, relativeDirectory = ""): Promise<CapturedWorkspaceFileV1[]> {
  const absoluteDirectory = relativeDirectory === "" ? root : join(root, ...relativeDirectory.split("/"));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: CapturedWorkspaceFileV1[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (path === ".git" || path.startsWith(".git/") || path === ".bornagent" || path.startsWith(".bornagent/")) continue;
    assertPortablePath(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace contains an unsupported entry: ${path}`);
    }
    if (entry.isDirectory()) files.push(...await walkRegular(root, path));
    else {
      const metadata = await lstat(join(root, ...path.split("/")));
      const mode: "100644" | "100755" = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      files.push(await stableReadRegular(root, path, mode));
    }
    if (files.length > MAX_FILES) throw new WorktreeError("worktree_promotion_unsupported", "workspace file count exceeds 25,000");
  }
  return files;
}

export async function captureWorkspaceSnapshot(input: {
  readonly baselineManifestSha256: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}): Promise<WorkspaceSnapshotCaptureV1> {
  const first = await walkRegular(input.workspaceRoot);
  const totalBytes = first.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new WorktreeError("worktree_promotion_unsupported", "workspace bytes exceed 512 MiB");
  const second = await walkRegular(input.workspaceRoot);
  if (sha256Canonical(first.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.toString("base64") }))) !==
      sha256Canonical(second.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.toString("base64") })))) {
    throw new WorktreeError("worktree_identity_stale", "workspace changed during snapshot capture");
  }
  const entries = first.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.byteLength }));
  const identityContent = {
    baselineManifestSha256: input.baselineManifestSha256,
    entries,
    schemaVersion: 1 as const,
    totalBytes,
    workspaceId: input.workspaceId,
  };
  const snapshot = workspaceSnapshotManifestSchema.parse({ ...identityContent, snapshotSha256: sha256Canonical(identityContent) });
  return Object.freeze({ files: Object.freeze(first), manifest: Object.freeze(snapshot) });
}
