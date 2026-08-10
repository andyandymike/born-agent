import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { createCanonicalPhase20CodingFixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { NodeGitWorktreePort } from "../../src/worktrees/git-worktree-port.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const realBuiltBackgroundDelegationTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, maxRetries: 5, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function budget() {
  return {
    maxArtifactBytes: 512 * 1024,
    maxAttempts: 2,
    maxChangedBytes: 32 * 1024,
    maxChangedFiles: 4,
    maxCommandExecutions: 2,
    maxCommandOutputBytes: 256 * 1024,
    maxDurationMs: 240_000,
    maxModelSteps: 8,
    maxReportedTokens: 4096,
  };
}

async function waitForBackgroundApprovalBoundary(input: {
  readonly operationId: string;
  readonly repositoryId: string;
  readonly workerId: string;
  readonly workerRoot: string;
  readonly workspace: string;
}) {
  let last = "unobserved";
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const session = await new SessionCatalog(input.workspace).read(SESSION_ID);
      if (session.taskExecution?.status === "waiting_for_user" && session.background.current === null) return session;
      if (session.background.current?.status === "reconciliation_required") {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.operationId,
          repositoryId: input.repositoryId,
          root: input.workerRoot,
        });
        const diagnostic = await store.readFailureDiagnostic(input.workerId);
        throw new Error(`background delegation reconciliation required: ${JSON.stringify(diagnostic)}`);
      }
      last = JSON.stringify({
        background: session.background.current?.status ?? null,
        graph: session.taskExecution?.status ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background delegation reconciliation")) throw error;
      // The sealed worker may own the exact writer while crossing a durable
      // boundary; polling never treats lock contention as completion.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`background delegation did not reach its foreground approval boundary: ${last}`);
}

describe("Phase 20D Phase 19 background-worker ownership", () => {
  realBuiltBackgroundDelegationTest("defers an effectful child to foreground approval without spawning a third model actor", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20w-"));
    const userState = await mkdtemp(join(tmpdir(), "b20u-"));
    roots.push(workspace, userState);
    const worktreeRoot = join(userState, "w");
    const workerRoot = join(userState, "k");
    const delegationRoot = join(userState, "d");
    await mkdir(dirname(join(workspace, "fixtures", "phase-07-fix-and-verify")), { recursive: true });
    await cp(resolve("fixtures", "phase-07-fix-and-verify"), join(workspace, "fixtures", "phase-07-fix-and-verify"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 20 background delegation fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase20 Background Delegation");
    await git(workspace, "config", "user.email", "phase20-background@bornagent.local");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    const setup = createRuntime({ cwd: workspace, randomUUID });
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Delegate one background-owned isolated fix"], createMemoryIO().io, setup)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{
        acceptance: "The worker stops durably before the child requires foreground effect approval.",
        id: "delegate-fix",
        required: true,
        title: "Delegate isolated fix",
      }],
      schema_version: 1,
      title: "Phase 20 background delegation",
    }), "utf8");
    expect(await runCli([
      "plan", "replace", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--file", "plan.json",
    ], createMemoryIO().io, setup)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli([
      "plan", "approve", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--plan-id", plan.planId,
      "--revision", "1",
      "--sha256", plan.planSha256,
    ], createMemoryIO().io, setup)).toBe(0);
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
      graphId: "97000000-0000-4000-8000-000000000020",
      nodes: [{
        agent: { mode: "build", taskProfile: "coding" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "build",
        objective: "Coordinate the isolated clamp correction.",
        planItemIds: ["delegate-fix"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Build isolated fix",
        workspace: { declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"], mode: "managed_worktree" },
      }],
      schemaVersion: 1,
      title: "Phase 20 background delegation Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, setup)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, setup)).toBe(0);

    const environment = { ...process.env, LOCALAPPDATA: userState, XDG_STATE_HOME: userState };
    const runtime = createNodeRuntime({
      approvalInput: { interactive: true, readLine: async () => "y" },
      capabilityUserStateRoot: join(userState, "capabilities"),
      cliEntryPath: resolve("dist", "cli.js"),
      cwd: workspace,
      delegationUserStateRoot: delegationRoot,
      env: environment,
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0-phase20-background",
      workerUserStateRoot: workerRoot,
      worktreeUserStateRoot: worktreeRoot,
    });
    const allocationIo = createMemoryIO();
    expect(await runCli([
      "graph", "worktree-allocate", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--source-node", "build",
    ], allocationIo.io, runtime), allocationIo.readStderr()).toBe(0);
    const allocated = await new SessionCatalog(workspace).read(SESSION_ID);
    const managed = allocated.worktrees.workspaces[0]!;
    const coding = await createCanonicalPhase20CodingFixture({
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

    expect(await runCli([
      "graph", "enqueue", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--runtime-profile", "local-free",
      "--background",
    ], createMemoryIO().io, runtime)).toBe(0);
    const launchIo = createMemoryIO();
    expect(await runCli(["graph", "run", SESSION_ID, "--background", "--json"], launchIo.io, runtime), launchIo.readStderr()).toBe(0);
    const launched = JSON.parse(launchIo.readStdout()) as {
      readonly result: { readonly operationId: string; readonly workerId: string };
    };
    const repository = await new NodeGitWorktreePort({ environment }).observe(workspace);
    const waiting = await waitForBackgroundApprovalBoundary({
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      workerId: launched.result.workerId,
      workerRoot,
      workspace,
    });
    const revision = waiting.delegations.revisions.find((candidate) => candidate.delegationId === coding.delegationId)!;
    expect(revision.status).toBe("queued");
    expect(waiting.events.filter((event) => event.scope === "session" && event.type === "delegation.child.started")).toHaveLength(0);
    expect(waiting.events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        reason: "approval_required",
        requested_action_ref: `delegation/${coding.delegationId}/${revision.delegationSha256}`,
      }),
      scope: "session",
      type: "task_graph.waiting_for_user",
    }));
    expect(waiting.background.workers.at(-1)?.status).toBe("terminal");
    expect(await DelegationGroupLeaseStore.listExisting(delegationRoot)).toHaveLength(0);

    const startIo = createMemoryIO();
    expect(await runCli([
      "delegations", "start",
      "--session", SESSION_ID,
      "--delegation", coding.delegationId,
      "--json",
    ], startIo.io, runtime), startIo.readStderr()).toBe(0);
    const terminal = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(terminal.delegations.revisions.find((candidate) => candidate.delegationId === coding.delegationId)?.status).toBe("accepted");
    expect(terminal.delegations.activeActorSlots).toEqual([]);
    expect(terminal.delegations.activeConflictClaims).toEqual([]);
  }, 150_000);
});
