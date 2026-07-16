import { createHash } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { ExecutionPreparationError } from "./execution-types.js";

export interface ResolvedExecutable {
  readonly logicalName: string;
  readonly canonicalFile: string;
  readonly bytesSha256: string;
  readonly byteLength: number;
  readonly versionIdentity: string;
}

export interface ExecutableRegistryFileSystem {
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly isFile: () => boolean; readonly size: number }>;
}

const nodeFileSystem: ExecutableRegistryFileSystem = {
  access,
  readFile,
  realpath,
  stat,
};

const REGISTERED = new Set(["corepack", "git", "node", "npm", "pnpm", "rg"]);
const GIT_HARD_DENY = new Set([
  "checkout",
  "clean",
  "commit",
  "merge",
  "push",
  "rebase",
  "reset",
  "stash",
]);
const PACKAGE_HARD_DENY = new Set([
  "add",
  "ci",
  "dlx",
  "exec",
  "install",
  "link",
  "outdated",
  "pack",
  "publish",
  "rebuild",
  "remove",
  "uninstall",
  "unlink",
  "update",
  "upgrade",
]);

function validateArgv(logicalName: string, args: readonly string[]): void {
  if (args.length > 64) {
    throw new ExecutionPreparationError("too_many_arguments", "at most 64 command arguments are allowed");
  }
  for (const argument of args) {
    if (argument.includes("\0") || argument.length > 4096) {
      throw new ExecutionPreparationError(
        "invalid_argument",
        "arguments must not contain NUL and must be at most 4096 characters",
      );
    }
  }

  if (logicalName === "git") {
    if (args.some((argument) => ["-c", "--config-env", "--exec-path", "--ext-diff", "--textconv"].includes(argument.toLowerCase()))) {
      throw new ExecutionPreparationError(
        "hard_denied_subcommand",
        "git executable/config hooks are denied by the registry",
      );
    }
    const command = args.find((argument) =>
      GIT_HARD_DENY.has(argument.toLowerCase()),
    );
    if (command) {
      throw new ExecutionPreparationError(
        "hard_denied_subcommand",
        `git ${command.toLowerCase()} is denied by the executable registry`,
      );
    }
  }

  const packageArguments =
    logicalName === "corepack" && ["npm", "pnpm"].includes(args[0]?.toLowerCase() ?? "")
      ? args.slice(1)
      : args;
  if (
    logicalName === "corepack" &&
    !["npm", "pnpm"].includes(args[0]?.toLowerCase() ?? "")
  ) {
    throw new ExecutionPreparationError(
      "hard_denied_subcommand",
      "corepack only accepts a registered npm or pnpm fixture runner",
    );
  }
  if (["corepack", "npm", "pnpm"].includes(logicalName)) {
    const command = packageArguments.find((argument) =>
      PACKAGE_HARD_DENY.has(argument.toLowerCase()),
    );
    if (command) {
      throw new ExecutionPreparationError(
        "hard_denied_subcommand",
        `${logicalName} ${command.toLowerCase()} is denied by the executable registry`,
      );
    }
  }

  if (logicalName === "node") {
    const forbidden = args.some((argument) =>
      ["-", "-e", "--eval", "-p", "--print", "--input-type"].some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
    );
    if (forbidden) {
      throw new ExecutionPreparationError(
        "node_inline_code_denied",
        "node inline or stdin programs are denied; use a reviewed workspace script",
      );
    }
    if (
      (args[0] === "--version" && args.length !== 1) ||
      (args[0] !== "--version" &&
        (args[0] === undefined || args[0].startsWith("-")))
    ) {
      throw new ExecutionPreparationError(
        "node_argv_shape_denied",
        "node must begin with a reviewed workspace script (or exactly --version)",
      );
    }
  }
}

async function exists(
  fileSystem: ExecutableRegistryFileSystem,
  candidate: string,
): Promise<boolean> {
  try {
    await fileSystem.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export class ExecutableRegistry {
  constructor(
    private readonly options: {
      readonly platform: NodeJS.Platform;
      readonly execPath: string;
      readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
      readonly resolvedFiles?: Readonly<Record<string, string>>;
      readonly versionIdentities?: Readonly<Record<string, string>>;
      readonly fileSystem?: ExecutableRegistryFileSystem;
    },
  ) {}

  async resolve(
    requestedName: string,
    args: readonly string[],
  ): Promise<ResolvedExecutable> {
    if (
      requestedName.length === 0 ||
      requestedName.length > 128 ||
      !/^[a-z][a-z0-9_-]*$/u.test(requestedName) ||
      !REGISTERED.has(requestedName)
    ) {
      throw new ExecutionPreparationError(
        "unknown_executable",
        "executable must be a registered logical program name",
      );
    }
    validateArgv(requestedName, args);

    const fileSystem = this.options.fileSystem ?? nodeFileSystem;
    const candidate = await this.resolveCandidate(requestedName, fileSystem);
    const canonicalFile = await fileSystem.realpath(candidate);
    const metadata = await fileSystem.stat(canonicalFile);
    if (!metadata.isFile()) {
      throw new ExecutionPreparationError(
        "executable_not_file",
        "resolved executable is not a regular file",
      );
    }
    const bytes = await fileSystem.readFile(canonicalFile);
    const bytesSha256 = createHash("sha256").update(bytes).digest("hex");
    return Object.freeze({
      byteLength: metadata.size,
      bytesSha256,
      canonicalFile,
      logicalName: requestedName,
      versionIdentity:
        this.options.versionIdentities?.[requestedName] ??
        `bytes:${bytesSha256.slice(0, 16)}`,
    });
  }

  private async resolveCandidate(
    logicalName: string,
    fileSystem: ExecutableRegistryFileSystem,
  ): Promise<string> {
    if (logicalName === "node") {
      return this.options.execPath;
    }
    const override = this.options.resolvedFiles?.[logicalName];
    if (override) {
      return override;
    }

    const pathEntry = Object.entries(this.options.hostEnvironment).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1];
    if (!pathEntry) {
      throw new ExecutionPreparationError(
        "executable_missing",
        `registered executable ${logicalName} was not found`,
      );
    }
    const pathSeparator = this.options.platform === "win32" ? ";" : ":";
    const suffixes = this.options.platform === "win32" ? [".exe", ".com", ""] : [""];
    for (const directory of pathEntry.split(pathSeparator).filter(Boolean)) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${logicalName}${suffix}`);
        if (await exists(fileSystem, candidate)) {
          return candidate;
        }
      }
    }
    throw new ExecutionPreparationError(
      "executable_missing",
      `registered executable ${logicalName} was not found as a shell-free binary`,
    );
  }
}

export function createDefaultExecutableRegistry(options: {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly resolvedFiles?: Readonly<Record<string, string>>;
  readonly versionIdentities?: Readonly<Record<string, string>>;
}): ExecutableRegistry {
  return new ExecutableRegistry(options);
}
