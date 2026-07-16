import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";
import type { ToolExecution } from "../../src/tools/tool-types.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
} from "../fakes/fake-chat-client.js";
import type { FakeModelTurnSignal as ModelTurnSignal } from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  FakeToolRegistry,
  InMemorySessionWriter,
} from "../helpers.js";

function toolTurn(
  argumentsJson = '{"path":"README.md"}',
): readonly ModelTurnSignal[] {
  return [
    {
      call: {
        argumentsJson,
        callId: "call_read",
        name: "read_file",
      },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
    {
      continuation: new FakeContinuation("tool"),
      providerResponseId: "resp_tool",
      type: "turn_completed",
    },
  ];
}

function finalTurn(text = "The answer is BORN."): readonly ModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    {
      type: "usage",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    },
    {
      continuation: new FakeContinuation("final"),
      providerResponseId: "resp_final",
      type: "turn_completed",
    },
  ];
}

describe("born chat Phase 3 read-only tool round trip", () => {
  it("persists requested/result before the second model turn and aggregates usage", async () => {
    const writer = new InMemorySessionWriter();
    const memory = createMemoryIO();
    const registry = new FakeToolRegistry({
      ok: true,
      output: JSON.stringify({ content: "BORN", ok: true }),
      truncated: false,
    });
    const client = new FakeStreamingChatClient(async function* (request) {
      if (request.input.kind === "user_prompt") {
        yield* toolTurn();
        return;
      }
      expect(writer.events.map((event) => event.type)).toContain(
        "tool.call.completed",
      );
      expect(request.tools).toEqual([]);
      expect(request.input.output).toBe(
        JSON.stringify({ content: "BORN", ok: true }),
      );
      yield* finalTurn();
    });

    const exitCode = await runCli(
      ["chat", "inspect the fixture", "--verbose"],
      memory.io,
      createRuntime({
        createModelBackend: () => client,
        createSessionWriter: async () => writer,
        createToolRegistry: async () => registry,
      }),
    );

    expect(exitCode).toBe(0);
    expect(client.calls).toHaveLength(2);
    expect(registry.calls).toHaveLength(1);
    expect(memory.readStdout()).toBe("The answer is BORN.\n");
    expect(memory.readStderr()).not.toContain("content");
    expect(writer.events.map((event) => event.type)).toEqual([
      "run.started",
      "backend.selected",
      "tool.call.requested",
      "tool.call.completed",
      "text.delta",
      "usage",
      "run.completed",
    ]);
    expect(writer.events.find((event) => event.type === "usage")).toMatchObject({
      data: {
        input_tokens: 30,
        model_turns: 2,
        output_tokens: 7,
        total_tokens: 37,
      },
    });
    expect(writer.events.at(-1)).toMatchObject({
      data: { model_turns: 2, tool_calls: 1 },
      type: "run.completed",
    });
  });

  it("feeds a recoverable tool error to the final model turn", async () => {
    const writer = new InMemorySessionWriter();
    const error: ToolExecution = {
      error: {
        category: "permission",
        code: "path_outside_workspace",
        message: "path is outside the workspace",
        retryable: false,
      },
      ok: false,
      output: JSON.stringify({
        error: {
          category: "permission",
          code: "path_outside_workspace",
          message: "path is outside the workspace",
          retryable: false,
        },
        ok: false,
      }),
      truncated: false,
    };
    const registry = new FakeToolRegistry(error);
    const client = new FakeStreamingChatClient(async function* (request) {
      if (request.input.kind === "user_prompt") {
        yield* toolTurn('{"path":"../secret"}');
      } else {
        expect(request.input.output).toContain("path_outside_workspace");
        yield* finalTurn("I cannot access that path.");
      }
    });

    const exitCode = await runCli(
      ["chat", "read outside"],
      createMemoryIO().io,
      createRuntime({
        createModelBackend: () => client,
        createSessionWriter: async () => writer,
        createToolRegistry: async () => registry,
      }),
    );
    expect(exitCode).toBe(0);
    expect(writer.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: {
        error_category: "permission",
        error_code: "path_outside_workspace",
        status: "error",
      },
    });
  });

  it("keeps parent, .git, and .env secret contents out of stdout and sessions", async () => {
    const base = await mkdtemp(join(tmpdir(), "born-boundary-"));
    const workspace = join(base, "workspace");
    const secrets = {
      "../outside-secret.txt": "PARENT-SECRET-79b6",
      ".env": "ENV-SECRET-42f1",
      ".git/config": "GIT-SECRET-18ac",
    } as const;

    try {
      await mkdir(join(workspace, ".git"), { recursive: true });
      await writeFile(join(base, "outside-secret.txt"), secrets["../outside-secret.txt"]);
      await writeFile(join(workspace, ".env"), secrets[".env"]);
      await writeFile(join(workspace, ".git", "config"), secrets[".git/config"]);

      for (const [path, secret] of Object.entries(secrets)) {
        const writer = new InMemorySessionWriter();
        const memory = createMemoryIO();
        const registry = await createReadonlyToolRegistry(workspace);
        const client = new FakeStreamingChatClient(async function* (request) {
          if (request.input.kind === "user_prompt") {
            yield* toolTurn(
              JSON.stringify({ end_line: null, path, start_line: null }),
            );
            return;
          }
          expect(request.input.output).not.toContain(secret);
          yield* finalTurn("Access denied.");
        });

        const exitCode = await runCli(
          ["chat", "perform the boundary check"],
          memory.io,
          createRuntime({
            createModelBackend: () => client,
            createSessionWriter: async () => writer,
            createToolRegistry: async () => registry,
            cwd: workspace,
          }),
        );

        expect(exitCode, path).toBe(0);
        expect(memory.readStdout(), path).toBe("Access denied.\n");
        expect(memory.readStdout(), path).not.toContain(secret);
        expect(JSON.stringify(writer.events), path).not.toContain(secret);
        expect(
          writer.events.find((event) => event.type === "tool.call.completed"),
          path,
        ).toMatchObject({ data: { status: "error" } });
      }
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("stops on a system tool error without making a second model request", async () => {
    const writer = new InMemorySessionWriter();
    const registry = new FakeToolRegistry({
      error: {
        category: "system",
        code: "rg_not_found",
        message: "ripgrep is not available",
        retryable: false,
      },
      ok: false,
      output: '{"ok":false}',
      truncated: false,
    });
    const client = new FakeStreamingChatClient(async function* () {
      yield* toolTurn();
    });
    const exitCode = await runCli(
      ["chat", "inspect"],
      createMemoryIO().io,
      createRuntime({
        createModelBackend: () => client,
        createSessionWriter: async () => writer,
        createToolRegistry: async () => registry,
      }),
    );
    expect(exitCode).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(writer.events.at(-1)).toMatchObject({
      data: { code: "rg_not_found" },
      type: "run.failed",
    });
  });

  it("fails with tool_round_limit if a second turn asks for a tool", async () => {
    const writer = new InMemorySessionWriter();
    const registry = new FakeToolRegistry();
    const client = new FakeStreamingChatClient(async function* () {
      yield* toolTurn();
    });
    const exitCode = await runCli(
      ["chat", "loop"],
      createMemoryIO().io,
      createRuntime({
        createModelBackend: () => client,
        createSessionWriter: async () => writer,
        createToolRegistry: async () => registry,
      }),
    );
    expect(exitCode).toBe(5);
    expect(registry.calls).toHaveLength(1);
    expect(client.calls).toHaveLength(2);
    expect(writer.events.at(-1)).toMatchObject({
      data: { code: "tool_round_limit" },
      type: "run.failed",
    });
  });

  it("does not initialize tools when --no-tools is selected", async () => {
    const createToolRegistry = vi.fn();
    const client = new FakeStreamingChatClient(async function* (request) {
      expect(request.tools).toEqual([]);
      yield* finalTurn("plain response");
    });
    const exitCode = await runCli(
      ["chat", "plain", "--no-tools"],
      createMemoryIO().io,
      createRuntime({ createModelBackend: () => client, createToolRegistry }),
    );
    expect(exitCode).toBe(0);
    expect(createToolRegistry).not.toHaveBeenCalled();
  });

  it("redacts a key from persisted tool arguments", async () => {
    const secret = "sk-phase3-secret-123456";
    const writer = new InMemorySessionWriter();
    const registry = new FakeToolRegistry();
    const client = new FakeStreamingChatClient(async function* (request) {
      if (request.input.kind === "user_prompt") {
        yield* toolTurn(JSON.stringify({ path: secret }));
      } else {
        yield* finalTurn();
      }
    });
    await runCli(
      ["chat", "secret"],
      createMemoryIO().io,
      createRuntime({
        createModelBackend: () => client,
        createSessionWriter: async () => writer,
        createToolRegistry: async () => registry,
        env: { OPENAI_API_KEY: secret },
      }),
    );
    expect(JSON.stringify(writer.events)).not.toContain(secret);
  });
});
