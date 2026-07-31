import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { ModelBackend, ModelTurnRequest } from "../../src/model/model-backend.js";
import {
  QUALIFICATION_SEQUENCE_COMPLETE,
} from "../../src/model/model-qualification-suite.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeStreamBehavior,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const roots: string[] = [];

async function temporaryState(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase16e-cli-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function passingBehavior(): FakeStreamBehavior {
  let request = 0;
  let nonce = "";
  return async function* (input, signal) {
    request += 1;
    if (input.input.kind === "user_prompt") {
      nonce = /nonce "([A-Za-z0-9._-]+)"/u.exec(input.input.text)?.[1] ?? nonce;
    }
    if (request === 1) {
      yield {
        call: {
          argumentsJson: JSON.stringify({ nonce }),
          callId: "echo-1",
          name: "qualification_echo",
        },
        type: "tool_call",
      };
    } else if (request === 2) {
      yield { delta: "BORN_QUALIFICATION_OK", type: "text_delta" };
    } else if (request === 3 || request === 4) {
      yield {
        call: {
          argumentsJson: JSON.stringify({ index: request - 2, nonce }),
          callId: `step-${String(request - 2)}`,
          name: "qualification_step",
        },
        type: "tool_call",
      };
    } else if (request === 5) {
      yield { delta: QUALIFICATION_SEQUENCE_COMPLETE, type: "text_delta" };
    } else {
      yield { delta: "1", type: "text_delta" };
      if (!signal.aborted) throw new Error("qualification cancellation was not requested");
      yield {
        error: {
          category: "cancelled",
          code: "cancelled",
          message: "cancelled",
          retryable: false,
        },
        type: "failed",
      };
      return;
    }
    yield {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    yield { continuation: new FakeContinuation(), type: "turn_completed" };
  };
}

function failingBehavior(): FakeStreamBehavior {
  return async function* (input, signal) {
    if (
      input.input.kind === "user_prompt" &&
      input.input.text.includes("qualification_echo")
    ) {
      yield {
        call: {
          argumentsJson: '{"nonce":"wrong","extra":true}',
          callId: "bad-echo",
          name: "qualification_echo",
        },
        type: "tool_call",
      };
    } else if (
      input.input.kind === "user_prompt" &&
      input.input.text.includes("qualification_step")
    ) {
      yield { delta: "wrong sequence", type: "text_delta" };
    } else {
      yield { delta: "1", type: "text_delta" };
      if (signal.aborted) return;
    }
    yield {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    yield { continuation: new FakeContinuation(), type: "turn_completed" };
  };
}

function piBackend(behavior: FakeStreamBehavior): ModelBackend {
  const delegate = new FakeStreamingChatClient(behavior, {
    model: "qwen3:1.7b",
    provider: "ollama",
  });
  return {
    capabilities: delegate.capabilities,
    contextCapacity: delegate.contextCapacity,
    identity: {
      adapter: "pi-ai",
      adapterVersion: "0.80.7",
      configFingerprint: "0".repeat(64),
      model: "qwen3:1.7b",
      provider: "ollama",
    },
    resume: delegate.resume,
    runTurn: (request: ModelTurnRequest, signal: AbortSignal) =>
      delegate.runTurn(request, signal),
  };
}

describe("Phase 16E models qualification CLI", () => {
  it("qualifies, shows, and explicitly removes exact local evidence", async () => {
    const state = await temporaryState();
    const createModelBackend = vi.fn(() => piBackend(passingBehavior()));
    const refreshLocalModelCatalog = vi.fn(async () => [
      { digest: "a".repeat(64), tag: "qwen3:1.7b" },
    ]);
    const runtime = createRuntime({
      createModelBackend,
      env: { LOCALAPPDATA: state },
      refreshLocalModelCatalog,
    });

    const qualify = createMemoryIO();
    const qualifyExit = await runCli(
      ["models", "qualify", "--provider", "ollama", "--model", "qwen3:1.7b", "--json"],
      qualify.io,
      runtime,
    );
    expect({ exit: qualifyExit, stderr: qualify.readStderr() }).toEqual({
      exit: 0,
      stderr: "",
    });
    const qualified = JSON.parse(qualify.readStdout()) as {
      record: { evidenceSha256: string; identitySha256: string; qualifiedModes: string[] };
    };
    expect(qualified.record.qualifiedModes).toEqual(["plan", "build"]);
    expect(createModelBackend).toHaveBeenCalledOnce();
    expect(refreshLocalModelCatalog).toHaveBeenCalledOnce();

    createModelBackend.mockImplementationOnce(() => piBackend(failingBehavior()));
    const failed = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualify", "--provider", "ollama", "--model", "qwen3:1.7b"],
        failed.io,
        runtime,
      ),
    ).toBe(2);

    const preserved = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualification", "show", "--provider", "ollama", "--model", "qwen3:1.7b", "--json"],
        preserved.io,
        runtime,
      ),
    ).toBe(0);
    expect((JSON.parse(preserved.readStdout()) as typeof qualified).record.evidenceSha256).toBe(
      qualified.record.evidenceSha256,
    );

    const show = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualification", "show", "--provider", "ollama", "--model", "qwen3:1.7b", "--json"],
        show.io,
        runtime,
      ),
    ).toBe(0);
    expect((JSON.parse(show.readStdout()) as typeof qualified).record.evidenceSha256).toBe(
      qualified.record.evidenceSha256,
    );
    expect(createModelBackend).toHaveBeenCalledTimes(2);

    const deniedRemove = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualification", "remove", "--identity-sha256", qualified.record.identitySha256],
        deniedRemove.io,
        runtime,
      ),
    ).toBe(2);

    const remove = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualification", "remove", "--identity-sha256", qualified.record.identitySha256, "--yes", "--json"],
        remove.io,
        runtime,
      ),
    ).toBe(0);
    expect(JSON.parse(remove.readStdout())).toMatchObject({ removed: true });

    const missing = createMemoryIO();
    expect(
      await runCli(
        ["models", "qualification", "show", "--provider", "ollama", "--model", "qwen3:1.7b"],
        missing.io,
        runtime,
      ),
    ).toBe(2);
  });
});
