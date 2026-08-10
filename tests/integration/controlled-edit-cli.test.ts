import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createAgentToolRegistry } from "../../src/tools/create-agent-tool-registry.js";
import { reconstructSession } from "../../src/sessions/reconstruct-session.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
} from "../fakes/fake-chat-client.js";
import type { FakeModelTurnSignal as ModelTurnSignal } from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  InMemorySessionWriter,
} from "../helpers.js";

const temporaryDirectories: string[] = [];

async function fixtureWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "born-phase5-"));
  temporaryDirectories.push(root);
  await cp(resolve("fixtures/phase-05-controlled-edit"), root, {
    recursive: true,
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

const patch = [
  "diff --git a/src/math.ts b/src/math.ts",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,3 @@",
  " export function clamp(value: number, minimum: number, maximum: number): number {",
  "-  return Math.min(minimum, Math.max(maximum, value));",
  "+  return Math.min(maximum, Math.max(minimum, value));",
  " }",
  "",
].join("\n");

function toolTurn(): readonly ModelTurnSignal[] {
  return [
    {
      call: {
        argumentsJson: JSON.stringify({ patch }),
        callId: "call_patch",
        name: "apply_patch",
      },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation("patch"),
      providerResponseId: "resp_patch",
      type: "turn_completed",
    },
  ];
}

function finalTurn(text: string): readonly ModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation("final"),
      providerResponseId: "resp_final",
      type: "turn_completed",
    },
  ];
}

function scriptedClient(finalText: string) {
  const turns = [toolTurn(), finalTurn(finalText)];
  let index = 0;
  return new FakeStreamingChatClient(async function* () {
    const turn = turns[index++];
    if (turn === undefined) throw new Error("unexpected model turn");
    yield* turn;
  });
}

async function runEdit(options: {
  readonly approval: "approved" | "cancelled" | "denied";
  readonly onPrompt?: () => Promise<void> | void;
  readonly writer?: InMemorySessionWriter;
  readonly workspace: string;
}) {
  const writer = options.writer ?? new InMemorySessionWriter();
  const memory = createMemoryIO();
  const prompt = vi.fn(async () => {
    await options.onPrompt?.();
    return options.approval;
  });
  const client = scriptedClient(
    options.approval === "approved"
      ? "Patch applied. Phase 5 did not run verification."
      : "The patch was denied and no edit was applied.",
  );
  const exitCode = await runCli(
    [
      "agent",
      "fix clamp without changing unrelated files",
      "--provider",
      "ollama",
      "--edit-approval",
      "ask",
    ],
    memory.io,
    createRuntime({
      createAgentToolRegistry,
      createApprovalPrompt: () => ({ request: prompt }),
      createModelBackend: () => client,
      createSessionWriter: async () => writer,
      cwd: options.workspace,
      env: {},
    }),
  );
  return { client, exitCode, memory, prompt, writer };
}

describe("born agent Phase 5 controlled edits", () => {
  it("applies one approved patch and preserves unrelated dirty work", async () => {
    const workspace = await fixtureWorkspace();
    const dirtyPath = join(workspace, "notes/user-draft.txt");
    await writeFile(dirtyPath, "user draft dirty\n", "utf8");

    const result = await runEdit({ approval: "approved", workspace });

    expect(result.exitCode, result.memory.readStderr()).toBe(8);
    expect(await readFile(join(workspace, "src/math.ts"), "utf8")).toContain(
      "Math.min(maximum, Math.max(minimum, value))",
    );
    expect(await readFile(dirtyPath, "utf8")).toBe("user draft dirty\n");
    expect(result.prompt).toHaveBeenCalledOnce();
    expect(result.writer.events.map((event) => event.type)).toContain(
      "patch.apply.completed",
    );
    expect(
      reconstructSession(result.writer.events).patchAttempts[0],
    ).toMatchObject({
      applyState: "completed",
      approvalDecided: { decision: "approved" },
    });
    expect(result.memory.readStdout()).toBe("");
    expect(result.memory.readStderr()).toContain(
      "Incomplete: completion_signal_required",
    );
  });

  it("audits denial without changing the target", async () => {
    const workspace = await fixtureWorkspace();
    const target = join(workspace, "src/math.ts");
    const before = await readFile(target);

    const result = await runEdit({ approval: "denied", workspace });

    expect(result.exitCode).toBe(8);
    expect(await readFile(target)).toEqual(before);
    expect(result.writer.events.some((event) => event.type === "approval.decided"))
      .toBe(true);
    expect(
      result.writer.events.some((event) => event.type === "patch.apply.started"),
    ).toBe(false);
    expect(result.writer.events.find((event) => event.type === "tool.call.completed"))
      .toMatchObject({ data: { error_code: "patch_denied", status: "error" } });
  });

  it("invalidates approval when the preimage changes during the prompt", async () => {
    const workspace = await fixtureWorkspace();
    const target = join(workspace, "src/math.ts");
    const external = "export const externallyChanged = true;\n";

    const result = await runEdit({
      approval: "approved",
      onPrompt: async () => writeFile(target, external, "utf8"),
      workspace,
    });

    expect(result.exitCode).toBe(8);
    expect(await readFile(target, "utf8")).toBe(external);
    expect(
      result.writer.events.some((event) => event.type === "patch.apply.started"),
    ).toBe(false);
    expect(result.writer.events.find((event) => event.type === "tool.call.completed"))
      .toMatchObject({ data: { error_code: "patch_stale", status: "error" } });
  });

  it("maps approval cancellation to run.cancelled and exit 130", async () => {
    const workspace = await fixtureWorkspace();
    const target = join(workspace, "src/math.ts");
    const before = await readFile(target);

    const result = await runEdit({ approval: "cancelled", workspace });

    expect(result.exitCode).toBe(130);
    expect(result.client.calls).toHaveLength(1);
    expect(await readFile(target)).toEqual(before);
    expect(result.writer.events.at(-1)?.type).toBe("run.cancelled");
    expect(result.writer.events.find((event) => event.type === "tool.call.completed"))
      .toMatchObject({
        data: {
          error_category: "cancelled",
          error_code: "tool_cancelled",
          status: "error",
        },
      });
  });

  it("stops after completed-evidence persistence fails and warns that files may differ", async () => {
    const workspace = await fixtureWorkspace();
    const writer = new InMemorySessionWriter("memory://storage-failure", (event) => {
      if (event.type === "patch.apply.completed") throw new Error("disk full");
    });

    const result = await runEdit({
      approval: "approved",
      workspace,
      writer,
    });

    expect(result.exitCode).toBe(1);
    expect(result.client.calls).toHaveLength(1);
    expect(await readFile(join(workspace, "src/math.ts"), "utf8")).toContain(
      "Math.min(maximum, Math.max(minimum, value))",
    );
    expect(result.memory.readStderr()).toContain("session storage failed");
    expect(result.memory.readStderr()).toContain("workspace may have changed");
    expect(writer.events.at(-1)?.type).toBe("patch.apply.started");
  });
});
