import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import {
  OpenAIStreamingChatClient,
  type OpenAIStreamingSdkFactory,
} from "../../src/providers/openai/openai-streaming-chat-client.js";
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
        createModelTurnClient: () =>
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
    const factory: OpenAIStreamingSdkFactory = () => ({
      responses: {
        create: async () => {
          throw {
            cause: {
              body: `request body ${secret}`,
              headers: { authorization: `Bearer ${secret}` },
            },
            headers: { authorization: `Bearer ${secret}` },
            message: `provider exploded ${secret}`,
            requestID: "req_secret_test",
            stack: `stack ${secret}`,
            status: 500,
          };
        },
      },
    });
    const exitCode = await runCli(
      ["chat", "ordinary prompt"],
      memory.io,
      createRuntime({
        createSessionWriter: JsonlSessionWriter.create,
        createModelTurnClient: () =>
          new OpenAIStreamingChatClient({ apiKey: secret }, factory),
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
