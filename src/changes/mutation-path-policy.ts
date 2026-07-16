import { lstat, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { SensitivePathPolicy } from "../tools/sensitive-path-policy.js";
import type {
  FileIdentity,
  PatchChangeKind,
  PlannedFileChange,
  PlannedParentState,
} from "./patch-types.js";
import { patchOperationError } from "./patch-types.js";

export interface MutationPathFileSystem {
  lstat(path: string): Promise<{
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  realpath(path: string): Promise<string>;
}

const nodeFileSystem: MutationPathFileSystem = { lstat, realpath };

export interface MutationTargetResolution {
  readonly absolutePath: string;
  readonly identity: FileIdentity | null;
  readonly parent: PlannedParentState;
  readonly relativePath: string;
}

export interface MutationPathPolicyOptions {
  readonly caseInsensitive?: boolean;
  readonly fileSystem?: MutationPathFileSystem;
  readonly sensitive?: SensitivePathPolicy;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
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

function isWriteSensitive(path: string, policy: SensitivePathPolicy): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1) ?? "";
  // PHASE5: 写入策略比只读策略更严格；所有 `.env*` 都可能覆盖本地凭据，模板也不例外。
  return (
    name.startsWith(".env") ||
    name === ".gitmodules" ||
    policy.isDenied(normalized)
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

export class MutationPathPolicy {
  readonly workspaceRealPath: string;
  private readonly caseInsensitive: boolean;
  private readonly fileSystem: MutationPathFileSystem;
  private readonly sensitive: SensitivePathPolicy;

  private constructor(
    workspaceRealPath: string,
    options: MutationPathPolicyOptions,
  ) {
    this.workspaceRealPath = workspaceRealPath;
    this.caseInsensitive = options.caseInsensitive ?? true;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.sensitive = options.sensitive ?? new SensitivePathPolicy();
  }

  static async create(
    workspace: string,
    options: MutationPathPolicyOptions = {},
  ): Promise<MutationPathPolicy> {
    const fileSystem = options.fileSystem ?? nodeFileSystem;
    const workspaceRealPath = await fileSystem.realpath(workspace);
    return new MutationPathPolicy(workspaceRealPath, options);
  }

  canonicalKey(relativePath: string): string {
    return this.caseInsensitive ? relativePath.toLowerCase() : relativePath;
  }

  async resolve(
    rawPath: string,
    kind: PatchChangeKind,
  ): Promise<MutationTargetResolution> {
    const relativePath = this.validateLexicalPath(rawPath);
    const segments = relativePath.split("/");
    const absolutePath = resolve(this.workspaceRealPath, ...segments);
    if (!isContained(this.workspaceRealPath, absolutePath)) {
      throw patchOperationError(
        "permission",
        "path_outside_workspace",
        "patch path is outside the workspace",
      );
    }

    let current = this.workspaceRealPath;
    let existingAncestor = this.workspaceRealPath;
    let identity: FileIdentity | null = null;
    const missingDirectories: string[] = [];
    let missing = false;

    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const isTarget = index === segments.length - 1;
      if (missing) {
        if (!isTarget) {
          missingDirectories.push(current);
        }
        continue;
      }

      let metadata: Awaited<ReturnType<MutationPathFileSystem["lstat"]>>;
      try {
        metadata = await this.fileSystem.lstat(current);
      } catch (error) {
        if (!isNotFound(error)) {
          throw patchOperationError(
            "system",
            "patch_path_io_failed",
            "failed to inspect a patch path",
            { cause: error },
          );
        }
        missing = true;
        if (!isTarget) {
          missingDirectories.push(current);
        }
        continue;
      }

      if (metadata.isSymbolicLink()) {
        throw patchOperationError(
          "permission",
          "patch_symlink_denied",
          "patch targets and parent directories must not be symlinks or junctions",
        );
      }
      if (!isTarget) {
        if (!metadata.isDirectory()) {
          throw patchOperationError(
            "invalid_arguments",
            "patch_parent_not_directory",
            "a patch parent path is not a directory",
          );
        }
        existingAncestor = current;
        continue;
      }

      if (kind === "create") {
        throw patchOperationError(
          "invalid_arguments",
          "patch_target_exists",
          "create patch target already exists",
        );
      }
      if (!metadata.isFile()) {
        throw patchOperationError(
          "invalid_arguments",
          "patch_target_not_regular_file",
          "modify patch target is not a regular file",
        );
      }
      identity = {
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
      };
    }

    if (kind === "modify" && (missing || identity === null)) {
      throw patchOperationError(
        "not_found",
        "patch_target_not_found",
        "modify patch target was not found",
      );
    }

    const existingAncestorRealPath = await this.canonicalDirectory(existingAncestor);
    // PHASE5: lexical containment 拦截 `..` 等文本逃逸；realpath containment 则拦截
    // 文件系统链接重定向。新文件必须把检查绑定到最近的已存在父目录。
    if (!isContained(this.workspaceRealPath, existingAncestorRealPath)) {
      throw patchOperationError(
        "permission",
        "path_outside_workspace",
        "patch parent resolves outside the workspace",
      );
    }

    return {
      absolutePath,
      identity,
      parent: {
        existingAncestorAbsolutePath: existingAncestor,
        existingAncestorRealPath,
        missingDirectories,
      },
      relativePath,
    };
  }

  async revalidate(
    change: PlannedFileChange,
    allowedCreatedDirectories: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const expectedAncestor = change.parent.existingAncestorAbsolutePath;
    let ancestorMetadata: Awaited<ReturnType<MutationPathFileSystem["lstat"]>>;
    try {
      ancestorMetadata = await this.fileSystem.lstat(expectedAncestor);
    } catch (error) {
      throw this.stale(error);
    }
    if (
      ancestorMetadata.isSymbolicLink() ||
      !ancestorMetadata.isDirectory() ||
      !this.sameCanonical(
        await this.canonicalDirectory(expectedAncestor),
        change.parent.existingAncestorRealPath,
      )
    ) {
      throw this.stale();
    }

    for (const directory of change.parent.missingDirectories) {
      try {
        const metadata = await this.fileSystem.lstat(directory);
        if (
          !allowedCreatedDirectories.has(directory) ||
          metadata.isSymbolicLink() ||
          !metadata.isDirectory()
        ) {
          throw this.stale();
        }
        const canonical = await this.fileSystem.realpath(directory);
        if (!isContained(this.workspaceRealPath, canonical)) {
          throw this.stale();
        }
      } catch (error) {
        if (error instanceof Error && error.name === "PatchOperationError") {
          throw error;
        }
        if (!isNotFound(error) || allowedCreatedDirectories.has(directory)) {
          throw this.stale(error);
        }
      }
    }

    try {
      const metadata = await this.fileSystem.lstat(change.absolutePath);
      if (
        change.kind === "create" ||
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        change.identity === null ||
        !sameIdentity(change.identity, {
          device: metadata.dev,
          inode: metadata.ino,
          mode: metadata.mode,
        })
      ) {
        throw this.stale();
      }
    } catch (error) {
      if (error instanceof Error && error.name === "PatchOperationError") {
        throw error;
      }
      if (change.kind === "modify" || !isNotFound(error)) {
        throw this.stale(error);
      }
    }
  }

  private validateLexicalPath(rawPath: string): string {
    if (
      rawPath.length === 0 ||
      rawPath.includes("\0") ||
      rawPath.includes("\n") ||
      rawPath.includes("\r") ||
      rawPath.includes("\\") ||
      rawPath.startsWith("//") ||
      isAbsolute(rawPath) ||
      win32.isAbsolute(rawPath) ||
      /^[a-zA-Z]:/u.test(rawPath)
    ) {
      throw patchOperationError(
        "permission",
        "path_outside_workspace",
        "patch path must be an unambiguous workspace-relative path",
      );
    }
    const segments = rawPath.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment.includes(":") ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
      )
    ) {
      throw patchOperationError(
        "permission",
        "path_outside_workspace",
        "patch path contains an ambiguous or reserved segment",
      );
    }
    const relativePath = segments.join("/");
    if (isWriteSensitive(relativePath, this.sensitive)) {
      throw patchOperationError(
        "permission",
        "sensitive_path_denied",
        "patch path is denied by the sensitive write policy",
      );
    }
    return relativePath;
  }

  private async canonicalDirectory(path: string): Promise<string> {
    try {
      return await this.fileSystem.realpath(path);
    } catch (error) {
      throw patchOperationError(
        "system",
        "patch_path_io_failed",
        "failed to resolve a patch parent directory",
        { cause: error },
      );
    }
  }

  private sameCanonical(left: string, right: string): boolean {
    return this.caseInsensitive
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }

  private stale(cause?: unknown): Error {
    return patchOperationError(
      "invalid_arguments",
      "patch_stale",
      "patch target or parent changed after the plan was created",
      cause === undefined ? {} : { cause },
    );
  }
}

export function relativeDirectoryDepth(path: string): number {
  return portablePath(path).split("/").length;
}
