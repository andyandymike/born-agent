import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { BackgroundWorkerTakeoverReconciler } from "../../src/background/background-worker-takeover.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { taskMutationContext } from "../../src/commands/task-control-plane-command.js";
import { runCli } from "../../src/cli/run-cli.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "../unit/phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

const WORKER_ID = "93000000-0000-4000-8000-000000000019";
const OPERATION_ID = "94000000-0000-4000-8000-000000000019";
const REPOSITORY_ID = "a".repeat(64);
const WORKER_NONCE_SHA256 = "b".repeat(64);
const PARENT_NONCE_SHA256 = "c".repeat(64);

function hash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function budget() {
  return {
    maxArtifactBytes: 4096,
    maxAttempts: 1,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 1,
    maxReportedTokens: 1024,
  };
}

async function queuedWorkerFixture() {
  const workspace = await temporaryWorkspace();
  await writeLegacySession(workspace);
  const runtime = createRuntime({ cwd: workspace, randomUUID });
  await writeFile(join(workspace, "plan.json"), JSON.stringify({
    items: [{ acceptance: "Takeover stays fail closed.", id: "takeover", required: true, title: "Take over safely" }],
    schema_version: 1,
    title: "Worker takeover",
  }), "utf8");
  expect(await runCli(["goal", "set", SESSION_ID, "--text", "Recover one dead worker"], createMemoryIO().io, runtime)).toBe(0);
  const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
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
    graphBudget: budget(),
    graphId: "95000000-0000-4000-8000-000000000019",
    nodes: [{
      agent: { mode: "plan", taskProfile: "read-only" },
      budget: budget(),
      dependsOn: [],
      kind: "agent",
      nodeId: "inspect",
      objective: "Inspect without effects.",
      planItemIds: ["takeover"],
      requiredCapabilities: [],
      retry: { automaticOn: [], maxAttempts: 1 },
      sequence: 1,
      title: "Inspect",
      workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
    }],
    schemaVersion: 1,
    title: "Takeover Graph",
  }), "utf8");
  expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, runtime)).toBe(0);
  const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
  expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
  expect(await runCli([
    "graph", "enqueue", SESSION_ID,
    "--revision", "1",
    "--sha256", graph.graphSha256,
    "--runtime-profile", "local-free",
    "--background",
  ], createMemoryIO().io, runtime)).toBe(0);

  const workerRoot = join(workspace, "worker-state");
  const descriptor = {
    cliEntryPathSha256: hash("cli-path"),
    cliEntrySha256: hash("cli-bytes"),
    nodeExecutablePathSha256: hash("node-path"),
    nodeExecutableSha256: hash("node-bytes"),
    nodeVersion: process.versions.node,
    packageName: "bornagent" as const,
    packageRootInventorySha256: hash("package"),
    packageVersion: "0.0.0",
    schemaVersion: 1 as const,
    workerProtocolVersion: 1 as const,
  };
  const descriptorSha256 = sha256Canonical(descriptor);
  const store = await BackgroundOperationStore.create({
    operationId: OPERATION_ID,
    repositoryId: REPOSITORY_ID,
    root: workerRoot,
  });
  await store.createLaunch({
    cliEntryPath: process.execPath,
    descriptor,
    descriptorSha256,
    graphId: graph.graphId,
    graphRevision: graph.revision,
    graphSha256: graph.graphSha256,
    launchDeadline: "2026-08-10T00:10:00.000Z",
    nodeExecutablePath: process.execPath,
    operationId: OPERATION_ID,
    originRoot: workspace,
    parentPid: 2_000_000_000,
    parentProcessStartIdentity: "dead-parent-start",
    repositoryId: REPOSITORY_ID,
    runtimeProfileId: "local-free",
    schemaVersion: 1,
    sessionId: SESSION_ID,
    workerId: WORKER_ID,
    workerNonceSha256: WORKER_NONCE_SHA256,
  });
  await store.createHandoff({
    graphSha256: graph.graphSha256,
    operationId: OPERATION_ID,
    owner: "parent",
    ownerPid: 2_000_000_000,
    ownerProcessStartIdentity: "dead-parent-start",
    parentNonceSha256: PARENT_NONCE_SHA256,
    schemaVersion: 1,
    state: "launching",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workerId: WORKER_ID,
    workerNonceSha256: WORKER_NONCE_SHA256,
  });
  const writer = await V2SessionWriter.openExisting(workspace, SESSION_ID);
  await writer.appendTaskGraphEvent("task_worker.spawn.requested", {
    descriptor,
    descriptor_sha256: descriptorSha256,
    graph_id: graph.graphId,
    graph_revision: graph.revision,
    graph_sha256: graph.graphSha256,
    operation_id: OPERATION_ID,
    repository_id: REPOSITORY_ID,
    worker_id: WORKER_ID,
    worker_nonce_sha256: WORKER_NONCE_SHA256,
  });
  await writer.close();
  return { graph, runtime, store, workerRoot, workspace };
}

describe("Phase 19D controlled worker takeover", () => {
  it("closes a confirmed-dead pre-attempt owner and leaves one fresh background queue", async () => {
    const value = await queuedWorkerFixture();
    const result = await new BackgroundWorkerTakeoverReconciler({
      context: taskMutationContext(value.runtime, SESSION_ID),
      ownerProbe: { probe: async () => "missing" },
      userStateRoot: value.workerRoot,
    }).reconcile({ graphRevision: 1, graphSha256: value.graph.graphSha256 });
    expect(result).toMatchObject({ observation: "not_started", operationId: OPERATION_ID });
    const session = await new SessionCatalog(value.workspace).read(SESSION_ID);
    expect(session.background.current).toBeNull();
    expect(session.taskExecution).toMatchObject({ activeAttempt: null, status: "queued" });
    expect(await value.store.readHandoff()).toMatchObject({ state: "terminal" });
  }, 20_000);

  it("refuses takeover while the exact process owner is still active", async () => {
    const value = await queuedWorkerFixture();
    await expect(new BackgroundWorkerTakeoverReconciler({
      context: taskMutationContext(value.runtime, SESSION_ID),
      ownerProbe: { probe: async () => "matching" },
      userStateRoot: value.workerRoot,
    }).reconcile({ graphRevision: 1, graphSha256: value.graph.graphSha256 })).rejects.toMatchObject({
      code: "worker_owner_active",
    });
    expect((await new SessionCatalog(value.workspace).read(SESSION_ID)).background.current).not.toBeNull();
  }, 20_000);

  it("repairs the event-first crash prefix without appending a duplicate reconciliation", async () => {
    const value = await queuedWorkerFixture();
    const handoff = await value.store.readHandoff();
    if (handoff === null) throw new Error("fixture handoff is missing");
    const writer = await V2SessionWriter.openExisting(value.workspace, SESSION_ID);
    const reconciled = await writer.appendTaskGraphEvent("task_worker.reconciled", {
      evidence_sha256: sha256Canonical({
        active_attempt: null,
        effect_ledger: "clean",
        graph_sha256: value.graph.graphSha256,
        handoff: sha256Canonical(handoff),
        observation: "not_started",
        operation_id: OPERATION_ID,
        owner_process: "missing",
      }),
      graph_id: value.graph.graphId,
      graph_revision: value.graph.revision,
      graph_sha256: value.graph.graphSha256,
      observation: "not_started",
      operation_id: OPERATION_ID,
      worker_id: WORKER_ID,
    });
    await writer.close();

    const reconciler = new BackgroundWorkerTakeoverReconciler({
      context: taskMutationContext(value.runtime, SESSION_ID),
      ownerProbe: { probe: async () => "missing" },
      userStateRoot: value.workerRoot,
    });
    const first = await reconciler.reconcile({ graphRevision: 1, graphSha256: value.graph.graphSha256 });
    const second = await reconciler.reconcile({ graphRevision: 1, graphSha256: value.graph.graphSha256 });
    expect(first.reconciledEventId).toBe(reconciled.eventId);
    expect(second.reconciledEventId).toBe(reconciled.eventId);
    expect(await value.store.readHandoff()).toMatchObject({ owner: "parent", state: "terminal" });
    const session = await new SessionCatalog(value.workspace).read(SESSION_ID);
    expect(session.events.filter((event) => event.type === "task_worker.reconciled")).toHaveLength(1);
  }, 20_000);
});
