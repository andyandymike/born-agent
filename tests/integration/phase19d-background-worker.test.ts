import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { runCli } from "../../src/cli/run-cli.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { taskMutationContext } from "../../src/commands/task-control-plane-command.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadExistingHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { NodeGitWorktreePort } from "../../src/worktrees/git-worktree-port.js";
import { ManagedWorktreeManager } from "../../src/worktrees/managed-worktree-manager.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const realBuiltWorkerTest = process.env.BORN_RUN_BUILT_WORKER_TEST === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 4096,
    maxAttempts: 3,
    maxChangedBytes: 4096,
    maxChangedFiles: 2,
    maxCommandExecutions: 3,
    maxCommandOutputBytes: 4096,
    maxDurationMs: 60_000,
    maxModelSteps: 0,
    maxReportedTokens: 0,
    ...overrides,
  };
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

async function waitForWaiting(input: {
  readonly operationId: string;
  readonly repositoryId: string;
  readonly workerId: string;
  readonly workerRoot: string;
  readonly workspace: string;
}): Promise<Awaited<ReturnType<SessionCatalog["read"]>>> {
  let last = "no readable projection";
  for (let index = 0; index < 600; index += 1) {
    try {
      const session = await new SessionCatalog(input.workspace).read(SESSION_ID);
      if (session.taskExecution?.status === "waiting_for_user" && session.background.current === null) return session;
      if (["blocked", "failed"].includes(session.taskExecution?.status ?? "") && session.background.current?.status !== "running") {
        const terminal = [...session.events].reverse().find((event) => event.scope === "session" && event.type === "task_node.attempt.terminal");
        const artifactId = terminal?.scope === "session" && terminal.type === "task_node.attempt.terminal" ? terminal.data.receipt_artifact_id : null;
        const receipt = artifactId === null || artifactId === undefined
          ? "no receipt"
          : (await (await ArtifactStore.create({ sessionId: SESSION_ID, workspace: input.workspace })).readVerified(artifactId)).bytes.toString("utf8");
        throw new Error(`background worker stopped ${session.taskExecution?.status}: ${receipt}`);
      }
      if (session.background.current?.status === "reconciliation_required") {
        const store = await BackgroundOperationStore.openExisting({
          operationId: input.operationId,
          repositoryId: input.repositoryId,
          root: input.workerRoot,
        });
        const diagnostic = await store.readFailureDiagnostic(input.workerId);
        throw new Error(`background worker reconciliation required: ${JSON.stringify(diagnostic)}`);
      }
      last = JSON.stringify({ background: session.background.current?.status ?? null, graph: session.taskExecution?.status ?? null });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("background worker ")) throw error;
      // The worker owns the exclusive writer during a durable transition. A
      // status poll waits; it never treats lock contention as completion.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`real background worker did not reach its bounded waiting terminal: ${last}`);
}

describe("Phase 19D bounded background worker", () => {
  realBuiltWorkerTest("hands a real built child durable ownership, exits on approval, and resumes with fresh authority", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bo-"));
    const userState = await mkdtemp(join(tmpdir(), "bs-"));
    roots.push(workspace, userState);
    const worktreeRoot = join(userState, "w");
    const workerRoot = join(userState, "k");
    await git(workspace, "init");
    await git(workspace, "config", "user.email", "phase19d@example.invalid");
    await git(workspace, "config", "user.name", "Phase 19D Fixture");
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Phase 19D fixture\n", "utf8");
    await mkdir(join(workspace, "fixtures"), { recursive: true });
    await cp(
      resolve("fixtures", "phase-07-fix-and-verify"),
      join(workspace, "fixtures", "phase-07-fix-and-verify"),
      { recursive: true },
    );
    await writeFile(
      join(workspace, "fixtures", "phase-07-fix-and-verify", "src", "clamp.mjs"),
      [
        "export function clamp(value, minimum, maximum) {",
        "  return Math.min(maximum, Math.max(minimum, value));",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(workspace, "add", ".gitignore", "AGENTS.md", "fixtures/phase-07-fix-and-verify");
    await git(workspace, "commit", "-m", "background fixture");
    await writeLegacySession(workspace);

    const setup = createRuntime({ cwd: workspace, randomUUID });
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Run one bounded background verification"], createMemoryIO().io, setup)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "Verification is durably replayable.", id: "verify", required: true, title: "Verify" }],
      schema_version: 1,
      title: "Background verification",
    }), "utf8");
    expect(await runCli(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"], createMemoryIO().io, setup)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli(["plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1", "--sha256", plan.planSha256], createMemoryIO().io, setup)).toBe(0);
    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: { goalId: goal.content.goalId, goalRevision: 1, planId: plan.planId, planRevision: 1, planSha256: plan.planSha256, sessionId: SESSION_ID },
      graphBudget: budget({
        maxArtifactBytes: 12_288,
        maxCommandExecutions: 3,
        maxCommandOutputBytes: 131_072,
        maxDurationMs: 180_000,
      }),
      graphId: "92000000-0000-4000-8000-000000000019",
      nodes: [{
        budget: budget({
          maxAttempts: 2,
          maxCommandExecutions: 1,
          maxCommandOutputBytes: 131_072,
          maxDurationMs: 120_000,
        }),
        dependsOn: [],
        kind: "verification",
        nodeId: "verify",
        objective: "Run the exact local verification command.",
        planItemIds: ["verify"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Verify fixture",
        verification: {
          argv: ["node", "verify.mjs"],
          cwd: "fixtures/phase-07-fix-and-verify",
          purpose: "Verify the trusted local-free fixture",
        },
        workspace: {
          declaredPathPrefixes: ["fixtures/phase-07-fix-and-verify"],
          mode: "managed_worktree",
        },
      }],
      schemaVersion: 1,
      title: "Bounded worker Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, setup)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, setup)).toBe(0);

    const manager = new ManagedWorktreeManager({
      context: taskMutationContext(setup, SESSION_ID),
      git: new NodeGitWorktreePort({ environment: process.env }),
      managedRoot: worktreeRoot,
      prompt: { request: async () => "approved" as const },
      repositoryRulesSha256: sha256Canonical({ fixture: "phase19d-rules" }),
    });
    await manager.allocate({ allowDirty: false, graphRevision: 1, graphSha256: graph.graphSha256, signal: new AbortController().signal, sourceNodeId: "verify" });

    const cliEntryPath = resolve("dist/cli.js");
    const environment = { ...process.env, LOCALAPPDATA: userState };
    const runtime = createNodeRuntime({
      approvalInput: { interactive: true, readLine: async () => "y" },
      cliEntryPath,
      cwd: workspace,
      env: environment,
      execPath: process.execPath,
      killProcess: (identity, signal) => process.kill(identity, signal),
      nodeVersion: process.versions.node,
      onCancel: () => () => undefined,
      platform: process.platform,
      version: "0.0.0",
      workerUserStateRoot: workerRoot,
      worktreeUserStateRoot: worktreeRoot,
    });
    if (runtime.controlPlaneStateRoot === undefined) {
      throw new Error("Phase 19D control root is unavailable");
    }
    expect(await runCli(["graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--runtime-profile", "local-free", "--background"], createMemoryIO().io, runtime)).toBe(0);
    const authority = await loadExistingHostControlAuthority({
      root: runtime.controlPlaneStateRoot,
    });
    const operations = new ControlOperationJournal(authority.paths);
    await waitForCompletedOperation({
      actionKind: "graph.enqueue",
      excludedOperationIds: new Set(),
      journal: operations,
    });
    const launchIo = createMemoryIO();
    expect(await runCli(["graph", "run", SESSION_ID, "--background", "--json"], launchIo.io, runtime), launchIo.readStderr()).toBe(0);
    const launched = JSON.parse(launchIo.readStdout()) as { readonly result: { readonly accepted: boolean; readonly operationId: string; readonly workerId: string } };
    expect(launched.result).toMatchObject({ accepted: true });
    expect(launchIo.readStdout()).not.toContain(userState);
    const repository = await new NodeGitWorktreePort({ environment }).observe(workspace);
    const waiting = await waitForWaiting({
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      workerId: launched.result.workerId,
      workerRoot,
      workspace,
    });
    expect(waiting.background.workers[0]).toMatchObject({ operationId: launched.result.operationId, status: "terminal", workerId: launched.result.workerId });
    expect(waiting.taskExecution?.nodes[0]?.attempts[0]?.status).toBe("terminal");
    const operationStore = await BackgroundOperationStore.openExisting({
      operationId: launched.result.operationId,
      repositoryId: repository.identity.repositoryId,
      root: workerRoot,
    });
    expect(await operationStore.readHandoffAuthority()).toMatchObject({
      handoff: { owner: "worker", state: "terminal" },
      protocol: "v2",
      revision: 2,
    });
    expect((await operationStore.inspectHandoff()).legacyLockPresent).toBe(false);
    expect(await lstat(operationStore.paths.handoff).then(() => true).catch(() => false)).toBe(false);

    const resumeIo = createMemoryIO();
    expect(await runCli(["graph", "resume", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--foreground", "--json"], resumeIo.io, runtime), resumeIo.readStderr()).toBe(8);
    const terminal = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(terminal.taskExecution?.status, JSON.stringify({
      blocker: terminal.taskExecution?.blocker,
      nodes: terminal.taskExecution?.nodes,
      stderr: resumeIo.readStderr(),
    })).toBe("awaiting_integration");
    expect(terminal.taskExecution?.nodes[0]?.attempts).toHaveLength(2);
    expect(
      await readFile(
        join(workspace, "fixtures", "phase-07-fix-and-verify", "verify.mjs"),
        "utf8",
      ),
    ).toContain("phase7 clamp verification passed");
    // The node may legitimately consume its complete 120s budget before the
    // worker publishes the durable terminal, and the enclosing Graph permits
    // 180s.  Keep this harness outside both domain budgets so a loaded hosted
    // runner reports the actual terminal instead of Vitest killing evidence
    // collection first.
  }, 210_000);
});
