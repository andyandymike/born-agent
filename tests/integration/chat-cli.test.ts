import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { mapOpenAIError } from "../../src/providers/openai/map-openai-error.js";
import {
  FakeChatClient,
  fixedResponse,
  rejected,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

describe("born chat", () => {
  it("writes only normalized assistant text to stdout", async () => {
    const client = new FakeChatClient(fixedResponse("hello\n\n"));
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "say hello"],
      memory.io,
      createRuntime({ createChatClient: () => client }),
    );
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toBe("hello\n");
    expect(memory.readStderr()).toBe("");
    expect(client.calls[0]?.request.prompt).toBe("say hello");
  });

  it("uses Ollama without an OpenAI key and reports the selected provider", async () => {
    const client = new FakeChatClient(fixedResponse("local answer"));
    const memory = createMemoryIO();
    let configuration: unknown;
    const exitCode = await runCli(
      ["chat", "hello", "--provider", "ollama", "--verbose"],
      memory.io,
      createRuntime({
        createChatClient: (selected) => {
          configuration = selected;
          return client;
        },
        env: {},
      }),
    );

    expect(exitCode).toBe(0);
    expect(configuration).toEqual({
      baseURL: "http://localhost:11434/v1",
      provider: "ollama",
    });
    expect(client.calls[0]?.request.model).toBe("qwen3:1.7b");
    expect(memory.readStdout()).toBe("local answer\n");
    expect(memory.readStderr()).toContain("provider=ollama");
  });

  it("keeps text in stdout and writes metadata to stderr in verbose mode", async () => {
    const times = [100, 142];
    const client = new FakeChatClient(fixedResponse("verbose answer"));
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello", "--model", "test-model", "--verbose"],
      memory.io,
      createRuntime({
        createChatClient: () => client,
        now: () => times.shift() ?? 142,
      }),
    );
    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toBe("verbose answer\n");
    expect(memory.readStderr()).toContain("provider=openai");
    expect(memory.readStderr()).toContain("model=test-model");
    expect(memory.readStderr()).toContain("response_id=resp_fake");
    expect(memory.readStderr()).toContain("total_tokens=5");
    expect(memory.readStderr()).toContain("elapsed_ms=42");
  });

  it("does not create a client when the API key is missing", async () => {
    const createChatClient = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({ createChatClient, env: {} }),
    );
    expect(exitCode).toBe(4);
    expect(createChatClient).not.toHaveBeenCalled();
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe("OPENAI_API_KEY is not configured\n");
  });

  it("does not create a client for an invalid timeout", async () => {
    const createChatClient = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello", "--timeout-ms", "999"],
      memory.io,
      createRuntime({ createChatClient }),
    );
    expect(exitCode).toBe(2);
    expect(createChatClient).not.toHaveBeenCalled();
    expect(memory.readStderr()).toContain("usage/config error");
  });

  it("maps authentication failure without leaking the API key", async () => {
    const secret = "sk-cli-secret-value";
    const client = new FakeChatClient(
      rejected(
        mapOpenAIError({
          code: "invalid_api_key",
          message: `invalid ${secret}`,
          requestID: "req_auth",
          status: 401,
        }),
      ),
    );
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({
        createChatClient: () => client,
        env: { OPENAI_API_KEY: secret },
      }),
    );
    expect(exitCode).toBe(4);
    expect(memory.readStderr()).toContain("authentication failed");
    expect(memory.readStderr()).not.toContain(secret);
    expect(memory.readStdout()).toBe("");
  });

  it("classifies rate limits as provider failures without retrying", async () => {
    const client = new FakeChatClient(
      rejected(
        mapOpenAIError({
          code: "rate_limit_exceeded",
          requestID: "req_rate",
          status: 429,
        }),
      ),
    );
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({ createChatClient: () => client }),
    );
    expect(exitCode).toBe(5);
    expect(client.calls).toHaveLength(1);
    expect(memory.readStderr()).toContain("provider request failed");
    expect(memory.readStderr()).toContain("rate_limit");
    expect(memory.readStdout()).toBe("");
  });

  it("aborts the request and returns 6 on timeout", async () => {
    const client = new FakeChatClient(waitForAbort());
    const clearTimer = vi.fn();
    const stopListening = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello", "--timeout-ms", "1000"],
      memory.io,
      createRuntime({
        clearTimer,
        createChatClient: () => client,
        onCancel: () => stopListening,
        setTimer: (listener) => {
          queueMicrotask(listener);
          return "timeout-handle";
        },
      }),
    );
    expect(exitCode).toBe(6);
    expect(client.calls[0]?.signal.aborted).toBe(true);
    expect(clearTimer).toHaveBeenCalledWith("timeout-handle");
    expect(stopListening).toHaveBeenCalledOnce();
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe("request timed out after 1000 ms\n");
  });

  it("aborts the request and returns 130 on Ctrl+C", async () => {
    const client = new FakeChatClient(waitForAbort());
    const clearTimer = vi.fn();
    const stopListening = vi.fn();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "hello"],
      memory.io,
      createRuntime({
        clearTimer,
        createChatClient: () => client,
        onCancel: (listener) => {
          queueMicrotask(listener);
          return stopListening;
        },
        setTimer: () => "timeout-handle",
      }),
    );
    expect(exitCode).toBe(130);
    expect(client.calls[0]?.signal.aborted).toBe(true);
    expect(clearTimer).toHaveBeenCalledWith("timeout-handle");
    expect(stopListening).toHaveBeenCalledOnce();
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe("Cancelled\n");
  });
});
