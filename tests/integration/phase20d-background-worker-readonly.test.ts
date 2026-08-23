import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadExistingHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { PreparedActionStore } from "../../src/control-plane/prepared-action-store.js";
import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { DelegationOperationStore } from "../../src/delegation/delegation-operation-store.js";
import { createCanonicalPhase20CodingFixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { SessionPathPolicy } from "../../src/sessions/session-path-policy.js";
import { NodeGitWorktreePort } from "../../src/worktrees/git-worktree-port.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const realBuiltBackgroundReadOnlyTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, maxRetries: 5, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

async function waitForCompletedOperation(input: {
  readonly actionKind: string;
  readonly excludedOperationIds: ReadonlySet<string>;
  readonly journal: ControlOperationJournal;
}): Promise<void> {
  let last = "missing";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = (await input.journal.list()).find((candidate) =>
      candidate.actionKind === input.actionKind &&
      !input.excludedOperationIds.has(candidate.operationId)
    );
    last = operation === undefined
      ? "missing"
      : `${operation.operationId}:${operation.state}`;
    if (operation?.state === "completed") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${input.actionKind} Host operation did not complete: ${last}`);
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

async function waitForTerminalChildren(input: {
  readonly delegationIds: readonly string[];
  readonly operationId: string;
  readonly repositoryId: string;
  readonly workerId: string;
  readonly workerRoot: string;
  readonly workspace: string;
}) {
  const policy = await SessionPathPolicy.create(input.workspace);
  const paths = await policy.inspectExistingSession(SESSION_ID);
  let last = "unobserved";
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      // Polling is observation only: acquiring the exclusive catalog snapshot
      // lock here would contend with the worker and change the behavior under
      // test. Final assertions below return to the locked SessionCatalog path.
      const session = reconstructMultiRunSession(await readStoredSession(paths.sessionFilePath));
      const revisions = input.delegationIds.map((delegationId) =>
        session.delegations.revisions.find((candidate) => candidate.delegationId === delegationId));
      if (
        session.background.current === null &&
        revisions.every((revision) =>
          revision?.status === "accepted" && revision.receipt?.status === "succeeded")
      ) {
        return new SessionCatalog(input.workspace).read(SESSION_ID);
      }
      if (session.background.current?.status === "reconciliation_required") {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.operationId,
          repositoryId: input.repositoryId,
          root: input.workerRoot,
        });
        const diagnostic = await store.readFailureDiagnostic(input.workerId);
        const operationStores = await DelegationOperationStore.listExisting(input.workerRoot);
        const operations = await Promise.all(operationStores.map((operationStore) => operationStore.read()));
        throw new Error(`background read-only delegation reconciliation required: ${JSON.stringify({
          diagnostic,
          delegations: revisions.map((revision) => ({
            attempts: revision?.attempts.map((child) => ({
              terminal: child.terminal,
              unresolvedEffectIds: child.unresolvedEffectIds,
            })) ?? [],
            envelope: revision?.envelope?.envelopeSha256 ?? null,
            parentRunId: revision?.parentRunId ?? null,
            receipt: revision?.receipt?.status ?? null,
            sequence: revision?.content.sequence ?? null,
            status: revision?.status ?? null,
          })),
          activeActorSlots: session.delegations.activeActorSlots,
          activeConflictClaims: session.delegations.activeConflictClaims,
          barriers: session.delegations.barriers,
          graph: session.taskExecution?.status ?? null,
          lastSessionEvents: session.events.filter((event) => event.scope === "session").slice(-12).map((event) => event.type),
          operations: operations.map((operation) => operation === null ? null : ({
            childAttemptId: operation.childAttemptId,
            failure: operation.failure,
            processCleanup: operation.processCleanup,
            state: operation.state,
          })),
        })}`);
      }
      last = JSON.stringify({
        background: session.background.current?.status ?? null,
        delegations: revisions.map((revision) => revision?.status ?? null),
        graph: session.taskExecution?.status ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background read-only delegation reconciliation")) {
        throw error;
      }
      // The worker and its child coordinator use the exact session writer; a
      // transient lock observation is not a terminal or failure conclusion.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`background worker did not close two read-only children: ${last}`);
}

async function waitForActiveChildren(input: {
  readonly delegationIds: readonly string[];
  readonly operationId: string;
  readonly repositoryId: string;
  readonly workerId: string;
  readonly workerRoot: string;
  readonly workspace: string;
}) {
  const policy = await SessionPathPolicy.create(input.workspace);
  const paths = await policy.inspectExistingSession(SESSION_ID);
  let last = "unobserved";
  // A built Windows child imports the packaged CLI before emitting its first
  // nonce-bound handshake. Keep the observation window bounded but large
  // enough for two concurrent cold starts; the 180s test timeout remains the
  // outer liveness gate and any sidecar failure still fails immediately.
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      const events = await readStoredSession(paths.sessionFilePath);
      const session = reconstructMultiRunSession(events);
      const active = input.delegationIds.map((delegationId) =>
        session.delegations.revisions.find((candidate) => candidate.delegationId === delegationId));
      if (
        session.background.current?.status === "running" &&
        active.every((revision) => revision?.status === "active" &&
          revision.attempts.at(-1)?.startedEventId !== null)
      ) return session;
      if (session.background.current?.status === "reconciliation_required") {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.operationId,
          repositoryId: input.repositoryId,
          root: input.workerRoot,
        });
        throw new Error(`background active child reconciliation required: ${JSON.stringify(
          await store.readFailureDiagnostic(input.workerId),
        )}`);
      }
      last = JSON.stringify({
        background: session.background.current?.status ?? null,
        delegations: active.map((revision) => revision?.status ?? null),
        lastEvents: events.filter((event) => event.scope === "session").slice(-8).map((event) => event.type),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background active child reconciliation")) throw error;
      // Observation-only read can race a durable append; retry the same exact
      // subject until the bounded active-child window is visible.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const operationStores = await DelegationOperationStore.listExisting(input.workerRoot);
  const operations = await Promise.all(operationStores.map((store) => store.read()));
  const backgroundStore = await BackgroundOperationStore.openExisting({
    operationId: input.operationId,
    repositoryId: input.repositoryId,
    root: input.workerRoot,
  });
  throw new Error(`background children did not enter their active window: ${JSON.stringify({
    last,
    operations: operations.map((operation) => operation === null ? null : ({
      failure: operation.failure,
      operationId: operation.operationId,
      process: operation.process,
      processCleanup: operation.processCleanup,
      state: operation.state,
    })),
    workerFailure: await backgroundStore.readFailureDiagnostic(input.workerId),
  })}`);
}

async function waitForCancelledChildren(input: {
  readonly delegationIds: readonly string[];
  readonly operationId: string;
  readonly repositoryId: string;
  readonly workerId: string;
  readonly workerRoot: string;
  readonly workspace: string;
}) {
  const policy = await SessionPathPolicy.create(input.workspace);
  const paths = await policy.inspectExistingSession(SESSION_ID);
  let last = "unobserved";
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      const events = await readStoredSession(paths.sessionFilePath);
      const session = reconstructMultiRunSession(events);
      const revisions = input.delegationIds.map((delegationId) =>
        session.delegations.revisions.find((candidate) => candidate.delegationId === delegationId));
      if (
        session.background.current === null && session.taskExecution?.status === "cancelled" &&
        revisions.every((revision) => revision?.status === "cancelled")
      ) return new SessionCatalog(input.workspace).read(SESSION_ID);
      if (session.background.current?.status === "reconciliation_required") {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.operationId,
          repositoryId: input.repositoryId,
          root: input.workerRoot,
        });
        const operationStores = await DelegationOperationStore.listExisting(input.workerRoot);
        const operations = await Promise.all(operationStores.map((operationStore) => operationStore.read()));
        throw new Error(`background cancel cascade reconciliation required: ${JSON.stringify({
          activeActorSlots: session.delegations.activeActorSlots,
          activeConflictClaims: session.delegations.activeConflictClaims,
          barriers: session.delegations.barriers,
          events: events.filter((event) => event.scope === "session").slice(-30).map((event) => ({
            data: event.data,
            sequence: event.sessionSeq,
            type: event.type,
          })),
          operations: operations.map((operation) => operation === null ? null : ({
            failure: operation.failure,
            operationId: operation.operationId,
            process: operation.process,
            processCleanup: operation.processCleanup,
            state: operation.state,
          })),
          worker: await store.readFailureDiagnostic(input.workerId),
        })}`);
      }
      last = JSON.stringify({
        background: session.background.current?.status ?? null,
        delegations: revisions.map((revision) => revision?.status ?? null),
        graph: session.taskExecution?.status ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background cancel cascade reconciliation")) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`background cancel cascade did not reach a clean terminal: ${last}`);
}

describe("Phase 20D Phase 19 background-worker read-only delegation", () => {
  realBuiltBackgroundReadOnlyTest("owns one bounded group and launches two real read-only children", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b20r-"));
    const userState = await mkdtemp(join(tmpdir(), "b20v-"));
    roots.push(workspace, userState);
    const workerRoot = join(userState, "k");
    const delegationRoot = join(userState, "d");
    await mkdir(dirname(join(workspace, "fixtures", "phase-07-fix-and-verify")), { recursive: true });
    await cp(
      resolve("fixtures", "phase-07-fix-and-verify"),
      join(workspace, "fixtures", "phase-07-fix-and-verify"),
      { recursive: true },
    );
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 20 background read-only fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase20 Background ReadOnly");
    await git(workspace, "config", "user.email", "phase20-background-readonly@bornagent.local");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    const setup = createRuntime({ cwd: workspace, randomUUID });
    expect(await runCli([
      "goal", "set", SESSION_ID, "--text", "Run two background-owned read-only delegations",
    ], createMemoryIO().io, setup)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{
        acceptance: "Two sealed read-only child receipts close without foreground approval.",
        id: "delegate-read-only",
        required: true,
        title: "Delegate read-only checks",
      }],
      schema_version: 1,
      title: "Phase 20 background read-only delegation",
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
      graphId: "98000000-0000-4000-8000-000000000020",
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "inspect",
        objective: "Coordinate two bounded read-only child checks.",
        planItemIds: ["delegate-read-only"],
        requiredCapabilities: [
          `workspace:phase20-background-readonly@1.0.0/skill/gate#sha256:${"0".repeat(64)}`,
        ],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Inspect through children",
        workspace: {
          declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"],
          mode: "origin_read_only",
        },
      }],
      schemaVersion: 1,
      title: "Phase 20 background read-only Graph",
    }), "utf8");
    expect(await runCli([
      "graph", "replace", SESSION_ID, "--file", "graph.json",
    ], createMemoryIO().io, setup)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli([
      "graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
    ], createMemoryIO().io, setup)).toBe(0);

    const environment = { ...process.env, LOCALAPPDATA: userState, XDG_STATE_HOME: userState };
    const runtime = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
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
      version: "0.0.0-phase20-background-readonly",
      workerUserStateRoot: workerRoot,
      worktreeUserStateRoot: join(userState, "w"),
    });
    const delegationIds: string[] = [];
    for (const sequence of [1, 2]) {
      const prepared = await createCanonicalPhase20CodingFixture({
        graphId: graph.graphId,
        graphRevision: graph.revision,
        graphSha256: graph.graphSha256,
        goalId: goal.content.goalId,
        goalObjective: goal.content.objective,
        goalRevision: goal.content.revision,
        managedWorkspaceBaselineSha256: graph.graphSha256,
        managedWorkspaceId: randomUUID(),
        nodeId: "inspect",
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sequence,
        sessionId: SESSION_ID,
        taskProfile: "read-only",
        workspace,
      });
      delegationIds.push(prepared.delegationId);
    }

    expect(await runCli([
      "graph", "enqueue", SESSION_ID,
      "--revision", "1",
      "--sha256", graph.graphSha256,
      "--runtime-profile", "local-free",
      "--background",
    ], createMemoryIO().io, runtime)).toBe(0);
    if (runtime.controlPlaneStateRoot === undefined) throw new Error("Phase 21A control root is unavailable");
    const authority = await loadExistingHostControlAuthority({ root: runtime.controlPlaneStateRoot });
    const operationJournal = new ControlOperationJournal(authority.paths);
    const preparedStore = new PreparedActionStore(authority.integrityKey, authority.paths);
    const operationIdsBeforeRun = new Set((await operationJournal.list()).map((operation) => operation.operationId));
    const preparedFilesBeforeRun = new Set(await readdir(authority.paths.prepareRoot));
    const launchIo = createMemoryIO();
    expect(await runCli([
      "graph", "run", SESSION_ID, "--background", "--json",
    ], launchIo.io, runtime), launchIo.readStderr()).toBe(0);
    const launched = JSON.parse(launchIo.readStdout()) as {
      readonly result: { readonly operationId: string; readonly workerId: string };
    };
    const repository = await new NodeGitWorktreePort({ environment }).observe(workspace);
    const terminal = await waitForTerminalChildren({
      delegationIds,
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      workerId: launched.result.workerId,
      workerRoot,
      workspace,
    });

    expect(terminal.delegations.maximumObservedActiveChildren).toBe(2);
    expect(terminal.delegations.activeActorSlots).toEqual([]);
    expect(terminal.delegations.activeConflictClaims).toEqual([]);
    expect(terminal.events.filter((event) =>
      event.scope === "session" && event.type === "delegation.child.started")).toHaveLength(2);
    expect(terminal.events.filter((event) =>
      event.scope === "run" && event.type === "approval.requested")).toHaveLength(0);
    expect(terminal.background.workers.at(-1)?.status).toBe("terminal");

    const applicationOperations = await operationJournal.list();
    expect(applicationOperations.filter((operation) => operation.actionKind === "delegation.start")).toEqual([]);
    const preparedActions = await Promise.all(
      (await readdir(authority.paths.prepareRoot))
        .filter((name) => name.endsWith(".json"))
        .map((name) => preparedStore.read(name.slice(0, -".json".length))),
    );
    expect(preparedActions.filter((record) => record?.prepared.actionKind === "delegation.start")).toEqual([]);
    expect(applicationOperations
      .filter((operation) => !operationIdsBeforeRun.has(operation.operationId))
      .map((operation) => operation.actionKind)).toEqual(["graph.run"]);
    const preparedAfterRun = await readdir(authority.paths.prepareRoot);
    const workerWindowPreparedActions = await Promise.all(
      preparedAfterRun
        .filter((name) => name.endsWith(".json") && !preparedFilesBeforeRun.has(name))
        .map((name) => preparedStore.read(name.slice(0, -".json".length))),
    );
    expect(workerWindowPreparedActions.map((record) => record?.prepared.actionKind)).toEqual(["graph.run"]);

    const spawn = terminal.events.find((event) =>
      event.scope === "session" && event.type === "task_worker.spawn.requested" &&
      event.data.operation_id === launched.result.operationId);
    expect(spawn?.scope === "session" && spawn.type === "task_worker.spawn.requested" && "origin" in spawn.data
      ? spawn.data.origin
      : null).toMatchObject({
      application_commit: { action_kind: "graph.run", principal_id: "local_owner" },
      kind: "authenticated_surface",
      surface: "cli",
    });
    const graphRunOperationId = spawn?.scope === "session" && spawn.type === "task_worker.spawn.requested" &&
        "origin" in spawn.data && spawn.data.origin.kind === "authenticated_surface"
      ? spawn.data.origin.application_commit.operation_id
      : null;
    expect(applicationOperations.filter((operation) => operation.actionKind === "graph.run"))
      .toContainEqual(expect.objectContaining({ operationId: graphRunOperationId, state: "completed" }));

    const groupLease = terminal.events.find((event) =>
      event.scope === "session" && event.type === "delegation.group.lease.acquired");
    expect(groupLease?.scope === "session" && groupLease.type === "delegation.group.lease.acquired"
      ? groupLease.data
      : null).toMatchObject({
      coordinator_kind: "phase19_background_worker",
      parent_run_id: terminal.delegations.revisions.find((revision) =>
        revision.delegationId === delegationIds[0])?.parentRunId,
    });
    expect(groupLease?.scope === "session" && groupLease.type === "delegation.group.lease.acquired" &&
      "origin" in groupLease.data ? groupLease.data.origin : null).toMatchObject({
      application_commit: { action_kind: "graph.run", operation_id: graphRunOperationId },
      kind: "authenticated_surface",
    });
    const leases = await DelegationGroupLeaseStore.listExisting(workerRoot);
    expect(leases).toHaveLength(1);
    expect(await leases[0]!.read()).toMatchObject({
      ownerBackgroundOperationId: launched.result.operationId,
      ownerKind: "phase19_background_worker",
      releaseReason: "terminal",
      state: "released",
    });
  }, 180_000);

  realBuiltBackgroundReadOnlyTest("cascades an authenticated Graph cancel to active children without synthetic human authority", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "b21c-"));
    const userState = await mkdtemp(join(tmpdir(), "b21s-"));
    roots.push(workspace, userState);
    const workerRoot = join(userState, "k");
    const delegationRoot = join(userState, "d");
    await mkdir(dirname(join(workspace, "fixtures", "phase-07-fix-and-verify")), { recursive: true });
    await cp(resolve("fixtures", "phase-07-fix-and-verify"), join(workspace, "fixtures", "phase-07-fix-and-verify"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 21 background cancel cascade fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase21 Background Cancel");
    await git(workspace, "config", "user.email", "phase21-background-cancel@bornagent.local");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    await writeLegacySession(workspace);

    const setup = createRuntime({ cwd: workspace, randomUUID });
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Cancel two active background delegations"], createMemoryIO().io, setup)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "Both active children stop from one exact Graph cancel.", id: "cancel-active", required: true, title: "Cancel active children" }],
      schema_version: 1,
      title: "Phase 21 background cancel cascade",
    }), "utf8");
    expect(await runCli(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"], createMemoryIO().io, setup)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli(["plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1", "--sha256", plan.planSha256], createMemoryIO().io, setup)).toBe(0);
    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: { goalId: goal.content.goalId, goalRevision: 1, planId: plan.planId, planRevision: 1, planSha256: plan.planSha256, sessionId: SESSION_ID },
      graphBudget: budget(),
      graphId: "99000000-0000-4000-8000-000000000021",
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "inspect",
        objective: "Coordinate two cancellable read-only children.",
        planItemIds: ["cancel-active"],
        requiredCapabilities: [`workspace:phase20-background-readonly@1.0.0/skill/gate#sha256:${"0".repeat(64)}`],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Inspect through cancellable children",
        workspace: { declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Phase 21 background cancel Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, setup)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, setup)).toBe(0);

    const environment = {
      ...process.env,
      BORN_PHASE20_CANONICAL_FAKE_OBSERVATION_MS: "60000",
      LOCALAPPDATA: userState,
      XDG_STATE_HOME: userState,
    };
    const runtime = createNodeRuntime({
      approvalInput: { interactive: false, readLine: async () => null },
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
      version: "0.0.0-phase21-background-cancel",
      workerUserStateRoot: workerRoot,
      worktreeUserStateRoot: join(userState, "w"),
    });
    const delegationIds: string[] = [];
    for (const sequence of [1, 2]) {
      const prepared = await createCanonicalPhase20CodingFixture({
        graphId: graph.graphId,
        graphRevision: graph.revision,
        graphSha256: graph.graphSha256,
        goalId: goal.content.goalId,
        goalObjective: goal.content.objective,
        goalRevision: goal.content.revision,
        managedWorkspaceBaselineSha256: graph.graphSha256,
        managedWorkspaceId: randomUUID(),
        nodeId: "inspect",
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sequence,
        sessionId: SESSION_ID,
        taskProfile: "read-only",
        workspace,
      });
      delegationIds.push(prepared.delegationId);
    }
    expect(await runCli(["graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--runtime-profile", "local-free", "--background"], createMemoryIO().io, runtime)).toBe(0);
    if (runtime.controlPlaneStateRoot === undefined) throw new Error("Phase 21A control root is unavailable");
    const authority = await loadExistingHostControlAuthority({ root: runtime.controlPlaneStateRoot });
    const operations = new ControlOperationJournal(authority.paths);
    const beforeOperationIds = new Set((await operations.list()).map((operation) => operation.operationId));
    const launchIo = createMemoryIO();
    expect(await runCli(["graph", "run", SESSION_ID, "--background", "--json"], launchIo.io, runtime), launchIo.readStderr()).toBe(0);
    const launched = JSON.parse(launchIo.readStdout()) as { readonly result: { readonly operationId: string; readonly workerId: string } };
    const repository = await new NodeGitWorktreePort({ environment }).observe(workspace);
    await waitForActiveChildren({
      delegationIds,
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      workerId: launched.result.workerId,
      workerRoot,
      workspace,
    });
    await waitForCompletedOperation({
      actionKind: "graph.run",
      excludedOperationIds: beforeOperationIds,
      journal: operations,
    });
    const cancelIo = createMemoryIO();
    const cancelExit = await runCli([
      "graph", "cancel", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
      "--reason", "authenticated active child cascade", "--json",
    ], cancelIo.io, runtime);
    if (cancelExit !== 0) {
      const failed = reconstructMultiRunSession(await readStoredSession(
        (await (await SessionPathPolicy.create(workspace)).inspectExistingSession(SESSION_ID)).sessionFilePath,
      ));
      const recent = (await operations.list()).slice(-4).map((operation) => ({
        actionKind: operation.actionKind,
        operationId: operation.operationId,
        state: operation.state,
      }));
      throw new Error(`Graph cancel failed: ${JSON.stringify({
        exit: cancelExit,
        recent,
        sessionEvents: failed.events.filter((event) => event.scope === "session").slice(-12).map((event) => event.type),
        stderr: cancelIo.readStderr(),
      })}`);
    }

    const terminal = await waitForCancelledChildren({
      delegationIds,
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      workerId: launched.result.workerId,
      workerRoot,
      workspace,
    });
    expect(terminal.taskExecution?.status).toBe("cancelled");
    expect(terminal.delegations.revisions.filter((revision) => delegationIds.includes(revision.delegationId))
      .every((revision) => revision.status === "cancelled")).toBe(true);
    const cancels = terminal.events.filter((event) => event.scope === "session" && event.type === "delegation.cancel.requested");
    expect(cancels).toHaveLength(2);
    expect(cancels.every((event) => event.scope === "session" && event.type === "delegation.cancel.requested" &&
      event.data.root_event_id !== null && event.data.origin.kind === "authenticated_surface" &&
      event.data.origin.application_commit.action_kind === "graph.cancel")).toBe(true);
    expect(terminal.events.filter((event) => event.scope === "session" && event.type === "delegation.cancel.requested" &&
      event.data.origin.kind === "user")).toEqual([]);
    expect((await operations.list())
      .filter((operation) => !beforeOperationIds.has(operation.operationId))
      .map((operation) => operation.actionKind)
      .sort()).toEqual(["graph.cancel", "graph.run"]);
    expect((await operations.list()).filter((operation) => operation.actionKind === "delegation.cancel")).toEqual([]);
  }, 180_000);
});
