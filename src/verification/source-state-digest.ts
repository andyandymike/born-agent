import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  NodeGitArgvRunner,
  type GitArgvResult,
  type GitArgvRunner,
} from "./git-argv-runner.js";

export type SourceEntryType = "file" | "missing" | "symlink";

export interface SourceFileFingerprint {
  readonly bytesSha256: string;
  readonly path: string;
  readonly type: SourceEntryType;
}

export interface SourceStateDigest {
  readonly files: readonly SourceFileFingerprint[];
  readonly gitHeadSha256: string;
  readonly gitIndexSha256: string;
  readonly sourceStateSha256: string;
}

export class SourceStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "SourceStateError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function addField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function digestFields(version: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  addField(hash, version);
  for (const field of fields) {
    addField(hash, field);
  }
  return hash.digest("hex");
}

function compareCanonicalPath(
  left: { readonly path: string },
  right: { readonly path: string },
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new SourceStateError(
      "invalid_source_path",
      "source paths must be non-empty workspace-relative POSIX paths",
    );
  }
  const normalized = value.normalize("NFC");
  const components = normalized.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw new SourceStateError(
      "invalid_source_path",
      "source paths must not contain empty, current, or parent components",
    );
  }
  return components.join("/");
}

function isInternalStatePath(path: string): boolean {
  const root = path.split("/", 1)[0]?.toLowerCase();
  return root === ".git" || root === ".bornagent";
}

function decodePathList(output: Buffer): readonly string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values: string[] = [];
  let start = 0;
  try {
    for (let index = 0; index < output.byteLength; index += 1) {
      if (output[index] !== 0) {
        continue;
      }
      if (index > start) {
        values.push(decoder.decode(output.subarray(start, index)));
      }
      start = index + 1;
    }
    if (start < output.byteLength) {
      throw new SourceStateError(
        "unterminated_source_path_list",
        "git source path list was not NUL terminated",
      );
    }
  } catch (error) {
    if (error instanceof SourceStateError) {
      throw error;
    }
    throw new SourceStateError(
      "source_path_invalid_utf8",
      "git returned a source path that is not valid UTF-8",
      { cause: error },
    );
  }
  return values;
}

function outputText(result: GitArgvResult): string {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(result.stdout)
      .trim();
  } catch (error) {
    throw new SourceStateError(
      "git_metadata_invalid_utf8",
      "git metadata output is not valid UTF-8",
      { cause: error },
    );
  }
}

function ensureGitSuccess(
  result: GitArgvResult,
  code: string,
  message: string,
): void {
  if (result.exitCode !== 0) {
    throw new SourceStateError(code, message);
  }
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function fingerprintPath(
  workspaceRealPath: string,
  path: string,
): Promise<SourceFileFingerprint> {
  const absolutePath = resolve(workspaceRealPath, ...path.split("/"));
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { bytesSha256: sha256(""), path, type: "missing" };
    }
    throw new SourceStateError(
      "source_entry_unreadable",
      `failed to inspect source entry ${path}`,
      { cause: error },
    );
  }

  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: "buffer" });
    return { bytesSha256: sha256(target), path, type: "symlink" };
  }
  if (!metadata.isFile()) {
    throw new SourceStateError(
      "unsupported_source_entry",
      `source entry ${path} is not a regular file or symbolic link`,
    );
  }
  const canonicalFile = await realpath(absolutePath);
  if (!isInside(workspaceRealPath, canonicalFile)) {
    throw new SourceStateError(
      "source_entry_escape",
      `source entry ${path} resolves outside the workspace`,
    );
  }
  return {
    bytesSha256: sha256(await readFile(canonicalFile)),
    path,
    type: "file",
  };
}

async function readIndexFingerprint(
  workspaceRealPath: string,
  runner: GitArgvRunner,
): Promise<string> {
  const result = await runner.run(workspaceRealPath, [
    "rev-parse",
    "--git-path",
    "index",
  ]);
  ensureGitSuccess(
    result,
    "git_index_path_unavailable",
    "could not resolve the Git index path",
  );
  const value = outputText(result);
  if (value.length === 0 || value.includes("\0")) {
    throw new SourceStateError(
      "git_index_path_invalid",
      "Git returned an invalid index path",
    );
  }
  const indexPath = isAbsolute(value) ? value : resolve(workspaceRealPath, value);
  try {
    return sha256(await readFile(indexPath));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return sha256("bornagent-index-missing-v1");
    }
    throw new SourceStateError(
      "git_index_unreadable",
      "could not read the Git index fingerprint",
      { cause: error },
    );
  }
}

async function readHeadFingerprint(
  workspaceRealPath: string,
  runner: GitArgvRunner,
): Promise<string> {
  const [referenceResult, commitResult] = await Promise.all([
    runner.run(workspaceRealPath, ["symbolic-ref", "-q", "HEAD"]),
    runner.run(workspaceRealPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
  ]);
  if (![0, 1].includes(referenceResult.exitCode)) {
    throw new SourceStateError(
      "git_head_reference_unavailable",
      "could not resolve the Git HEAD reference",
    );
  }
  if (![0, 128].includes(commitResult.exitCode)) {
    throw new SourceStateError(
      "git_head_object_unavailable",
      "could not resolve the Git HEAD object",
    );
  }
  const reference =
    referenceResult.exitCode === 0 ? outputText(referenceResult) : "DETACHED";
  const object = commitResult.exitCode === 0 ? outputText(commitResult) : "UNBORN";
  return digestFields("bornagent-git-head-v1", [reference, object]);
}

export class SourceStateDigestBuilder {
  constructor(private readonly runner: GitArgvRunner = new NodeGitArgvRunner()) {}

  async build(workspace: string): Promise<SourceStateDigest> {
    const workspaceRealPath = await realpath(workspace);
    const listed = await this.runner.run(workspaceRealPath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    ensureGitSuccess(
      listed,
      "git_source_list_failed",
      "could not enumerate tracked and nonignored untracked source files",
    );

    const paths = decodePathList(listed.stdout)
      .map(normalizeWorkspaceRelativePath)
      .filter((path) => !isInternalStatePath(path));
    if (new Set(paths).size !== paths.length) {
      throw new SourceStateError(
        "duplicate_source_path",
        "source paths collide after canonical normalization",
      );
    }
    const files = (
      await Promise.all(paths.map((path) => fingerprintPath(workspaceRealPath, path)))
    ).sort(compareCanonicalPath);
    const sourceStateSha256 = digestFields(
      "bornagent-source-state-v1",
      files.flatMap((file) => [file.path, file.type, file.bytesSha256]),
    );

    // PHASE7: source bytes, HEAD/ref, and the index are separate fingerprints.
    // A test that edits any of them cannot turn its own mutation into a new passing
    // baseline merely by exiting zero; before/after/completion snapshots must match.
    const [gitHeadSha256, gitIndexSha256] = await Promise.all([
      readHeadFingerprint(workspaceRealPath, this.runner),
      readIndexFingerprint(workspaceRealPath, this.runner),
    ]);
    return Object.freeze({
      files: Object.freeze(files.map((file) => Object.freeze(file))),
      gitHeadSha256,
      gitIndexSha256,
      sourceStateSha256,
    });
  }
}
