import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createPlanToolRegistry } from "../../src/tools/create-plan-tool-registry.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  fixedStream,
  type FakeStreamBehavior,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  createRuntime,
  withoutApplicationControlPlane,
} from "../helpers.js";

const workspaces: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "bornagent-phase16d-cli-"));
  workspaces.push(result);
  await writeFile(join(result, "fixture.txt"), "phase16 baseline\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: result });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: result,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 Fixture"], {
    cwd: result,
  });
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: result });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: result,
  });
  return result;
}

function planBehavior(): FakeStreamBehavior {
  let turn = 0;
  return async function* (request) {
    turn += 1;
    if (turn === 1) {
      const toolNames = request.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(expect.arrayContaining([
        "list_files",
        "read_artifact",
        "read_file",
        "search",
        "update_plan",
      ]));
      expect(toolNames.filter((name) => ["find_references", "find_symbol", "repository_outline"].includes(name))).toEqual(
        toolNames.includes("find_symbol") ? ["find_references", "find_symbol", "repository_outline"] : [],
      );
      yield {
        call: {
          argumentsJson: JSON.stringify({
            operation: "propose",
            plan: {
              items: [
                {
                  acceptance: "The Plan/Build binding is replayable.",
                  id: "runtime",
                  required: true,
                  title: "Wire the runtime",
                },
              ],
              title: "Phase 16D runtime",
            },
          }),
          callId: "phase16-plan-call",
          name: "update_plan",
        },
        type: "tool_call",
      };
    } else {
      expect(request.input.kind).toBe("tool_result");
      yield { delta: "The durable draft is ready for review.", type: "text_delta" };
    }
    yield {
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    };
    yield {
      continuation: new FakeContinuation(`turn-${String(turn)}`),
      providerResponseId: `phase16-response-${String(turn)}`,
      type: "turn_completed",
    };
  };
}

function reviseBehavior(base: {
  readonly planId: string;
  readonly revision: number;
  readonly sha256: string;
}): FakeStreamBehavior {
  return async function* (request) {
    expect(request.tools.map((tool) => tool.name)).toContain("update_plan");
    yield {
      call: {
        argumentsJson: JSON.stringify({
          base_plan_id: base.planId,
          base_revision: base.revision,
          base_sha256: base.sha256,
          operation: "revise",
          plan: {
            items: [
              {
                acceptance: "The revised Plan is explicitly reviewed.",
                id: "runtime-v2",
                required: true,
                title: "Revise the runtime",
              },
            ],
            title: "Phase 16D runtime revision",
          },
        }),
        callId: "phase16-build-revise",
        name: "update_plan",
      },
      type: "tool_call",
    };
    yield {
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };
    yield {
      continuation: new FakeContinuation("build-revise"),
      providerResponseId: "phase16-build-response",
      type: "turn_completed",
    };
  };
}

describe("Phase 16D Plan CLI runtime", () => {
  it("commits Goal before run, uses the mechanical Plan registry, and ends plan_ready", async () => {
    const cwd = await workspace();
    const backend = new FakeStreamingChatClient(planBehavior(), {
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "agent",
        "Design the next reliable Agent slice",
        "--mode",
        "plan",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(0);
    expect(backend.calls).toHaveLength(2);
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    );
    expect(file).toBeDefined();
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file!),
    );
    expect(events[0]).toMatchObject({ scope: "session", type: "goal.created" });
    expect(events[1]).toMatchObject({
      data: {
        agent_mode: "plan",
        agent_mode_source: "explicit_cli",
        goal_change_ledger_sha256: null,
        plan_id: null,
      },
      scope: "run",
      type: "run.started",
    });
    expect(events.find((event) => event.type === "plan.proposed")).toBeDefined();
    expect(events.at(-1)).toMatchObject({
      data: { completion_mode: "plan_ready" },
      type: "run.completed",
    });
    expect(
      events.some((event) =>
        ["command.execution.requested", "patch.apply.started"].includes(
          event.type,
        ),
      ),
    ).toBe(false);
  });

  it("ends with clarification_required when Plan mode creates no durable Plan", async () => {
    const cwd = await workspace();
    const backend = new FakeStreamingChatClient(
      fixedStream(["I need one bounded clarification."]),
      { model: "qwen3:1.7b", provider: "ollama" },
    );
    const memory = createMemoryIO();
    const exitCode = await runCli(
      [
        "agent",
        "Investigate an underspecified task",
        "--mode",
        "plan",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
      ],
      memory.io,
      createRuntime({
        createAgentToolRegistry: async (options) =>
          createPlanToolRegistry(
            options.workspace,
            options.updatePlanTool!,
            options.secrets ?? [],
            options.artifactRuntime,
          ),
        createModelBackend: () => backend,
        createSessionWriter: V2SessionWriter.create,
        cwd,
        env: {},
      }),
    );

    expect(exitCode, memory.readStderr()).toBe(8);
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    )!;
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file),
    );
    expect(events.at(-1)).toMatchObject({
      data: { reason: "clarification_required" },
      type: "run.incomplete",
    });
  });

  it("pauses a Build run immediately after proposing a revised Plan", async () => {
    const cwd = await workspace();
    let backend = new FakeStreamingChatClient(planBehavior(), {
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    const node = withoutApplicationControlPlane(createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      cwd,
      env: {},
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase16d",
    }));
    let registryError: unknown;
    const runtime: CliRuntime = {
      ...node,
      agentModelEvidence: () => ({
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      }),
      createAgentToolRegistry: async (options) => {
        try {
          return await node.createAgentToolRegistry(options);
        } catch (error) {
          registryError = error;
          throw error;
        }
      },
      createModelBackend: () => backend,
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
    };
    const planIo = createMemoryIO();
    expect(
      await runCli(
        [
          "agent",
          "Design a reviewable implementation",
          "--mode",
          "plan",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
        ],
        planIo.io,
        runtime,
      ),
      planIo.readStderr(),
    ).toBe(0);
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    )!;
    const sessionId = file.slice(0, -".jsonl".length);
    let events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file),
    );
    const proposed = events.find(
      (event): event is Extract<(typeof events)[number], { type: "plan.proposed" }> =>
        event.type === "plan.proposed",
    )!;
    const goal = events.find(
      (event): event is Extract<(typeof events)[number], { type: "goal.created" }> =>
        event.type === "goal.created",
    )!;
    const approveIo = createMemoryIO();
    expect(
      await runCli(
        [
          "plan",
          "approve",
          sessionId,
          "--goal-id",
          goal.data.goal_id,
          "--goal-revision",
          "1",
          "--plan-id",
          proposed.data.content.planId,
          "--revision",
          "1",
          "--sha256",
          proposed.data.plan_sha256,
        ],
        approveIo.io,
        runtime,
      ),
      approveIo.readStderr(),
    ).toBe(0);

    backend = new FakeStreamingChatClient(
      reviseBehavior({
        planId: proposed.data.content.planId,
        revision: 1,
        sha256: proposed.data.plan_sha256,
      }),
      { model: "qwen3:1.7b", provider: "ollama" },
    );
    const buildIo = createMemoryIO();
    const buildExit = await runCli(
      [
        "sessions",
        "resume",
        sessionId,
        "--mode",
        "build",
        "--message",
        "Revise the approved Plan before implementation",
        "--allow-degraded-resume",
      ],
      buildIo.io,
      runtime,
    );

    events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file),
    );
    expect(
      buildExit,
      `${buildIo.readStderr()}\n${registryError instanceof Error ? registryError.stack : String(registryError)}\n${JSON.stringify(events.slice(-12))}`,
    ).toBe(8);
    expect(backend.calls).toHaveLength(1);
    expect(events.find((event) => event.type === "plan.revised")).toBeDefined();
    expect(events.at(-1)).toMatchObject({
      data: { reason: "plan_approval_required" },
      type: "run.incomplete",
    });
  }, 10_000);
});
