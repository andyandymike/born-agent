import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  MAXIMUM_TIMEOUT_MS,
  MINIMUM_TIMEOUT_MS,
  resolveChatConfig,
} from "../../src/chat/config.js";
import type { ChatCommandOptions } from "../../src/chat/types.js";

const baseOptions: ChatCommandOptions = {
  model: undefined,
  prompt: "hello",
  provider: undefined,
  timeoutMs: undefined,
  verbose: false,
};

describe("resolveChatConfig", () => {
  it("uses CLI model before environment and default", () => {
    const result = resolveChatConfig(
      { ...baseOptions, model: "cli-model" },
      { BORN_MODEL: "env-model" },
    );
    expect(result).toMatchObject({ ok: true, value: { model: "cli-model" } });
  });

  it("uses environment model before the default", () => {
    const environment = resolveChatConfig(baseOptions, {
      BORN_MODEL: "env-model",
    });
    const fallback = resolveChatConfig(baseOptions, {});
    expect(environment).toMatchObject({
      ok: true,
      value: { model: "env-model" },
    });
    expect(fallback).toMatchObject({
      ok: true,
      value: { model: DEFAULT_MODEL },
    });
  });

  it("selects Ollama from CLI or environment with local defaults", () => {
    const cli = resolveChatConfig(
      { ...baseOptions, provider: "OLLAMA" },
      {},
    );
    const environment = resolveChatConfig(baseOptions, {
      BORN_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/",
      BORN_PROVIDER: "ollama",
    });

    expect(cli).toMatchObject({
      ok: true,
      value: {
        model: DEFAULT_OLLAMA_MODEL,
        ollamaBaseURL: DEFAULT_OLLAMA_BASE_URL,
        provider: "ollama",
      },
    });
    expect(environment).toMatchObject({
      ok: true,
      value: {
        ollamaBaseURL: "http://127.0.0.1:11434/v1",
        provider: "ollama",
      },
    });
  });

  it("rejects unknown providers and invalid Ollama URLs", () => {
    expect(
      resolveChatConfig({ ...baseOptions, provider: "unknown" }, {}),
    ).toMatchObject({ ok: false });
    expect(
      resolveChatConfig(
        { ...baseOptions, provider: "ollama" },
        { BORN_OLLAMA_BASE_URL: "http://remote.example:11434/v1" },
      ),
    ).toMatchObject({ ok: false });
    expect(
      resolveChatConfig(
        { ...baseOptions, provider: "ollama" },
        { BORN_OLLAMA_BASE_URL: "file:///tmp/ollama" },
      ),
    ).toMatchObject({ ok: false });
  });

  it.each([MINIMUM_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS])(
    "accepts timeout boundary %s",
    (timeoutMs) => {
      expect(
        resolveChatConfig(
          { ...baseOptions, timeoutMs: String(timeoutMs) },
          {},
        ),
      ).toMatchObject({ ok: true, value: { timeoutMs } });
    },
  );

  it.each(["999", "600001", "1.5", "abc", ""])(
    "rejects invalid timeout %j",
    (timeoutMs) => {
      expect(
        resolveChatConfig({ ...baseOptions, timeoutMs }, {}),
      ).toMatchObject({ ok: false });
    },
  );

  it("rejects whitespace-only prompts and models", () => {
    expect(
      resolveChatConfig({ ...baseOptions, prompt: " \t " }, {}),
    ).toMatchObject({ ok: false });
    expect(
      resolveChatConfig({ ...baseOptions, model: "   " }, {}),
    ).toMatchObject({ ok: false });
  });
});
