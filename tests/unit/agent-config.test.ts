import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_MAX_DURATION_MS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MAX_TOKENS,
  DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES,
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  resolveAgentConfig,
} from "../../src/agent/agent-config.js";

const options = {
  editApproval: undefined,
  maxDurationMs: undefined,
  maxSteps: undefined,
  maxTokens: undefined,
  maxToolOutputBytes: undefined,
  model: undefined,
  provider: undefined,
  requestTimeoutMs: undefined,
  task: "inspect the repository",
  verbose: false,
};

describe("resolveAgentConfig", () => {
  it("uses the Phase 4 defaults", () => {
    expect(resolveAgentConfig(options, {})).toEqual({
      ok: true,
      value: {
        editApproval: "ask",
        maxDurationMs: DEFAULT_AGENT_MAX_DURATION_MS,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
        maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        maxToolOutputBytes: DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES,
        model: "gpt-5.6-terra",
        provider: "openai",
        requestTimeoutMs: DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
        task: options.task,
        verbose: false,
      },
    });
  });

  it("applies CLI over environment over defaults", () => {
    const result = resolveAgentConfig(
      {
        ...options,
        maxSteps: "7",
        provider: "ollama",
        requestTimeoutMs: "9000",
      },
      {
        BORN_AGENT_MAX_DURATION_MS: "8000",
        BORN_AGENT_MAX_STEPS: "6",
        BORN_AGENT_MAX_TOKENS: "7000",
        BORN_AGENT_MAX_TOOL_OUTPUT_BYTES: "70000",
        BORN_AGENT_REQUEST_TIMEOUT_MS: "6000",
        BORN_MODEL: "local-model",
        BORN_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        maxDurationMs: 8000,
        maxSteps: 7,
        maxTokens: 7000,
        maxToolOutputBytes: 70000,
        model: "local-model",
        ollamaBaseURL: "http://127.0.0.1:11434/v1",
        provider: "ollama",
        requestTimeoutMs: 9000,
      },
    });
  });

  it.each([
    [{ ...options, task: "   " }, "task must not be empty"],
    [{ ...options, maxSteps: "0" }, "max steps"],
    [{ ...options, maxSteps: "33" }, "max steps"],
    [{ ...options, maxDurationMs: "999" }, "max duration"],
    [{ ...options, requestTimeoutMs: "nope" }, "request timeout"],
    [{ ...options, maxTokens: "10000001" }, "max tokens"],
    [{ ...options, maxToolOutputBytes: "65535" }, "max tool output bytes"],
    [{ ...options, editApproval: "always" }, "edit approval"],
  ])("rejects invalid input before a session is created", (input, message) => {
    const result = resolveAgentConfig(input, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it.each([
    "https://localhost:11434/v1",
    "http://ollama.example:11434/v1",
    "http://127.0.0.1:11435/v1",
  ])("rejects non-policy Ollama endpoint %s before runtime creation", (baseURL) => {
    const result = resolveAgentConfig(
      { ...options, provider: "ollama" },
      { BORN_OLLAMA_BASE_URL: baseURL },
    );
    expect(result).toMatchObject({ ok: false });
  });
});
