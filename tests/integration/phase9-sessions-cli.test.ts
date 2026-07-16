import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { runEventSchema } from "../../src/events/run-event-schema.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase9-cli-"));
  temporaryDirectories.push(path);
  return path;
}

async function sessionIdentity(workspace: string): Promise<{
  readonly id: string;
  readonly path: string;
}> {
  const directory = join(workspace, ".bornagent", "sessions");
  const file = (await readdir(directory)).find((name) => name.endsWith(".jsonl"));
  if (file === undefined) throw new Error("missing session fixture");
  return { id: file.slice(0, -".jsonl".length), path: join(directory, file) };
}

async function createPendingCommandSession(workspace: string): Promise<string> {
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const runId = "20000000-0000-4000-8000-000000000001";
  const writer = await V2SessionWriter.createNew(workspace, sessionId);
  let sequence = 0;
  const write = async (type: RunEvent["type"], data: unknown) => {
    sequence += 1;
    await writer.write(
      runEventSchema.parse({
        data,
        event_id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        run_id: runId,
        schema_version: 1,
        seq: sequence,
        session_id: sessionId,
        timestamp: "2026-07-17T00:00:00.000Z",
        type,
      }),
    );
  };
  await write("run.started", {
    command: "agent",
    input: { role: "user", text: "pending command fixture" },
    max_duration_ms: 300_000,
    max_steps: 8,
    max_tokens: 100_000,
    max_tool_output_bytes: 262_144,
    model: "qwen3:1.7b",
    provider: "ollama",
    request_timeout_ms: 120_000,
    task_profile: "read-only",
    workspace,
  });
  await write("backend.selected", {
    adapter: "deterministic-fake",
    adapter_version: "phase8-test-v1",
    capabilities: {
      cancellation: "abort_signal",
      reasoning: "opaque_passthrough",
      streaming: true,
      tools: "strict",
      usage: "complete",
    },
    config_fingerprint: "0".repeat(64),
    model: "qwen3:1.7b",
    provider: "ollama",
    resume_capability: "canonical_only",
  });
  await write("agent.step.started", {
    input_kind: "user_task",
    max_steps: 8,
    remaining_duration_ms: 300_000,
    remaining_tokens: 100_000,
    remaining_tool_output_bytes: 262_144,
    step: 1,
  });
  await write("model.usage", {
    cache_read_tokens: null,
    cache_write_tokens: null,
    completeness: "complete",
    input_tokens: 1,
    output_tokens: 1,
    provider: "ollama",
    step: 1,
    total_tokens: 2,
  });
  await write("agent.step.completed", {
    duration_ms: 1,
    outcome: "tool_call",
    step: 1,
    text_chars: 0,
    tool_call_id: "call-command",
  });
  await write("tool.call.requested", {
    arguments_json: "{}",
    call_id: "call-command",
    step: 1,
    tool_name: "run_command",
  });
  await write("permission.evaluated", {
    action_kind: "run_command",
    action_sha256: "a".repeat(64),
    call_id: "call-command",
    effect: "allow",
    policy_version: "phase9-test-v1",
    rule_id: "read-only-inspect",
    step: 1,
  });
  await write("command.execution.requested", {
    action_sha256: "a".repeat(64),
    call_id: "call-command",
    cwd: ".",
    executable: "node",
    execution_id: "40000000-0000-4000-8000-000000000001",
    executor: "local",
    purpose: "inspect",
    redacted_argv: ["node"],
    step: 1,
  });
  await writer.appendRunEvent(runId, "backend.canonical_boundary.created", {
    pending_call: true,
    transcript_sha256: "b".repeat(64),
    turn: 1,
  });
  await writer.close();
  return sessionId;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 9 sessions CLI", () => {
  it("validates list bounds before scanning", async () => {
    const runtime = createRuntime();
    const memory = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "list", "--limit", "0"],
        memory.io,
        runtime,
      ),
    ).toBe(2);
    expect(memory.readStderr()).toContain("1 to 200");
  });

  it("lists and replays a real v2 session without calling a model", async () => {
    const cwd = await createWorkspace();
    const createModelBackend = vi.fn(
      (request: { readonly model: string; readonly provider: string }) =>
        new FakeStreamingChatClient(fixedStream(["saved answer"]), {
          model: request.model,
          provider: request.provider as "anthropic" | "ollama" | "openai",
        }),
    );
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd,
      env: {},
    });
    const initial = createMemoryIO();
    expect(
      await runCli(
        [
          "agent",
          "remember the local fixture",
          "--task-profile",
          "read-only",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
        ],
        initial.io,
        runtime,
      ),
    ).toBe(0);
    expect(createModelBackend).toHaveBeenCalledOnce();
    const session = await sessionIdentity(cwd);

    const list = createMemoryIO();
    expect(await runCli(["sessions", "list"], list.io, runtime)).toBe(0);
    expect(list.readStdout()).toContain(session.id);
    expect(list.readStdout()).toContain("completed");
    expect(list.readStdout()).toContain("message_required");

    const show = createMemoryIO();
    expect(
      await runCli(["sessions", "show", session.id], show.io, runtime),
    ).toBe(0);
    expect(show.readStdout()).toContain(`Session: ${session.id}`);
    expect(show.readStdout()).toContain("User: remember the local fixture");
    expect(show.readStdout()).toContain("Assistant: saved answer");
    expect(createModelBackend).toHaveBeenCalledOnce();

    const json = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "show", session.id, "--events", "--json"],
        json.io,
        runtime,
      ),
    ).toBe(0);
    expect(JSON.parse(json.readStdout())).toMatchObject({
      sessionId: session.id,
      status: "completed",
    });

    const context = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "show", session.id, "--context", "--json"],
        context.io,
        runtime,
      ),
    ).toBe(0);
    expect(JSON.parse(context.readStdout())).toMatchObject({
      context: {
        plans: [
          {
            canonicalContextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            epoch: 0,
            estimatedInputTokens: expect.any(Number),
            protectedCategories: expect.arrayContaining([
              "system_policy",
              "user_instruction",
            ]),
            step: 1,
          },
        ],
        plansTruncated: false,
      },
      schemaVersion: 1,
      sessionId: session.id,
    });
    expect(context.readStdout()).not.toContain("saved answer");
    expect(createModelBackend).toHaveBeenCalledOnce();
  });

  it("requires explicit degradation before constructing a backend", async () => {
    const cwd = await createWorkspace();
    const createModelBackend = vi.fn(
      (request: { readonly model: string; readonly provider: string }) =>
        new FakeStreamingChatClient(fixedStream(), {
          model: request.model,
          provider: request.provider as "anthropic" | "ollama" | "openai",
        }),
    );
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd,
      env: {},
    });
    expect(
      await runCli(
        [
          "agent",
          "safe local task",
          "--task-profile",
          "read-only",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
        ],
        createMemoryIO().io,
        runtime,
      ),
    ).toBe(0);
    const session = await sessionIdentity(cwd);
    expect(createModelBackend).toHaveBeenCalledOnce();

    const denied = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "resume", session.id, "--message", "one more check"],
        denied.io,
        runtime,
      ),
    ).toBe(2);
    expect(denied.readStderr()).toContain("--allow-degraded-resume");
    expect(createModelBackend).toHaveBeenCalledOnce();
  });

  it("creates a new canonical-degraded run only after durable resume facts", async () => {
    const cwd = await createWorkspace();
    const createModelBackend = vi.fn(
      (request: { readonly model: string; readonly provider: string }) =>
        new FakeStreamingChatClient(fixedStream(["resumed answer"]), {
          model: request.model,
          provider: request.provider as "anthropic" | "ollama" | "openai",
        }),
    );
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd,
      env: {},
    });
    expect(
      await runCli(
        [
          "agent",
          "safe local task",
          "--task-profile",
          "read-only",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
        ],
        createMemoryIO().io,
        runtime,
      ),
    ).toBe(0);
    const stored = await sessionIdentity(cwd);
    const before = reconstructMultiRunSession(await readStoredSession(stored.path));

    const resumed = createMemoryIO();
    expect(
      await runCli(
        [
          "sessions",
          "resume",
          stored.id,
          "--message",
          "one more check",
          "--allow-degraded-resume",
        ],
        resumed.io,
        runtime,
      ),
    ).toBe(0);
    expect(resumed.readStdout()).toContain("Resume mode: canonical_degraded");
    expect(resumed.readStdout()).toContain("Pending effects: none");
    expect(createModelBackend).toHaveBeenCalledTimes(2);
    const resumedBackend = createModelBackend.mock.results[1]?.value;
    expect(resumedBackend?.calls[0]?.request.input).toMatchObject({
      kind: "user_prompt",
      text: expect.stringContaining(
        "explicitly approved canonical-degraded resume",
      ),
    });

    const after = reconstructMultiRunSession(await readStoredSession(stored.path));
    expect(after.runs).toHaveLength(2);
    expect(after.lastRun.runId).not.toBe(before.lastRun.runId);
    expect(after.lastRun).toMatchObject({
      resumeMode: "canonical_degraded",
      resumeOfRunId: before.lastRun.runId,
      status: "completed",
    });
    expect(after.lastRun.started.data.input.text).toBe("one more check");
    const request = after.sessionEvents.find(
      (event) => event.type === "session.resume.requested",
    );
    expect(request).toMatchObject({
      data: {
        message: "one more check",
        requested_mode: "canonical_degraded",
        source_run_id: before.lastRun.runId,
      },
    });
  });

  it("refuses show while a writer lock exists", async () => {
    const cwd = await createWorkspace();
    const runtime = createRuntime({
      createSessionWriter: V2SessionWriter.create,
      cwd,
      env: {},
    });
    expect(
      await runCli(
        [
          "agent",
          "lock fixture",
          "--task-profile",
          "read-only",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
        ],
        createMemoryIO().io,
        runtime,
      ),
    ).toBe(0);
    const session = await sessionIdentity(cwd);
    const writer = await V2SessionWriter.openExisting(cwd, session.id);
    try {
      const shown = createMemoryIO();
      expect(
        await runCli(["sessions", "show", session.id], shown.io, runtime),
      ).toBe(2);
      expect(shown.readStderr()).toContain("writer lock");
    } finally {
      await writer.close();
    }
  });

  it("blocks an unknown command effect without constructing a backend", async () => {
    const cwd = await createWorkspace();
    const sessionId = await createPendingCommandSession(cwd);
    const createModelBackend = vi.fn(() => {
      throw new Error("model must not be constructed");
    });
    const runtime = createRuntime({ createModelBackend, cwd, env: {} });
    const resumed = createMemoryIO();

    const exitCode = await runCli(
      [
        "sessions",
        "resume",
        sessionId,
        "--allow-degraded-resume",
      ],
      resumed.io,
      runtime,
    );
    expect(exitCode, resumed.readStderr()).toBe(2);
    expect(resumed.readStderr()).toContain("command effect is unknown");
    expect(createModelBackend).not.toHaveBeenCalled();
  });
});
