import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  InMemorySessionWriter,
} from "../helpers.js";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase10-command-"));
  temporaryDirectories.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 10 production command boundary", () => {
  it("links frozen root AGENTS.md bytes to the real durable rules event id", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Always run the focused tests before reporting completion.\n",
      "utf8",
    );
    const backend = new FakeStreamingChatClient(fixedStream(["done"]), {
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "agent",
        "inspect the fixture",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--task-profile",
        "read-only",
      ],
      memory.io,
      createRuntime({
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd: workspace,
        env: {},
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(0);
    const sessionsDirectory = join(workspace, ".bornagent", "sessions");
    const sessionFile = (await readdir(sessionsDirectory)).find((name) =>
      name.endsWith(".jsonl"),
    );
    expect(sessionFile).toBeDefined();
    const events = await readStoredSession(
      join(sessionsDirectory, sessionFile ?? "missing.jsonl"),
    );
    const rules = events.find(
      (event) =>
        event.type === "repository.rules.loaded" &&
        event.data.state === "loaded",
    );
    expect(rules?.type).toBe("repository.rules.loaded");
    if (rules?.type !== "repository.rules.loaded" || rules.data.state !== "loaded") {
      throw new Error("missing loaded repository rules event");
    }
    const artifact = events.find(
      (event) =>
        event.type === "artifact.stored" &&
        event.data.origin_event_id === rules.eventId,
    );
    expect(artifact).toMatchObject({
      data: {
        artifact_id: rules.data.artifact_id,
        bytes: rules.data.bytes,
        media_type: "text/markdown; charset=utf-8",
        sha256: rules.data.content_sha256,
      },
      type: "artifact.stored",
    });
    expect(artifact?.sessionSeq).toBeLessThan(rules.sessionSeq);
    expect(backend.calls[0]?.request.canonicalContext?.text).toContain(
      rules.eventId,
    );
  });

  it("fails closed before a model call when a full writer lacks a required capability", async () => {
    const base = new InMemorySessionWriter("memory://incomplete-full-writer");
    const writer = {
      appendRunEvent: base.appendRunEvent.bind(base),
      close: base.close.bind(base),
      path: base.path,
      persistenceProfile: "phase10_full" as const,
      write: base.write.bind(base),
    };
    const backend = new FakeStreamingChatClient(fixedStream(["unreachable"]));
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["agent", "inspect", "--task-profile", "read-only"],
      memory.io,
      createRuntime({
        createModelBackend: () => backend,
        createSessionWriter: async () => writer,
      }),
    );

    expect(exitCode).toBe(1);
    expect(backend.calls).toHaveLength(0);
    expect(base.events.map(({ type }) => type)).toEqual([
      "run.started",
      "backend.selected",
      "run.failed",
    ]);
  });
});
