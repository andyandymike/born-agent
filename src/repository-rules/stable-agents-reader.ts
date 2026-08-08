import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const MAX_REPOSITORY_RULE_BYTES = 64 * 1024;

export type StableAgentsReaderErrorCode =
  | "rules_contains_nul"
  | "rules_invalid_utf8"
  | "rules_io_failed"
  | "rules_link_denied"
  | "rules_not_regular_file"
  | "rules_outside_workspace"
  | "rules_too_large"
  | "rules_unstable"
  | "workspace_invalid"
  | "workspace_unstable";

export class StableAgentsReaderError extends Error {
  constructor(
    readonly code: StableAgentsReaderErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "StableAgentsReaderError";
  }
}

interface FileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export type StableAgentsDiskState =
  | { readonly state: "missing" }
  | {
      readonly bytes: Uint8Array;
      readonly content: string;
      readonly contentSha256: string;
      readonly state: "loaded";
    };

function identity(metadata: FileIdentity): FileIdentity {
  return {
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameNode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith("../") && !difference.startsWith("..\\") && difference !== ".." && !isAbsolute(difference));
}

function platformPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonicalRelativeRulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    basename(normalized) !== "AGENTS.md"
  ) {
    throw new StableAgentsReaderError("rules_outside_workspace", "repository rule path is not canonical");
  }
  return normalized;
}

export class StableAgentsReader {
  private constructor(
    readonly workspaceRealPath: string,
    private readonly workspaceIdentity: FileIdentity,
  ) {}

  static async create(workspace: string): Promise<StableAgentsReader> {
    try {
      const workspaceRealPath = await realpath(resolve(workspace));
      const metadata = await lstat(workspaceRealPath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new StableAgentsReaderError("workspace_invalid", "workspace must resolve to a regular directory");
      }
      return new StableAgentsReader(workspaceRealPath, identity(metadata));
    } catch (error) {
      if (error instanceof StableAgentsReaderError) throw error;
      throw new StableAgentsReaderError("workspace_invalid", "failed to resolve the workspace", { cause: error });
    }
  }

  async read(relativePathInput: string, options: { readonly allowMissing: boolean }): Promise<StableAgentsDiskState> {
    await this.assertWorkspaceIdentity();
    const relativePath = canonicalRelativeRulePath(relativePathInput);
    const rulesPath = resolve(this.workspaceRealPath, relativePath);
    if (!contained(this.workspaceRealPath, rulesPath)) {
      throw new StableAgentsReaderError("rules_outside_workspace", "repository rule is outside the workspace");
    }

    let namedBefore: Awaited<ReturnType<typeof lstat>>;
    try {
      namedBefore = await lstat(rulesPath);
    } catch (error) {
      if (options.allowMissing && isNotFound(error)) return { state: "missing" };
      throw new StableAgentsReaderError("rules_io_failed", "failed to inspect repository rule", { cause: error });
    }
    if (namedBefore.isSymbolicLink()) {
      throw new StableAgentsReaderError("rules_link_denied", "repository rule must not be a link");
    }
    if (!namedBefore.isFile()) {
      throw new StableAgentsReaderError("rules_not_regular_file", "repository rule must be a regular file");
    }
    if (namedBefore.size > MAX_REPOSITORY_RULE_BYTES) {
      throw new StableAgentsReaderError("rules_too_large", "repository rule exceeds 64 KiB");
    }
    const canonicalBefore = await realpath(rulesPath).catch((error: unknown) => {
      throw new StableAgentsReaderError("rules_io_failed", "failed to resolve repository rule", { cause: error });
    });
    if (
      !contained(this.workspaceRealPath, canonicalBefore) ||
      platformPath(canonicalBefore) !== platformPath(rulesPath)
    ) {
      throw new StableAgentsReaderError("rules_outside_workspace", "repository rule traverses a link or leaves the workspace");
    }

    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(rulesPath, constants.O_RDONLY | noFollow).catch((error: unknown) => {
      throw new StableAgentsReaderError("rules_io_failed", "failed to open repository rule", { cause: error });
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(identity(namedBefore), identity(opened))) {
        throw new StableAgentsReaderError("rules_unstable", "repository rule changed before reading");
      }
      const capture = Buffer.allocUnsafe(MAX_REPOSITORY_RULE_BYTES + 1);
      let offset = 0;
      while (offset < capture.byteLength) {
        const result = await handle.read(capture, offset, capture.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_REPOSITORY_RULE_BYTES) {
        throw new StableAgentsReaderError("rules_too_large", "repository rule exceeds 64 KiB");
      }
      const handleAfter = await handle.stat();
      let namedAfter: Awaited<ReturnType<typeof lstat>>;
      let canonicalAfter: string;
      try {
        namedAfter = await lstat(rulesPath);
        canonicalAfter = await realpath(rulesPath);
      } catch (error) {
        throw new StableAgentsReaderError("rules_unstable", "repository rule changed while reading", { cause: error });
      }
      if (
        namedAfter.isSymbolicLink() ||
        !namedAfter.isFile() ||
        !sameIdentity(identity(namedBefore), identity(handleAfter)) ||
        !sameIdentity(identity(namedAfter), identity(handleAfter)) ||
        platformPath(canonicalAfter) !== platformPath(rulesPath)
      ) {
        throw new StableAgentsReaderError("rules_unstable", "repository rule changed while reading");
      }
      const bytes = capture.subarray(0, offset);
      if (bytes.includes(0)) throw new StableAgentsReaderError("rules_contains_nul", "repository rule contains NUL bytes");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new StableAgentsReaderError("rules_invalid_utf8", "repository rule must be valid UTF-8", { cause: error });
      }
      return Object.freeze({
        bytes: Uint8Array.from(bytes),
        content,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        state: "loaded" as const,
      });
    } finally {
      await handle.close();
    }
  }

  private async assertWorkspaceIdentity(): Promise<void> {
    try {
      const metadata = await lstat(this.workspaceRealPath);
      const canonical = await realpath(this.workspaceRealPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !sameNode(this.workspaceIdentity, identity(metadata)) ||
        platformPath(canonical) !== platformPath(this.workspaceRealPath)
      ) {
        throw new StableAgentsReaderError("workspace_unstable", "workspace identity changed while rules were frozen");
      }
    } catch (error) {
      if (error instanceof StableAgentsReaderError) throw error;
      throw new StableAgentsReaderError("workspace_unstable", "failed to revalidate workspace", { cause: error });
    }
  }
}
