import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactSessionRuntime } from "../../src/artifacts/artifact-session-runtime.js";
import { executeSessionsShow } from "../../src/commands/sessions.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ToolDefinition } from "../../src/tools/tool-types.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  testBackendSelected,
  testCompleteModelUsage,
} from "../phase8-event-helpers.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000081";
const RUN_ID = "20000000-0000-4000-8000-000000000081";
const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase10-session-"));
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

describe("Phase 10 artifact production session integration", () => {
  it("persists before authority and replays exact model observation plus artifact facts", async () => {
    const workspace = await temporaryWorkspace();
    let uuid = 100;
    const nextUuid = () =>
      `30000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;
    const writer = await V2SessionWriter.createNew(workspace, SESSION_ID, {
      createEventId: nextUuid,
      timestamp: () => "2026-07-17T00:00:00.000Z",
    });
    const publisher = new EventPublisher({
      randomUUID: nextUuid,
      renderer: { render: () => undefined },
      runId: RUN_ID,
      sessionId: SESSION_ID,
      timestamp: () => "2026-07-17T00:00:00.000Z",
      writer,
    });
    await publisher.publish({
      data: {
        command: "agent",
        command_approval: "deny",
        command_timeout_ms: 120_000,
        completion_policy: "verified",
        edit_approval: "deny",
        input: { role: "user", text: "inspect a large local result" },
        max_command_output_bytes: 1_114_112,
        max_duration_ms: 60_000,
        max_steps: 2,
        max_tokens: 4_000,
        max_tool_output_bytes: 262_144,
        model: "qwen3:1.7b",
        provider: "ollama",
        report_format: "text",
        request_timeout_ms: 30_000,
        require_verification: "auto",
        task_profile: "read-only",
        tools: ["read_artifact", "search"],
        tools_enabled: true,
        workspace,
      },
      type: "run.started",
    });
    await publisher.publish(testBackendSelected("ollama", "qwen3:1.7b"));
    await publisher.publish({
      data: {
        input_kind: "user_task",
        max_steps: 2,
        remaining_duration_ms: 60_000,
        remaining_tokens: 4_000,
        remaining_tool_output_bytes: 262_144,
        step: 1,
      },
      type: "agent.step.started",
    });
    await publisher.publish(testCompleteModelUsage("ollama", 1));
    await publisher.publish({
      data: {
        duration_ms: 1,
        outcome: "tool_call",
        step: 1,
        text_chars: 0,
        tool_call_id: "large-call",
      },
      type: "agent.step.completed",
    });
    const requested = await publisher.publish({
      data: {
        arguments_json: '{"query":"phase10"}',
        call_id: "large-call",
        step: 1,
        tool_name: "search",
      },
      type: "tool.call.requested",
    });

    const artifacts = await ArtifactSessionRuntime.create({
      budgets: {
        perArtifactBytes: 65_536,
        perRunBytes: 131_072,
        perSessionBytes: 262_144,
      },
      eventAppender: writer,
      events: writer.events,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspace,
    });
    const definition: ToolDefinition<{ readonly query: string }> = {
      capability: "read",
      description: "Return a deterministic oversized local observation.",
      execute: async () => ({
        ok: true,
        truncated: false,
        value: { content: "x".repeat(80_000) },
      }),
      inputSchema: z.object({ query: z.string() }).strict(),
      name: "search",
    };
    const registry = new ToolRegistry(
      [definition as ToolDefinition<unknown>],
      [],
      undefined,
      artifacts,
    );
    const execution = await registry.execute(
      {
        argumentsJson: '{"query":"phase10"}',
        callId: "large-call",
        name: "search",
        originEventId: requested.event_id,
        step: 1,
      },
      new AbortController().signal,
    );
    const completed = await publisher.publish({
      data: {
        call_id: "large-call",
        duration_ms: 2,
        output: execution.output,
        status: "success",
        step: 1,
        tool_name: "search",
        truncated: execution.truncated,
      },
      type: "tool.call.completed",
    });
    if (completed.type !== "tool.call.completed") {
      throw new TypeError("publisher returned the wrong completed event type");
    }
    await publisher.publish({
      data: {
        category: "internal",
        code: "fixture_complete",
        duration_ms: 3,
        message: "fixture stopped after proving artifact persistence",
        output_chars: 0,
        retryable: false,
        steps: 1,
        tool_calls: 1,
      },
      type: "run.failed",
    });

    expect(writer.events.map(({ type }) => type)).toContain("artifact.stored");
    expect(writer.events.map(({ type }) => type)).toContain(
      "artifact.capture.truncated",
    );
    expect(completed.data.output).toBe(execution.output);
    expect(Buffer.byteLength(completed.data.output, "utf8")).toBe(65_536);
    expect(completed.data.truncated).toBe(true);
    const storedIndex = writer.events.findIndex(
      ({ type }) => type === "artifact.stored",
    );
    const completedIndex = writer.events.findIndex(
      ({ type }) => type === "tool.call.completed",
    );
    expect(storedIndex).toBeGreaterThan(-1);
    expect(storedIndex).toBeLessThan(completedIndex);

    const projection = reconstructMultiRunSession(writer.events);
    expect(projection.artifacts).toMatchObject({
      storedReferenceCount: 1,
      truncatedCaptureEventCount: 1,
      uniqueObjectBytes: 65_536,
    });
    const reference = projection.artifacts.references[0]!;
    await expect(
      artifacts.reader.read({
        artifactId: reference.artifactId,
        maxBytes: 128,
        offsetBytes: 0,
      }),
    ).resolves.toMatchObject({ contentBytes: 128 });

    await writer.close();
    const memory = createMemoryIO();
    const exitCode = await executeSessionsShow(
      { events: false, json: true, sessionId: SESSION_ID },
      createRuntime({ cwd: workspace, env: {} }),
      memory.io,
    );
    const shown = JSON.parse(memory.readStdout()) as {
      readonly artifacts: {
        readonly storedReferences: number;
        readonly truncatedCaptures: number;
        readonly uniqueObjects: number;
      };
    };
    expect(exitCode).toBe(0);
    expect(shown.artifacts).toMatchObject({
      storedReferences: 1,
      truncatedCaptures: 1,
      uniqueObjects: 1,
    });
  });
});
