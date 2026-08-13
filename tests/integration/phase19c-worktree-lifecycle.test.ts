import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { planeForRuntime } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { taskMutationContext } from "../../src/commands/task-control-plane-command.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../src/coordination/task-control-plane.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { NodeGitWorktreePort } from "../../src/worktrees/git-worktree-port.js";
import { ManagedWorktreeManager } from "../../src/worktrees/managed-worktree-manager.js";
import { WorktreePromotionRuntime } from "../../src/worktrees/promotion-runtime.js";
import { createMemoryIO, createRuntime, withoutApplicationControlPlane } from "../helpers.js";
import { SESSION_ID, writeLegacySession } from "../unit/phase16b-test-helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 3 })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 4096,
    maxAttempts: 1,
    maxChangedBytes: 4096,
    maxChangedFiles: 2,
    maxCommandExecutions: 1,
    maxCommandOutputBytes: 4096,
    maxDurationMs: 60_000,
    maxModelSteps: 4,
    maxReportedTokens: 4096,
    ...overrides,
  };
}

describe("Phase 19C managed worktree lifecycle", () => {
  it("keeps origin unchanged until exact approved promotion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase19c-origin-"));
    const state = await mkdtemp(join(tmpdir(), "b19c-"));
    roots.push(workspace, state);
    await git(workspace, "init");
    await git(workspace, "config", "user.email", "phase19c@example.invalid");
    await git(workspace, "config", "user.name", "Phase 19C Fixture");
    await writeFile(join(workspace, ".gitignore"), ".bornagent/\nplan.json\ngraph.json\n", "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# Fixture rules\n", "utf8");
    await writeFile(join(workspace, "message.txt"), "origin\n", "utf8");
    await git(workspace, "add", ".gitignore", "AGENTS.md", "message.txt");
    await git(workspace, "commit", "-m", "fixture baseline");
    await writeLegacySession(workspace);
    const io = createMemoryIO();
    let runtime = createRuntime({ cwd: workspace });
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Promote isolated work"], io.io, runtime)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "Origin receives an exact promotion.", id: "promote", required: true, title: "Promote work" }],
      schema_version: 1,
      title: "Worktree plan",
    }), "utf8");
    expect(await runCli(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"], createMemoryIO().io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli(["plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1", "--sha256", plan.planSha256], createMemoryIO().io, runtime)).toBe(0);
    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: { goalId: goal.content.goalId, goalRevision: 1, planId: plan.planId, planRevision: 1, planSha256: plan.planSha256, sessionId: SESSION_ID },
      graphBudget: budget(),
      graphId: "91000000-0000-4000-8000-000000000019",
      nodes: [{
        agent: { mode: "build", taskProfile: "coding" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "build",
        objective: "Change message.txt in the managed worktree.",
        planItemIds: ["promote"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Build in isolation",
        workspace: { declaredPathPrefixes: ["message.txt"], mode: "managed_worktree" },
      }],
      schemaVersion: 1,
      title: "Managed build",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, runtime)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);

    const prompt = { request: async () => "approved" as const };
    const gitPort = new NodeGitWorktreePort({ environment: process.env });
    const makeContext = (currentRuntime: typeof runtime, authenticatedMutation?: AuthenticatedTaskMutationBindingV1, inputSurface: "cli" | "tui" = "cli") => ({
      ...taskMutationContext(currentRuntime, SESSION_ID, inputSurface),
      ...(authenticatedMutation === undefined ? {} : { authenticatedApplication: authenticatedMutation }),
    });
    const makeManager = (currentRuntime: typeof runtime, authenticatedMutation?: AuthenticatedTaskMutationBindingV1, inputSurface?: "cli" | "tui") => new ManagedWorktreeManager({
      context: makeContext(currentRuntime, authenticatedMutation, inputSurface),
      git: gitPort,
      managedRoot: state,
      prompt,
      repositoryRulesSha256: sha256Canonical({ fixture: "rules" }),
    });
    let manager = makeManager(runtime);
    runtime = createRuntime({
      controlPlaneStateRoot: join(state, "phase21a-control"),
      cwd: workspace,
      randomUUID,
      createManagedWorktreeManager: async ({ authenticatedMutation, inputSurface }) => {
        manager = makeManager(runtime, authenticatedMutation, inputSurface);
        return manager;
      },
      createWorktreePromotionRuntime: async ({ authenticatedMutation, inputSurface }) => {
        manager = makeManager(runtime, authenticatedMutation, inputSurface);
        return new WorktreePromotionRuntime({
        context: makeContext(runtime, authenticatedMutation, inputSurface),
        manager,
        prompt,
        repositoryRulesSha256: sha256Canonical({ fixture: "rules" }),
      });
      },
      createTaskAttemptExecutor: () => ({
        prepareWorkspace: async (input) => {
          const handle = await manager.locate({ graphId: input.graph.graphId, graphRevision: input.graph.revision, graphSha256: input.graph.graphSha256, nodeId: input.node.nodeId });
          return {
            binding: {
              managed_path_sha256: handle.identity.managedPathSha256,
              repository_id: handle.identity.repositoryId,
              source_snapshot_sha256: sha256Canonical({ fixture: "source" }),
              workspace_baseline_sha256: handle.baselineManifestSha256,
              workspace_id: handle.identity.workspaceId,
            },
            executionRoot: handle.workspacePath,
          };
        },
        start: async (input) => {
          await writeFile(join(input.workspace.executionRoot, "message.txt"), "managed result\n", "utf8");
          const accepted = await manager.acceptSnapshot({ attemptId: input.attemptId, graph: input.graph, nodeId: input.node.nodeId });
          return {
            result: Promise.resolve({
              budget: { artifactBytes: 0, attempts: 1, changedBytes: accepted.changedBytes, changedFiles: accepted.changedFiles, commandExecutions: 0, commandOutputBytes: 0, durationMs: 1, modelSteps: 1, reportedTokens: 1 },
              receiptArtifactId: null,
              receiptSha256: null,
              terminal: "succeeded" as const,
              usageCompleteness: "complete" as const,
            }),
          };
        },
        supports: () => true,
      }),
    });
    manager = makeManager(runtime);

    const allocationIo = createMemoryIO();
    expect(await runCli(["graph", "worktree-allocate", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--source-node", "build"], allocationIo.io, runtime), allocationIo.readStderr()).toBe(0);
    expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe("origin\n");
    expect(await runCli(["graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
    const runIo = createMemoryIO();
    expect(await runCli(["graph", "run", SESSION_ID, "--foreground"], runIo.io, runtime), runIo.readStderr()).toBe(8);
    expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe("origin\n");
    const session = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(session.taskExecution?.status).toBe("awaiting_integration");
    const attempt = session.taskExecution?.nodes[0]?.attempts[0];
    expect(attempt?.workspaceBinding?.workspace_id).toBeTruthy();
    await writeFile(join(workspace, "message.txt"), "external edit\n", "utf8");
    const staleIo = createMemoryIO();
    expect(await runCli(["graph", "promote", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--node-id", "build", "--attempt-id", attempt!.attemptId], staleIo.io, withoutApplicationControlPlane(runtime))).toBe(8);
    expect(staleIo.readStderr()).toContain("worktree_promotion_stale");
    expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe("external edit\n");
    await writeFile(join(workspace, "message.txt"), "origin\n", "utf8");
    const promotionIo = createMemoryIO();
    expect(await runCli(["graph", "promote", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--node-id", "build", "--attempt-id", attempt!.attemptId], promotionIo.io, runtime), promotionIo.readStderr()).toBe(0);
    expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe("managed result\n");
    const cleanupIo = createMemoryIO();
    expect(await runCli(["graph", "worktree-cleanup", SESSION_ID, "--graph-id", graph.graphId, "--revision", "1", "--sha256", graph.graphSha256, "--node-id", "build", "--archive-and-remove"], cleanupIo.io, runtime), cleanupIo.readStderr()).toBe(0);
    const cleaned = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(cleaned.worktrees.workspaces[0]?.status).toBe("archived");
    expect(cleaned.worktrees.pendingOperationIds).toEqual([]);
    for (const [type, actionKind] of [
      ["task_worktree.allocation.prepared", "worktree.allocate"],
      ["task_worktree.promotion.proposed", "promotion.apply"],
      ["task_worktree.cleanup.requested", "worktree.cleanup"],
    ] as const) {
      const event = cleaned.events.find((candidate) => candidate.scope === "session" && candidate.type === type);
      expect(event?.scope === "session" && "origin" in event.data ? event.data.origin : null).toMatchObject({
        application_commit: { action_kind: actionKind },
        kind: "authenticated_surface",
      });
    }
    const operations = await (await planeForRuntime(runtime, createMemoryIO().io)).operations.list();
    const composite = operations.filter((operation) =>
      ["worktree.allocate", "promotion.apply", "worktree.cleanup"].includes(operation.actionKind)
    );
    expect(composite.map((operation) => operation.actionKind).sort()).toEqual([
      "promotion.apply",
      "worktree.allocate",
      "worktree.cleanup",
    ]);
    expect(composite.every((operation) =>
      operation.state === "completed" && operation.primaryDomainRecord !== null &&
      operation.domainRecordRefs.length >= 1 && operation.underlyingOperationRefs.length >= 1
    )).toBe(true);
    const rawLines = (await readFile(join(workspace, ".bornagent", "sessions", `${SESSION_ID}.jsonl`), "utf8"))
      .trimEnd()
      .split("\n");
    const rawHashes = new Map(rawLines.map((line) => {
      const eventId = (JSON.parse(line) as { event_id: string }).event_id;
      return [eventId, createHash("sha256").update(line, "utf8").digest("hex")] as const;
    }));
    for (const operation of composite) {
      for (const reference of [...operation.domainRecordRefs, ...operation.underlyingOperationRefs]) {
        expect(reference.recordSha256).toBe(rawHashes.get(reference.recordId));
      }
    }
  }, 30_000);
});
