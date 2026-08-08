import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { WorkspacePathPolicy } from "../tools/workspace-path-policy.js";

interface ComparableStat {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface StableSourceRead {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly textEncoding: "binary" | "utf8";
}

function comparable(value: ComparableStat): readonly number[] {
  return [value.dev, value.ino, value.mode, value.size, value.mtimeMs, value.ctimeMs];
}

function sameStat(left: ComparableStat, right: ComparableStat): boolean {
  const leftFields = comparable(left);
  const rightFields = comparable(right);
  return leftFields.every((value, index) => Object.is(value, rightFields[index]));
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith("../") &&
      !difference.startsWith("..\\") &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

async function readBounded(
  handle: FileHandle,
  byteLength: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (byteLength > maxBytes) {
    throw new RepositoryIntelligenceError(
      "source_too_large",
      "source file exceeds the configured stable-read bound",
      7,
    );
  }
  const output = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    if (signal.aborted) {
      throw new RepositoryIntelligenceError("source_unstable", "source read was cancelled", 130);
    }
    const result = await handle.read(output, offset, Math.min(64 * 1024, byteLength - offset), offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== byteLength) {
    throw new RepositoryIntelligenceError(
      "source_unstable",
      "source file changed length while it was being read",
    );
  }
  return output;
}

function classifyEncoding(bytes: Uint8Array): "binary" | "utf8" {
  if (bytes.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf8";
  } catch {
    return "binary";
  }
}

export class StableSourceReader {
  constructor(private readonly paths: WorkspacePathPolicy) {}

  async read(
    relativePath: string,
    options: { readonly maxBytes: number; readonly signal: AbortSignal },
  ): Promise<StableSourceRead> {
    if (options.signal.aborted) {
      throw new RepositoryIntelligenceError("source_unstable", "source read was cancelled", 130);
    }
    const resolved = await this.paths.resolveFile(relativePath);
    if (!resolved.ok) {
      throw new RepositoryIntelligenceError(
        resolved.error.code === "path_outside_workspace" ? "source_link_denied" : "source_unstable",
        "source path did not pass workspace validation",
      );
    }
    const lexical = resolve(this.paths.workspaceRealPath, relativePath);
    if (!contained(this.paths.workspaceRealPath, lexical)) {
      throw new RepositoryIntelligenceError("source_link_denied", "source path escapes the workspace");
    }

    const before = await lstat(lexical);
    // PHASE17: links are denied even when their target remains in the workspace; otherwise a
    // path can change target between inventory, indexing, and the final source verification.
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new RepositoryIntelligenceError("source_link_denied", "source path is not a regular unlinked file");
    }
    const canonicalBefore = await realpath(lexical);
    if (!contained(this.paths.workspaceRealPath, canonicalBefore)) {
      throw new RepositoryIntelligenceError("source_link_denied", "source path resolves outside the workspace");
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(lexical, constants.O_RDONLY);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameStat(before, opened)) {
        throw new RepositoryIntelligenceError("source_unstable", "source identity changed before reading");
      }
      const bytes = await readBounded(handle, opened.size, options.maxBytes, options.signal);
      const afterHandle = await handle.stat();
      const after = await lstat(lexical);
      const canonicalAfter = await realpath(lexical);

      // PHASE17: mtime/size alone are not a stable identity. Compare the named path and open
      // handle before and after hashing so a replace/write race cannot enter a complete snapshot.
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        canonicalBefore !== canonicalAfter ||
        !contained(this.paths.workspaceRealPath, canonicalAfter) ||
        !sameStat(opened, afterHandle) ||
        !sameStat(opened, after)
      ) {
        throw new RepositoryIntelligenceError("source_unstable", "source identity changed while reading");
      }
      return Object.freeze({
        byteLength: bytes.byteLength,
        bytes: Uint8Array.from(bytes),
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        textEncoding: classifyEncoding(bytes),
      });
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError) throw error;
      throw new RepositoryIntelligenceError(
        "source_unstable",
        "source could not be read as one stable identity",
        options.signal.aborted ? 130 : 1,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
