import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventPublisher } from "../../src/events/event-publisher.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

export const SESSION_ID = "16000000-0000-4000-8000-000000000001";
export const RUN_ID = "16000000-0000-4000-8000-000000000002";

export const temporaryDirectories: string[] = [];

export async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase16b-"));
  temporaryDirectories.push(path);
  return path;
}

export async function cleanupTemporaryWorkspaces(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
}

export async function writeLegacySession(workspace: string): Promise<void> {
  const writer = await V2SessionWriter.createNew(workspace, SESSION_ID);
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: RUN_ID,
    sessionId: SESSION_ID,
    timestamp: () => "2026-07-31T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "chat",
      input: { role: "user", text: "legacy task" },
      model: "fake-model",
      provider: "fake",
      timeout_ms: 1_000,
      workspace,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "deterministic-fake",
      adapter_version: "phase16b-test-v1",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "a".repeat(64),
      model: "fake-model",
      provider: "fake",
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
}

export function context(workspace: string) {
  let counter = 100;
  return {
    inputSurface: "cli" as const,
    now: () => "2026-07-31T00:00:00.000Z",
    randomUuid: () => {
      counter += 1;
      return `16000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
    sessionId: SESSION_ID,
    workspace,
  };
}

export const editablePlan = {
  items: [
    {
      acceptance: "The exact durable control-plane behavior is covered.",
      id: "control-plane",
      required: true,
      title: "Implement the control plane",
    },
  ],
  schema_version: 1 as const,
  title: "Phase 16B",
};
