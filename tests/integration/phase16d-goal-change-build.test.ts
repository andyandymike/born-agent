import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { projectGoalChangeLedger } from "../../src/coordination/goal-change-ledger.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeStreamBehavior,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO } from "../helpers.js";

const workspaces: string[] = [];
const execFileAsync = promisify(execFile);
const GOAL_CHANGE_TEST_TIMEOUT_MS = process.env.BORN_CI_WINDOWS_SERIAL_TESTS === "1"
  ? 60_000
  : 15_000;

const patch = [
  "diff --git a/src/value.ts b/src/value.ts",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16d-change-"));
  workspaces.push(workspace);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 Fixture"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "src/value.ts"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: workspace,
  });
  return workspace;
}

function behavior(): FakeStreamBehavior {
  let turn = 0;
  return async function* (request) {
    turn += 1;
    if (turn === 1) {
      expect(request.tools.map((tool) => tool.name)).toContain("apply_patch");
      yield {
        call: {
          argumentsJson: JSON.stringify({ patch }),
          callId: "phase16-change-call",
          name: "apply_patch",
        },
        type: "tool_call",
      };
    } else {
      expect(request.input.kind).toBe("tool_result");
      yield { delta: "The patch is applied; verification is still required.", type: "text_delta" };
    }
    yield {
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    };
    yield {
      continuation: new FakeContinuation(`phase16-change-${String(turn)}`),
      providerResponseId: `phase16-change-response-${String(turn)}`,
      type: "turn_completed",
    };
  };
}

describe("Phase 16D Build Goal change integration", () => {
  it("captures baseline and pre/post artifacts before committing one cross-run change", async () => {
    const cwd = await fixtureWorkspace();
    const backend = new FakeStreamingChatClient(behavior(), {
      model: "qwen3:1.7b",
      provider: "ollama",
    });
    const node = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      cwd,
      env: { BORN_CONTROL_STATE_ROOT: join(cwd, ".bornagent", "test-control") },
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase16d-change",
    });
    const runtime: CliRuntime = {
      ...node,
      agentModelEvidence: () => ({
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      }),
      createApprovalPrompt: () => ({ request: async () => "approved" }),
      createModelBackend: () => backend,
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
    };
    const memory = createMemoryIO();

    const exitCode = await runCli(
      [
        "agent",
        "Change the fixture value",
        "--mode",
        "build",
        "--provider",
        "ollama",
        "--model",
        "qwen3:1.7b",
        "--edit-approval",
        "ask",
      ],
      memory.io,
      runtime,
    );

    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    )!;
    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file),
    );
    expect(
      exitCode,
      `${memory.readStderr()}\n${JSON.stringify(events.slice(-12), null, 2)}`,
    ).toBe(8);
    expect(await readFile(join(cwd, "src", "value.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    const types = events.map((event) => event.type);
    const baselineIndex = types.indexOf("goal.execution.baseline.captured");
    const planIndex = types.indexOf("patch.plan.created");
    const patchPlanEventId = events[planIndex]!.eventId;
    const artifacts = events.filter(
      (event) =>
        event.type === "artifact.stored" &&
        event.data.origin_event_id === patchPlanEventId,
    );
    const startedIndex = types.indexOf("patch.apply.started");
    const completedIndex = types.indexOf("patch.apply.completed");
    const recordIndex = types.indexOf("goal.change.recorded");
    const receiptIndex = types.findIndex(
      (type, index) => type === "tool.call.completed" && index > recordIndex,
    );
    expect(baselineIndex).toBeGreaterThan(types.indexOf("backend.selected"));
    expect(planIndex).toBeGreaterThan(baselineIndex);
    expect(artifacts).toHaveLength(2);
    expect(events.indexOf(artifacts[0]!)).toBeGreaterThan(planIndex);
    expect(events.indexOf(artifacts[1]!)).toBeLessThan(startedIndex);
    expect(startedIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(recordIndex);
    expect(recordIndex).toBeLessThan(receiptIndex);

    const start = events.find((event) => event.type === "run.started")!;
    const goal = events.find((event) => event.type === "goal.created")!;
    const projection = projectGoalChangeLedger(
      events,
      goal.data.goal_id,
      goal.data.revision,
    );
    expect(projection).toMatchObject({
      goalId: goal.data.goal_id,
      netChangedPaths: ["src/value.ts"],
      sourceRunIds: [start.runId],
    });
    expect(projection?.records).toHaveLength(1);
  }, GOAL_CHANGE_TEST_TIMEOUT_MS);
});
