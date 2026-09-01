import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The live runner may hold a provider credential in its own process. Direct
 * fixture subprocesses never inherit that process environment; they receive
 * only the small OS surface needed to locate Git/Node and create temp files.
 */
export function createDs0SubprocessEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return Object.freeze({
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

export const DS0_PUBLIC_SMOKE_FIXTURE = "phase-07-fix-and-verify" as const;
export const DS0_PUBLIC_SMOKE_TARGET =
  "fixtures/phase-07-fix-and-verify/src/clamp.mjs" as const;
export const DS0_PUBLIC_SMOKE_VERIFY_CWD =
  "fixtures/phase-07-fix-and-verify" as const;
export const DS0_PUBLIC_SMOKE_VERIFY_ARGV = Object.freeze([
  "node",
  "verify.mjs",
] as const);

export const DS0_PUBLIC_SMOKE_BUGGY_SOURCE = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(minimum, Math.max(maximum, value));",
  "}",
  "",
].join("\n");

export const DS0_PUBLIC_SMOKE_FIXED_SOURCE = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(maximum, Math.max(minimum, value));",
  "}",
  "",
].join("\n");

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const DS0_PUBLIC_SMOKE_BUGGY_SHA256 = sha256(
  DS0_PUBLIC_SMOKE_BUGGY_SOURCE,
);
export const DS0_PUBLIC_SMOKE_FIXED_SHA256 = sha256(
  DS0_PUBLIC_SMOKE_FIXED_SOURCE,
);

async function git(workspace: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
    env: createDs0SubprocessEnvironment(),
    windowsHide: true,
  });
  return result.stdout.trim();
}

export interface Ds0PublicSmokeWorkspace {
  readonly baselineCommit: string;
  readonly targetRelativePath: typeof DS0_PUBLIC_SMOKE_TARGET;
  readonly workspace: string;
}

export async function createDs0PublicSmokeWorkspace(input: Readonly<{
  readonly repositoryRoot: string;
  readonly workspace: string;
}>): Promise<Ds0PublicSmokeWorkspace> {
  const sourceRoot = resolve(
    input.repositoryRoot,
    "fixtures",
    DS0_PUBLIC_SMOKE_FIXTURE,
  );
  const destination = join(
    input.workspace,
    "fixtures",
    DS0_PUBLIC_SMOKE_FIXTURE,
  );
  await mkdir(dirname(destination), { recursive: true });
  await cp(sourceRoot, destination, { errorOnExist: true, recursive: true });

  const initial = await readFile(
    join(input.workspace, ...DS0_PUBLIC_SMOKE_TARGET.split("/")),
    "utf8",
  );
  if (
    initial !== DS0_PUBLIC_SMOKE_BUGGY_SOURCE ||
    sha256(initial) !== DS0_PUBLIC_SMOKE_BUGGY_SHA256
  ) {
    throw new Error("DS0 public smoke source fixture drifted from the reviewed bug");
  }

  await writeFile(join(input.workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await git(input.workspace, ["init", "--quiet"]);
  await git(input.workspace, ["config", "user.email", "ds0@example.invalid"]);
  await git(input.workspace, ["config", "user.name", "FAL DS0"]);
  await git(input.workspace, ["config", "core.autocrlf", "false"]);
  await git(input.workspace, ["add", "--all"]);
  await git(input.workspace, [
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "DS0 public smoke baseline",
  ]);
  const baselineCommit = await git(input.workspace, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baselineCommit)) {
    throw new Error("DS0 public smoke baseline commit is invalid");
  }
  return Object.freeze({
    baselineCommit,
    targetRelativePath: DS0_PUBLIC_SMOKE_TARGET,
    workspace: input.workspace,
  });
}

export interface Ds0PublicSmokeFreshVerification {
  readonly changedPaths: readonly (typeof DS0_PUBLIC_SMOKE_TARGET)[];
  readonly finalTargetSha256: string;
  readonly stdout: string;
  readonly verifierExitCode: 0;
}

export async function verifyDs0PublicSmokeWorkspace(
  workspace: string,
): Promise<Ds0PublicSmokeFreshVerification> {
  const finalSource = await readFile(
    join(workspace, ...DS0_PUBLIC_SMOKE_TARGET.split("/")),
    "utf8",
  );
  if (
    finalSource !== DS0_PUBLIC_SMOKE_FIXED_SOURCE ||
    sha256(finalSource) !== DS0_PUBLIC_SMOKE_FIXED_SHA256
  ) {
    throw new Error("DS0 public smoke target does not match the exact fixed bytes");
  }
  const [trackedChanges, untrackedChanges] = await Promise.all([
    git(workspace, ["diff", "--name-only", "HEAD", "--"]),
    git(workspace, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const changed = [...new Set(
    `${trackedChanges}\n${untrackedChanges}`.split(/\r?\n/u).filter(Boolean),
  )].sort();
  if (
    changed.length !== 1 ||
    changed[0] !== DS0_PUBLIC_SMOKE_TARGET
  ) {
    throw new Error("DS0 public smoke changed paths are outside the exact target");
  }
  const verifier = await execFileAsync(
    DS0_PUBLIC_SMOKE_VERIFY_ARGV[0],
    [DS0_PUBLIC_SMOKE_VERIFY_ARGV[1]],
    {
      cwd: join(workspace, ...DS0_PUBLIC_SMOKE_VERIFY_CWD.split("/")),
      encoding: "utf8",
      env: createDs0SubprocessEnvironment(),
      windowsHide: true,
    },
  );
  return Object.freeze({
    changedPaths: Object.freeze([DS0_PUBLIC_SMOKE_TARGET]),
    finalTargetSha256: DS0_PUBLIC_SMOKE_FIXED_SHA256,
    stdout: verifier.stdout.trim(),
    verifierExitCode: 0,
  });
}
