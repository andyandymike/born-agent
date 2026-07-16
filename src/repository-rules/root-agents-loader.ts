import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";

import {
  compareRepositoryRules,
  invalidRepositoryRulesChange,
  RepositoryRuleSet,
  ROOT_AGENTS_RELATIVE_PATH,
} from "./repository-rule-set.js";
import type {
  RepositoryRulesArtifactReference,
  RepositoryRulesChangeDetection,
  RepositoryRulesIdentity,
} from "./repository-rule-set.js";

export const MAX_ROOT_AGENTS_BYTES = 64 * 1024;

export interface RepositoryRulesArtifactInput {
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly mediaType: "text/markdown; charset=utf-8";
}

/** Narrow adapter implemented by Phase 10 ArtifactStore integration. */
export interface RepositoryRulesArtifactPort {
  storeRepositoryRules(
    input: RepositoryRulesArtifactInput,
  ): Promise<RepositoryRulesArtifactReference>;
}

export type RootAgentsLoaderErrorCode =
  | "artifact_reference_invalid"
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

export class RootAgentsLoaderError extends Error {
  override readonly name = "RootAgentsLoaderError";

  constructor(
    readonly code: RootAgentsLoaderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

interface RulesContent {
  readonly bytes: Uint8Array;
  readonly content: string;
  readonly contentSha256: string;
}

type RulesDiskState =
  | { readonly state: "missing" }
  | ({ readonly state: "loaded" } & RulesContent);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith("../") &&
      !difference.startsWith("..\\") &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

function platformPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
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

function sameNodeIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function identity(metadata: {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}): FileIdentity {
  return {
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function validRelativeArtifactRef(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    value.length === 0 ||
    value.includes("\\") ||
    hasControlCharacter ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function diskIdentity(state: RulesDiskState): RepositoryRulesIdentity {
  return state.state === "missing"
    ? Object.freeze({ contentSha256: null, state: "missing" })
    : Object.freeze({
        contentSha256: state.contentSha256,
        state: "loaded",
      });
}

export class RootAgentsLoader {
  readonly workspaceRealPath: string;
  private readonly rulesPath: string;

  private constructor(
    workspaceRealPath: string,
    private readonly workspaceIdentity: FileIdentity,
    private readonly artifactStore: RepositoryRulesArtifactPort,
  ) {
    this.workspaceRealPath = workspaceRealPath;
    this.rulesPath = join(workspaceRealPath, ROOT_AGENTS_RELATIVE_PATH);
  }

  static async create(
    workspace: string,
    options: { readonly artifactStore: RepositoryRulesArtifactPort },
  ): Promise<RootAgentsLoader> {
    let workspaceRealPath: string;
    try {
      workspaceRealPath = await realpath(resolve(workspace));
      const metadata = await lstat(workspaceRealPath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new RootAgentsLoaderError(
          "workspace_invalid",
          "workspace must resolve to a regular directory",
        );
      }
      return new RootAgentsLoader(
        workspaceRealPath,
        identity(metadata),
        options.artifactStore,
      );
    } catch (error) {
      if (error instanceof RootAgentsLoaderError) {
        throw error;
      }
      throw new RootAgentsLoaderError(
        "workspace_invalid",
        "failed to resolve the workspace",
        { cause: error },
      );
    }
  }

  async loadForRun(): Promise<RepositoryRuleSet> {
    // PHASE10: This adapter reads only the fixed root AGENTS.md and freezes its
    // bytes before the model request. Repository text remains lower-priority,
    // untrusted instruction; it never becomes permission/completion policy.
    const state = await this.readDiskState();
    if (state.state === "missing") {
      return RepositoryRuleSet.missing();
    }

    const artifact = await this.artifactStore.storeRepositoryRules({
      bytes: Uint8Array.from(state.bytes),
      expectedSha256: state.contentSha256,
      mediaType: "text/markdown; charset=utf-8",
    });
    this.assertArtifact(artifact, state);
    return RepositoryRuleSet.loaded({
      artifact,
      content: state.content,
      contentBytes: state.bytes.byteLength,
      contentSha256: state.contentSha256,
    });
  }

  async detectChange(
    frozen: RepositoryRuleSet,
  ): Promise<RepositoryRulesChangeDetection> {
    try {
      const current = await this.readDiskState();
      return compareRepositoryRules(frozen, diskIdentity(current));
    } catch (error) {
      if (error instanceof RootAgentsLoaderError) {
        return invalidRepositoryRulesChange(frozen, error.code);
      }
      throw error;
    }
  }

  private async assertWorkspaceIdentity(): Promise<void> {
    try {
      const metadata = await lstat(this.workspaceRealPath);
      const canonical = await realpath(this.workspaceRealPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !sameNodeIdentity(this.workspaceIdentity, identity(metadata)) ||
        platformPath(canonical) !== platformPath(this.workspaceRealPath)
      ) {
        throw new RootAgentsLoaderError(
          "workspace_unstable",
          "workspace identity changed while repository rules were frozen",
        );
      }
    } catch (error) {
      if (error instanceof RootAgentsLoaderError) {
        throw error;
      }
      throw new RootAgentsLoaderError(
        "workspace_unstable",
        "failed to revalidate the workspace",
        { cause: error },
      );
    }
  }

  private async readDiskState(): Promise<RulesDiskState> {
    await this.assertWorkspaceIdentity();
    if (!isContained(this.workspaceRealPath, resolve(this.rulesPath))) {
      throw new RootAgentsLoaderError(
        "rules_outside_workspace",
        "root AGENTS.md path is outside the workspace",
      );
    }

    let namedBefore: Awaited<ReturnType<typeof lstat>>;
    try {
      namedBefore = await lstat(this.rulesPath);
    } catch (error) {
      if (isNotFound(error)) {
        return { state: "missing" };
      }
      throw new RootAgentsLoaderError(
        "rules_io_failed",
        "failed to inspect root AGENTS.md",
        { cause: error },
      );
    }

    if (namedBefore.isSymbolicLink()) {
      throw new RootAgentsLoaderError(
        "rules_link_denied",
        "root AGENTS.md must not be a symbolic link or junction",
      );
    }
    if (!namedBefore.isFile()) {
      throw new RootAgentsLoaderError(
        "rules_not_regular_file",
        "root AGENTS.md must be a regular file",
      );
    }
    if (namedBefore.size > MAX_ROOT_AGENTS_BYTES) {
      throw new RootAgentsLoaderError(
        "rules_too_large",
        "root AGENTS.md exceeds 64 KiB",
      );
    }

    let canonicalBefore: string;
    try {
      canonicalBefore = await realpath(this.rulesPath);
    } catch (error) {
      throw new RootAgentsLoaderError(
        "rules_io_failed",
        "failed to resolve root AGENTS.md",
        { cause: error },
      );
    }
    if (
      !isContained(this.workspaceRealPath, canonicalBefore) ||
      platformPath(canonicalBefore) !== platformPath(this.rulesPath)
    ) {
      throw new RootAgentsLoaderError(
        "rules_outside_workspace",
        "root AGENTS.md must not traverse a link or leave the workspace",
      );
    }

    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.rulesPath, constants.O_RDONLY | noFollow);
    } catch (error) {
      throw new RootAgentsLoaderError(
        "rules_io_failed",
        "failed to open root AGENTS.md",
        { cause: error },
      );
    }

    try {
      const handleBefore = await handle.stat();
      if (
        !handleBefore.isFile() ||
        !sameIdentity(identity(namedBefore), identity(handleBefore))
      ) {
        throw new RootAgentsLoaderError(
          "rules_unstable",
          "root AGENTS.md changed before it could be read",
        );
      }

      const capture = Buffer.allocUnsafe(MAX_ROOT_AGENTS_BYTES + 1);
      let offset = 0;
      while (offset < capture.byteLength) {
        const { bytesRead } = await handle.read(
          capture,
          offset,
          capture.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      if (offset > MAX_ROOT_AGENTS_BYTES) {
        throw new RootAgentsLoaderError(
          "rules_too_large",
          "root AGENTS.md exceeds 64 KiB",
        );
      }

      const handleAfter = await handle.stat();
      let namedAfter: Awaited<ReturnType<typeof lstat>>;
      let canonicalAfter: string;
      try {
        namedAfter = await lstat(this.rulesPath);
        canonicalAfter = await realpath(this.rulesPath);
      } catch (error) {
        throw new RootAgentsLoaderError(
          "rules_unstable",
          "root AGENTS.md changed while it was being read",
          { cause: error },
        );
      }
      if (
        namedAfter.isSymbolicLink() ||
        !namedAfter.isFile() ||
        !sameIdentity(identity(namedBefore), identity(handleAfter)) ||
        !sameIdentity(identity(namedAfter), identity(handleAfter)) ||
        platformPath(canonicalAfter) !== platformPath(this.rulesPath)
      ) {
        throw new RootAgentsLoaderError(
          "rules_unstable",
          "root AGENTS.md changed while it was being read",
        );
      }

      const bytes = capture.subarray(0, offset);
      if (bytes.includes(0)) {
        throw new RootAgentsLoaderError(
          "rules_contains_nul",
          "root AGENTS.md must not contain NUL bytes",
        );
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new RootAgentsLoaderError(
          "rules_invalid_utf8",
          "root AGENTS.md must be valid UTF-8",
          { cause: error },
        );
      }

      return {
        bytes: Uint8Array.from(bytes),
        content,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        state: "loaded",
      };
    } finally {
      await handle.close();
    }
  }

  private assertArtifact(
    artifact: RepositoryRulesArtifactReference,
    content: RulesContent,
  ): void {
    if (
      artifact.bytes !== content.bytes.byteLength ||
      artifact.sha256 !== content.contentSha256 ||
      artifact.artifactId !== `sha256:${content.contentSha256}` ||
      !validRelativeArtifactRef(artifact.relativeRef)
    ) {
      throw new RootAgentsLoaderError(
        "artifact_reference_invalid",
        "repository rules artifact reference does not match the frozen content",
      );
    }
  }
}
