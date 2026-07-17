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
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
  type ContextBudget,
  type TokenEstimator,
} from "../context/token-estimator.js";
import type { ContextCapacity } from "../model/model-context-capacity.js";

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
export const DEFAULT_CONTEXT_RESERVE_OUTPUT_TOKENS = 4_096;
export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 0.8;
export const DEFAULT_CONTEXT_FIXED_SAFETY_MARGIN_TOKENS = 256;
export const DEFAULT_ARTIFACT_CAPTURE_BYTES = 4_194_304;

// PHASE4: 所有预算统一采用 CLI > 环境变量 > 内置默认值，先在创建 session 前完成验证。
export type ConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

interface IntegerContract {
  readonly label: string;
  readonly maximum: number;
  readonly minimum: number;
}

function resolveOptionalInteger(
  cliValue: string | undefined,
  environmentValue: string | undefined,
  contract: IntegerContract,
): ConfigResult<number | undefined> {
  const selected = cliValue ?? environmentValue;
  if (selected === undefined) return { ok: true, value: undefined };
  return resolveInteger(selected, undefined, contract.minimum, contract);
}

function resolveThreshold(
  cliValue: string | undefined,
  environmentValue: string | undefined,
): ConfigResult<number> {
  const selected = cliValue ?? environmentValue;
  if (selected === undefined) {
    return { ok: true, value: DEFAULT_CONTEXT_COMPACTION_THRESHOLD };
  }
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(selected)) {
    return {
      error: "context compaction threshold must be a decimal from 0.50 to 0.95",
      ok: false,
    };
  }
  const value = Number(selected);
  return value >= 0.5 && value <= 0.95
    ? { ok: true, value }
    : {
        error: "context compaction threshold must be a decimal from 0.50 to 0.95",
        ok: false,
      };
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
  const mcpServerIds = [...(options.mcpServerIds ?? [])];
  if (
    mcpServerIds.length > 4 ||
    new Set(mcpServerIds).size !== mcpServerIds.length ||
    mcpServerIds.some((serverId) => !/^[a-z][a-z0-9_-]{0,31}$/u.test(serverId))
  ) {
    return {
      error: "MCP server ids must be unique valid ids and at most four may be enabled",
      ok: false,
    };
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
  const contextReserveOutputTokens = resolveInteger(
    options.contextReserveOutputTokens,
    env.BORN_CONTEXT_RESERVE_OUTPUT_TOKENS,
    DEFAULT_CONTEXT_RESERVE_OUTPUT_TOKENS,
    {
      label: "context reserve output tokens",
      maximum: 32_768,
      minimum: 512,
    },
  );
  if (!contextReserveOutputTokens.ok) return contextReserveOutputTokens;
  const contextCompactionThreshold = resolveThreshold(
    options.contextCompactionThreshold,
    env.BORN_CONTEXT_COMPACTION_THRESHOLD,
  );
  if (!contextCompactionThreshold.ok) return contextCompactionThreshold;
  const contextWindowTokens = resolveOptionalInteger(
    options.contextWindowTokens,
    env.BORN_CONTEXT_WINDOW_TOKENS,
    {
      label: "context window tokens",
      maximum: 2_000_000,
      minimum: 2_048,
    },
  );
  if (!contextWindowTokens.ok) return contextWindowTokens;
  const artifactCaptureBytes = resolveInteger(
    options.artifactCaptureBytes,
    env.BORN_ARTIFACT_CAPTURE_BYTES,
    DEFAULT_ARTIFACT_CAPTURE_BYTES,
    {
      label: "artifact capture bytes",
      maximum: 16_777_216,
      minimum: 65_536,
    },
  );
  if (!artifactCaptureBytes.ok) return artifactCaptureBytes;

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
      artifactCaptureBytes: artifactCaptureBytes.value,
      commandApproval,
      commandTimeoutMs: commandTimeoutMs.value,
      completionPolicy,
      contextCompactionThreshold: contextCompactionThreshold.value,
      contextReserveOutputTokens: contextReserveOutputTokens.value,
      ...(contextWindowTokens.value === undefined
        ? {}
        : { contextWindowTokens: contextWindowTokens.value }),
      editApproval,
      maxDurationMs: maxDurationMs.value,
      maxCommandOutputBytes: maxCommandOutputBytes.value,
      maxSteps: maxSteps.value,
      maxTokens: maxTokens.value,
      maxToolOutputBytes: maxToolOutputBytes.value,
      ...(mcpServerIds.length === 0
        ? {}
        : { mcpServerIds: Object.freeze(mcpServerIds) }),
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

export interface ResolvedAgentContextRuntime {
  readonly budget: ContextBudget;
  readonly estimator: TokenEstimator;
}

export function resolveAgentContextRuntime(
  config: ResolvedAgentConfig,
  backendCapacity: ContextCapacity | undefined,
): ConfigResult<ResolvedAgentContextRuntime> {
  const catalogWindow = backendCapacity?.contextWindowTokens ?? null;
  if (
    config.contextWindowTokens !== undefined &&
    catalogWindow !== null &&
    config.contextWindowTokens > catalogWindow
  ) {
    return {
      error: `context window tokens may lower but not exceed pinned catalog limit ${catalogWindow}`,
      ok: false,
    };
  }
  const contextWindowTokens = config.contextWindowTokens ?? catalogWindow;
  const capacity: ContextCapacity = Object.freeze({
    contextWindowTokens,
    maximumOutputTokens: backendCapacity?.maximumOutputTokens ?? null,
    source:
      config.contextWindowTokens === undefined
        ? "pinned_catalog"
        : "user_conservative_limit",
  });
  try {
    const budget = resolveContextBudget(capacity, {
      compactionThreshold:
        config.contextCompactionThreshold ??
        DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
      fixedSafetyMarginTokens: DEFAULT_CONTEXT_FIXED_SAFETY_MARGIN_TOKENS,
      reservedOutputTokens:
        config.contextReserveOutputTokens ??
        DEFAULT_CONTEXT_RESERVE_OUTPUT_TOKENS,
    });
    const estimator = new DeterministicTokenEstimator({
      bytesPerToken: 3,
      itemOverheadTokens: 8,
      model: config.model,
      provider: config.provider,
      tokenizer: "utf8-conservative",
      version: "phase10-v1",
    });
    return {
      ok: true,
      value: Object.freeze({ budget, estimator }),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "context capacity configuration is invalid",
      ok: false,
    };
  }
}
