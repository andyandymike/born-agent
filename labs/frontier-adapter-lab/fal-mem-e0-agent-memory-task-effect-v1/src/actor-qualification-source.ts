import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

const execFileAsync = promisify(execFile);
const COMMIT_SHA1 = /^[a-f0-9]{40}$/u;
const TREE_SHA1 = /^[a-f0-9]{40}$/u;
const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;

/**
 * The live qualification is meaningful only for the exact product/lab actor
 * implementation that will later be reused by the paid MEM-E0 effect run.
 * Paths are persisted only through their hashes in the public receipt.
 */
export const MEM_E0_ACTOR_QUALIFICATION_PROTECTED_PATHS = Object.freeze([
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/cases/mem-e0-harm-control/case.json",
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/cases/mem-e0-harm-control/hidden/verifier.mjs",
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/cases/mem-e0-harm-control/public-workspace/src/harm-control.mjs",
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/cases/mem-e0-harm-control/public-workspace/verify.mjs",
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/actor-config.json",
  "fixtures/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/remote-policy.json",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-fixture.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-model-evidence.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-provider-meter.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-source.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-actor-qualification-executor.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-actor-qualification-runner.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-preflight.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-effect-actor.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-effect-contract.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/live-effect-runner.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/production-memory-effect-actor.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/qualification-host-state.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/sanitized-failure.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/workspace.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-actor-qualification-child.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-live-effect-child.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-live-effect.ts",
  "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/tools/run-actor-qualification.ts",
  "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-pilot-fixture.ts",
  "src/agent/agent-execution-service.ts",
  "src/agent/system-instructions.ts",
  "src/cli/node-runtime.ts",
  "src/cli/types.ts",
  "src/completion/completion-evidence-schema.ts",
  "src/completion/completion-types.ts",
  "src/control-plane/adapters/agent-cli-adapter.ts",
  "src/execution/environment-filter.ts",
  "src/memory/recall/automatic-memory-recall-service.ts",
  "src/model/backend-factory.ts",
  "src/model/model-backend.ts",
  "src/model/model-qualification-schema.ts",
  "src/permissions/default-policy.ts",
  "src/policy/policy-config-loader.ts",
  "src/policy/policy-resolver.ts",
  "src/policy/runtime-policy-schema.ts",
  "src/providers/pi/pi-model-backend.ts",
  "src/providers/pi/production-pi-runtime-port.ts",
  "src/tools/create-agent-tool-registry.ts",
  "src/tools/restricted-tool-registry.ts",
] as const);

export interface MemE0ActorQualificationSourceSnapshot {
  readonly commit: string;
  readonly implementationSha256s: readonly string[];
  readonly protectedPathsClean: boolean;
  readonly protectedTreeSha256: string;
}

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeProtectedPaths(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.split(sep).join("/"));
  if (
    normalized.length === 0 ||
    normalized.some((value) =>
      !RELATIVE_PATH.test(value) ||
      value.startsWith("/") ||
      /^[A-Za-z]:/u.test(value) ||
      value.includes("\\") ||
      value.split("/").some((segment) => segment === "." || segment === "..")
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new TypeError("MEM-E0 qualification protected paths are invalid");
  }
  return Object.freeze([...normalized].sort((left, right) =>
    left.localeCompare(right, "en")));
}

function gitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

async function git(
  repositoryRoot: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.trim();
}

export async function observeMemE0ActorQualificationSource(input: Readonly<{
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly protectedPaths?: readonly string[];
  readonly repositoryRoot: string;
}>): Promise<MemE0ActorQualificationSourceSnapshot> {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (!isAbsolute(repositoryRoot)) {
    throw new TypeError("MEM-E0 qualification repository root must be absolute");
  }
  const environment = gitEnvironment(input.env ?? process.env);
  const actualRoot = resolve(await git(
    repositoryRoot,
    ["rev-parse", "--show-toplevel"],
    environment,
  ));
  if (await realpath(actualRoot) !== await realpath(repositoryRoot)) {
    throw new Error("MEM-E0 qualification must run at the exact Git root");
  }
  const [commit, gitTree, status] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"], environment),
    git(repositoryRoot, ["rev-parse", "HEAD^{tree}"], environment),
    git(
      repositoryRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      environment,
    ),
  ]);
  if (!COMMIT_SHA1.test(commit) || !TREE_SHA1.test(gitTree)) {
    throw new Error("MEM-E0 qualification Git identity is invalid");
  }
  const protectedPaths = normalizeProtectedPaths(
    input.protectedPaths ?? MEM_E0_ACTOR_QUALIFICATION_PROTECTED_PATHS,
  );
  const implementations = await Promise.all(protectedPaths.map(async (path) => {
    const absolutePath = resolve(repositoryRoot, ...path.split("/"));
    const nested = relative(repositoryRoot, absolutePath);
    if (nested.startsWith("..") || isAbsolute(nested)) {
      throw new Error("MEM-E0 qualification protected path escaped the repository");
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("MEM-E0 qualification protected path is not a regular file");
    }
    return Object.freeze({
      pathSha256: rawSha256(path),
      rawSha256: rawSha256(await readFile(absolutePath)),
    });
  }));
  const implementationSha256s = Object.freeze(
    [...new Set(implementations.map((entry) => entry.rawSha256))]
      .sort((left, right) => left.localeCompare(right, "en")),
  );
  return Object.freeze({
    commit,
    implementationSha256s,
    // Qualification and later effect claims are exact-commit claims. A dirty
    // file anywhere in the repository means the executable source state is no
    // longer fully described by HEAD, so fail closed.
    protectedPathsClean: status.length === 0,
    protectedTreeSha256: sha256Canonical({
      commit,
      gitTree,
      implementations,
    }),
  });
}
