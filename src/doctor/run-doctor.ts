import { isAbsolute } from "node:path";

import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type ResolvedProviderPolicyRequest,
} from "../policy/policy-resolver.js";
import type { ProviderId } from "../model/model-backend.js";
import { credentialVariableForProvider } from "../security/credential-resolver.js";
import type {
  DoctorCheck,
  DoctorReport,
  DoctorRuntime,
  ExecutableResult,
} from "./types.js";

const MINIMUM_NODE_VERSION = [22, 19, 0] as const;
const COMMAND_TIMEOUT_MS = 3_000;

export interface DoctorPolicyOptions {
  readonly model?: string | undefined;
  readonly ollamaEndpoint?: string | undefined;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly provider?: string | undefined;
}

function nodeCheck(version: string): DoctorCheck {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const actual = match?.slice(1, 4).map(Number);

  if (actual === undefined || actual.some((part) => !Number.isFinite(part))) {
    return {
      detail: `could not parse version ${version}`,
      name: "Node.js",
      ok: false,
    };
  }

  let comparison = 0;
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const found = actual[index] ?? 0;
    const required = MINIMUM_NODE_VERSION[index] ?? 0;
    if (found !== required) {
      comparison = found > required ? 1 : -1;
      break;
    }
  }
  const supported = comparison >= 0;
  if (!supported) {
    return {
      detail: `v${version.replace(/^v/u, "")} found; v${MINIMUM_NODE_VERSION.join(".")}+ required`,
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

function credentialCheck(
  runtime: DoctorRuntime,
  provider: Exclude<ProviderId, "ollama">,
): DoctorCheck {
  const variable = credentialVariableForProvider(provider);
  if (variable === null) throw new TypeError("remote credential variable is unavailable");
  const configured = Boolean(runtime.env[variable]?.trim());
  const displayName = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    openai: "OpenAI",
  }[provider];
  return {
    detail: configured ? "configured" : "not configured",
    name: displayName + " credential",
    ok: configured,
  };
}

function modelCheck(model: string): DoctorCheck {
  return { detail: model, name: "Model", ok: true };
}

function providerCheck(provider: string): DoctorCheck {
  return { detail: `${provider} (enabled_by_policy)`, name: "Provider", ok: true };
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

async function ollamaChecks(
  runtime: DoctorRuntime,
  selectedModel: string,
): Promise<readonly DoctorCheck[]> {
  const model = modelCheck(selectedModel);
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
              detail: `not installed: ${model.detail}. Automatic model pull is disabled; install it manually outside BornAgent with: ollama pull ${model.detail}`,
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

function report(checks: readonly DoctorCheck[]): DoctorReport {
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  return { checks, failed, ok: failed === 0, passed };
}

export async function runDoctor(
  runtime: DoctorRuntime,
  options: DoctorPolicyOptions = {},
): Promise<DoctorReport> {
  const effectivePolicy = resolveEffectiveRuntimePolicy(
    await loadRuntimePolicyRegistry({
      ...(options.policyConfig === undefined
        ? {}
        : { configPath: options.policyConfig }),
      env: runtime.env,
      platform: runtime.platform,
      workspace: runtime.cwd,
    }),
    options.policyProfile,
  );
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
    {
      detail: `${effectivePolicy.entry.profile.id} / ${effectivePolicy.entry.profile.mode} / ${effectivePolicy.entry.profileSha256}`,
      name: "Runtime policy",
      ok: true,
    },
  ];
  let resolved: ResolvedProviderPolicyRequest;
  try {
    resolved = resolveProviderPolicyRequest(effectivePolicy, {
      endpoint:
        options.ollamaEndpoint ?? runtime.env.BORN_OLLAMA_BASE_URL,
      model: options.model ?? runtime.env.BORN_MODEL,
      provider: options.provider ?? runtime.env.BORN_PROVIDER,
    });
  } catch (error) {
    if (!(error instanceof RuntimePolicyError)) throw error;
    // PHASE15: a diagnostic request denied by policy is still useful output,
    // but it must not inspect the matching credential merely to explain that
    // the provider is disabled.
    return report([
      ...baseChecks,
      {
        detail: `${options.provider ?? runtime.env.BORN_PROVIDER ?? "default"} (disabled_by_policy: ${error.code})`,
        name: "Provider",
        ok: false,
      },
      {
        detail: "not_read (request disabled_by_policy)",
        name: "Credential access",
        ok: true,
      },
    ]);
  }

  const providerChecks: readonly DoctorCheck[] = [
    providerCheck(resolved.provider),
    ...(resolved.provider === "ollama"
      ? [
          {
            detail: "not_required (local_free)",
            name: "Credential access",
            ok: true,
          },
          ...(await ollamaChecks(runtime, resolved.model)),
        ]
      : resolved.provider === "openai" ||
          resolved.provider === "anthropic" ||
          resolved.provider === "deepseek"
        ? [credentialCheck(runtime, resolved.provider), modelCheck(resolved.model)]
        : [
            {
              detail: "not_required (in_process_test)",
              name: "Credential access",
              ok: true,
            },
            modelCheck(resolved.model),
          ]),
  ];
  return report([...baseChecks, ...providerChecks]);
}
