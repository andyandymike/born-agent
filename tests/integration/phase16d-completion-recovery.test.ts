import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { GoalChangeRecordReconciler } from "../../src/coordination/goal-change-record-reconciler.js";
import { projectGoalChangeLedger } from "../../src/coordination/goal-change-ledger.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
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
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16d-recovery-"));
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

describe("Phase 16D completion transition recovery", () => {
  it("closes every accepted-completion crash prefix without another model run", async () => {
    const cwd = await fixtureWorkspace();
    let turn = 0;
    const turns = [
      toolTurn("apply_patch", "recover-patch", { patch }),
      toolTurn("run_command", "recover-verify", {
        args: ["verify.mjs"],
        cwd: "fixtures/phase-07-fix-and-verify",
        executable: "node",
        purpose: "verify",
        timeout_ms: 120_000,
      }),
      toolTurn("finish_task", "recover-finish", {
        status: "completed",
        summary: "The Goal change passed the reviewed offline verification.",
      }),
    ];
    const backend = new FakeStreamingChatClient(async function* () {
      const signals = turns[turn++];
      if (signals === undefined) throw new Error("unexpected model turn");
      yield* signals;
    }, { model: "qwen3:1.7b", provider: "ollama" });
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
      version: "0.0.0-phase16d-recovery",
    });
    let backendFactoryCalls = 0;
    const runtime: CliRuntime = {
      ...node,
      agentModelEvidence: () => ({
        backend: "fake",
        endpointScope: "in_process",
        kind: "contract_verified",
        remoteBillableRequests: 0,
      }),
      createApprovalPrompt: () => ({ request: approval }),
      createModelBackend: () => {
        backendFactoryCalls += 1;
        return backend;
      },
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
    };

    const initialIo = createMemoryIO();
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
        ],
        initialIo.io,
        runtime,
      ),
      initialIo.readStderr(),
    ).toBe(0);
    expect(backend.calls).toHaveLength(3);
    expect(backendFactoryCalls).toBe(1);

    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find(
      (name) => name.endsWith(".jsonl"),
    )!;
    const sessionId = file.slice(0, -".jsonl".length);
    const path = join(cwd, ".bornagent", "sessions", file);
    const originalText = await readFile(path, "utf8");
    const originalLines = originalText.trimEnd().split("\n");
    const originalEvents = await readStoredSession(path);
    const markers = [
      {
        expected: [
          "tool.call.completed",
          "usage",
          "goal.status.changed",
          "run.completed",
        ],
        event: originalEvents.find(
          (event) =>
            event.type === "completion.evaluated" && event.data.effect === "accept",
        )!,
      },
      {
        expected: ["usage", "goal.status.changed", "run.completed"],
        event: originalEvents.find(
          (event) =>
            event.type === "tool.call.completed" &&
            event.data.call_id === "recover-finish",
        )!,
      },
      {
        expected: ["run.completed"],
        event: originalEvents.find(
          (event) =>
            event.type === "goal.status.changed" && event.data.to === "completed",
        )!,
      },
    ];

    for (const marker of markers) {
      await writeFile(
        path,
        `${originalLines.slice(0, marker.event.sessionSeq).join("\n")}\n`,
        "utf8",
      );
      const beforeBackendCalls = backendFactoryCalls;
      const io = createMemoryIO();
      expect(
        await runCli(["sessions", "resume", sessionId], io.io, runtime),
        io.readStderr(),
      ).toBe(0);
      expect(backendFactoryCalls).toBe(beforeBackendCalls);
      expect(io.readStdout()).toContain("Completion recovery:");

      const recoveredEvents = await readStoredSession(path);
      const appendedTypes = recoveredEvents
        .slice(marker.event.sessionSeq)
        .map((event) => event.type);
      for (const expected of marker.expected) {
        expect(appendedTypes).toContain(expected);
      }
      expect(
        recoveredEvents.filter((event) => event.type === "run.started"),
      ).toHaveLength(1);
      expect(
        recoveredEvents.filter(
          (event) =>
            event.type === "goal.status.changed" && event.data.to === "completed",
        ),
      ).toHaveLength(1);
      expect(reconstructMultiRunSession(recoveredEvents).status).toBe("completed");
    }

    const goal = originalEvents.find((event) => event.type === "goal.created")!;
    const patchCompleted = originalEvents.find(
      (event) => event.type === "patch.apply.completed",
    )!;
    await writeFile(
      path,
      `${originalLines.slice(0, patchCompleted.sessionSeq).join("\n")}\n`,
      "utf8",
    );
    let writer = await V2SessionWriter.openExisting(cwd, sessionId);
    let goalRecovery = await new GoalChangeRecordReconciler({
      goalId: goal.data.goal_id,
      goalRevision: 1,
      randomUUID: runtime.randomUUID,
      workspace: cwd,
      writer,
    }).reconcile();
    expect(goalRecovery.recovered).toBe(1);
    expect((await new GoalChangeRecordReconciler({
      goalId: goal.data.goal_id,
      goalRevision: 1,
      randomUUID: runtime.randomUUID,
      workspace: cwd,
      writer,
    }).reconcile()).recovered).toBe(0);
    let ledger = projectGoalChangeLedger(writer.events, goal.data.goal_id, 1);
    expect(ledger?.netChangedPaths).toEqual([target]);
    expect(
      writer.events.filter((event) => event.type === "patch.apply.completed"),
    ).toHaveLength(1);
    await writer.close();

    const patchStarted = originalEvents.find(
      (event) => event.type === "patch.apply.started",
    )!;
    await writeFile(
      path,
      `${originalLines.slice(0, patchStarted.sessionSeq).join("\n")}\n`,
      "utf8",
    );
    writer = await V2SessionWriter.openExisting(cwd, sessionId);
    await writer.appendSessionEvent("side_effect.reconciled", {
      effect_id: patchStarted.data.plan_id,
      effect_kind: "patch",
      evidence_sha256: "a".repeat(64),
      observed: "applied",
      source_run_id: patchStarted.runId,
    });
    goalRecovery = await new GoalChangeRecordReconciler({
      goalId: goal.data.goal_id,
      goalRevision: 1,
      randomUUID: runtime.randomUUID,
      workspace: cwd,
      writer,
    }).reconcile();
    expect(goalRecovery.recovered).toBe(1);
    ledger = projectGoalChangeLedger(writer.events, goal.data.goal_id, 1);
    expect(ledger?.records[0]?.data.source.kind).toBe("reconciled_patch");
    expect(ledger?.netChangedPaths).toEqual([target]);
    expect(
      writer.events.filter((event) => event.type === "patch.apply.completed"),
    ).toHaveLength(0);
    await writer.close();
  }, 20_000);
});
