import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import { MAX_MCP_INTEGRITY_FILES } from "./mcp-config-schema.js";
import { McpCoreError } from "./mcp-errors.js";

export const MAX_MCP_INTEGRITY_FILE_BYTES = 1024 * 1024;
export const MAX_MCP_INTEGRITY_TOTAL_BYTES = 4 * 1024 * 1024;
export const MCP_EMPTY_INTEGRITY_MARKER = "mcp-integrity:not-bound:v1";

export interface McpIntegrityFileSystem {
  lstat(filePath: string): Promise<{
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly size: number;
  }>;
  readFile(filePath: string): Promise<Uint8Array>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly size: number;
  }>;
}

const nodeFileSystem: McpIntegrityFileSystem = { lstat, readFile, realpath, stat };

export interface McpIntegrityEntry {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface McpIntegrityManifest {
  readonly binding: "explicit" | "not_bound";
  readonly entries: readonly McpIntegrityEntry[];
  readonly manifestSha256: string;
  readonly totalBytes: number;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestHash(
  binding: McpIntegrityManifest["binding"],
  entries: readonly McpIntegrityEntry[],
): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        binding === "not_bound"
          ? { binding, marker: MCP_EMPTY_INTEGRITY_MARKER }
          : { binding, entries },
      ),
      "utf8",
    )
    .digest("hex");
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0")) {
    throw new McpCoreError("mcp_integrity_invalid", "integrity path contains NUL");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new McpCoreError("mcp_integrity_invalid", "integrity path must remain inside the workspace");
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoSymlinkComponents(
  fileSystem: McpIntegrityFileSystem,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new McpCoreError("mcp_integrity_invalid", "integrity path escapes the workspace");
  }
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await fileSystem.lstat(cursor)).isSymbolicLink()) {
      throw new McpCoreError("mcp_integrity_invalid", "integrity path must not contain a symlink or junction");
    }
  }
}

export class McpIntegrityManifestBuilder {
  public constructor(
    private readonly options: {
      readonly fileSystem?: McpIntegrityFileSystem;
      readonly workspaceRealPath: string;
    },
  ) {}

  public async build(paths: readonly string[]): Promise<McpIntegrityManifest> {
    if (paths.length > MAX_MCP_INTEGRITY_FILES) {
      throw new McpCoreError("mcp_integrity_limit", "too many MCP integrity files");
    }
    const normalizedPaths = paths.map(normalizeRelativePath).sort();
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw new McpCoreError("mcp_integrity_invalid", "MCP integrity paths must be unique");
    }

    // PHASE12: only explicit integrity_files are hashed. Inferring scripts or
    // lockfiles from argv would claim authority the user never actually bound.
    if (normalizedPaths.length === 0) {
      return Object.freeze({
        binding: "not_bound",
        entries: Object.freeze([]),
        manifestSha256: manifestHash("not_bound", []),
        totalBytes: 0,
      });
    }

    const fileSystem = this.options.fileSystem ?? nodeFileSystem;
    const canonicalRoot = await fileSystem.realpath(this.options.workspaceRealPath);
    const entries: McpIntegrityEntry[] = [];
    let totalBytes = 0;
    for (const relativePath of normalizedPaths) {
      const candidate = path.resolve(canonicalRoot, relativePath);
      await assertNoSymlinkComponents(
        fileSystem,
        canonicalRoot,
        candidate,
      );
      const canonicalFile = await fileSystem.realpath(candidate);
      if (!isInside(canonicalRoot, canonicalFile)) {
        throw new McpCoreError("mcp_integrity_invalid", "integrity file resolves outside the workspace");
      }
      const metadata = await fileSystem.stat(canonicalFile);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new McpCoreError("mcp_integrity_invalid", "integrity entry must be a regular file");
      }
      if (metadata.size > MAX_MCP_INTEGRITY_FILE_BYTES) {
        throw new McpCoreError("mcp_integrity_limit", "an MCP integrity file exceeds 1 MiB");
      }
      const bytes = await fileSystem.readFile(canonicalFile);
      if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_MCP_INTEGRITY_FILE_BYTES) {
        throw new McpCoreError("mcp_integrity_changed", "integrity file changed while it was read");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_MCP_INTEGRITY_TOTAL_BYTES) {
        throw new McpCoreError("mcp_integrity_limit", "MCP integrity files exceed 4 MiB total");
      }
      entries.push(
        Object.freeze({
          bytes: bytes.byteLength,
          path: relativePath,
          sha256: sha256Bytes(bytes),
        }),
      );
    }
    return Object.freeze({
      binding: "explicit",
      entries: Object.freeze(entries),
      manifestSha256: manifestHash("explicit", entries),
      totalBytes,
    });
  }

  public async recheck(expected: McpIntegrityManifest): Promise<void> {
    const current = await this.build(expected.entries.map((entry) => entry.path));
    if (
      current.binding !== expected.binding ||
      current.manifestSha256 !== expected.manifestSha256 ||
      canonicalJson(current.entries) !== canonicalJson(expected.entries)
    ) {
      throw new McpCoreError("mcp_integrity_changed", "MCP integrity evidence changed after approval");
    }
  }
}
