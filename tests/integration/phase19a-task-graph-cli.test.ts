import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { createMemoryIO, createRuntime } from "../helpers.js";
import {
  cleanupTemporaryWorkspaces,
  SESSION_ID,
  temporaryWorkspace,
  writeLegacySession,
} from "../unit/phase16b-test-helpers.js";

afterEach(cleanupTemporaryWorkspaces);

function budget(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    maxArtifactBytes: 4096,
    maxAttempts: 2,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 4,
    maxReportedTokens: 4096,
    ...overrides,
  };
}

describe("Phase 19A Graph CLI/control plane", () => {
  it("proposes, replaces, exact-approves, verifies the artifact, and replays without a model", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "Graph control is replayable.", id: "graph-control", required: true, title: "Add Graph control" }],
      schema_version: 1,
      title: "Phase 19 control",
    }), "utf8");
    const runtime = createRuntime({
      createTaskAttemptExecutor: () => ({
        start: async () => ({
          result: Promise.resolve({
            budget: {
              artifactBytes: 0,
              attempts: 1,
              changedBytes: 0,
              changedFiles: 0,
              commandExecutions: 0,
              commandOutputBytes: 0,
              durationMs: 5,
              modelSteps: 1,
              reportedTokens: 8,
            },
            receiptArtifactId: null,
            receiptSha256: null,
            terminal: "succeeded",
            usageCompleteness: "complete",
          }),
        }),
        supports: () => true,
      }),
      cwd: workspace,
    });
    const model = vi.spyOn(runtime, "createModelBackend");

    let io = createMemoryIO();
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Implement Phase 19"], io.io, runtime)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    io = createMemoryIO();
    expect(await runCli([
      "plan", "replace", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--file", "plan.json",
    ], io.io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    io = createMemoryIO();
    expect(await runCli([
      "plan", "approve", SESSION_ID,
      "--goal-id", goal.content.goalId,
      "--goal-revision", "1",
      "--plan-id", plan.planId,
      "--revision", "1",
      "--sha256", plan.planSha256,
    ], io.io, runtime)).toBe(0);

    const source = {
      binding: {
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sessionId: SESSION_ID,
      },
      graphBudget: budget(),
      graphId: "90000000-0000-4000-8000-000000000019",
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget({ maxAttempts: 1 }),
        dependsOn: [],
        kind: "agent",
        nodeId: "inspect",
        objective: "Inspect exact durable Graph facts.",
        planItemIds: ["graph-control"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Inspect Graph facts",
        workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Phase 19 Graph",
    };
    await writeFile(join(workspace, "graph.json"), JSON.stringify(source), "utf8");

    io = createMemoryIO();
    expect(await runCli(["graph", "validate", "--file", "graph.json", "--json"], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ command: "graph.validate", result: { nodeCount: 1 } });

    io = createMemoryIO();
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json", "--json"], io.io, runtime)).toBe(0);
    const first = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(first.graphId).not.toBe(source.graphId);

    source.title = "Phase 19 Graph revision two";
    await writeFile(join(workspace, "graph.json"), JSON.stringify(source), "utf8");
    io = createMemoryIO();
    expect(await runCli([
      "graph", "replace", SESSION_ID,
      "--file", "graph.json",
      "--base-revision", "1",
      "--base-sha256", first.graphSha256,
      "--json",
    ], io.io, runtime)).toBe(0);
    const second = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(second).toMatchObject({ graphId: first.graphId, revision: 2 });

    io = createMemoryIO();
    expect(await runCli([
      "graph", "approve", SESSION_ID,
      "--revision", "2",
      "--sha256", "0".repeat(64),
    ], io.io, runtime)).toBe(8);

    io = createMemoryIO();
    expect(await runCli([
      "graph", "approve", SESSION_ID,
      "--revision", "2",
      "--sha256", second.graphSha256,
      "--json",
    ], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ graph: { revision: 2, status: "approved" } });

    io = createMemoryIO();
    expect(await runCli(["graph", "show", SESSION_ID, "--json"], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      result: {
        currentObservation: { binding: "current" },
        revisions: [{ status: "superseded" }, { status: "approved" }],
        trackingMode: "phase19",
      },
    });

    io = createMemoryIO();
    expect(await runCli([
      "graph", "enqueue", SESSION_ID,
      "--revision", "2",
      "--sha256", second.graphSha256,
      "--runtime-profile", "local-free",
      "--json",
    ], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      command: "graph.enqueue",
      result: { execution: { readyNodeIds: ["inspect"] } },
    });

    io = createMemoryIO();
    expect(await runCli(["graph", "run", SESSION_ID, "--foreground", "--json"], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      command: "graph.run",
      result: {
        execution: { graph: { status: "completed" }, nodes: [{ nodeId: "inspect", status: "succeeded" }] },
        startedAttempts: 1,
        stopReason: "completed",
      },
    });

    io = createMemoryIO();
    expect(await runCli(["graph", "status", SESSION_ID, "--json"], io.io, runtime)).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      result: { execution: { graph: { status: "completed" } } },
    });
    expect(model).not.toHaveBeenCalled();
  });
});
