import { resolve } from "node:path";

import type { CliIO, CliRuntime } from "../src/cli/types.js";
import type { RunEvent } from "../src/events/run-event.js";
import type { ExecutableResult } from "../src/doctor/types.js";
import type { SessionWriter } from "../src/sessions/jsonl-session-writer.js";
import {
  FakeStreamingChatClient,
  fixedStream,
} from "./fakes/fake-chat-client.js";
import type {
  ToolExecution,
  ToolInvocation,
  ToolRegistryLike,
} from "../src/tools/tool-types.js";

export class FakeToolRegistry implements ToolRegistryLike {
  readonly calls: ToolInvocation[] = [];
  readonly modelDefinitions = [
    {
      description: "fake read",
      name: "read_file",
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      },
      strict: true as const,
    },
  ];

  constructor(
    private readonly result: ToolExecution = {
      ok: true,
      output: JSON.stringify({ ok: true, value: "fake tool result" }),
      truncated: false,
    },
  ) {}

  async execute(invocation: ToolInvocation): Promise<ToolExecution> {
    this.calls.push(invocation);
    return this.result;
  }
}

export class InMemorySessionWriter implements SessionWriter {
  readonly events: RunEvent[] = [];
  closed = false;

  constructor(
    readonly path = "memory://session.jsonl",
    private readonly onWrite?: (event: RunEvent) => Promise<void> | void,
  ) {}

  async write(event: RunEvent): Promise<void> {
    await this.onWrite?.(event);
    this.events.push(event);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function createMemoryIO(): {
  io: CliIO;
  readStderr(): string;
  readStdout(): string;
} {
  let stderr = "";
  let stdout = "";

  return {
    io: {
      stderr: { write: (value) => void (stderr += value) },
      stdout: { write: (value) => void (stdout += value) },
    },
    readStderr: () => stderr,
    readStdout: () => stdout,
  };
}

export function createRuntime(
  overrides: Partial<CliRuntime> = {},
): CliRuntime {
  let uuidCounter = 0;
  const randomUUID = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };

  return {
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createApprovalPrompt: () => ({
      request: async () => "denied" as const,
    }),
    createAgentToolRegistry: async () => new FakeToolRegistry(),
    createSessionWriter: async (_workspace, sessionId) =>
      new InMemorySessionWriter(`memory://${sessionId}.jsonl`),
    createModelTurnClient: () =>
      new FakeStreamingChatClient(fixedStream()),
    createToolRegistry: async () => new FakeToolRegistry(),
    cwd: resolve("fixture-workspace"),
    env: { OPENAI_API_KEY: "test-api-key" },
    isReadableDirectory: async () => true,
    nodeVersion: "22.16.0",
    now: Date.now,
    onCancel: () => () => undefined,
    platform: "win32",
    randomUUID,
    runExecutable: async (command): Promise<ExecutableResult> => ({
      kind: "completed",
      exitCode: 0,
      stderr: "",
      stdout:
        command === "git"
          ? "git version 2.30.0.windows.2\n"
          : "ripgrep 15.1.0\n",
    }),
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    timestamp: () => "2026-07-16T00:00:00.000Z",
    version: "0.0.0",
    ...overrides,
  };
}
