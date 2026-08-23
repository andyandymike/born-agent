import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { DurableDelegationCancellationCursor } from "../../src/delegation/runtime/durable-delegation-cancellation-cursor.js";
import { DeterministicTaskScheduler } from "../../src/scheduling/deterministic-task-scheduler.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { SessionEventTailReader } from "../../src/sessions/session-event-tail-reader.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "./phase16b-test-helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await cleanupTemporaryWorkspaces();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tailFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-as52-tail-"));
  temporary.push(workspace);
  const sessionId = randomUUID();
  const goalId = randomUUID();
  const writer = await V2SessionWriter.createNew(workspace, sessionId);
  await writer.appendTaskEvent("goal.created", {
    goal_id: goalId,
    objective: "projection ownership",
    origin: { input_surface: "cli", kind: "user" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  await writer.close();
  return { goalId, sessionId, workspace };
}

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 4096,
    maxAttempts: 1,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 2,
    maxReportedTokens: 4096,
    ...overrides,
  };
}

describe("AS5.2 projection ownership", () => {
  it("scheduler mutation reuses the append-owned projection after one initial reconstruction", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(join(workspace, "as52-plan.json"), JSON.stringify({
      items: [{ acceptance: "The scheduler owns one projection path.", id: "projection", required: true, title: "Project once" }],
      schema_version: 1,
      title: "AS5.2 projection ownership",
    }), "utf8");
    const runtime = createRuntime({
      controlPlaneStateRoot: join(workspace, "as52-control"),
      cwd: workspace,
    });
    const run = async (argv: readonly string[]) => {
      const io = createMemoryIO();
      expect(await runCli([...argv], io.io, runtime), io.readStderr()).toBe(0);
    };
    await run(["goal", "set", SESSION_ID, "--text", "Own scheduler projections"]);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    await run([
      "plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId,
      "--goal-revision", "1", "--file", "as52-plan.json",
    ]);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    await run([
      "plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId,
      "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1",
      "--sha256", plan.planSha256,
    ]);
    await writeFile(join(workspace, "as52-graph.json"), JSON.stringify({
      binding: {
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sessionId: SESSION_ID,
      },
      graphBudget: budget(),
      graphId: randomUUID(),
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget(),
        dependsOn: [],
        kind: "agent",
        nodeId: "projection",
        objective: "Prove one initial scheduler reconstruction.",
        planItemIds: ["projection"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Projection owner",
        workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "AS5.2 Graph",
    }), "utf8");
    await run(["graph", "replace", SESSION_ID, "--file", "as52-graph.json"]);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    await run(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256]);
    await run([
      "graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
      "--runtime-profile", "local-free",
    ]);

    const mutations: Array<Readonly<{ cachedProjectionReads: number; initialReconstructionCount: number }>> = [];
    const scheduler = new DeterministicTaskScheduler({
      context: {
        inputSurface: "cli",
        now: () => "2026-08-23T00:00:00.000Z",
        randomUuid: randomUUID,
        sessionId: SESSION_ID,
        workspace,
      },
      executor: {
        start: async () => { throw new Error("startOwnership must not execute a node"); },
        supports: () => true,
      },
      projectionObservation: {
        onMutationProjection: (input) => { mutations.push(input); },
      },
      repositoryId: "b".repeat(64),
    });
    const execution = await scheduler.startOwnership();

    expect(execution.status).toBe("running");
    expect(mutations).toEqual([{ cachedProjectionReads: 1, initialReconstructionCount: 1 }]);
  }, 30_000);

  it("idle child cancellation polls keep exclusive full snapshot delta at zero", async () => {
    const fixture = await tailFixture();
    const fullSnapshots: string[] = [];
    const incrementalReads: Array<Readonly<{ anchorSequence: number; appendedEventCount: number }>> = [];
    const cursor = new DurableDelegationCancellationCursor({
      observation: {
        onFullSnapshot: ({ reason }) => { fullSnapshots.push(reason); },
        onIncrementalRead: (input) => { incrementalReads.push(input); },
      },
      sessionId: fixture.sessionId,
      target: {
        delegationId: randomUUID(),
        delegationRevision: 1,
        delegationSha256: "a".repeat(64),
        parentActorId: randomUUID(),
        parentRunId: randomUUID(),
      },
      workspace: fixture.workspace,
    });

    expect(await cursor.poll()).toBeNull();
    const fullAfterStartup = fullSnapshots.length;
    for (let index = 0; index < 10; index += 1) expect(await cursor.poll()).toBeNull();

    expect(fullSnapshots).toEqual(["startup"]);
    expect(fullSnapshots.length - fullAfterStartup).toBe(0);
    expect(incrementalReads).toHaveLength(10);
    expect(incrementalReads.every((read) => read.appendedEventCount === 0)).toBe(true);
  });

  it("recovers one exact cursor ambiguity and then fails closed", async () => {
    const fixture = await tailFixture();
    const initial = new SessionEventTailReader(fixture);
    await initial.read();
    const checkpoint = initial.checkpoint()!;
    const writer = await V2SessionWriter.openExisting(fixture.workspace, fixture.sessionId);
    await writer.appendTaskEvent("goal.revised", {
      base_revision: 1,
      goal_id: fixture.goalId,
      objective: "cursor recovery",
      origin: { input_surface: "cli", kind: "user" },
      revision: 2,
    });
    await writer.close();
    const reasons: string[] = [];
    const recovered = new SessionEventTailReader({
      cursor: { ...checkpoint, fileIdentity: `${checkpoint.fileIdentity}:ambiguous` },
      observation: { onFullSnapshot: ({ reason }) => { reasons.push(reason); } },
      sessionId: fixture.sessionId,
      workspace: fixture.workspace,
    });

    const suffix = await recovered.read();
    expect(suffix.mode).toBe("cursor_ambiguity");
    expect(suffix.events.map((event) => event.type)).toEqual(["goal.revised"]);
    expect(reasons).toEqual(["cursor_ambiguity"]);

    const exhausted = recovered.checkpoint()!;
    const ambiguousAgain = new SessionEventTailReader({
      cursor: { ...exhausted, fileIdentity: `${exhausted.fileIdentity}:ambiguous-again` },
      sessionId: fixture.sessionId,
      workspace: fixture.workspace,
    });
    await expect(ambiguousAgain.read()).rejects.toMatchObject({ code: "session_tail_cursor_ambiguous" });
  });
});
