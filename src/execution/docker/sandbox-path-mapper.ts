import { posix, win32 } from "node:path";

import type { SnapshotManifest } from "../snapshot/snapshot-manifest.js";

export class SandboxPathMappingError extends Error {
  override readonly name = "SandboxPathMappingError";

  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SandboxPathMapperOptions {
  readonly hostPlatform: "linux" | "win32";
  readonly hostWorkspaceRoot: string;
  readonly manifest: SnapshotManifest;
}

function looksExternal(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:/u.test(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(value)
  );
}

function portableSegments(value: string, platform: "linux" | "win32"): string[] {
  if (value === ".") return [];
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    looksExternal(value) ||
    (platform === "linux" && value.includes("\\"))
  ) {
    throw new SandboxPathMappingError(
      "external_path_denied",
      "sandbox path argument must be a bounded relative workspace path",
    );
  }
  const normalized = platform === "win32" ? value.replaceAll("\\", "/") : value;
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new SandboxPathMappingError(
      "path_escape_denied",
      "sandbox path argument contains an empty or dot segment",
    );
  }
  return segments;
}

export class SandboxPathMapper {
  readonly #directories: ReadonlySet<string>;
  readonly #files: ReadonlySet<string>;
  readonly #hostPlatform: "linux" | "win32";
  readonly #hostWorkspaceRoot: string;

  public constructor(options: SandboxPathMapperOptions) {
    const pathApi = options.hostPlatform === "win32" ? win32 : posix;
    if (!pathApi.isAbsolute(options.hostWorkspaceRoot)) {
      throw new SandboxPathMappingError(
        "workspace_root_not_absolute",
        "normalized host workspace root must be absolute",
      );
    }
    this.#hostPlatform = options.hostPlatform;
    this.#hostWorkspaceRoot = pathApi.normalize(options.hostWorkspaceRoot);
    const files = new Set(options.manifest.entries.map(({ path }) => path));
    const directories = new Set<string>([""]);
    for (const file of files) {
      const segments = file.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    }
    this.#files = files;
    this.#directories = directories;
  }

  public mapHostCwd(hostCwd: string): string {
    const pathApi = this.#hostPlatform === "win32" ? win32 : posix;
    if (!pathApi.isAbsolute(hostCwd)) {
      throw new SandboxPathMappingError(
        "cwd_not_absolute",
        "normalized host cwd must be absolute before sandbox mapping",
      );
    }
    const normalized = pathApi.normalize(hostCwd);
    const relative = pathApi.relative(this.#hostWorkspaceRoot, normalized);
    if (
      pathApi.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${pathApi.sep}`)
    ) {
      throw new SandboxPathMappingError(
        "cwd_outside_snapshot",
        "host cwd is outside the approved snapshot workspace",
      );
    }
    const portable = relative.replaceAll("\\", "/");
    if (!this.#directories.has(portable)) {
      throw new SandboxPathMappingError(
        "cwd_not_in_manifest",
        "host cwd cannot be uniquely reconstructed from the snapshot manifest",
      );
    }
    return portable.length === 0 ? "/workspace" : `/workspace/${portable}`;
  }

  public mapArguments(input: {
    readonly args: readonly string[];
    readonly hostCwd: string;
    readonly pathArgumentIndexes: readonly number[];
  }): readonly string[] {
    const containerCwd = this.mapHostCwd(input.hostCwd);
    const cwdRelative = containerCwd === "/workspace"
      ? []
      : containerCwd.slice("/workspace/".length).split("/");
    const indexes = new Set(input.pathArgumentIndexes);
    if (
      indexes.size !== input.pathArgumentIndexes.length ||
      [...indexes].some(
        (index) =>
          !Number.isSafeInteger(index) || index < 0 || index >= input.args.length,
      )
    ) {
      throw new SandboxPathMappingError(
        "invalid_path_argument_index",
        "path argument positions must be unique valid argv indexes",
      );
    }
    // PHASE13: Host paths are semantic data, not strings to regex-replace.
    // Only registry-declared path positions are mapped against the approved
    // manifest; every other argument remains exact and external paths fail.
    return Object.freeze(
      input.args.map((argument, index) => {
        if (argument.includes("\0") || argument.includes("\n")) {
          throw new SandboxPathMappingError(
            "invalid_argument",
            "sandbox argument contains a control character",
          );
        }
        if (!indexes.has(index)) {
          if (looksExternal(argument)) {
            throw new SandboxPathMappingError(
              "undeclared_external_path",
              "undeclared argument cannot carry an absolute host/container path",
            );
          }
          return argument;
        }
        const segments = portableSegments(argument, this.#hostPlatform);
        const resolved = [...cwdRelative];
        for (const segment of segments) resolved.push(segment);
        const relative = resolved.join("/");
        if (!this.#files.has(relative) && !this.#directories.has(relative)) {
          throw new SandboxPathMappingError(
            "path_not_in_manifest",
            "declared path argument is absent from the approved snapshot manifest",
          );
        }
        return relative.length === 0 ? "/workspace" : `/workspace/${relative}`;
      }),
    );
  }
}
