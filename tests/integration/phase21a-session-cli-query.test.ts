import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { DefaultApplicationQueryService } from "../../src/control-plane/application-query-service.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function productRuntime(input: Readonly<{ readonly cwd: string; readonly stateRoot: string }>) {
  return createRuntime({
    controlPlaneStateRoot: input.stateRoot,
    createModelBackend: (request) => new FakeStreamingChatClient(fixedStream(["typed session answer"]), {
      model: request.model,
      provider: request.provider as "anthropic" | "ollama" | "openai",
    }),
    createSessionWriter: V2SessionWriter.create,
    cwd: input.cwd,
    env: {},
    randomUUID,
  });
}

async function materializedSession(cwd: string, stateRoot: string): Promise<string> {
  const memory = createMemoryIO();
  expect(await runCli([
    "agent",
    "list and show through fixed queries",
    "--task-profile",
    "read-only",
    "--provider",
    "ollama",
    "--model",
    "qwen3:1.7b",
  ], memory.io, productRuntime({ cwd, stateRoot })), memory.readStderr()).toBe(0);
  const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find((name) => name.endsWith(".jsonl"));
  if (file === undefined) throw new Error("missing Phase 21A session fixture");
  return file.slice(0, -".jsonl".length);
}

describe("Phase 21A sessions CLI named-query surface", () => {
  it("renders list and show from fixed application queries", async () => {
    const cwd = await directory("bornagent-phase21a-session-cli-repo-");
    const stateRoot = await directory("bornagent-phase21a-session-cli-state-");
    const sessionId = await materializedSession(cwd, stateRoot);
    const queryKinds: string[] = [];
    const original = DefaultApplicationQueryService.prototype.query;
    vi.spyOn(DefaultApplicationQueryService.prototype, "query").mockImplementation(async function (
      this: DefaultApplicationQueryService,
      context,
      request,
    ) {
      queryKinds.push(request.queryKind);
      return original.call(this, context, request);
    });

    const listed = createMemoryIO();
    expect(await runCli(
      ["sessions", "list", "--json"],
      listed.io,
      productRuntime({ cwd, stateRoot }),
    ), listed.readStderr()).toBe(0);
    expect(JSON.parse(listed.readStdout())).toMatchObject({
      entries: [{ catalogState: "registered", sessionId, status: "completed" }],
      schemaVersion: 1,
    });

    const shown = createMemoryIO();
    expect(await runCli(
      ["sessions", "show", sessionId],
      shown.io,
      productRuntime({ cwd, stateRoot }),
    ), shown.readStderr()).toBe(0);
    expect(shown.readStdout()).toContain(`Session: ${sessionId}`);
    expect(shown.readStdout()).toContain("User: list and show through fixed queries");
    expect(shown.readStdout()).toContain("Assistant: typed session answer");
    expect(queryKinds).toContain("session.list");
    expect(queryKinds).toContain("session.view");
  }, 30_000);

  it("pages redacted display events at one exact ledger version", async () => {
    const cwd = await directory("bornagent-phase21a-session-events-repo-");
    const stateRoot = await directory("bornagent-phase21a-session-events-state-");
    const sessionId = await materializedSession(cwd, stateRoot);
    const queryKinds: string[] = [];
    const original = DefaultApplicationQueryService.prototype.query;
    vi.spyOn(DefaultApplicationQueryService.prototype, "query").mockImplementation(async function (
      this: DefaultApplicationQueryService,
      context,
      request,
    ) {
      queryKinds.push(request.queryKind);
      return original.call(this, context, request);
    });

    const shown = createMemoryIO();
    expect(await runCli(
      ["sessions", "show", sessionId, "--events", "--json"],
      shown.io,
      productRuntime({ cwd, stateRoot }),
    ), shown.readStderr()).toBe(0);
    const document = JSON.parse(shown.readStdout()) as {
      readonly events: readonly Readonly<{ readonly data: unknown; readonly sessionSeq: number }>[];
      readonly sessionId: string;
    };
    expect(document.sessionId).toBe(sessionId);
    expect(document.events.length).toBeGreaterThan(0);
    expect(document.events.map((event) => event.sessionSeq)).toEqual(
      document.events.map((_event, index) => index + 1),
    );
    expect(shown.readStdout()).not.toContain("application_commit");
    expect(queryKinds[0]).toBe("session.events_page");
    expect(queryKinds.at(-1)).toBe("session.view");
  }, 30_000);
});
