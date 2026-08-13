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

export const WORKSPACE_SNAPSHOT_LIMITS_V1 = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_FILES,
  maxPathBytes: MAX_PATH_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
});

export interface WorkspaceSnapshotLimitsV1 {
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxPathBytes: number;
  readonly maxTotalBytes: number;
}

export type WorkspaceCapturePassV1 = "origin" | "snapshot_materialize" | "snapshot_verify";

/** AS0.2: optional behavior-neutral counters used by characterization gates. */
export interface WorkspaceCaptureObservationV1 {
  readonly onLimitCheck?: (observation: Readonly<{
    limitBytes: number;
    observedBytes: number;
    pass: WorkspaceCapturePassV1;
    stage?: "pre_read" | "post_read";
  }>) => void;
  readonly onPayloadRead?: (observation: Readonly<{
    bytes: number;
    pass: WorkspaceCapturePassV1;
    path: string;
  }>) => void;
  readonly onPassComplete?: (pass: WorkspaceCapturePassV1) => Promise<void> | void;
  readonly onRetainedPayloadBytes?: (bytes: number) => void;
  readonly onPassRetainedPayloadBytes?: (observation: Readonly<{
    bytes: number;
    pass: WorkspaceCapturePassV1;
  }>) => void;
}

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

function captureLimits(value?: Partial<WorkspaceSnapshotLimitsV1>): WorkspaceSnapshotLimitsV1 {
  const limits = { ...WORKSPACE_SNAPSHOT_LIMITS_V1, ...value };
  for (const name of Object.keys(WORKSPACE_SNAPSHOT_LIMITS_V1) as (keyof WorkspaceSnapshotLimitsV1)[]) {
    const limit = limits[name];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_SNAPSHOT_LIMITS_V1[name]) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace ${name} limit is invalid`);
    }
  }
  return Object.freeze(limits);
}

function assertPortablePath(path: string, limits: WorkspaceSnapshotLimitsV1 = WORKSPACE_SNAPSHOT_LIMITS_V1): void {
  if (
    path.length === 0 || path.includes("\\") || path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > limits.maxPathBytes || path.split("/").length > limits.maxDepth ||
    path.split("/").some((part) => part === "" || part === "." || part === ".." || containsControlCharacter(part))
  ) {
    throw new WorktreeError("worktree_path_unsafe", `workspace path is unsupported: ${path}`);
  }
  const first = path.split("/")[0]?.toLocaleLowerCase("en-US");
  if (first === ".git" || first === ".bornagent") {
    throw new WorktreeError("worktree_path_unsafe", `internal path cannot enter a managed baseline: ${path}`);
  }
}

class WorkspaceReadBudget {
  #files = 0;
  #retainedBytes = 0;
  #totalBytes = 0;

  constructor(
    private readonly limits: WorkspaceSnapshotLimitsV1,
    private readonly observation: WorkspaceCaptureObservationV1 | undefined,
    private readonly pass: WorkspaceCapturePassV1,
    private readonly retainedBaseBytes: number,
  ) {}

  addFile(path: string): void {
    this.#files += 1;
    if (this.#files > this.limits.maxFiles) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace file count exceeds ${String(this.limits.maxFiles)}: ${path}`);
    }
  }

  beforePayload(path: string, bytes: number): void {
    if (bytes > this.limits.maxFileBytes) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace file exceeds its byte limit: ${path}`);
    }
    const observedBytes = this.#totalBytes + bytes;
    this.observation?.onLimitCheck?.(Object.freeze({
      limitBytes: this.limits.maxTotalBytes,
      observedBytes,
      pass: this.pass,
      stage: "pre_read",
    }));
    if (observedBytes > this.limits.maxTotalBytes) {
      throw new WorktreeError("worktree_promotion_unsupported", "workspace bytes exceed the configured total limit");
    }
  }

  afterPayload(path: string, bytes: number): void {
    const observedBytes = this.#totalBytes + bytes;
    this.observation?.onLimitCheck?.(Object.freeze({
      limitBytes: this.limits.maxTotalBytes,
      observedBytes,
      pass: this.pass,
      stage: "post_read",
    }));
    if (bytes > this.limits.maxFileBytes || observedBytes > this.limits.maxTotalBytes) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace payload crossed its byte limit: ${path}`);
    }
    this.#totalBytes = observedBytes;
  }

  observePayloadRetained(currentPayloadBytes: number, retainPayload: boolean): void {
    if (retainPayload) this.#retainedBytes += currentPayloadBytes;
    else this.#retainedBytes = currentPayloadBytes;
    this.observation?.onPassRetainedPayloadBytes?.(Object.freeze({ bytes: this.#retainedBytes, pass: this.pass }));
    this.observation?.onRetainedPayloadBytes?.(this.retainedBaseBytes + this.#retainedBytes);
    if (!retainPayload) {
      this.#retainedBytes = 0;
      this.observation?.onPassRetainedPayloadBytes?.(Object.freeze({ bytes: 0, pass: this.pass }));
      this.observation?.onRetainedPayloadBytes?.(this.retainedBaseBytes);
    }
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }
}

interface StableWorkspaceObservationV1 {
  readonly byteLength: number;
  readonly bytes: Buffer | null;
  readonly mode: "100644" | "100755";
  readonly path: string;
  readonly sha256: string;
}

async function stableObserveRegular(
  root: string,
  path: string,
  mode: "100644" | "100755",
  budget: WorkspaceReadBudget,
  limits: WorkspaceSnapshotLimitsV1,
  retainPayload: boolean,
  observation?: WorkspaceCaptureObservationV1,
  pass: WorkspaceCapturePassV1 = "origin",
): Promise<StableWorkspaceObservationV1> {
  assertPortablePath(path, limits);
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
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limits.maxFileBytes) {
    throw new WorktreeError("worktree_promotion_unsupported", `baseline entry is not a bounded unique regular file: ${path}`);
  }
  budget.beforePayload(path, before.size);
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
    budget.afterPayload(path, bytes.byteLength);
    observation?.onPayloadRead?.(Object.freeze({ bytes: bytes.byteLength, pass, path }));
    budget.observePayloadRetained(bytes.byteLength, retainPayload);
    const result = Object.freeze({
      byteLength: bytes.byteLength,
      bytes: retainPayload ? bytes : null,
      mode,
      path,
      sha256: hash(bytes),
    });
    return result;
  } finally {
    await handle.close();
  }
}

interface StatusEntry { readonly code: string; readonly path: string }

function parseStatus(bytes: Buffer, limits: WorkspaceSnapshotLimitsV1): readonly StatusEntry[] {
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
    assertPortablePath(path, limits);
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

function manifest(baseCommit: string, statusSha256: string, files: readonly StableWorkspaceObservationV1[]): WorkspaceBaselineManifestV1 {
  const entries = files.map((entry) => ({ bytes: entry.byteLength, mode: entry.mode, path: entry.path, sha256: entry.sha256 }));
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
  readonly limits?: Partial<WorkspaceSnapshotLimitsV1>;
  readonly observation?: WorkspaceCaptureObservationV1;
  readonly originRoot: string;
}): Promise<WorkspaceBaselineCaptureV1> {
  const captured = await captureOriginBaselineInternal(input, true);
  return Object.freeze({
    files: Object.freeze(captured.observed.map((entry) => {
      if (entry.bytes === null) throw new WorktreeError("worktree_operation_incomplete", "materialized origin baseline lost its payload");
      return Object.freeze({ bytes: entry.bytes, mode: entry.mode, path: entry.path, sha256: entry.sha256 });
    })),
    manifest: captured.manifest,
    observation: captured.observation,
    overlay: captured.overlay,
  });
}

export interface WorkspaceBaselineObservationCaptureV1 {
  readonly manifest: WorkspaceBaselineManifestV1;
  readonly observation: GitRepositoryObservationV1;
  readonly overlay: BaselineOverlayV1 | null;
}

export async function captureOriginBaselineManifest(input: {
  readonly allowDirty: boolean;
  readonly git: GitWorktreePort;
  readonly limits?: Partial<WorkspaceSnapshotLimitsV1>;
  readonly observation?: WorkspaceCaptureObservationV1;
  readonly originRoot: string;
}): Promise<WorkspaceBaselineObservationCaptureV1> {
  const captured = await captureOriginBaselineInternal(input, false);
  return Object.freeze({ manifest: captured.manifest, observation: captured.observation, overlay: captured.overlay });
}

async function captureOriginBaselineInternal(input: {
  readonly allowDirty: boolean;
  readonly git: GitWorktreePort;
  readonly limits?: Partial<WorkspaceSnapshotLimitsV1>;
  readonly observation?: WorkspaceCaptureObservationV1;
  readonly originRoot: string;
}, retainPayloads: boolean) {
  const limits = captureLimits(input.limits);
  const first = await input.git.observe(input.originRoot);
  const gitMetadata = await lstat(join(first.originRoot, ".git")).catch(() => null);
  if (gitMetadata === null || !gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new WorktreeError("worktree_git_unavailable", "write Graph origin must be the primary non-submodule worktree");
  }
  const common = await realpath(first.commonDir);
  const dotGit = await realpath(join(first.originRoot, ".git"));
  if (common !== dotGit) throw new WorktreeError("worktree_git_unavailable", "linked worktree cannot be used as a write Graph origin");
  const status = parseStatus(first.statusBytes, limits);
  if (status.length > 0 && !input.allowDirty) {
    throw new WorktreeError("worktree_source_dirty_unapproved", "origin has tracked or untracked changes; explicit inclusion approval is required");
  }
  const byTracked = trackedMap(first.tracked);
  const deleted = new Set(status.filter((entry) => entry.code.includes("D")).map((entry) => entry.path));
  const candidates = first.tracked.filter((entry) => !deleted.has(entry.path));
  const untracked = status.filter((entry) => entry.code === "??").map((entry) => ({ mode: "100644" as const, objectId: "", path: entry.path }));
  const all = [...candidates, ...(input.allowDirty ? untracked : [])].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (all.length > limits.maxFiles) throw new WorktreeError("worktree_promotion_unsupported", `baseline file count exceeds ${String(limits.maxFiles)}`);
  const observed: StableWorkspaceObservationV1[] = [];
  const budget = new WorkspaceReadBudget(limits, input.observation, "origin", 0);
  for (const entry of all) {
    budget.addFile(entry.path);
    observed.push(await stableObserveRegular(
      first.originRoot,
      entry.path,
      entry.mode,
      budget,
      limits,
      retainPayloads,
      input.observation,
      "origin",
    ));
  }
  const second = await input.git.observe(first.originRoot);
  if (!sameObservation(first, second)) {
    throw new WorktreeError("worktree_allocation_stale", "repository identity or status changed during baseline capture");
  }
  const statusSha256 = hash(first.statusBytes);
  const baseline = manifest(first.identity.baseCommit, statusSha256, observed);
  const overlayEntries = status.map((entry) => {
    const captured = observed.find((file) => file.path === entry.path);
    const tracked = byTracked.get(entry.path);
    const statusKind = entry.code === "??" ? "untracked" as const
      : entry.code.includes("D") ? "tracked_deleted" as const
        : "tracked_modified" as const;
    return Object.freeze({
      baseSha256: statusKind === "untracked" ? null : tracked === undefined ? null : hash(`${first.identity.objectFormat}:${tracked.objectId}`),
      bytes: captured?.byteLength ?? 0,
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
  return Object.freeze({ manifest: baseline, observation: first, observed: Object.freeze(observed), overlay });
}

async function walkRegular(
  root: string,
  budget: WorkspaceReadBudget,
  limits: WorkspaceSnapshotLimitsV1,
  retainPayloads: boolean,
  relativeDirectory = "",
  observation?: WorkspaceCaptureObservationV1,
  pass: WorkspaceCapturePassV1 = "snapshot_materialize",
): Promise<StableWorkspaceObservationV1[]> {
  const absoluteDirectory = relativeDirectory === "" ? root : join(root, ...relativeDirectory.split("/"));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: StableWorkspaceObservationV1[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (path === ".git" || path.startsWith(".git/") || path === ".bornagent" || path.startsWith(".bornagent/")) continue;
    assertPortablePath(path, limits);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new WorktreeError("worktree_promotion_unsupported", `workspace contains an unsupported entry: ${path}`);
    }
    if (entry.isDirectory()) files.push(...await walkRegular(root, budget, limits, retainPayloads, path, observation, pass));
    else {
      budget.addFile(path);
      const metadata = await lstat(join(root, ...path.split("/")));
      const mode: "100644" | "100755" = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      files.push(await stableObserveRegular(root, path, mode, budget, limits, retainPayloads, observation, pass));
    }
  }
  return files;
}

export async function captureWorkspaceSnapshot(input: {
  readonly baselineManifestSha256: string;
  readonly limits?: Partial<WorkspaceSnapshotLimitsV1>;
  readonly observation?: WorkspaceCaptureObservationV1;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}): Promise<WorkspaceSnapshotCaptureV1> {
  const limits = captureLimits(input.limits);
  const firstBudget = new WorkspaceReadBudget(limits, input.observation, "snapshot_materialize", 0);
  const first = await walkRegular(input.workspaceRoot, firstBudget, limits, true, "", input.observation, "snapshot_materialize");
  const totalBytes = firstBudget.totalBytes;
  await input.observation?.onPassComplete?.("snapshot_materialize");
  const secondBudget = new WorkspaceReadBudget(limits, input.observation, "snapshot_verify", totalBytes);
  const second = await walkRegular(input.workspaceRoot, secondBudget, limits, false, "", input.observation, "snapshot_verify");
  await input.observation?.onPassComplete?.("snapshot_verify");
  if (sha256Canonical(snapshotEntries(first)) !== sha256Canonical(snapshotEntries(second))) {
    throw new WorktreeError("worktree_identity_stale", "workspace changed during snapshot capture");
  }
  input.observation?.onRetainedPayloadBytes?.(totalBytes);
  const files = first.map((entry) => {
    if (entry.bytes === null) throw new WorktreeError("worktree_operation_incomplete", "materialized workspace snapshot lost its payload");
    return Object.freeze({ bytes: entry.bytes, mode: entry.mode, path: entry.path, sha256: entry.sha256 });
  });
  return Object.freeze({ files: Object.freeze(files), manifest: workspaceSnapshotManifest(input, snapshotEntries(first), totalBytes) });
}

export interface WorkspaceSnapshotObservationCaptureV1 {
  readonly manifest: WorkspaceSnapshotManifestV1;
}

export async function captureWorkspaceSnapshotManifest(input: {
  readonly baselineManifestSha256: string;
  readonly limits?: Partial<WorkspaceSnapshotLimitsV1>;
  readonly observation?: WorkspaceCaptureObservationV1;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}): Promise<WorkspaceSnapshotObservationCaptureV1> {
  const limits = captureLimits(input.limits);
  const firstBudget = new WorkspaceReadBudget(limits, input.observation, "snapshot_verify", 0);
  const first = await walkRegular(input.workspaceRoot, firstBudget, limits, false, "", input.observation, "snapshot_verify");
  await input.observation?.onPassComplete?.("snapshot_verify");
  const secondBudget = new WorkspaceReadBudget(limits, input.observation, "snapshot_verify", 0);
  const second = await walkRegular(input.workspaceRoot, secondBudget, limits, false, "", input.observation, "snapshot_verify");
  await input.observation?.onPassComplete?.("snapshot_verify");
  if (sha256Canonical(snapshotEntries(first)) !== sha256Canonical(snapshotEntries(second))) {
    throw new WorktreeError("worktree_identity_stale", "workspace changed during manifest-only revalidation");
  }
  return Object.freeze({ manifest: workspaceSnapshotManifest(input, snapshotEntries(first), firstBudget.totalBytes) });
}

function snapshotEntries(files: readonly StableWorkspaceObservationV1[]) {
  return files.map((entry) => Object.freeze({ bytes: entry.byteLength, mode: entry.mode, path: entry.path, sha256: entry.sha256 }));
}

function workspaceSnapshotManifest(
  input: Readonly<{ baselineManifestSha256: string; workspaceId: string }>,
  entries: ReturnType<typeof snapshotEntries>,
  totalBytes: number,
): WorkspaceSnapshotManifestV1 {
  const identityContent = {
    baselineManifestSha256: input.baselineManifestSha256,
    entries,
    schemaVersion: 1 as const,
    totalBytes,
    workspaceId: input.workspaceId,
  };
  return Object.freeze(workspaceSnapshotManifestSchema.parse({
    ...identityContent,
    snapshotSha256: sha256Canonical(identityContent),
  }));
}
