import { describe, expect, it, vi } from "vitest";

import { ChatClientError } from "../../src/chat/errors.js";
import {
  normalizeAssistantText,
  runChat,
} from "../../src/chat/run-chat.js";
import { createRuntime } from "../helpers.js";
import {
  createDeferredBehavior,
  emptyResponse,
  FakeChatClient,
  fixedResponse,
  rejected,
} from "../fakes/fake-chat-client.js";

const options = {
  model: undefined,
  prompt: "hello",
  provider: undefined,
  timeoutMs: undefined,
  verbose: false,
};

describe("runChat", () => {
  it("normalizes output to exactly one trailing newline", () => {
    expect(normalizeAssistantText("hello")).toBe("hello\n");
    expect(normalizeAssistantText("hello\n\n  ")).toBe("hello\n");
  });

  it("supports a response delayed until the test releases it", async () => {
    const deferred = createDeferredBehavior();
    const client = new FakeChatClient(deferred.behavior);
    const promise = runChat(
      options,
      createRuntime({ createChatClient: () => client }),
    );
    await vi.waitFor(() => expect(client.calls).toHaveLength(1));
    deferred.release("done");
    await expect(promise).resolves.toMatchObject({
      ok: true,
      response: { text: "done" },
    });
  });

  it("creates an Ollama client without requiring an OpenAI API key", async () => {
    let configuration: unknown;
    const result = await runChat(
      { ...options, provider: "ollama" },
      createRuntime({
        createChatClient: (selected) => {
          configuration = selected;
          return new FakeChatClient(fixedResponse());
        },
        env: {},
      }),
    );

    expect(result).toMatchObject({ ok: true, provider: "ollama" });
    expect(configuration).toEqual({
      baseURL: "http://localhost:11434/v1",
      provider: "ollama",
    });
  });

  it("clears the timeout and cancellation listener after success", async () => {
    const clearTimer = vi.fn();
    const stopListening = vi.fn();
    const timer = Symbol("timer");
    const result = await runChat(
      options,
      createRuntime({
        clearTimer,
        createChatClient: () => new FakeChatClient(fixedResponse()),
        onCancel: () => stopListening,
        setTimer: () => timer,
      }),
    );
    expect(result.ok).toBe(true);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    expect(stopListening).toHaveBeenCalledOnce();
  });

  it("maps client failures without leaking unknown error messages", async () => {
    const secret = "sk-test-secret-value";
    const result = await runChat(
      options,
      createRuntime({
        createChatClient: () =>
          new FakeChatClient(rejected(new Error(`network failed ${secret}`))),
        env: { OPENAI_API_KEY: secret },
      }),
    );
    expect(result).toEqual({
      error: "internal protocol error",
      exitCode: 1,
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("maps typed authentication, provider, and protocol errors", async () => {
    const cases = [
      [new ChatClientError("authentication", { status: 401 }), 4],
      [new ChatClientError("provider", { category: "rate_limit", status: 429 }), 5],
      [new ChatClientError("protocol"), 1],
    ] as const;

    for (const [error, exitCode] of cases) {
      const result = await runChat(
        options,
        createRuntime({
          createChatClient: () => new FakeChatClient(rejected(error)),
        }),
      );
      expect(result).toMatchObject({ exitCode, ok: false });
    }
  });

  it("treats an empty successful response as a protocol error", async () => {
    const result = await runChat(
      options,
      createRuntime({
        createChatClient: () => new FakeChatClient(emptyResponse()),
      }),
    );
    expect(result).toEqual({
      error: "internal protocol error",
      exitCode: 1,
      ok: false,
    });
  });
});
