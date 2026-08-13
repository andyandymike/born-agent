import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import { createCanonicalPhase20CodingFixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { readVerifiedChildReceipt } from "../../src/delegation/receipts/child-receipt-verifier.js";
import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const realBuiltCodingTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
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

describe("Phase 20C real coding child worktree", () => {
  realBuiltCodingTest("applies an independently approved patch only in a managed worktree and returns a verified change receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20c-"));
    const userState = await mkdtemp(join(tmpdir(), "b20s-"));
    roots.push(workspace, userState);
    const worktreeRoot = join(userState, "w");
    const delegationRoot = join(userState, "d");
    await mkdir(dirname(join(workspace, "fixtures", "phase-07-fix-and-verify")), { recursive: true });
    await cp(
      resolve("fixtures", "phase-07-fix-and-verify"),
      join(workspace, "fixtures", "phase-07-fix-and-verify"),
      { recursive: true },
    );
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 20 coding fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase20 Coding");
    await git(workspace, "config", "user.email", "phase20-coding@bornagent.local");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    const setup = createRuntime({ cwd: workspace, randomUUID });
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Delegate one verified isolated clamp fix"], createMemoryIO().io, setup)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{
        acceptance: "A child fixes and verifies clamp only inside the managed worktree.",
        id: "delegate-fix",
        required: true,
        title: "Delegate isolated fix",
      }],
      schema_version: 1,
      title: "Phase 20 coding delegation",
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
      graphId: "96000000-0000-4000-8000-000000000020",
      nodes: [{
        agent: { mode: "build", taskProfile: "coding" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "build",
        objective: "Delegate the isolated clamp correction.",
        planItemIds: ["delegate-fix"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Build isolated fix",
        workspace: {
          declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"],
          mode: "managed_worktree",
        },
      }],
      schemaVersion: 1,
      title: "Phase 20 coding Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, setup)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, setup)).toBe(0);

    const environment = {
      ...process.env,
      LOCALAPPDATA: userState,
      XDG_STATE_HOME: userState,
    };
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
      version: "0.0.0-phase20-coding",
      workerUserStateRoot: delegationRoot,
      worktreeUserStateRoot: worktreeRoot,
    });
    const allocationIo = createMemoryIO();
    expect(await runCli([
      "graph", "worktree-allocate", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--source-node", "build",
    ], allocationIo.io, runtime), allocationIo.readStderr()).toBe(0);
    let session = await new SessionCatalog(workspace).read(SESSION_ID);
    const managed = session.worktrees.workspaces[0]!;
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
    const startIo = createMemoryIO();
    expect(await runCli([
      "delegations", "start",
      "--session", SESSION_ID,
      "--delegation", coding.delegationId,
      "--json",
    ], startIo.io, runtime), startIo.readStderr()).toBe(0);

    if (runtime.controlPlaneStateRoot === undefined) throw new Error("Phase 21A control root is unavailable");
    const authority = await loadOrCreateHostControlAuthority({ root: runtime.controlPlaneStateRoot });
    const startOperation = (await new ControlOperationJournal(authority.paths).list()).find((operation) =>
      operation.actionKind === "delegation.start");
    expect(startOperation).toMatchObject({ state: "completed" });
    expect(startOperation?.domainRecordRefs.length).toBeGreaterThanOrEqual(1);
    expect(startOperation?.underlyingOperationRefs.length).toBeGreaterThanOrEqual(10);
    const primary = startOperation?.primaryDomainRecord;
    if (primary === undefined || primary === null || primary.sequence === null) {
      throw new Error("Delegation start primary evidence is unavailable");
    }
    const rawLines = (await readFile(
      join(workspace, ".bornagent", "sessions", `${SESSION_ID}.jsonl`),
      "utf8",
    )).trimEnd().split("\n");
    const primaryRaw = rawLines[primary.sequence - 1];
    if (primaryRaw === undefined) throw new Error("Delegation start primary raw record is unavailable");
    expect(createHash("sha256").update(primaryRaw, "utf8").digest("hex")).toBe(primary.recordSha256);
    expect(JSON.parse(primaryRaw)).toMatchObject({
      data: { origin: { application_commit: { operation_id: startOperation?.operationId } } },
      type: "delegation.group.lease.acquired",
    });

    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const revision = session.delegations.revisions.find((candidate) =>
      candidate.delegationId === coding.delegationId)!;
    expect(revision.status).toBe("accepted");
    const receipt = await readVerifiedChildReceipt({ sessionId: SESSION_ID, workspace, revision });
    expect(receipt).toMatchObject({
      status: "succeeded",
      workspace: {
        logicalWorkspaceId: managed.identity.workspaceId,
        sourceSnapshotSha256: revision.content.workspace.sourceSnapshotSha256,
      },
    });
    expect(receipt.workspace.changeBundleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: "change-bundle", kind: "change_bundle", status: "verified" }),
    ]));
    expect(session.delegations.activeActorSlots).toEqual([]);
    expect(session.delegations.activeConflictClaims).toEqual([]);
    expect(session.events.filter((event) =>
      event.scope === "run" && event.type === "approval.decided" && event.data.decision === "approved").length).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(workspace, "fixtures", "phase-07-fix-and-verify", "src", "clamp.mjs"), "utf8"))
      .toContain("Math.min(minimum, Math.max(maximum, value))");
    const manager = await runtime.createManagedWorktreeManager!({ io: createMemoryIO().io, sessionId: SESSION_ID });
    const located = await manager.locate({
      graphId: graph.graphId,
      graphRevision: graph.revision,
      graphSha256: graph.graphSha256,
      nodeId: "build",
    });
    expect(await readFile(join(located.workspacePath, "fixtures", "phase-07-fix-and-verify", "src", "clamp.mjs"), "utf8"))
      .toContain("Math.min(maximum, Math.max(minimum, value))");
    const leases = await DelegationGroupLeaseStore.listExisting(delegationRoot);
    expect(await leases[0]!.read()).toMatchObject({ state: "released", releaseReason: "terminal" });
  }, 120_000);
});
