import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { taskMutationContext } from "../../src/commands/task-control-plane-command.js";
import { TaskOrchestrationCompletionComposer } from "../../src/coordination/task-orchestration-completion.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeModelTurnSignal,
} from "../fakes/fake-chat-client.js";
import { createMemoryIO } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const fixtureRoot = "fixtures/phase-07-fix-and-verify";
const target = `${fixtureRoot}/src/clamp.mjs`;
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
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true, maxRetries: 5 })
  ));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 1_048_576,
    maxAttempts: 2,
    maxChangedBytes: 16_384,
    maxChangedFiles: 2,
    maxCommandExecutions: 2,
    maxCommandOutputBytes: 262_144,
    maxDurationMs: 360_000,
    maxModelSteps: 8,
    maxReportedTokens: 16_384,
    ...overrides,
  };
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

describe("Phase 19E completion composition", () => {
  it("promotes a verified Graph snapshot and composes exact Plan, Graph, and Goal terminals", async () => {
    // Git 2.30 on Windows has a much smaller internal worktree admin-path
    // budget than modern Git, so this real integration fixture stays short.
    const workspace = await mkdtemp(join(tmpdir(), "b19e-o-"));
    const userState = await mkdtemp(join(tmpdir(), "b19e-s-"));
    const worktreeRoot = join(userState, "w");
    roots.push(workspace, userState);

    await mkdir(dirname(join(workspace, fixtureRoot)), { recursive: true });
    await cp(resolve(fixtureRoot), join(workspace, fixtureRoot), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 19E fixture rules\n", "utf8");
    await git(workspace, "init", "--quiet");
    await git(workspace, "config", "user.email", "phase19e@example.invalid");
    await git(workspace, "config", "user.name", "Phase 19E Fixture");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--quiet", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    const turns = [
      toolTurn("apply_patch", "graph-patch", { patch }),
      toolTurn("run_command", "graph-build-verify", {
        args: ["verify.mjs"],
        cwd: fixtureRoot,
        executable: "node",
        purpose: "verify",
        timeout_ms: 120_000,
      }),
      toolTurn("finish_task", "graph-finish", {
        status: "completed",
        summary: "The isolated Graph change passed its reviewed verification.",
      }),
    ];
    let turn = 0;
    const backend = new FakeStreamingChatClient(async function* (request) {
      expect(request.tools.map((tool) => tool.name)).not.toContain("update_plan");
      const signals = turns[turn++];
      if (signals === undefined) throw new Error("unexpected Graph model turn");
      yield* signals;
    }, { model: "qwen3:1.7b", provider: "ollama" });
    const modelRuntime = {
      agentModelEvidence: () => ({
        backend: "fake" as const,
        endpointScope: "in_process" as const,
        kind: "contract_verified" as const,
        remoteBillableRequests: 0 as const,
      }),
      createModelBackend: () => backend,
      modelQualificationGate: new BundledFakeModelQualificationGate(true),
    };
    const node = createNodeRuntime({
      approvalInput: { interactive: true, readLine: async () => "y" },
      capabilityUserStateRoot: join(userState, "capabilities"),
      cwd: workspace,
      // The controller root follows LOCALAPPDATA on Windows and XDG_STATE_HOME
      // on Linux. Bind both so this integration fixture never reuses a real or
      // prior-test Host authority after its temporary repository is removed.
      env: { ...process.env, LOCALAPPDATA: userState, XDG_STATE_HOME: userState },
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      taskAgentRuntimeOverrides: modelRuntime,
      version: "0.0.0-phase19e-composition",
      worktreeUserStateRoot: worktreeRoot,
    });
    const runtime: CliRuntime = {
      ...node,
      ...modelRuntime,
      randomUUID,
    };

    const goalIo = createMemoryIO();
    const goalExitCode = await runCli(
      ["goal", "set", SESSION_ID, "--text", "Promote a verified isolated change"],
      goalIo.io,
      runtime,
    );
    expect(
      goalExitCode,
      `goal set must succeed before the completion composition fixture continues\n${goalIo.readStderr()}${goalIo.readStdout()}`,
    ).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{
        acceptance: "The isolated patch passes verification and is promoted exactly.",
        id: "promote",
        required: true,
        title: "Build, verify, and promote",
      }],
      schema_version: 1,
      title: "Phase 19E composition",
    }), "utf8");
    expect(await runCli(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"], createMemoryIO().io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli(["plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1", "--sha256", plan.planSha256], createMemoryIO().io, runtime)).toBe(0);

    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: {
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sessionId: SESSION_ID,
      },
      graphBudget: budget(),
      graphId: "94000000-0000-4000-8000-000000000019",
      nodes: [
        {
          agent: { mode: "build", taskProfile: "coding" },
          budget: budget({
            maxArtifactBytes: 524_288,
            maxAttempts: 1,
            maxCommandExecutions: 1,
            maxCommandOutputBytes: 131_072,
            maxDurationMs: 120_000,
          }),
          dependsOn: [],
          kind: "agent",
          nodeId: "build",
          objective: "Fix the checked-in clamp fixture and finish only after the reviewed verification passes.",
          planItemIds: ["promote"],
          requiredCapabilities: [],
          retry: { automaticOn: [], maxAttempts: 1 },
          sequence: 1,
          title: "Build isolated patch",
          workspace: { declaredPathPrefixes: [target], mode: "managed_worktree" },
        },
        {
          budget: budget({
            maxArtifactBytes: 524_288,
            maxAttempts: 1,
            maxChangedBytes: 0,
            maxChangedFiles: 0,
            maxCommandExecutions: 1,
            maxCommandOutputBytes: 131_072,
            maxDurationMs: 120_000,
            maxModelSteps: 0,
            maxReportedTokens: 0,
          }),
          dependsOn: ["build"],
          kind: "verification",
          nodeId: "verify",
          objective: "Run the exact reviewed verification against the accepted workspace snapshot.",
          planItemIds: ["promote"],
          requiredCapabilities: [],
          retry: { automaticOn: [], maxAttempts: 1 },
          sequence: 2,
          title: "Verify accepted snapshot",
          verification: {
            argv: ["node", "verify.mjs"],
            cwd: fixtureRoot,
            purpose: "verify",
          },
          workspace: { declaredPathPrefixes: [target], mode: "inherit_predecessor" },
        },
      ],
      schemaVersion: 1,
      title: "Verified promotion Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, runtime)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
    const allocation = createMemoryIO();
    expect(await runCli(["graph", "worktree-allocate", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--source-node", "build"], allocation.io, runtime), allocation.readStderr()).toBe(0);
    expect(await runCli(["graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
    const graphRun = createMemoryIO();
    const graphExit = await runCli(["graph", "run", SESSION_ID, "--foreground"], graphRun.io, runtime);

    let session = await new SessionCatalog(workspace).read(SESSION_ID);
    const logs = createMemoryIO();
    await runCli(["graph", "logs", SESSION_ID, "--json"], logs.io, runtime);
    const graphDiagnostic = `${graphRun.readStderr()}\n${logs.readStdout()}\n${JSON.stringify(session.taskExecution?.nodes, null, 2)}`;
    expect(graphExit, graphDiagnostic).toBe(8);
    expect(
      session.taskExecution?.status,
      graphDiagnostic,
    ).toBe("awaiting_integration");
    expect(session.taskExecution?.nodes.map((candidate) => candidate.status)).toEqual(["succeeded", "succeeded"]);
    expect(backend.calls).toHaveLength(3);
    expect(await readFile(join(workspace, ...target.split("/")), "utf8")).not.toBe(fixedClamp);
    const buildAttempt = session.taskExecution!.nodes[0]!.attempts[0]!;

    const promotion = createMemoryIO();
    const promotionExit = await runCli([
      "graph", "promote", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--node-id", "build",
      "--attempt-id", buildAttempt.attemptId,
    ], promotion.io, runtime);

    let composeDiagnostic = "";
    if (promotionExit !== 0) {
      const writer = await V2SessionWriter.openExisting(workspace, SESSION_ID);
      try {
        await new TaskOrchestrationCompletionComposer({
          context: taskMutationContext(runtime, SESSION_ID),
          writer,
        }).compose();
      } catch (error) {
        composeDiagnostic = error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      } finally {
        await writer.close();
      }
    }
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(await readFile(join(workspace, ...target.split("/")), "utf8")).toBe(fixedClamp);
    const completionDiagnostic = JSON.stringify({
      execution: session.taskExecution,
      graphEvents: session.events.filter((event) => event.scope === "session" && (
        event.type === "task_graph.terminal" ||
        event.type === "goal.change.recorded" ||
        event.type === "task_node.attempt.terminal" ||
        event.type.startsWith("task_origin_verification.") ||
        event.type.startsWith("task_worktree.promotion") ||
        event.type === "task_worktree.snapshot.accepted"
      )),
      runs: session.runs.map((candidate) => ({
        binding: {
          agentMode: candidate.started.data.agent_mode,
          goalId: candidate.started.data.goal_id,
          goalRevision: candidate.started.data.goal_revision,
          planId: candidate.started.data.plan_id,
          planRevision: candidate.started.data.plan_revision,
          planSha256: candidate.started.data.plan_sha256,
          taskNode: candidate.started.data.task_node_binding,
        },
        completions: candidate.events.filter((event) => event.type === "completion.evaluated"),
        runId: candidate.runId,
        status: candidate.status,
      })),
      worktrees: session.worktrees,
    }, null, 2);
    expect(promotionExit, `${promotion.readStderr()}\n${composeDiagnostic}\n${completionDiagnostic}`).toBe(0);
    expect(session.taskExecution?.status, completionDiagnostic).toBe("completed");
    expect(session.taskState.plans.find((candidate) => candidate.content.planId === plan.planId)?.status).toBe("completed");
    expect(session.taskState.goals.find((candidate) => candidate.content.goalId === goal.content.goalId)?.status).toBe("completed");
    expect(session.events.filter((event) => event.scope === "session" && event.type === "plan.item.status_changed")).toHaveLength(2);
    const originEvents = session.events.filter((event) => event.scope === "session" && event.type.startsWith("task_origin_verification."));
    expect(originEvents.map((event) => event.type)).toEqual([
      "task_origin_verification.approved",
      "task_origin_verification.requested",
      "task_origin_verification.completed",
    ]);
    const completedOrigin = originEvents.at(-1);
    expect(completedOrigin?.scope === "session" && completedOrigin.type === "task_origin_verification.completed"
      ? {
          after: completedOrigin.data.after_source_state_sha256,
          before: completedOrigin.data.before_source_state_sha256,
          status: completedOrigin.data.status,
          target: completedOrigin.data.origin_source_snapshot_sha256,
        }
      : null).toEqual({
        after: session.worktrees.promotions[0]!.originSourceSnapshotSha256,
        before: session.worktrees.promotions[0]!.originSourceSnapshotSha256,
        status: "passed",
        target: session.worktrees.promotions[0]!.originSourceSnapshotSha256,
      });
    expect(session.worktrees.originVerifications).toHaveLength(1);
    expect(session.worktrees.originVerifications[0]?.status).toBe("passed");
    const promotionChange = session.events.find((event) => event.scope === "session" && event.type === "goal.change.recorded");
    const appliedPromotion = session.events.find((event) => event.scope === "session" && event.type === "task_worktree.promotion.applied");
    expect(promotionChange?.scope === "session" && promotionChange.type === "goal.change.recorded"
      ? {
          bundle: promotionChange.data.source.bundle_sha256,
          kind: promotionChange.data.source.kind,
          operation: promotionChange.data.source.operation_id,
          paths: promotionChange.data.files.map((file) => file.path),
        }
      : null).toEqual({
        bundle: session.worktrees.promotions[0]!.bundle.bundleSha256,
        kind: "task_promotion",
        operation: session.worktrees.promotions[0]!.operationId,
        paths: [target],
      });
    expect(promotionChange!.sessionSeq).toBeLessThan(appliedPromotion!.sessionSeq);
  }, 120_000);
});
