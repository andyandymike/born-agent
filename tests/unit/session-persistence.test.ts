import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventPublisher } from "../../src/events/event-publisher.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { JsonlSessionWriter } from "../../src/sessions/jsonl-session-writer.js";
import { readSession } from "../../src/sessions/read-session.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase2-"));
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

describe("JSONL session persistence", () => {
  it("writes UTF-8 JSONL and reconstructs prompt, deltas, usage, and terminal", async () => {
    const workspace = await temporaryWorkspace();
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const writer = await JsonlSessionWriter.create(workspace, sessionId);
    let eventId = 2;
    const publisher = new EventPublisher({
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++eventId).padStart(12, "0")}`,
      renderer: { render: () => undefined },
      runId: "00000000-0000-4000-8000-000000000002",
      sessionId,
      timestamp: () => "2026-07-16T00:00:00.000Z",
      writer,
    });

    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: "原样保存这个提示" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 120_000,
        workspace,
      },
      type: "run.started",
    });
    await publisher.publish({ data: { delta: "你" }, type: "text.delta" });
    await publisher.publish({ data: { delta: "好" }, type: "text.delta" });
    await publisher.publish({
      data: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      type: "usage",
    });
    await publisher.publish({
      data: { duration_ms: 25, output_chars: 2 },
      type: "run.completed",
    });
    await writer.close();

    expect(writer.path).toBe(
      join(workspace, ".bornagent", "sessions", `${sessionId}.jsonl`),
    );
    expect(writer.path).not.toContain("原样保存");
    const raw = await readFile(writer.path);
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    expect(raw.toString("utf8").endsWith("\n")).toBe(true);
    const events = await readSession(writer.path);
    expect(reconstructSession(events)).toMatchObject({
      output: "你好",
      started: { input: { text: "原样保存这个提示" } },
      terminal: { type: "run.completed" },
      usage: { total_tokens: 6 },
    });
  });

  it("reports line numbers and rejects unknown versions or truncated tails", async () => {
    const workspace = await temporaryWorkspace();
    const invalid = join(workspace, "invalid.jsonl");
    const unknown = join(workspace, "unknown.jsonl");
    const truncated = join(workspace, "truncated.jsonl");
    await writeFile(invalid, "{}\nnot-json\n", "utf8");
    await writeFile(unknown, '{"schema_version":2}\n', "utf8");
    await writeFile(truncated, "{}", "utf8");

    await expect(readSession(invalid)).rejects.toThrow("line 1");
    await expect(readSession(unknown)).rejects.toThrow(
      "unsupported schema_version 2 at line 1",
    );
    await expect(readSession(truncated)).rejects.toThrow("complete JSONL line");
  });

  it("rejects broken sequence, missing start or terminal, and output mismatch", () => {
    const common = {
      run_id: "00000000-0000-4000-8000-000000000002",
      schema_version: 1 as const,
      session_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const valid: RunEvent[] = [
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000003",
        seq: 1,
        data: {
          command: "chat",
          input: { role: "user", text: "hello" },
          model: "gpt-test",
          provider: "openai",
          timeout_ms: 120_000,
          workspace: "D:\\Code\\bornagent",
        },
        type: "run.started",
      },
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000004",
        seq: 2,
        data: { delta: "hi" },
        type: "text.delta",
      },
      {
        ...common,
        event_id: "00000000-0000-4000-8000-000000000005",
        seq: 3,
        data: { duration_ms: 10, output_chars: 2 },
        type: "run.completed",
      },
    ];

    expect(() => reconstructSession(valid)).not.toThrow();
    expect(() =>
      reconstructSession([
        valid[0] as RunEvent,
        { ...(valid[1] as RunEvent), seq: 3 },
        valid[2] as RunEvent,
      ]),
    ).toThrow("expected seq 2");
    expect(() => reconstructSession(valid.slice(1))).toThrow("run.started");
    expect(() => reconstructSession(valid.slice(0, 2))).toThrow("terminal");
    expect(() =>
      reconstructSession([
        valid[0] as RunEvent,
        valid[1] as RunEvent,
        {
          ...(valid[2] as Extract<RunEvent, { type: "run.completed" }>),
          data: { duration_ms: 10, output_chars: 99 },
        },
      ]),
    ).toThrow("output_chars");
  });

  it("reconstructs paired tools and allows interrupted tools only for failure", () => {
    const common = {
      run_id: "00000000-0000-4000-8000-000000000002",
      schema_version: 1 as const,
      session_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const started: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000003",
      seq: 1,
      data: {
        command: "chat",
        input: { role: "user", text: "inspect" },
        model: "gpt-test",
        provider: "openai",
        timeout_ms: 120_000,
        workspace: "D:\\Code\\bornagent",
      },
      type: "run.started",
    };
    const requested: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000004",
      seq: 2,
      data: {
        arguments_json: "{}",
        call_id: "call_1",
        step: 1,
        tool_name: "read_file",
      },
      type: "tool.call.requested",
    };
    const completed: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000005",
      seq: 3,
      data: {
        call_id: "call_1",
        duration_ms: 1,
        output: '{"ok":true}',
        status: "success",
        step: 1,
        tool_name: "read_file",
        truncated: false,
      },
      type: "tool.call.completed",
    };
    const succeeded: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000006",
      seq: 4,
      data: { duration_ms: 2, output_chars: 0, tool_calls: 1 },
      type: "run.completed",
    };
    expect(reconstructSession([started, requested, completed, succeeded])).toMatchObject({
      toolCalls: [
        {
          completed: { call_id: "call_1" },
          interrupted: false,
          requested: { call_id: "call_1" },
        },
      ],
    });

    const failed: RunEvent = {
      ...common,
      event_id: "00000000-0000-4000-8000-000000000007",
      seq: 3,
      data: {
        category: "internal",
        code: "internal_error",
        duration_ms: 2,
        message: "failed",
        retryable: false,
      },
      type: "run.failed",
    };
    expect(reconstructSession([started, requested, failed])).toMatchObject({
      toolCalls: [{ interrupted: true }],
    });
    expect(() =>
      reconstructSession([
        started,
        requested,
        { ...succeeded, seq: 3, data: { ...succeeded.data, tool_calls: 0 } },
      ]),
    ).toThrow("interrupted");
  });
});
