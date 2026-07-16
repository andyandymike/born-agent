import { isAbsolute } from "node:path";

import { resolveModel, resolveProvider } from "../chat/config.js";
import type { ChatProvider } from "../chat/types.js";
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

function missingHint(command: "git" | "ollama" | "rg") {
  if (command === "git") {
    return "not found. Install: Windows `winget install Git.Git`; macOS `brew install git`; Linux use your package manager.";
  }

  if (command === "ollama") {
    return "not found. Install Ollama from https://ollama.com/download";
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

function credentialCheck(runtime: DoctorRuntime): DoctorCheck {
  const configured = Boolean(runtime.env.OPENAI_API_KEY?.trim());
  return {
    detail: configured ? "configured" : "not configured",
    name: "OpenAI credential",
    ok: configured,
  };
}

function modelCheck(runtime: DoctorRuntime, provider: ChatProvider): DoctorCheck {
  const result = resolveModel(undefined, runtime.env.BORN_MODEL, provider);
  return result.ok
    ? { detail: result.value, name: "Model", ok: true }
    : { detail: result.error, name: "Model", ok: false };
}

function providerCheck(provider: ChatProvider): DoctorCheck {
  return { detail: provider, name: "Provider", ok: true };
}

function ollamaFailureChecks(
  detail: string,
  model: DoctorCheck,
): readonly DoctorCheck[] {
  return [
    { detail, name: "Ollama service", ok: false },
    model.ok
      ? {
          detail: "not checked because Ollama is unavailable",
          name: "Model",
          ok: false,
        }
      : model,
  ];
}

function installedOllamaModels(stdout: string): ReadonlySet<string> {
  const names = stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

async function ollamaChecks(runtime: DoctorRuntime): Promise<readonly DoctorCheck[]> {
  const model = modelCheck(runtime, "ollama");
  const result = await runtime.runExecutable(
    "ollama",
    ["list"],
    COMMAND_TIMEOUT_MS,
  );

  switch (result.kind) {
    case "completed": {
      if (result.exitCode !== 0) {
        return ollamaFailureChecks(
          `ollama list exited with code ${result.exitCode}`,
          model,
        );
      }
      if (!model.ok) {
        return [
          { detail: "reachable", name: "Ollama service", ok: true },
          model,
        ];
      }
      const installed = installedOllamaModels(result.stdout);
      return [
        { detail: "reachable", name: "Ollama service", ok: true },
        installed.has(model.detail)
          ? model
          : {
              detail: `not installed: ${model.detail}. Run: ollama pull ${model.detail}`,
              name: "Model",
              ok: false,
            },
      ];
    }
    case "missing":
      return ollamaFailureChecks(missingHint("ollama"), model);
    case "timeout":
      return ollamaFailureChecks(
        `ollama list timed out after ${COMMAND_TIMEOUT_MS} ms`,
        model,
      );
    case "failed":
      return ollamaFailureChecks(oneLine(result.message), model);
  }
}

export async function runDoctor(runtime: DoctorRuntime): Promise<DoctorReport> {
  const [git, ripgrep, workspace] = await Promise.all([
    executableCheck(runtime, "git", "Git"),
    executableCheck(runtime, "rg", "ripgrep"),
    workspaceCheck(runtime),
  ]);
  const baseChecks = [
    nodeCheck(runtime.nodeVersion),
    git,
    ripgrep,
    workspace,
  ];
  const provider = resolveProvider(undefined, runtime.env.BORN_PROVIDER);
  const providerChecks: readonly DoctorCheck[] = provider.ok
    ? [
        providerCheck(provider.value),
        ...(provider.value === "openai"
          ? [credentialCheck(runtime), modelCheck(runtime, "openai")]
          : await ollamaChecks(runtime)),
      ]
    : [{ detail: provider.error, name: "Provider", ok: false }];
  const checks = [...baseChecks, ...providerChecks];
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;

  return {
    checks,
    failed,
    ok: failed === 0,
    passed,
  };
}
