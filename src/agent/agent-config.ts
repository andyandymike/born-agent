import {
  DEFAULT_OLLAMA_BASE_URL,
  resolveModel,
  resolveProvider,
} from "../chat/config.js";
import type {
  AgentCommandOptions,
  ResolvedAgentConfig,
} from "./agent-types.js";
import { resolveLoopbackOllamaURL } from "../security/loopback-ollama-url.js";

export const DEFAULT_AGENT_MAX_STEPS = 8;
export const DEFAULT_AGENT_MAX_DURATION_MS = 300_000;
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENT_MAX_TOKENS = 100_000;
export const DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES = 262_144;
export const DEFAULT_EDIT_APPROVAL = "ask" as const;
export const DEFAULT_COMMAND_APPROVAL = "ask" as const;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 131_072;
export const DEFAULT_TASK_PROFILE = "coding" as const;
export const DEFAULT_COMPLETION_POLICY = "verified" as const;
export const DEFAULT_REQUIRE_VERIFICATION = "auto" as const;
export const DEFAULT_REPORT_FORMAT = "text" as const;

// PHASE4: 所有预算统一采用 CLI > 环境变量 > 内置默认值，先在创建 session 前完成验证。
type ConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

interface IntegerContract {
  readonly label: string;
  readonly maximum: number;
  readonly minimum: number;
}

function resolveInteger(
  cliValue: string | undefined,
  environmentValue: string | undefined,
  fallback: number,
  contract: IntegerContract,
): ConfigResult<number> {
  // PHASE4: 不接受小数、负数、科学计数法或超出 safe integer 的值，避免预算语义含糊。
  const selected = cliValue ?? environmentValue;
  if (selected === undefined) {
    return { ok: true, value: fallback };
  }
  if (!/^\d+$/u.test(selected)) {
    return {
      error: `${contract.label} must be an integer from ${contract.minimum} to ${contract.maximum}`,
      ok: false,
    };
  }
  const value = Number(selected);
  if (
    !Number.isSafeInteger(value) ||
    value < contract.minimum ||
    value > contract.maximum
  ) {
    return {
      error: `${contract.label} must be an integer from ${contract.minimum} to ${contract.maximum}`,
      ok: false,
    };
  }
  return { ok: true, value };
}

function resolveOllamaBaseURL(value: string | undefined): ConfigResult<string> {
  return resolveLoopbackOllamaURL(value ?? DEFAULT_OLLAMA_BASE_URL);
}

export function resolveAgentConfig(
  options: AgentCommandOptions,
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult<ResolvedAgentConfig> {
  // PHASE4: 配置失败必须发生在 writer/model/tool 初始化前，因此不会留下无意义的半截 session。
  if (options.task.trim().length === 0) {
    return { error: "task must not be empty", ok: false };
  }

  const editApproval = options.editApproval ?? DEFAULT_EDIT_APPROVAL;
  if (editApproval !== "ask" && editApproval !== "deny") {
    return { error: "edit approval must be one of: ask, deny", ok: false };
  }
  const commandApproval = options.commandApproval ?? DEFAULT_COMMAND_APPROVAL;
  if (commandApproval !== "ask" && commandApproval !== "deny") {
    return { error: "command approval must be one of: ask, deny", ok: false };
  }
  const taskProfile = options.taskProfile ?? DEFAULT_TASK_PROFILE;
  if (taskProfile !== "coding" && taskProfile !== "read-only") {
    return { error: "task profile must be one of: read-only, coding", ok: false };
  }
  const completionPolicy =
    options.completionPolicy ?? DEFAULT_COMPLETION_POLICY;
  if (completionPolicy !== "verified") {
    return { error: "completion policy must be: verified", ok: false };
  }
  const requireVerification =
    options.requireVerification ?? DEFAULT_REQUIRE_VERIFICATION;
  if (requireVerification !== "auto") {
    return { error: "require verification must be: auto", ok: false };
  }
  const reportFormat = options.reportFormat ?? DEFAULT_REPORT_FORMAT;
  if (reportFormat !== "text" && reportFormat !== "json") {
    return { error: "report format must be one of: text, json", ok: false };
  }

  const provider = resolveProvider(options.provider, env.BORN_PROVIDER);
  if (!provider.ok) {
    return provider;
  }
  const model = resolveModel(options.model, env.BORN_MODEL, provider.value);
  if (!model.ok) {
    return model;
  }

  const maxSteps = resolveInteger(
    options.maxSteps,
    env.BORN_AGENT_MAX_STEPS,
    DEFAULT_AGENT_MAX_STEPS,
    { label: "max steps", maximum: 32, minimum: 1 },
  );
  if (!maxSteps.ok) return maxSteps;
  const maxDurationMs = resolveInteger(
    options.maxDurationMs,
    env.BORN_AGENT_MAX_DURATION_MS,
    DEFAULT_AGENT_MAX_DURATION_MS,
    { label: "max duration", maximum: 1_800_000, minimum: 1_000 },
  );
  if (!maxDurationMs.ok) return maxDurationMs;
  const requestTimeoutMs = resolveInteger(
    options.requestTimeoutMs,
    env.BORN_AGENT_REQUEST_TIMEOUT_MS,
    DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    { label: "request timeout", maximum: 600_000, minimum: 1_000 },
  );
  if (!requestTimeoutMs.ok) return requestTimeoutMs;
  const maxTokens = resolveInteger(
    options.maxTokens,
    env.BORN_AGENT_MAX_TOKENS,
    DEFAULT_AGENT_MAX_TOKENS,
    { label: "max tokens", maximum: 10_000_000, minimum: 1 },
  );
  if (!maxTokens.ok) return maxTokens;
  const maxToolOutputBytes = resolveInteger(
    options.maxToolOutputBytes,
    env.BORN_AGENT_MAX_TOOL_OUTPUT_BYTES,
    DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES,
    { label: "max tool output bytes", maximum: 1_048_576, minimum: 65_536 },
  );
  if (!maxToolOutputBytes.ok) return maxToolOutputBytes;
  const commandTimeoutMs = resolveInteger(
    options.commandTimeoutMs,
    env.BORN_COMMAND_TIMEOUT_MS,
    DEFAULT_COMMAND_TIMEOUT_MS,
    { label: "command timeout", maximum: 600_000, minimum: 1_000 },
  );
  if (!commandTimeoutMs.ok) return commandTimeoutMs;
  const maxCommandOutputBytes = resolveInteger(
    options.maxCommandOutputBytes,
    env.BORN_MAX_COMMAND_OUTPUT_BYTES,
    DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
    {
      label: "max command output bytes",
      maximum: 1_048_576,
      minimum: 16_384,
    },
  );
  if (!maxCommandOutputBytes.ok) return maxCommandOutputBytes;

  const ollamaBaseURL =
    provider.value === "ollama"
      ? resolveOllamaBaseURL(env.BORN_OLLAMA_BASE_URL)
      : undefined;
  if (ollamaBaseURL !== undefined && !ollamaBaseURL.ok) {
    return ollamaBaseURL;
  }

  return {
    ok: true,
    value: {
      commandApproval,
      commandTimeoutMs: commandTimeoutMs.value,
      completionPolicy,
      editApproval,
      maxDurationMs: maxDurationMs.value,
      maxCommandOutputBytes: maxCommandOutputBytes.value,
      maxSteps: maxSteps.value,
      maxTokens: maxTokens.value,
      maxToolOutputBytes: maxToolOutputBytes.value,
      model: model.value,
      ...(ollamaBaseURL === undefined
        ? {}
        : { ollamaBaseURL: ollamaBaseURL.value }),
      provider: provider.value,
      reportFormat,
      requireVerification,
      requestTimeoutMs: requestTimeoutMs.value,
      task: options.task,
      taskProfile,
      verbose: options.verbose,
    },
  };
}
