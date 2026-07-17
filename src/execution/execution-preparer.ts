import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";

import {
  type ExecutionReview,
  ExecutionPreparationError,
  type ExecutionInputIdentity,
  type ExecutionIntent,
  type NormalizedExecutionAction,
  type PackageManagerIdentity,
  type PreparedExecution,
  type ReviewedLifecycleScript,
} from "./execution-types.js";
import {
  type ExecutableRegistry,
  type ResolvedExecutable,
} from "./executable-registry.js";
import {
  filterExecutionEnvironment,
  OFFLINE_NODE_GUARD_IDENTITY,
  OFFLINE_NODE_GUARD_SHA256,
} from "./environment-filter.js";
import { trustedExecutionDependencies } from "./trusted-execution-dependencies.js";
import { createCommandActionIdentity } from "../permissions/action-digest.js";
import type {
  BinaryFingerprint,
  LifecycleScriptFingerprints,
  NormalizedCommandAction,
} from "../permissions/permission-types.js";

export interface ExecutionPreparerFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  }>;
}

const nodeFileSystem: ExecutionPreparerFileSystem = { readFile, realpath, stat };

interface BuiltExecution {
  readonly request: PreparedExecution["request"];
  readonly actionIdentity: NormalizedExecutionAction;
  readonly actionSha256: string;
  readonly executionInputsSha256: string;
  readonly review: ExecutionReview;
}

interface InputSnapshot {
  readonly executionInputs: ExecutionInputIdentity;
  readonly lifecycleScripts: LifecycleScriptFingerprints | null;
  readonly packageManager: PackageManagerIdentity | null;
  readonly reviewedLifecycleScripts: readonly ReviewedLifecycleScript[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith("../") &&
      !difference.startsWith("..\\") &&
      !isAbsolute(difference))
  );
}

function portableRelative(root: string, value: string): string {
  return relative(root, value).replaceAll("\\", "/") || ".";
}

function assertNoExternalPathArguments(args: readonly string[]): void {
  for (const argument of args) {
    const possiblePath = argument.includes("=")
      ? argument.slice(argument.indexOf("=") + 1)
      : argument;
    if (
      isAbsolute(possiblePath) ||
      win32.isAbsolute(possiblePath) ||
      /^[a-zA-Z]:/u.test(possiblePath) ||
      possiblePath.startsWith("\\\\") ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(possiblePath) ||
      possiblePath
        .replaceAll("\\", "/")
        .split("/")
        .some((segment) => segment === "..")
    ) {
      throw new ExecutionPreparationError(
        "external_path_argument_denied",
        "absolute and workspace-external path arguments are denied",
      );
    }
  }
}

async function readIfFile(
  fileSystem: ExecutionPreparerFileSystem,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const metadata = await fileSystem.stat(path);
    return metadata.isFile() ? await fileSystem.readFile(path) : null;
  } catch {
    return null;
  }
}

function scriptCommand(
  logicalExecutable: string,
  args: readonly string[],
): { readonly manager: "npm" | "pnpm"; readonly args: readonly string[] } | null {
  if (logicalExecutable === "npm" || logicalExecutable === "pnpm") {
    return { args, manager: logicalExecutable };
  }
  if (logicalExecutable === "corepack") {
    const manager = args[0];
    if (manager === "npm" || manager === "pnpm") {
      return { args: args.slice(1), manager };
    }
  }
  return null;
}

function requestedScriptName(
  args: readonly string[],
  scripts: Readonly<Record<string, unknown>>,
): string | null {
  if (args[0] === "run" || args[0] === "run-script") {
    return args[1] ?? null;
  }
  const alias = args[0];
  if (alias && Object.hasOwn(scripts, alias)) {
    return alias;
  }
  return null;
}

export class ExecutionPreparer {
  private constructor(
    private readonly workspaceRealPath: string,
    private readonly registry: ExecutableRegistry,
    private readonly options: {
      readonly platform: NodeJS.Platform;
      readonly hostEnvironment:
        | Readonly<Record<string, string | undefined>>
        | (() => Readonly<Record<string, string | undefined>>);
      readonly fileSystem: ExecutionPreparerFileSystem;
    },
  ) {}

  static async create(options: {
    readonly workspace: string;
    readonly registry: ExecutableRegistry;
    readonly platform: NodeJS.Platform;
    readonly hostEnvironment:
      | Readonly<Record<string, string | undefined>>
      | (() => Readonly<Record<string, string | undefined>>);
    readonly fileSystem?: ExecutionPreparerFileSystem;
  }): Promise<ExecutionPreparer> {
    const fileSystem = options.fileSystem ?? nodeFileSystem;
    const workspaceRealPath = await fileSystem.realpath(options.workspace);
    const workspaceMetadata = await fileSystem.stat(workspaceRealPath);
    if (!workspaceMetadata.isDirectory()) {
      throw new ExecutionPreparationError(
        "workspace_not_directory",
        "workspace must be an existing directory",
      );
    }
    return new ExecutionPreparer(workspaceRealPath, options.registry, {
      fileSystem,
      hostEnvironment: options.hostEnvironment,
      platform: options.platform,
    });
  }

  async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    const initial = await this.build(intent);
    const revalidate = async (): Promise<"current" | "stale"> => {
      try {
        const current = await this.build(intent);
        return current.actionSha256 === initial.actionSha256 &&
          current.executionInputsSha256 === initial.executionInputsSha256 &&
          current.request.executableFile === initial.request.executableFile &&
          current.request.cwd === initial.request.cwd
          ? "current"
          : "stale";
      } catch {
        return "stale";
      }
    };
    return Object.freeze({
      ...initial,
      revalidate,
    });
  }

  private async build(intent: ExecutionIntent): Promise<BuiltExecution> {
    this.validateIntent(intent);
    assertNoExternalPathArguments(intent.args);
    const cwd = await this.resolveCwd(intent.cwd);
    const executable = await this.registry.resolve(intent.executable, intent.args);
    const environment = filterExecutionEnvironment({
      hostEnvironment:
        typeof this.options.hostEnvironment === "function"
          ? this.options.hostEnvironment()
          : this.options.hostEnvironment,
      platform: this.options.platform,
    });
    const inputs = await this.snapshotInputs(executable, intent.args, cwd.absolutePath);
    const normalizedAction: NormalizedCommandAction = Object.freeze({
      actionKind: "command",
      argv: Object.freeze([...intent.args]),
      binary: Object.freeze({
        bytesSha256: executable.bytesSha256,
        canonicalIdentity: executable.canonicalFile,
        version: executable.versionIdentity,
      }),
      canonicalCwd: cwd.relativePath,
      environmentPolicy: environment.policy,
      executionInputs: inputs.executionInputs,
      lifecycleScripts: inputs.lifecycleScripts,
      logicalExecutable: executable.logicalName,
      outputLimitBytes: intent.outputLimitBytes,
      packageManager: inputs.packageManager,
      purpose: intent.purpose,
      timeoutMs: intent.timeoutMs,
    });
    // PHASE6: Authorization hashes the canonical action and reviewed input bytes;
    // a friendly display command can be ambiguous and is never an approval identity.
    const actionIdentity: NormalizedExecutionAction =
      createCommandActionIdentity(normalizedAction);
    const executionInputsSha256 = actionIdentity.executionInputsSha256;
    const actionSha256 = actionIdentity.actionSha256;
    return Object.freeze({
      actionIdentity,
      actionSha256,
      executionInputsSha256,
      review: Object.freeze({
        environmentLines: Object.freeze([
          "executor: local",
          "isolation: none",
          "network: host policy",
        ]),
        lifecycleScripts: inputs.reviewedLifecycleScripts,
        warning:
          "Approved repository code may perform additional host side effects; local execution is not a sandbox.",
      }),
      environmentEvidence: Object.freeze({
        executor: "local",
        isolation: "none",
        network: "host",
        policyVersion: "local-executor-v1",
      }),
      request: Object.freeze({
        args: Object.freeze([...intent.args]),
        cwd: cwd.absolutePath,
        environment: environment.values,
        executableFile: executable.canonicalFile,
        logicalExecutable: executable.logicalName,
        outputLimitBytes: intent.outputLimitBytes,
        purpose: intent.purpose,
        timeoutMs: intent.timeoutMs,
      }),
    });
  }

  private validateIntent(intent: ExecutionIntent): void {
    if (!Number.isSafeInteger(intent.timeoutMs) || intent.timeoutMs < 1) {
      throw new ExecutionPreparationError("invalid_timeout", "timeout must be a positive safe integer");
    }
    if (!Number.isSafeInteger(intent.outputLimitBytes) || intent.outputLimitBytes < 1) {
      throw new ExecutionPreparationError(
        "invalid_output_limit",
        "output limit must be a positive safe integer",
      );
    }
    if (intent.purpose !== "inspect" && intent.purpose !== "verify") {
      throw new ExecutionPreparationError("invalid_purpose", "purpose must be inspect or verify");
    }
  }

  private async resolveCwd(input: string | null): Promise<{
    readonly absolutePath: string;
    readonly relativePath: string;
  }> {
    const requested = input ?? ".";
    if (
      requested.length === 0 ||
      requested.includes("\0") ||
      requested.includes("\n") ||
      isAbsolute(requested) ||
      win32.isAbsolute(requested) ||
      /^[a-zA-Z]:/u.test(requested)
    ) {
      throw new ExecutionPreparationError(
        "cwd_outside_workspace",
        "cwd must be a relative workspace directory",
      );
    }
    const lexical = resolve(this.workspaceRealPath, requested);
    if (!contained(this.workspaceRealPath, lexical)) {
      throw new ExecutionPreparationError("cwd_outside_workspace", "cwd is outside the workspace");
    }
    let canonical: string;
    try {
      canonical = await this.options.fileSystem.realpath(lexical);
    } catch {
      throw new ExecutionPreparationError("cwd_not_found", "cwd was not found");
    }
    if (!contained(this.workspaceRealPath, canonical)) {
      throw new ExecutionPreparationError(
        "cwd_outside_workspace",
        "cwd resolves outside the workspace",
      );
    }
    const metadata = await this.options.fileSystem.stat(canonical);
    if (!metadata.isDirectory()) {
      throw new ExecutionPreparationError("cwd_not_directory", "cwd is not a directory");
    }
    return {
      absolutePath: canonical,
      relativePath: portableRelative(this.workspaceRealPath, canonical),
    };
  }

  private async snapshotInputs(
    executable: ResolvedExecutable,
    args: readonly string[],
    cwd: string,
  ): Promise<InputSnapshot> {
    const runnerConfigHashes: Record<string, string> = {
      [OFFLINE_NODE_GUARD_IDENTITY]: OFFLINE_NODE_GUARD_SHA256,
    };
    const executableBinary: BinaryFingerprint = Object.freeze({
      bytesSha256: executable.bytesSha256,
      canonicalIdentity: executable.canonicalFile,
      version: executable.versionIdentity,
    });
    if (executable.logicalName === "node" && args[0] && !args[0].startsWith("-")) {
      const scriptLexical = resolve(cwd, args[0]);
      if (!contained(this.workspaceRealPath, scriptLexical)) {
        throw new ExecutionPreparationError(
          "node_script_outside_workspace",
          "node script must remain inside the workspace",
        );
      }
      let scriptCanonical: string;
      try {
        scriptCanonical = await this.options.fileSystem.realpath(scriptLexical);
      } catch {
        throw new ExecutionPreparationError("node_script_not_found", "node script was not found");
      }
      if (!contained(this.workspaceRealPath, scriptCanonical)) {
        throw new ExecutionPreparationError(
          "node_script_outside_workspace",
          "node script resolves outside the workspace",
        );
      }
      const metadata = await this.options.fileSystem.stat(scriptCanonical);
      if (!metadata.isFile()) {
        throw new ExecutionPreparationError("node_script_not_file", "node script is not a file");
      }
      const relativeScript = portableRelative(
        this.workspaceRealPath,
        scriptCanonical,
      );
      runnerConfigHashes[relativeScript] = sha256(
        await this.options.fileSystem.readFile(scriptCanonical),
      );
      for (const dependency of trustedExecutionDependencies(relativeScript)) {
        const dependencyLexical = resolve(this.workspaceRealPath, dependency);
        let dependencyCanonical: string;
        try {
          dependencyCanonical = await this.options.fileSystem.realpath(
            dependencyLexical,
          );
        } catch {
          throw new ExecutionPreparationError(
            "trusted_dependency_not_found",
            "reviewed execution dependency was not found",
          );
        }
        if (!contained(this.workspaceRealPath, dependencyCanonical)) {
          throw new ExecutionPreparationError(
            "trusted_dependency_outside_workspace",
            "reviewed execution dependency resolves outside the workspace",
          );
        }
        const dependencyMetadata = await this.options.fileSystem.stat(
          dependencyCanonical,
        );
        if (!dependencyMetadata.isFile()) {
          throw new ExecutionPreparationError(
            "trusted_dependency_not_file",
            "reviewed execution dependency is not a file",
          );
        }
        runnerConfigHashes[
          portableRelative(this.workspaceRealPath, dependencyCanonical)
        ] = sha256(
          await this.options.fileSystem.readFile(dependencyCanonical),
        );
      }
    }

    const packageCommand = scriptCommand(executable.logicalName, args);
    if (!packageCommand) {
      return this.freezeInputs(null, null, runnerConfigHashes, null);
    }
    const manifestPath = await this.findManifest(cwd);
    if (!manifestPath) {
      throw new ExecutionPreparationError(
        "package_manifest_not_found",
        "package-manager command requires a workspace package.json",
      );
    }
    const manifestBytes = await this.options.fileSystem.readFile(manifestPath);
    let manifest: { readonly scripts?: Readonly<Record<string, unknown>> };
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as {
        readonly scripts?: Readonly<Record<string, unknown>>;
      };
    } catch {
      throw new ExecutionPreparationError("invalid_package_manifest", "package.json is not valid UTF-8 JSON");
    }
    const scripts = manifest.scripts ?? {};
    const scriptName = requestedScriptName(packageCommand.args, scripts);
    const reviewedLifecycleScripts: ReviewedLifecycleScript[] = [];
    let lifecycleScripts: LifecycleScriptFingerprints | null = null;
    if (scriptName) {
      for (const name of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
        const body = scripts[name];
        if (typeof body === "string") {
          reviewedLifecycleScripts.push(Object.freeze({ body, name }));
        }
      }
      const mainBody = reviewedLifecycleScripts.find(
        (script) => script.name === scriptName,
      )?.body;
      if (mainBody === undefined) {
        throw new ExecutionPreparationError("package_script_not_found", "requested package script was not found");
      }
      lifecycleScripts = Object.freeze({
        mainBodySha256: sha256(mainBody),
        postBodySha256:
          reviewedLifecycleScripts.find((script) => script.name === `post${scriptName}`)
            ?.body === undefined
            ? null
            : sha256(
                reviewedLifecycleScripts.find(
                  (script) => script.name === `post${scriptName}`,
                )!.body,
              ),
        preBodySha256:
          reviewedLifecycleScripts.find((script) => script.name === `pre${scriptName}`)
            ?.body === undefined
            ? null
            : sha256(
                reviewedLifecycleScripts.find(
                  (script) => script.name === `pre${scriptName}`,
                )!.body,
              ),
        scriptName,
      });
    }

    const manifestDirectory = dirname(manifestPath);
    const lockfile = await this.findFirstFile(
      manifestDirectory,
      packageCommand.manager === "pnpm"
        ? ["pnpm-lock.yaml"]
        : ["npm-shrinkwrap.json", "package-lock.json"],
    );
    for (const configName of [".npmrc", "pnpm-workspace.yaml"]) {
      const configPath = await this.findFirstFile(manifestDirectory, [configName]);
      if (configPath) {
        runnerConfigHashes[portableRelative(this.workspaceRealPath, configPath)] =
          sha256(await this.options.fileSystem.readFile(configPath));
      }
    }
    return this.freezeInputs(
      sha256(manifestBytes),
      lockfile ? sha256(await this.options.fileSystem.readFile(lockfile)) : null,
      runnerConfigHashes,
      {
        binary: executableBinary,
        logicalName: packageCommand.manager,
        version:
          executable.logicalName === "corepack"
            ? `via-corepack:${executable.versionIdentity}`
            : executable.versionIdentity,
      },
      lifecycleScripts,
      reviewedLifecycleScripts,
    );
  }

  private freezeInputs(
    manifestSha256: string | null,
    lockfileSha256: string | null,
    runnerConfigHashes: Record<string, string>,
    packageManager: PackageManagerIdentity | null,
    lifecycleScripts: LifecycleScriptFingerprints | null = null,
    reviewedLifecycleScripts: readonly ReviewedLifecycleScript[] = [],
  ): InputSnapshot {
    const sortedRunnerHashes = Object.entries(runnerConfigHashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([canonicalPath, digest]) =>
        Object.freeze({ canonicalPath, sha256: digest }),
      );
    return Object.freeze({
      executionInputs: Object.freeze({
        lockfileSha256,
        manifestSha256,
        runnerConfigHashes: Object.freeze(sortedRunnerHashes),
      }),
      lifecycleScripts,
      packageManager: packageManager ? Object.freeze(packageManager) : null,
      reviewedLifecycleScripts: Object.freeze([...reviewedLifecycleScripts]),
    });
  }

  private async findManifest(start: string): Promise<string | null> {
    let current = start;
    while (contained(this.workspaceRealPath, current)) {
      const candidate = join(current, "package.json");
      if ((await readIfFile(this.options.fileSystem, candidate)) !== null) {
        return candidate;
      }
      if (current === this.workspaceRealPath) {
        break;
      }
      current = dirname(current);
    }
    return null;
  }

  private async findFirstFile(
    start: string,
    names: readonly string[],
  ): Promise<string | null> {
    let current = start;
    while (contained(this.workspaceRealPath, current)) {
      for (const name of names) {
        const candidate = join(current, name);
        if ((await readIfFile(this.options.fileSystem, candidate)) !== null) {
          return candidate;
        }
      }
      if (current === this.workspaceRealPath) {
        break;
      }
      current = dirname(current);
    }
    return null;
  }
}
