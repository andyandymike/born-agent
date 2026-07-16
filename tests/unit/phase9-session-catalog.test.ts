import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import type { SessionCatalogError } from "../../src/sessions/session-catalog.js";
import { SessionLock } from "../../src/sessions/session-lock.js";
import {
  SessionPathError,
  SessionPathPolicy,
} from "../../src/sessions/session-path-policy.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const SESSION_ID = "00000000-0000-4000-8000-000000009101";
const RUN_ID = "00000000-0000-4000-8000-000000009102";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase9-catalog-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function writeCompletedSession(workspace: string): Promise<string> {
  const writer = await V2SessionWriter.createNew(workspace, SESSION_ID);
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => "2026-07-17T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "catalog fixture" },
      model: "qwen3:1.7b",
      provider: "ollama",
      timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
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
      config_fingerprint: "a".repeat(64),
      model: "qwen3:1.7b",
      provider: "ollama",
      resume_capability: "canonical_only",
    },
    type: "backend.selected",
  });
  await publisher.publish({ data: { delta: "done" }, type: "text.delta" });
  await publisher.publish({
    data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    type: "usage",
  });
  await publisher.publish({
    data: { duration_ms: 1, output_chars: 4 },
    type: "run.completed",
  });
  await writer.close();
  return writer.path;
}

describe("Phase 9 SessionCatalog stable snapshots", () => {
  it("uses canonical policy paths and releases its snapshot lock after show", async () => {
    const workspace = await temporaryWorkspace();
    const sessionPath = await writeCompletedSession(workspace);
    const catalog = new SessionCatalog(workspace);

    await expect(catalog.read(SESSION_ID)).resolves.toMatchObject({
      sessionId: SESSION_ID,
      status: "completed",
    });
    await expect(lstat(sessionPath.replace(/\.jsonl$/u, ".lock"))).rejects.toEqual(
      expect.objectContaining({ code: "ENOENT" }),
    );
    await expect(catalog.scan()).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          sessionId: SESSION_ID,
          status: "completed",
        }),
      ],
    });
  });

  it("refuses show and marks list when the sibling writer lock is active", async () => {
    const workspace = await temporaryWorkspace();
    await writeCompletedSession(workspace);
    const policy = await SessionPathPolicy.create(workspace);
    const writerLock = await SessionLock.acquire(policy, SESSION_ID);
    const catalog = new SessionCatalog(workspace);

    await expect(catalog.read(SESSION_ID)).rejects.toEqual(
      expect.objectContaining<Partial<SessionCatalogError>>({
        code: "active_session_writer",
      }),
    );
    const listed = await catalog.scan();
    expect(listed.entries).toEqual([
      expect.objectContaining({
        error: "session has an active or unresolved writer lock",
        sessionId: SESSION_ID,
        status: "invalid",
      }),
    ]);
    await writerLock.release();
  });

  it("rejects a parent junction instead of reading a linked session tree", async () => {
    const workspace = await temporaryWorkspace();
    const linked = join(workspace, "linked-agent-state");
    await mkdir(join(linked, "sessions"), { recursive: true });
    await symlink(linked, join(workspace, ".bornagent"), "junction");

    await expect(new SessionCatalog(workspace).scan()).rejects.toBeInstanceOf(
      SessionPathError,
    );
  });
});
