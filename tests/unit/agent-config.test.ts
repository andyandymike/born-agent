import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_MAX_DURATION_MS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MAX_TOKENS,
  DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES,
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  DEFAULT_ARTIFACT_CAPTURE_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_RESERVE_OUTPUT_TOKENS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  resolveAgentConfig,
  resolveAgentContextRuntime,
} from "../../src/agent/agent-config.js";

const options = {
  commandApproval: undefined,
  commandTimeoutMs: undefined,
  completionPolicy: undefined,
  editApproval: undefined,
  maxDurationMs: undefined,
  maxCommandOutputBytes: undefined,
  maxSteps: undefined,
  maxTokens: undefined,
  maxToolOutputBytes: undefined,
  model: undefined,
  provider: undefined,
  reportFormat: undefined,
  requireVerification: undefined,
  requestTimeoutMs: undefined,
  task: "inspect the repository",
  taskProfile: undefined,
  verbose: false,
};

describe("resolveAgentConfig", () => {
  it("uses the Phase 4 defaults", () => {
    expect(resolveAgentConfig(options, {})).toEqual({
      ok: true,
      value: {
        artifactCaptureBytes: DEFAULT_ARTIFACT_CAPTURE_BYTES,
        commandApproval: "ask",
        commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        completionPolicy: "verified",
        contextCompactionThreshold: DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
        contextReserveOutputTokens: DEFAULT_CONTEXT_RESERVE_OUTPUT_TOKENS,
        editApproval: "ask",
        maxDurationMs: DEFAULT_AGENT_MAX_DURATION_MS,
        maxCommandOutputBytes: DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
        maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        maxToolOutputBytes: DEFAULT_AGENT_MAX_TOOL_OUTPUT_BYTES,
        model: "gpt-5.6-terra",
        provider: "openai",
        reportFormat: "text",
        requireVerification: "auto",
        requestTimeoutMs: DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
        task: options.task,
        taskProfile: "coding",
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
        BORN_OLLAMA_BASE_URL: "http://127.0.0.1:11434/",
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
        ollamaBaseURL: "http://127.0.0.1:11434",
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
    [{ ...options, commandApproval: "always" }, "command approval"],
    [{ ...options, commandTimeoutMs: "999" }, "command timeout"],
    [{ ...options, maxCommandOutputBytes: "16383" }, "max command output"],
    [{ ...options, taskProfile: "write" }, "task profile"],
    [{ ...options, completionPolicy: "trust-model" }, "completion policy"],
    [{ ...options, requireVerification: "false" }, "require verification"],
    [{ ...options, reportFormat: "yaml" }, "report format"],
    [
      { ...options, contextReserveOutputTokens: "511" },
      "context reserve output tokens",
    ],
    [
      { ...options, contextCompactionThreshold: "0.49" },
      "context compaction threshold",
    ],
    [
      { ...options, contextCompactionThreshold: "NaN" },
      "context compaction threshold",
    ],
    [{ ...options, contextWindowTokens: "2047" }, "context window tokens"],
    [{ ...options, artifactCaptureBytes: "65535" }, "artifact capture bytes"],
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

  it("resolves pinned capacity and only permits a conservative window override", () => {
    const resolved = resolveAgentConfig(options, {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const pinned = resolveAgentContextRuntime(resolved.value, {
      contextWindowTokens: 131_072,
      maximumOutputTokens: 16_384,
      source: "pinned_catalog",
    });
    expect(pinned).toMatchObject({
      ok: true,
      value: {
        budget: {
          capacitySource: "pinned_catalog",
          contextWindowTokens: 131_072,
        },
      },
    });

    const loweredConfig = resolveAgentConfig(
      { ...options, contextWindowTokens: "65536" },
      {},
    );
    expect(loweredConfig.ok).toBe(true);
    if (!loweredConfig.ok) return;
    expect(
      resolveAgentContextRuntime(loweredConfig.value, {
        contextWindowTokens: 131_072,
        maximumOutputTokens: 16_384,
        source: "pinned_catalog",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        budget: {
          capacitySource: "user_conservative_limit",
          contextWindowTokens: 65_536,
        },
      },
    });

    const raisedConfig = resolveAgentConfig(
      { ...options, contextWindowTokens: "200000" },
      {},
    );
    expect(raisedConfig.ok).toBe(true);
    if (!raisedConfig.ok) return;
    expect(
      resolveAgentContextRuntime(raisedConfig.value, {
        contextWindowTokens: 131_072,
        maximumOutputTokens: 16_384,
        source: "pinned_catalog",
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires an explicit conservative limit when backend capacity is unknown", () => {
    const resolved = resolveAgentConfig(options, {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolveAgentContextRuntime(resolved.value, undefined)).toMatchObject({
      ok: false,
    });
  });
});
