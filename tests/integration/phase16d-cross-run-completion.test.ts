import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { OutcomeReportBuilder, outcomeReportSchema } from "../../src/coordination/outcome-report.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeModelTurnSignal,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO } from "../helpers.js";

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

const target = "fixtures/phase-07-fix-and-verify/src/clamp.mjs";
const buggyClamp = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(minimum, Math.max(maximum, value));",
  "}",
  "",
].join("\n");
const fixedClamp = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(maximum, Math.max(minimum, value));",
  "}",
  "",
].join("\n");
const patch = [
  `diff --git a/${target} b/${target}`,
  `--- a/${target}`,
  `+++ b/${target}`,
  "@@ -1,3 +1,3 @@",
  " export function clamp(value, minimum, maximum) {",
  "-  return Math.min(minimum, Math.max(maximum, value));",
  "+  return Math.min(maximum, Math.max(minimum, value));",
  " }",
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
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16d-cross-run-"));
  workspaces.push(workspace);
  const destination = join(workspace, "fixtures", "phase-07-fix-and-verify");
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve("fixtures", "phase-07-fix-and-verify"), destination, {
    recursive: true,
  });
  await writeFile(join(workspace, ...target.split("/")), buggyClamp, "utf8");
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "phase16@example.invalid"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 16 Fixture"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "--all"], { cwd: workspace });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: workspace,
  });
  return workspace;
}

function toolTurn(
  name: string,
  callId: string,
  input: Readonly<Record<string, unknown>>,
): readonly FakeModelTurnSignal[] {
  return [
    {
      call: { argumentsJson: JSON.stringify(input), callId, name },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation(callId),
      providerResponseId: `response-${callId}`,
      type: "turn_completed",
    },
  ];
}

function finalTurn(): readonly FakeModelTurnSignal[] {
  return [
    { delta: "Patch is durable; verification remains for the next run.", type: "text_delta" },
    {
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    },
    {
      continuation: new FakeContinuation("run-a-final"),
      providerResponseId: "response-run-a-final",
      type: "turn_completed",
    },
  ];
}

function scriptedClient(
  turns: readonly (readonly FakeModelTurnSignal[])[],
): FakeStreamingChatClient {
  let index = 0;
  return new FakeStreamingChatClient(async function* () {
    const turn = turns[index++];
    if (turn === undefined) throw new Error("unexpected model turn");
    yield* turn;
  }, { model: "qwen3:1.7b", provider: "ollama" });
}

describe("Phase 16D cross-run completion", () => {
  it("seeds Run B from Run A artifacts, verifies once, and completes the Goal", async () => {
    const cwd = await fixtureWorkspace();
    let backend = scriptedClient([
      toolTurn("apply_patch", "run-a-patch", { patch }),
      finalTurn(),
    ]);
    const approval = vi.fn(async () => "approved" as const);
    const node = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
      cwd,
      env: { BORN_CONTROL_STATE_ROOT: join(cwd, ".bornagent", "test-control") },
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase16d-cross-run",
    });
    const runtime: CliRuntime = {
      ...node,
      agentModelEvidence: () => ({
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      }),
      createApprovalPrompt: () => ({ request: approval }),
      createModelBackend: () => backend,
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
    };

    const runAIo = createMemoryIO();
    expect(
      await runCli(
        [
          "agent",
          "Fix and verify the checked-in clamp fixture",
          "--mode",
          "build",
          "--provider",
          "ollama",
          "--model",
          "qwen3:1.7b",
          "--edit-approval",
          "ask",
          "--command-approval",
          "ask",
          "--report-format",
          "json",
        ],
        runAIo.io,
        runtime,
      ),
      runAIo.readStderr(),
    ).toBe(8);
    expect(await readFile(join(cwd, ...target.split("/")), "utf8")).toBe(
      fixedClamp,
    );

    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    )!;
    const sessionId = file.slice(0, -".jsonl".length);
    backend = scriptedClient([
      toolTurn("run_command", "run-b-verify", {
        args: ["verify.mjs"],
        cwd: "fixtures/phase-07-fix-and-verify",
        executable: "node",
        purpose: "verify",
        timeout_ms: 120_000,
      }),
      toolTurn("finish_task", "run-b-finish", {
        status: "completed",
        summary: "The prior-run clamp change passed the reviewed offline verification.",
      }),
    ]);
    const runBIo = createMemoryIO();
    const runBExit = await runCli(
      [
        "sessions",
        "resume",
        sessionId,
        "--mode",
        "build",
        "--message",
        "Verify the existing Goal change and finish it",
        "--allow-degraded-resume",
      ],
      runBIo.io,
      runtime,
    );

    const events = await readStoredSession(
      join(cwd, ".bornagent", "sessions", file),
    );
    expect(
      runBExit,
      `${runBIo.readStderr()}\n${JSON.stringify(events.slice(-16), null, 2)}`,
    ).toBe(0);
    const reconstructed = reconstructMultiRunSession(events);
    expect(reconstructed.status).toBe("completed");
    const starts = events.filter((event) => event.type === "run.started");
    expect(starts).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "goal.change.recorded"),
    ).toHaveLength(1);
    const evidence = events.find(
      (event) =>
        event.type === "completion.evidence" &&
        event.data.outcome === "completed",
    );
    expect(evidence).toMatchObject({
      data: {
        evidence: {
          attributionScope: {
            changeEventIds: [
              events.find((event) => event.type === "goal.change.recorded")!
                .eventId,
            ],
            kind: "goal_revision",
            sourceRunIds: [starts[0]!.runId],
          },
          changedByRun: [{ path: target }],
        },
      },
    });
    const acceptedIndex = events.findIndex(
      (event) =>
        event.type === "completion.evaluated" &&
        event.data.effect === "accept",
    );
    const receiptIndex = events.findIndex(
      (event) =>
        event.type === "tool.call.completed" &&
        event.data.call_id === "run-b-finish",
    );
    const goalCompletedIndex = events.findIndex(
      (event) =>
        event.type === "goal.status.changed" && event.data.to === "completed",
    );
    const terminalIndex = events.findIndex(
      (event) =>
        event.type === "run.completed" &&
        event.data.completion_mode === "verified_finish_task",
    );
    expect(acceptedIndex).toBeLessThan(receiptIndex);
    expect(receiptIndex).toBeLessThan(goalCompletedIndex);
    expect(goalCompletedIndex).toBeLessThan(terminalIndex);

    const reportLines = runBIo
      .readStdout()
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith("{"));
    expect(reportLines).toHaveLength(1);
    const report = outcomeReportSchema.parse(JSON.parse(reportLines[0]!));
    expect(report).toMatchObject({
      changeAttribution: {
        kind: "goal_revision",
      },
      changes: [{ path: target, sourceRunIds: [starts[0]!.runId] }],
      outcome: "completed",
    });

    const outcome = new OutcomeReportBuilder().build(reconstructed);
    expect(outcomeReportSchema.parse(outcome)).toEqual(outcome);
    expect(report.reportSha256).toBe(outcome.reportSha256);
    expect(outcome).toMatchObject({
      changeAttribution: {
        kind: "goal_revision",
      },
      changes: [
        {
          path: target,
          sourceRunIds: [starts[0]!.runId],
        },
      ],
      outcome: "completed",
      run: { id: starts[1]!.runId },
    });
    const showIo = createMemoryIO();
    expect(
      await runCli(
        ["sessions", "show", sessionId, "--json"],
        showIo.io,
        runtime,
      ),
      showIo.readStderr(),
    ).toBe(0);
    const shown = JSON.parse(showIo.readStdout()) as {
      readonly outcomeReport: { readonly reportSha256: string };
    };
    expect(shown.outcomeReport.reportSha256).toBe(outcome.reportSha256);
  }, 30_000);
});
