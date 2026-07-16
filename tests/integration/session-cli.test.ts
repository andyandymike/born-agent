import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { PiModelBackend } from "../../src/providers/pi/pi-model-backend.js";
import {
  ProductionPiRuntimePort,
  type PiRuntimeDriver,
} from "../../src/providers/pi/production-pi-runtime-port.js";
import { JsonlSessionWriter } from "../../src/sessions/jsonl-session-writer.js";
import { readSession } from "../../src/sessions/read-session.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  FakeStreamingChatClient,
  waitForAbort,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-cli-session-"));
  temporaryDirectories.push(path);
  return path;
}

async function onlySessionPath(path: string): Promise<string> {
  const directory = join(path, ".bornagent", "sessions");
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return join(directory, names[0] as string);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("real JSONL session CLI integration", () => {
  it("closes a cancelled session with a complete run.cancelled line", async () => {
    const cwd = await workspace();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["chat", "cancel me"],
      memory.io,
      createRuntime({
        createSessionWriter: JsonlSessionWriter.create,
        createModelBackend: () =>
          new FakeStreamingChatClient(waitForAbort()),
        cwd,
        onCancel: (listener) => {
          queueMicrotask(listener);
          return () => undefined;
        },
        setTimer: () => "timer",
      }),
    );

    expect(exitCode).toBe(130);
    expect(memory.readStderr()).toBe("Cancelled\n");
    const path = await onlySessionPath(cwd);
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const events = await readSession(path);
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(reconstructSession(events).terminal.type).toBe("run.cancelled");
  });

  it("never persists or prints secrets nested in an SDK failure", async () => {
    const cwd = await workspace();
    const secret = "sk-end-to-end-secret-value";
    const memory = createMemoryIO();
    const sdkFailure = Object.assign(
      new Error(`provider exploded ${secret}`),
      {
        cause: {
          body: `request body ${secret}`,
          headers: { authorization: `Bearer ${secret}` },
        },
        headers: { authorization: `Bearer ${secret}` },
        requestId: "req_secret_test",
        stack: `stack ${secret}`,
        status: 500,
      },
    );
    const driver: PiRuntimeDriver = {
      model: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.6-terra",
        input: ["text"],
        maxTokens: 1,
        name: "fixture",
        provider: "openai",
        reasoning: true,
      },
      stream: async function* () {
        yield await Promise.reject(sdkFailure);
      },
    };
    const exitCode = await runCli(
      ["chat", "ordinary prompt"],
      memory.io,
      createRuntime({
        createSessionWriter: JsonlSessionWriter.create,
        createModelBackend: () =>
          new PiModelBackend({
            capabilities: {
              cancellation: "abort_signal",
              reasoning: "opaque_passthrough",
              streaming: true,
              tools: "strict",
              usage: "complete",
            },
            identity: {
              adapter: "pi-ai",
              adapterVersion: "0.80.7",
              configFingerprint: "0".repeat(64),
              model: "gpt-5.6-terra",
              provider: "openai",
            },
            runtime: new ProductionPiRuntimePort(
              {
                credential: secret,
                model: "gpt-5.6-terra",
                provider: "openai",
              },
              async () => driver,
            ),
          }),
        cwd,
        env: { OPENAI_API_KEY: secret },
      }),
    );

    expect(exitCode).toBe(5);
    const path = await onlySessionPath(cwd);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("request body");
    expect(raw).not.toContain("stack");
    expect(memory.readStderr()).not.toContain(secret);
    expect(reconstructSession(await readSession(path))).toMatchObject({
      started: { input: { text: "ordinary prompt" } },
      terminal: {
        data: { provider_request_id: "req_secret_test" },
        type: "run.failed",
      },
    });
  });
});
