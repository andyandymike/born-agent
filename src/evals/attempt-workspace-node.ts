import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { EvalCoreError } from "./eval-errors.js";
import { readEvalFileTree } from "./eval-file-tree.js";
import { buildWorkspaceContentManifest, EVAL_GIT_BASELINE, EVAL_GIT_BASELINE_SHA256, type WorkspaceContentManifest } from "./attempt-workspace.js";

export interface PreparedAttemptWorkspace {
  readonly workspacePath: string;
  readonly initialManifest: WorkspaceContentManifest;
  readonly baselineGitHead: string;
  readonly baselineConfigSha256: string;
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_AUTHOR_DATE: EVAL_GIT_BASELINE.authorDate,
    GIT_AUTHOR_EMAIL: EVAL_GIT_BASELINE.userEmail,
    GIT_AUTHOR_NAME: EVAL_GIT_BASELINE.userName,
    GIT_COMMITTER_DATE: EVAL_GIT_BASELINE.committerDate,
    GIT_COMMITTER_EMAIL: EVAL_GIT_BASELINE.userEmail,
    GIT_COMMITTER_NAME: EVAL_GIT_BASELINE.userName,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runGit(workspace: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", workspace, ...args], {
      env: safeGitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => reject(new EvalCoreError("eval_workspace_invalid", "Git baseline process failed", 1, { cause: error })));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new EvalCoreError("eval_workspace_invalid", `Git baseline command failed: ${Buffer.concat(stderr).toString("utf8").trim()}`, 1));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

export async function prepareNodeAttemptWorkspace(sourceWorkspace: string, attemptRoot: string): Promise<PreparedAttemptWorkspace> {
  const source = await readEvalFileTree(sourceWorkspace, { rejectGrader: true, rejectPrivate: true });
  const initialManifest = buildWorkspaceContentManifest(source.entries);
  if (initialManifest.sourceStateSha256 !== source.contentSha256) {
    throw new EvalCoreError("eval_harness_invariant", "workspace digest implementations disagree", 1);
  }
  const workspacePath = path.join(attemptRoot, "workspace");
  await mkdir(workspacePath, { recursive: false });
  // PHASE14: each repetition is reconstructed from fresh checked-in bytes before any Agent/backend exists.
  for (const entry of source.entries) {
    const destination = path.join(workspacePath, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await mkdir(destination, { recursive: false });
    } else if (entry.kind === "file" && entry.bytes !== undefined) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.bytes, { flag: "wx" });
    } else {
      throw new EvalCoreError("eval_workspace_invalid", "fresh workspace source contains an unsupported entry", 1);
    }
  }

  // PHASE14: a fixed commit proves the fresh baseline, but `.git` is harness-private and excluded from Agent paths, source state, and candidate diff.
  await runGit(workspacePath, ["init", "--quiet", "--initial-branch=main"]);
  await runGit(workspacePath, ["config", "user.name", EVAL_GIT_BASELINE.userName]);
  await runGit(workspacePath, ["config", "user.email", EVAL_GIT_BASELINE.userEmail]);
  await runGit(workspacePath, ["config", "core.autocrlf", "false"]);
  await runGit(workspacePath, ["config", "core.filemode", "false"]);
  await runGit(workspacePath, ["config", "commit.gpgsign", "false"]);
  await runGit(workspacePath, ["add", "--all"]);
  await runGit(workspacePath, ["commit", "--quiet", "--no-gpg-sign", "-m", "BornAgent Eval baseline"]);
  const baselineGitHead = await runGit(workspacePath, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/u.test(baselineGitHead)) {
    throw new EvalCoreError("eval_workspace_invalid", "Git baseline HEAD is malformed", 1);
  }
  return Object.freeze({ workspacePath, initialManifest, baselineGitHead, baselineConfigSha256: EVAL_GIT_BASELINE_SHA256 });
}

export async function readAttemptWorkspaceManifest(workspacePath: string): Promise<WorkspaceContentManifest> {
  const tree = await readEvalFileTree(workspacePath);
  return buildWorkspaceContentManifest(tree.entries);
}

export async function verifyNodeAttemptGitBaseline(workspacePath: string, expectedHead: string): Promise<void> {
  const actualHead = await runGit(workspacePath, ["rev-parse", "HEAD"]);
  if (actualHead !== expectedHead) {
    throw new EvalCoreError("eval_harness_invariant", "attempt modified harness-private Git baseline metadata", 1);
  }
}
