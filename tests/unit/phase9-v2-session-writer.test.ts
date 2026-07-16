import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import { runCli } from "../../src/cli/run-cli.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase9-v2-"));
  temporaryDirectories.push(path);
  return path;
}

function publisher(
  writer: V2SessionWriter,
  sessionId: string,
  runId: string,
): EventPublisher {
  return new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId,
    sessionId,
    timestamp: () => new Date().toISOString(),
    writer,
  });
}

async function startAndSelect(
  events: EventPublisher,
  root: string,
  resume?: { readonly mode: "canonical_degraded"; readonly sourceRunId: string },
): Promise<void> {
  await events.publish({
    data: {
      command: "chat",
      input: { role: "user", text: resume === undefined ? "first" : "follow up" },
      model: "qwen3:1.7b",
      provider: "ollama",
      ...(resume === undefined
        ? {}
        : {
            resume_mode: resume.mode,
            resume_of_run_id: resume.sourceRunId,
            workspace_fingerprint: "a".repeat(64),
          }),
      timeout_ms: 1_000,
      workspace: root,
    },
    type: "run.started",
  });
  await events.publish({
    data: {
      adapter: "pi-ai",
      adapter_version: "0.80.7",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "best_effort",
        usage: "complete",
      },
      config_fingerprint: "b".repeat(64),
      model: "qwen3:1.7b",
      provider: "ollama",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 9 v2 session writer", () => {
  it("records a canonical boundary before a production-style CLI terminal", async () => {
    const root = await workspace();
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "chat",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--no-tools",
        "local fake prompt",
      ],
      memory.io,
      createRuntime({
        createSessionWriter: V2SessionWriter.create,
        cwd: root,
        env: {},
      }),
    );

    const sessions = join(root, ".bornagent", "sessions");
    const names = await readdir(sessions);
    expect(names.filter((name) => name.endsWith(".lock"))).toEqual([]);
    const sessionPath = join(
      sessions,
      names.find((name) => name.endsWith(".jsonl")) as string,
    );
    expect(
      exitCode,
      `${memory.readStderr()}\n${await readFile(sessionPath, "utf8")}`,
    ).toBe(0);
    const events = await readStoredSession(sessionPath);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "backend.selected",
      "text.delta",
      "backend.canonical_boundary.created",
      "usage",
      "run.completed",
    ]);
  });

  it("durably interleaves run and session events while keeping both sequences continuous", async () => {
    const root = await workspace();
    const sessionId = randomUUID();
    const firstRunId = randomUUID();
    const writer = await V2SessionWriter.createNew(root, sessionId);
    const first = publisher(writer, sessionId, firstRunId);
    await startAndSelect(first, root);
    await writer.appendRunEvent(firstRunId, "backend.canonical_boundary.created", {
      pending_call: false,
      transcript_sha256: "c".repeat(64),
      turn: 1,
    });
    await first.publish({
      data: { duration_ms: 1, output_chars: 0 },
      type: "run.completed",
    });
    await writer.close();

    const resumed = await V2SessionWriter.openExisting(root, sessionId);
    await resumed.appendSessionEvent("session.resume.requested", {
      message: "follow up",
      requested_mode: "canonical_degraded",
      source_run_id: firstRunId,
    });
    const secondRunId = randomUUID();
    const second = publisher(resumed, sessionId, secondRunId);
    await startAndSelect(second, root, {
      mode: "canonical_degraded",
      sourceRunId: firstRunId,
    });
    await second.publish({
      data: { duration_ms: 1, output_chars: 0 },
      type: "run.completed",
    });
    await resumed.close();

    const raw = (await readFile(resumed.path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(raw.map((event) => event.session_seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      raw.filter((event) => event.run_id === firstRunId).map((event) => event.run_seq),
    ).toEqual([1, 2, 3, 4]);
    expect(
      raw.filter((event) => event.run_id === secondRunId).map((event) => event.run_seq),
    ).toEqual([1, 2, 3]);
    expect(raw.every((event) => event.schema_version === 2)).toBe(true);

    const projection = reconstructMultiRunSession(
      await readStoredSession(resumed.path),
    );
    expect(projection.runs).toHaveLength(2);
    expect(projection.lastRun).toMatchObject({
      resumeMode: "canonical_degraded",
      resumeOfRunId: firstRunId,
      runId: secondRunId,
      status: "completed",
    });
  });
});
