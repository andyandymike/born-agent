import type {
  ChatCommandOptions,
  ChatProvider,
  ResolvedChatConfig,
} from "./types.js";
import { resolveLoopbackOllamaURL } from "../security/loopback-ollama-url.js";

// PHASE15: CLI orchestration supplies the built-in asset decision explicitly.
// These local defaults remain only for small config-unit compatibility paths.
export const DEFAULT_PROVIDER: ChatProvider = "ollama";
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = DEFAULT_OLLAMA_MODEL;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MINIMUM_TIMEOUT_MS = 1_000;
export const MAXIMUM_TIMEOUT_MS = 600_000;

type ConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

export function resolveProvider(
  cliProvider: string | undefined,
  environmentProvider: string | undefined,
): ConfigResult<ChatProvider> {
  const provider = (cliProvider ?? environmentProvider ?? DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();

  return provider === "openai" ||
      provider === "anthropic" ||
      provider === "deepseek" ||
      provider === "ollama"
    ? { ok: true, value: provider }
    : {
        error: `provider must be one of: openai, anthropic, deepseek, ollama (received ${provider || "empty"})`,
        ok: false,
      };
}

export function resolveModel(
  cliModel: string | undefined,
  environmentModel: string | undefined,
  provider: ChatProvider = DEFAULT_PROVIDER,
): ConfigResult<string> {
  const defaultModel =
    provider === "ollama"
      ? DEFAULT_OLLAMA_MODEL
      : provider === "anthropic"
        ? DEFAULT_ANTHROPIC_MODEL
        : provider === "deepseek"
          ? DEFAULT_DEEPSEEK_MODEL
          : DEFAULT_OPENAI_MODEL;
  const selected = cliModel ?? environmentModel ?? defaultModel;
  const model = selected.trim();

  return model.length > 0
    ? { ok: true, value: model }
    : { error: "model must not be empty", ok: false };
}

function resolveOllamaBaseURL(value: string | undefined): ConfigResult<string> {
  return resolveLoopbackOllamaURL(value ?? DEFAULT_OLLAMA_BASE_URL);
}

function resolveTimeout(value: string | undefined): ConfigResult<number> {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_TIMEOUT_MS };
  }

  if (!/^\d+$/u.test(value)) {
    return {
      error: `timeout must be an integer from ${MINIMUM_TIMEOUT_MS} to ${MAXIMUM_TIMEOUT_MS} ms`,
      ok: false,
    };
  }

  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MINIMUM_TIMEOUT_MS ||
    timeoutMs > MAXIMUM_TIMEOUT_MS
  ) {
    return {
      error: `timeout must be an integer from ${MINIMUM_TIMEOUT_MS} to ${MAXIMUM_TIMEOUT_MS} ms`,
      ok: false,
    };
  }

  return { ok: true, value: timeoutMs };
}

export function resolveChatConfig(
  options: ChatCommandOptions,
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult<ResolvedChatConfig> {
  if (options.prompt.trim().length === 0) {
    return { error: "prompt must not be empty", ok: false };
  }

  const provider = resolveProvider(options.provider, env.BORN_PROVIDER);
  if (!provider.ok) {
    return provider;
  }

  const model = resolveModel(options.model, env.BORN_MODEL, provider.value);
  if (!model.ok) {
    return model;
  }

  const timeout = resolveTimeout(options.timeoutMs);
  if (!timeout.ok) {
    return timeout;
  }

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
      model: model.value,
      ...(ollamaBaseURL === undefined
        ? {}
        : { ollamaBaseURL: ollamaBaseURL.value }),
      prompt: options.prompt,
      provider: provider.value,
      timeoutMs: timeout.value,
      toolsEnabled: options.toolsEnabled ?? true,
      verbose: options.verbose,
    },
  };
}
