import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";

import { SensitivePathPolicy } from "./sensitive-path-policy.js";
import { toolError } from "./tool-errors.js";
import type { ToolError } from "./tool-types.js";

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export type PathResolution =
  | { readonly ok: true; readonly value: ResolvedWorkspacePath }
  | { readonly error: ToolError; readonly ok: false };

export interface WorkspacePathFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const nodeFileSystem: WorkspacePathFileSystem = { realpath, stat };

function hasDriveRelativeRoot(value: string): boolean {
  return /^[a-zA-Z]:/u.test(value) || win32.isAbsolute(value);
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

function portableRelative(root: string, candidate: string): string {
  return relative(root, candidate).replaceAll("\\", "/") || ".";
}

export class WorkspacePathPolicy {
  private constructor(
    readonly workspaceRealPath: string,
    private readonly fileSystem: WorkspacePathFileSystem,
    private readonly sensitive: SensitivePathPolicy,
  ) {}

  static async create(
    workspace: string,
    options: {
      readonly fileSystem?: WorkspacePathFileSystem;
      readonly sensitive?: SensitivePathPolicy;
    } = {},
  ): Promise<WorkspacePathPolicy> {
    const fileSystem = options.fileSystem ?? nodeFileSystem;
    const workspaceRealPath = await fileSystem.realpath(workspace);
    return new WorkspacePathPolicy(
      workspaceRealPath,
      fileSystem,
      options.sensitive ?? new SensitivePathPolicy(),
    );
  }

  async resolveDirectory(input: string | null): Promise<PathResolution> {
    return this.resolveExisting(input ?? ".", "directory");
  }

  async resolveFile(input: string): Promise<PathResolution> {
    return this.resolveExisting(input, "file");
  }

  private async resolveExisting(
    input: string,
    expected: "directory" | "file",
  ): Promise<PathResolution> {
    if (
      input.length === 0 ||
      input.includes("\0") ||
      isAbsolute(input) ||
      hasDriveRelativeRoot(input) ||
      input.startsWith("\\\\")
    ) {
      return {
        error: toolError(
          "permission",
          "path_outside_workspace",
          "path must be relative and remain inside the workspace",
        ),
        ok: false,
      };
    }

    if (this.sensitive.isDenied(input)) {
      return {
        error: toolError(
          "permission",
          "sensitive_path_denied",
          "path is denied by the sensitive path policy",
        ),
        ok: false,
      };
    }

    const lexicalPath = resolve(this.workspaceRealPath, input);
    if (!isContained(this.workspaceRealPath, lexicalPath)) {
      return {
        error: toolError(
          "permission",
          "path_outside_workspace",
          "path is outside the workspace",
        ),
        ok: false,
      };
    }

    let canonicalPath: string;
    try {
      canonicalPath = await this.fileSystem.realpath(lexicalPath);
    } catch {
      return {
        error: toolError("not_found", "path_not_found", "path was not found"),
        ok: false,
      };
    }

    if (!isContained(this.workspaceRealPath, canonicalPath)) {
      return {
        error: toolError(
          "permission",
          "path_outside_workspace",
          "path resolves outside the workspace",
        ),
        ok: false,
      };
    }

    const relativePath = portableRelative(this.workspaceRealPath, canonicalPath);
    if (this.sensitive.isDenied(relativePath)) {
      return {
        error: toolError(
          "permission",
          "sensitive_path_denied",
          "path is denied by the sensitive path policy",
        ),
        ok: false,
      };
    }

    try {
      const metadata = await this.fileSystem.stat(canonicalPath);
      if (
        (expected === "file" && !metadata.isFile()) ||
        (expected === "directory" && !metadata.isDirectory())
      ) {
        return {
          error: toolError(
            "invalid_arguments",
            expected === "file" ? "not_a_file" : "not_a_directory",
            `path is not a ${expected}`,
          ),
          ok: false,
        };
      }
    } catch {
      return {
        error: toolError("not_found", "path_not_found", "path was not found"),
        ok: false,
      };
    }

    return {
      ok: true,
      value: { absolutePath: canonicalPath, relativePath },
    };
  }
}
