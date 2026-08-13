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
import type { DelegationRevisionDraftV1 } from "../../src/delegation/delegation-schema.js";
import {
  createCanonicalPhase20CodingFixture,
  createCanonicalPhase20GraphDelegationDraft,
} from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { BundledFakeModelQualificationGate } from "../../src/model/model-qualification-gate.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
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
const realBuiltPromotionTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, maxRetries: 5, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 1_048_576,
    maxAttempts: 4,
    maxChangedBytes: 32_768,
    maxChangedFiles: 4,
    maxCommandExecutions: 4,
    maxCommandOutputBytes: 524_288,
    maxDurationMs: 480_000,
    maxModelSteps: 12,
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
    { call: { argumentsJson: JSON.stringify(input), callId, name }, type: "tool_call" },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    {
      continuation: new FakeContinuation(callId),
      providerResponseId: `response-${callId}`,
      type: "turn_completed",
    },
  ];
}

function textTurn(text: string, id: string): readonly FakeModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    {
      continuation: new FakeContinuation(id),
      providerResponseId: `response-${id}`,
      type: "turn_completed",
    },
  ];
}

describe("Phase 20E delegated promotion composition", () => {
  realBuiltPromotionTest("resumes a waiting Graph from a verified coding receipt and keeps M10 promotion/origin authority", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20p-o-"));
    const userState = await mkdtemp(join(tmpdir(), "b20p-s-"));
    const worktreeRoot = join(userState, "w");
    const delegationRoot = join(userState, "d");
    roots.push(workspace, userState);

    await mkdir(dirname(join(workspace, fixtureRoot)), { recursive: true });
    await cp(resolve(fixtureRoot), join(workspace, fixtureRoot), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 20 delegated promotion fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase20 Promotion");
    await git(workspace, "config", "user.email", "phase20-promotion@bornagent.local");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    let proposal: DelegationRevisionDraftV1 | null = null;
    let acceptedReceiptSha256: string | null = null;
    let turn = 0;
    const backend = new FakeStreamingChatClient(async function* (request) {
      const currentTurn = turn;
      turn += 1;
      if (currentTurn === 0) {
        expect(request.tools.map((tool) => tool.name)).toContain("propose_delegation");
        if (proposal === null) throw new Error("canonical delegation proposal was not initialized");
        yield* toolTurn("propose_delegation", "delegate-clamp", { revision: proposal });
      } else if (currentTurn === 1) {
        yield* textTurn("The exact child proposal is ready for user review.", "delegation-wait");
      } else if (currentTurn === 2) {
        expect(acceptedReceiptSha256).not.toBeNull();
        expect(JSON.stringify(request)).toContain(acceptedReceiptSha256!);
        yield* textTurn("The Host-verified child receipt is ready for Graph integration.", "receipt-integrated");
      } else {
        throw new Error("unexpected delegated promotion model turn");
      }
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
    const environment = { ...process.env, LOCALAPPDATA: userState, XDG_STATE_HOME: userState };
    const node = createNodeRuntime({
      approvalInput: { interactive: true, readLine: async () => "y" },
      capabilityUserStateRoot: join(userState, "capabilities"),
      cliEntryPath: resolve("dist", "cli.js"),
      cwd: workspace,
      // The full built-path profile runs several real child fixtures in one
      // process. Keep the product 30s default unchanged and make this explicit
      // local evidence fixture tolerant of a loaded cold start.
      delegationHandshakeTimeoutMs: 60_000,
      delegationUserStateRoot: delegationRoot,
      env: environment,
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      taskAgentRuntimeOverrides: modelRuntime,
      version: "0.0.0-phase20-promotion",
      workerUserStateRoot: delegationRoot,
      worktreeUserStateRoot: worktreeRoot,
    });
    const runtime: CliRuntime = { ...node, ...modelRuntime, randomUUID };

    expect(await runCli([
      "goal", "set", SESSION_ID, "--text", "Promote one delegated verified clamp fix",
    ], createMemoryIO().io, runtime)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{
        acceptance: "The delegated clamp fix is verified and promoted exactly.",
        id: "delegate-promote",
        required: true,
        title: "Delegate, verify, and promote",
      }],
      schema_version: 1,
      title: "Phase 20 delegated promotion",
    }), "utf8");
    expect(await runCli([
      "plan", "replace", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--file", "plan.json",
    ], createMemoryIO().io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli([
      "plan", "approve", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--plan-id", plan.planId,
      "--revision", "1",
      "--sha256", plan.planSha256,
    ], createMemoryIO().io, runtime)).toBe(0);

    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: {
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sessionId: SESSION_ID,
      },
      graphBudget: budget({
        maxArtifactBytes: 2 * 1_048_576,
        maxDurationMs: 960_000,
        maxReportedTokens: 2 * 16_384,
      }),
      graphId: "99000000-0000-4000-8000-000000000020",
      nodes: [
        {
          agent: { mode: "build", taskProfile: "coding" },
          budget: budget({
            maxArtifactBytes: 524_288,
            maxAttempts: 2,
            maxCommandExecutions: 1,
            maxCommandOutputBytes: 131_072,
            maxDurationMs: 120_000,
            maxModelSteps: 4,
          }),
          dependsOn: [],
          kind: "agent",
          nodeId: "build",
          objective: "Delegate the clamp correction, then integrate only its verified receipt.",
          planItemIds: ["delegate-promote"],
          requiredCapabilities: [],
          retry: { automaticOn: [], maxAttempts: 2 },
          sequence: 1,
          title: "Delegated build",
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
          objective: "Verify the accepted delegated workspace snapshot.",
          planItemIds: ["delegate-promote"],
          requiredCapabilities: [],
          retry: { automaticOn: [], maxAttempts: 1 },
          sequence: 2,
          title: "Verify delegated snapshot",
          verification: {
            argv: ["node", "verify.mjs"],
            cwd: fixtureRoot,
            purpose: "verify",
          },
          workspace: { declaredPathPrefixes: [target], mode: "inherit_predecessor" },
        },
      ],
      schemaVersion: 1,
      title: "Phase 20 delegated promotion Graph",
    }), "utf8");
    expect(await runCli([
      "graph", "replace", SESSION_ID, "--file", "graph.json",
    ], createMemoryIO().io, runtime)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli([
      "graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
    ], createMemoryIO().io, runtime)).toBe(0);
    const allocationIo = createMemoryIO();
    expect(await runCli([
      "graph", "worktree-allocate", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--source-node", "build",
    ], allocationIo.io, runtime), allocationIo.readStderr()).toBe(0);
    let session = await new SessionCatalog(workspace).read(SESSION_ID);
    const managed = session.worktrees.workspaces[0]!;
    const source = await (await RepositorySourceSnapshotter.create(workspace, { environment })).snapshot();
    proposal = createCanonicalPhase20GraphDelegationDraft({
      managedWorkspaceId: managed.identity.workspaceId,
      sourceSnapshotSha256: source.snapshot.sourceStateSha256,
    });

    expect(await runCli([
      "graph", "enqueue", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
    ], createMemoryIO().io, runtime)).toBe(0);
    const firstRunIo = createMemoryIO();
    const firstRunExit = await runCli([
      "graph", "run", SESSION_ID, "--foreground",
    ], firstRunIo.io, runtime);
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const firstRunDiagnostic = JSON.stringify({
      attempts: session.events.filter((event) => event.scope === "session" && [
        "task_node.attempt.requested",
        "task_node.attempt.started",
        "task_node.attempt.waiting_for_user",
        "task_node.attempt.terminal",
      ].includes(event.type)).map((event) => ({ data: event.data, type: event.type })),
      executionBudget: session.taskExecution?.budget,
      delegations: session.delegations.revisions,
      latestRun: session.runs.at(-1)?.events.filter((event) => [
        "artifact.stored",
        "command.completed",
        "model.usage",
        "run.completed",
        "run.failed",
        "run.incomplete",
        "tool.call.completed",
        "tool.call.requested",
        "usage",
      ].includes(event.type)).map((event) => ({ data: event.data, type: event.type })) ?? null,
    }, null, 2);
    expect(firstRunExit, `${firstRunIo.readStderr()}\n${firstRunDiagnostic}`).toBe(8);
    expect(session.taskExecution?.status, `${firstRunIo.readStderr()}\n${firstRunDiagnostic}`).toBe("waiting_for_user");
    const firstAttempt = session.taskExecution!.nodes[0]!.attempts[0]!;
    const delegation = session.delegations.revisions[0]!;
    expect(delegation).toMatchObject({
      binding: {
        graphId: graph.graphId,
        graphRevision: graph.revision,
        graphSha256: graph.graphSha256,
        nodeAttemptId: firstAttempt.attemptId,
        nodeId: "build",
      },
      status: "draft",
    });

    const prepared = await createCanonicalPhase20CodingFixture({
      existingDelegationId: delegation.delegationId,
      graphId: graph.graphId,
      graphRevision: graph.revision,
      graphSha256: graph.graphSha256,
      goalId: goal.content.goalId,
      goalObjective: goal.content.objective,
      goalRevision: goal.content.revision,
      managedWorkspaceBaselineSha256: managed.baseline.manifestSha256,
      managedWorkspaceId: managed.identity.workspaceId,
      nodeId: "build",
      planId: plan.planId,
      planRevision: 1,
      planSha256: plan.planSha256,
      sessionId: SESSION_ID,
      workspace,
    });
    const childIo = createMemoryIO();
    expect(await runCli([
      "delegations", "start",
      "--session", SESSION_ID,
      "--delegation", prepared.delegationId,
      "--json",
    ], childIo.io, runtime), childIo.readStderr()).toBe(0);
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const accepted = session.delegations.revisions.find((revision) =>
      revision.delegationId === prepared.delegationId)!;
    expect(accepted.status).toBe("accepted");
    acceptedReceiptSha256 = accepted.receipt!.sha256;
    expect(await readFile(join(workspace, ...target.split("/")), "utf8")).not.toBe(fixedClamp);

    const resumeIo = createMemoryIO();
    const resumeExit = await runCli([
      "graph", "resume", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--foreground",
    ], resumeIo.io, runtime);
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const resumeDiagnostic = JSON.stringify({
      attempts: session.events.filter((event) => event.scope === "session" &&
        event.type.startsWith("task_node.attempt.")).map((event) => ({ data: event.data, type: event.type })),
      execution: session.taskExecution,
      runs: session.runs.map((run) => ({
        events: run.events.filter((event) => ["model.usage", "run.completed", "run.failed", "usage"].includes(event.type))
          .map((event) => ({ data: event.data, type: event.type })),
        runId: run.runId,
        status: run.status,
      })),
    }, null, 2);
    expect(resumeExit, `${resumeIo.readStderr()}\n${resumeDiagnostic}`).toBe(8);
    expect(
      session.taskExecution?.status,
      `${resumeIo.readStderr()}\n${resumeDiagnostic}`,
    ).toBe("awaiting_integration");
    expect(session.taskExecution?.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded"]);
    expect(session.taskExecution!.nodes[0]!.attempts).toHaveLength(2);
    expect(turn).toBe(3);

    const integratedAttempt = session.taskExecution!.nodes[0]!.attempts[1]!;
    const promotionIo = createMemoryIO();
    expect(await runCli([
      "graph", "promote", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--node-id", "build",
      "--attempt-id", integratedAttempt.attemptId,
    ], promotionIo.io, runtime), promotionIo.readStderr()).toBe(0);
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const promotionDiagnostic = JSON.stringify({
      execution: session.taskExecution,
      graphEvents: session.events.filter((event) => event.scope === "session" && (
        event.type === "goal.change.recorded" ||
        event.type === "plan.item.status_changed" ||
        event.type === "task_graph.terminal" ||
        event.type.startsWith("task_origin_verification.") ||
        event.type.startsWith("task_worktree.promotion")
      )),
      taskState: session.taskState,
      worktrees: session.worktrees,
    }, null, 2);
    expect(await readFile(join(workspace, ...target.split("/")), "utf8")).toBe(fixedClamp);
    expect(session.taskExecution?.status, promotionDiagnostic).toBe("completed");
    expect(session.worktrees.promotions).toHaveLength(1);
    expect(session.worktrees.originVerifications).toEqual([
      expect.objectContaining({ status: "passed" }),
    ]);
    expect(session.taskState.plans.find((candidate) =>
      candidate.content.planId === plan.planId)?.status).toBe("completed");
    expect(session.taskState.goals.find((candidate) =>
      candidate.content.goalId === goal.content.goalId)?.status).toBe("completed");
  }, 180_000);
});
