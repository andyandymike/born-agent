import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  memE0RawSha256,
  type MemE0LoadedCase,
} from "./fixture.js";
import { createMemE0SanitizedBoundaryError } from "./sanitized-failure.js";

const execFileAsync = promisify(execFile);
const FIXED_GIT_DATE = "2026-09-01T00:00:00.000Z";

export function memE0GitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
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

export function memE0VerifierEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    COMSPEC: source.COMSPEC ?? source.ComSpec,
    PATH: source.PATH ?? source.Path,
    PATHEXT: source.PATHEXT,
    SystemRoot: source.SystemRoot ?? source.SYSTEMROOT,
    TEMP: source.TEMP,
    TMP: source.TMP,
    WINDIR: source.WINDIR,
  });
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: workspace,
      encoding: "utf8",
      env: memE0GitEnvironment(process.env),
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw createMemE0SanitizedBoundaryError("workspace_process_failed", error);
  }
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error("MEM-E0 workspace contains a non-file public entry");
    }
  };
  await visit(root);
  return Object.freeze(files.sort());
}

interface ProcessObservation {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function observeProcess(input: Readonly<{
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executable: string;
}>): Promise<ProcessObservation> {
  try {
    const result = await execFileAsync(input.executable, [...input.args], {
      cwd: input.cwd,
      encoding: "utf8",
      env: memE0VerifierEnvironment(process.env),
      windowsHide: true,
    });
    return Object.freeze({ exitCode: 0, stderr: result.stderr, stdout: result.stdout });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
    ) {
      return Object.freeze({
        exitCode: error.code,
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
      });
    }
    throw createMemE0SanitizedBoundaryError("verifier_process_failed", error);
  }
}

export interface MemE0VerifierObservation {
  readonly argvIdentitySha256: string;
  readonly implementationRawSha256: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly stderrSha256: string;
  readonly stdoutSha256: string;
}

export async function runMemE0HiddenVerifier(
  loadedCase: MemE0LoadedCase,
  workspace: string,
): Promise<MemE0VerifierObservation> {
  const observation = await observeProcess({
    args: [loadedCase.hiddenVerifierPath, workspace],
    cwd: loadedCase.directory,
    executable: process.execPath,
  });
  const stdoutSha256 = memE0RawSha256(observation.stdout);
  return Object.freeze({
    argvIdentitySha256: loadedCase.definition.hiddenVerifier.argvIdentitySha256,
    implementationRawSha256:
      loadedCase.definition.hiddenVerifier.implementationRawSha256,
    exitCode: observation.exitCode,
    passed:
      observation.exitCode === loadedCase.definition.hiddenVerifier.successExitCode &&
      stdoutSha256 === loadedCase.definition.hiddenVerifier.successStdoutSha256,
    stderrSha256: memE0RawSha256(observation.stderr),
    stdoutSha256,
  });
}

export interface MemE0WorkspaceBefore {
  readonly baselineCommit: string;
  readonly beforeStateSha256: string;
  readonly caseId: MemE0LoadedCase["definition"]["caseId"];
  readonly hiddenVerifier: MemE0VerifierObservation;
  readonly initialTargetRawSha256: string;
  readonly publicFilePaths: readonly string[];
  readonly publicManifestSha256: string;
  readonly workspace: string;
}

export async function createMemE0Workspace(input: Readonly<{
  readonly loadedCase: MemE0LoadedCase;
  readonly workspace: string;
}>): Promise<MemE0WorkspaceBefore> {
  await mkdir(input.workspace, { recursive: false });
  for (const file of input.loadedCase.publicFiles) {
    const destination = join(input.workspace, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
  }
  const actualPaths = await listFiles(input.workspace);
  const expectedPaths = input.loadedCase.publicFiles.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("MEM-E0 copied public workspace file set drifted");
  }
  const copiedManifest = await Promise.all(
    input.loadedCase.publicFiles.map(async (file) => {
      const content = await readFile(join(input.workspace, ...file.path.split("/")));
      return Object.freeze({
        byteLength: content.byteLength,
        path: file.path,
        rawSha256: memE0RawSha256(content),
      });
    }),
  );
  const publicManifestSha256 = sha256Canonical(copiedManifest);
  if (publicManifestSha256 !== input.loadedCase.definition.publicWorkspace.manifestSha256) {
    throw new Error("MEM-E0 copied public workspace manifest drifted");
  }
  const targetPath = join(
    input.workspace,
    ...input.loadedCase.definition.publicWorkspace.targetRelativePath.split("/"),
  );
  const initialTargetRawSha256 = memE0RawSha256(await readFile(targetPath));
  if (
    initialTargetRawSha256 !==
      input.loadedCase.definition.publicWorkspace.initialTargetRawSha256
  ) {
    throw new Error("MEM-E0 copied initial target drifted");
  }
  const hiddenVerifier = await runMemE0HiddenVerifier(input.loadedCase, input.workspace);
  if (hiddenVerifier.exitCode === 0 || hiddenVerifier.passed) {
    throw new Error("MEM-E0 initial hidden verifier did not fail");
  }
  await git(input.workspace, ["init", "--quiet"]);
  await git(input.workspace, ["config", "user.email", "mem-e0@example.invalid"]);
  await git(input.workspace, ["config", "user.name", "FAL MEM-E0"]);
  await git(input.workspace, ["config", "core.autocrlf", "false"]);
  await git(input.workspace, ["add", "--all"]);
  await git(input.workspace, [
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    `MEM-E0 ${input.loadedCase.definition.caseId} baseline`,
  ]);
  const baselineCommit = await git(input.workspace, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baselineCommit)) {
    throw new Error("MEM-E0 baseline commit identity is invalid");
  }
  const beforeStateSha256 = sha256Canonical({
    baselineCommit,
    caseId: input.loadedCase.definition.caseId,
    hiddenVerifierExitCode: hiddenVerifier.exitCode,
    initialTargetRawSha256,
    publicManifestSha256,
  });
  return Object.freeze({
    baselineCommit,
    beforeStateSha256,
    caseId: input.loadedCase.definition.caseId,
    hiddenVerifier,
    initialTargetRawSha256,
    publicFilePaths: actualPaths,
    publicManifestSha256,
    workspace: input.workspace,
  });
}

export interface MemE0WorkspaceAfter {
  readonly afterStateSha256: string;
  readonly changedPaths: readonly string[];
  readonly diffSha256: string;
  readonly finalTargetRawSha256: string;
}

export interface MemE0PublicVerifierObservation {
  readonly argvIdentitySha256: string;
  readonly exitCode: number;
  readonly implementationRawSha256: string;
  readonly passed: boolean;
  readonly stderrSha256: string;
  readonly stdoutSha256: string;
}

export async function runMemE0PublicVerifier(
  loadedCase: MemE0LoadedCase,
  workspace: string,
): Promise<MemE0PublicVerifierObservation> {
  const [executable, verifierPath] =
    loadedCase.definition.publicWorkspace.publicVerifierArgv;
  const observation = await observeProcess({
    args: [verifierPath],
    cwd: workspace,
    executable,
  });
  const publicVerifier = loadedCase.publicFiles.find(
    (file) =>
      file.path ===
      loadedCase.definition.publicWorkspace.publicVerifierRelativePath,
  );
  if (publicVerifier === undefined) {
    throw new Error("MEM-E0 public verifier is absent from the frozen manifest");
  }
  return Object.freeze({
    argvIdentitySha256: sha256Canonical({
      argv: [executable, verifierPath],
      cwd: "<workspace-root>",
    }),
    exitCode: observation.exitCode,
    implementationRawSha256: publicVerifier.rawSha256,
    passed: observation.exitCode === 0,
    stderrSha256: memE0RawSha256(observation.stderr),
    stdoutSha256: memE0RawSha256(observation.stdout),
  });
}

export async function inspectMemE0WorkspaceAfter(
  loadedCase: MemE0LoadedCase,
  before: MemE0WorkspaceBefore,
): Promise<MemE0WorkspaceAfter> {
  const observed = await observeMemE0WorkspaceAfter(loadedCase, before);
  const allowed = loadedCase.definition.publicWorkspace.allowedChangedPaths;
  if (JSON.stringify(observed.changedPaths) !== JSON.stringify(allowed)) {
    throw new Error("MEM-E0 changed paths differ from the exact allowed target");
  }
  return observed;
}

export async function observeMemE0WorkspaceAfter(
  loadedCase: MemE0LoadedCase,
  before: MemE0WorkspaceBefore,
): Promise<MemE0WorkspaceAfter> {
  const [tracked, untracked, diff] = await Promise.all([
    git(before.workspace, ["diff", "--name-only", "HEAD", "--"]),
    git(before.workspace, ["ls-files", "--others", "--exclude-standard"]),
    git(before.workspace, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]),
  ]);
  const changedPaths = Object.freeze(
    [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/u).filter(Boolean))].sort(),
  );
  const finalTargetRawSha256 = memE0RawSha256(await readFile(join(
    before.workspace,
    ...loadedCase.definition.publicWorkspace.targetRelativePath.split("/"),
  )));
  const diffSha256 = memE0RawSha256(diff);
  return Object.freeze({
    afterStateSha256: sha256Canonical({
      baselineCommit: before.baselineCommit,
      changedPaths,
      diffSha256,
      finalTargetRawSha256,
    }),
    changedPaths,
    diffSha256,
    finalTargetRawSha256,
  });
}

export interface MemE0FreshVerification {
  readonly after: MemE0WorkspaceAfter;
  readonly fullPass: boolean;
  readonly verifier: MemE0VerifierObservation;
}

export async function verifyMemE0WorkspaceFresh(
  loadedCase: MemE0LoadedCase,
  before: MemE0WorkspaceBefore,
): Promise<MemE0FreshVerification> {
  const after = await inspectMemE0WorkspaceAfter(loadedCase, before);
  const verifier = await runMemE0HiddenVerifier(loadedCase, before.workspace);
  return Object.freeze({ after, fullPass: verifier.passed, verifier });
}
