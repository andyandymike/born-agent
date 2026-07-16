import { isAbsolute } from "node:path";

import type {
  DoctorCheck,
  DoctorReport,
  DoctorRuntime,
  ExecutableResult,
} from "./types.js";

const MINIMUM_NODE_MAJOR = 22;
const COMMAND_TIMEOUT_MS = 3_000;

function nodeCheck(version: string): DoctorCheck {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const major = match?.[1] ? Number(match[1]) : Number.NaN;

  if (!Number.isFinite(major)) {
    return {
      detail: `could not parse version ${version}`,
      name: "Node.js",
      ok: false,
    };
  }

  if (major < MINIMUM_NODE_MAJOR) {
    return {
      detail: `v${version.replace(/^v/u, "")} found; v${MINIMUM_NODE_MAJOR}+ required`,
      name: "Node.js",
      ok: false,
    };
  }

  return {
    detail: `v${version.replace(/^v/u, "")}`,
    name: "Node.js",
    ok: true,
  };
}

function firstOutputLine(result: Extract<ExecutableResult, { kind: "completed" }>) {
  const output = result.stdout.trim() || result.stderr.trim();
  return output.split(/\r?\n/u)[0] ?? "version command succeeded";
}

function oneLine(message: string): string {
  return message.replace(/\s+/gu, " ").trim() || "version command failed";
}

function missingHint(command: "git" | "rg") {
  if (command === "git") {
    return "not found. Install: Windows `winget install Git.Git`; macOS `brew install git`; Linux use your package manager.";
  }

  return "not found. Install: Windows `winget install BurntSushi.ripgrep.MSVC`; macOS `brew install ripgrep`; Linux use your package manager.";
}

async function executableCheck(
  runtime: DoctorRuntime,
  command: "git" | "rg",
  name: string,
): Promise<DoctorCheck> {
  const result = await runtime.runExecutable(
    command,
    ["--version"],
    COMMAND_TIMEOUT_MS,
  );

  switch (result.kind) {
    case "completed":
      return result.exitCode === 0
        ? { detail: firstOutputLine(result), name, ok: true }
        : {
            detail: `version command exited with code ${result.exitCode}`,
            name,
            ok: false,
          };
    case "missing":
      return { detail: missingHint(command), name, ok: false };
    case "timeout":
      return {
        detail: `version command timed out after ${COMMAND_TIMEOUT_MS} ms`,
        name,
        ok: false,
      };
    case "failed":
      return { detail: oneLine(result.message), name, ok: false };
  }
}

async function workspaceCheck(runtime: DoctorRuntime): Promise<DoctorCheck> {
  if (!isAbsolute(runtime.cwd)) {
    return {
      detail: `path is not absolute: ${runtime.cwd}`,
      name: "Workspace",
      ok: false,
    };
  }

  const readable = await runtime.isReadableDirectory(runtime.cwd);
  return readable
    ? { detail: runtime.cwd, name: "Workspace", ok: true }
    : {
        detail: `directory is not readable: ${runtime.cwd}`,
        name: "Workspace",
        ok: false,
      };
}

export async function runDoctor(runtime: DoctorRuntime): Promise<DoctorReport> {
  const [git, ripgrep, workspace] = await Promise.all([
    executableCheck(runtime, "git", "Git"),
    executableCheck(runtime, "rg", "ripgrep"),
    workspaceCheck(runtime),
  ]);
  const checks = [nodeCheck(runtime.nodeVersion), git, ripgrep, workspace];
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;

  return {
    checks,
    failed,
    ok: failed === 0,
    passed,
  };
}
