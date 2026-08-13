import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { DefaultApplicationQueryService } from "../../src/control-plane/application-query-service.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
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
  it.each(["active_attempt", "workspace_pre_admission"] as const)(
    "turns product foreground Graph SIGINT into typed durable cancellation at %s",
    async (cancelWindow) => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(join(workspace, "plan-cancel.json"), JSON.stringify({
      items: [{ acceptance: "Cancellation is durable.", id: "cancel-graph", required: true, title: "Cancel Graph" }],
      schema_version: 1,
      title: "Graph cancellation plan",
    }), "utf8");
    const hostSigintListeners = new Set<() => void>();
    let markCancellationWindowReady: (() => void) | undefined;
    const cancellationWindowReady = new Promise<void>((resolve) => { markCancellationWindowReady = resolve; });
    let startCalls = 0;
    const runtime = createRuntime({
      controlPlaneStateRoot: join(workspace, "phase21a-control-cancel"),
      createTaskAttemptExecutor: () => cancelWindow === "active_attempt" ? ({
        start: async ({ signal }) => {
          startCalls += 1;
          return ({
          attemptStartedPersisted: true,
          result: new Promise((resolve) => {
            markCancellationWindowReady?.();
            const finish = () => resolve({
              budget: {
                artifactBytes: 0,
                attempts: 1,
                changedBytes: 0,
                changedFiles: 0,
                commandExecutions: 0,
                commandOutputBytes: 0,
                durationMs: 1,
                modelSteps: 0,
                reportedTokens: 0,
              },
              receiptArtifactId: null,
              receiptSha256: null,
              terminal: "cancelled_clean" as const,
              usageCompleteness: "complete" as const,
            });
            if (signal.aborted) finish();
            else signal.addEventListener("abort", finish, { once: true });
          }),
        });
        },
        supports: () => true,
      }) : ({
        prepareWorkspace: async ({ signal }) => new Promise((resolve) => {
          markCancellationWindowReady?.();
          const finish = () => resolve(Object.freeze({ binding: null, executionRoot: workspace }));
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        }),
        start: async () => {
          startCalls += 1;
          throw new Error("attempt must not start after a pre-admission Graph cancellation");
        },
        supports: () => true,
      }),
      cwd: workspace,
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
    });
    let io = createMemoryIO();
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Cancel foreground Graph"], io.io, runtime), io.readStderr()).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    io = createMemoryIO();
    expect(await runCli([
      "plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId,
      "--goal-revision", "1", "--file", "plan-cancel.json",
    ], io.io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    io = createMemoryIO();
    expect(await runCli([
      "plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId,
      "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1",
      "--sha256", plan.planSha256,
    ], io.io, runtime)).toBe(0);
    await writeFile(join(workspace, "graph-cancel.json"), JSON.stringify({
      binding: {
        goalId: goal.content.goalId,
        goalRevision: 1,
        planId: plan.planId,
        planRevision: 1,
        planSha256: plan.planSha256,
        sessionId: SESSION_ID,
      },
      graphBudget: budget(),
      graphId: "91000000-0000-4000-8000-000000000021",
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget({ maxAttempts: 1 }),
        dependsOn: [],
        kind: "agent",
        nodeId: "wait",
        objective: "Wait for typed cancellation.",
        planItemIds: ["cancel-graph"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Wait",
        workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Cancellable Graph",
    }), "utf8");
    io = createMemoryIO();
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph-cancel.json"], io.io, runtime)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    io = createMemoryIO();
    expect(await runCli([
      "graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
    ], io.io, runtime)).toBe(0);
    io = createMemoryIO();
    expect(await runCli([
      "graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256,
      "--runtime-profile", "local-free",
    ], io.io, runtime)).toBe(0);

    io = createMemoryIO();
    const execution = runCli(["graph", "run", SESSION_ID, "--foreground", "--json"], io.io, runtime);
    await cancellationWindowReady;
    expect(hostSigintListeners.size).toBeGreaterThan(0);
    for (const listener of [...hostSigintListeners]) listener();
    expect(await execution, io.readStderr()).toBe(130);

    const events = (await new SessionCatalog(workspace).read(SESSION_ID)).events;
    const cancel = events.find((event) => event.scope === "session" && event.type === "task_graph.cancel.requested");
    const attemptTerminal = events.find((event) => event.scope === "session" && event.type === "task_node.attempt.terminal");
    const graphTerminal = events.find((event) => event.scope === "session" && event.type === "task_graph.terminal");
    expect(cancel?.scope === "session" && cancel.type === "task_graph.cancel.requested" && "origin" in cancel.data
      ? cancel.data.origin
      : null)
      .toMatchObject({ application_commit: { action_kind: "graph.cancel" }, kind: "authenticated_surface" });
    if (cancelWindow === "active_attempt") {
      expect(cancel!.sessionSeq).toBeLessThan(attemptTerminal!.sessionSeq);
      expect(attemptTerminal?.scope === "session" && attemptTerminal.type === "task_node.attempt.terminal"
        ? attemptTerminal.data.terminal
        : null).toBe("cancelled_clean");
      expect(attemptTerminal!.sessionSeq).toBeLessThan(graphTerminal!.sessionSeq);
      expect(startCalls).toBe(1);
    } else {
      expect(attemptTerminal).toBeUndefined();
      expect(events.some((event) => event.scope === "session" && event.type === "task_node.attempt.requested")).toBe(false);
      expect(cancel!.sessionSeq).toBeLessThan(graphTerminal!.sessionSeq);
      expect(startCalls).toBe(0);
    }
    expect(graphTerminal?.scope === "session" && graphTerminal.type === "task_graph.terminal"
      ? graphTerminal.data.status
      : null).toBe("cancelled");
    const authority = await loadOrCreateHostControlAuthority({ root: runtime.controlPlaneStateRoot! });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.some((operation) => operation.actionKind === "graph.run" && operation.state === "completed")).toBe(true);
    expect(operations.some((operation) => operation.actionKind === "graph.cancel" && operation.state === "completed")).toBe(true);
  }, 30_000);

  it("proposes, replaces, exact-approves, verifies the artifact, and replays without a model", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "Graph control is replayable.", id: "graph-control", required: true, title: "Add Graph control" }],
      schema_version: 1,
      title: "Phase 19 control",
    }), "utf8");
    const runtime = createRuntime({
      controlPlaneStateRoot: join(workspace, "phase21a-control"),
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
    const queryKinds: string[] = [];
    const originalQuery = DefaultApplicationQueryService.prototype.query;
    vi.spyOn(DefaultApplicationQueryService.prototype, "query").mockImplementation(async function (
      this: DefaultApplicationQueryService,
      context,
      request,
    ) {
      queryKinds.push(request.queryKind);
      return originalQuery.call(this, context, request);
    });

    let io = createMemoryIO();
    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Implement Phase 19"], io.io, runtime), io.readStderr()).toBe(0);
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
    ], io.io, runtime), io.readStderr()).toBe(8);

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
    io = createMemoryIO();
    expect(await runCli(["graph", "status", SESSION_ID, "--live", "--json"], io.io, runtime), io.readStderr()).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ result: { liveWorker: null } });
    io = createMemoryIO();
    expect(await runCli(["graph", "logs", SESSION_ID, "--json"], io.io, runtime), io.readStderr()).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ command: "graph.logs", result: { records: expect.any(Array) } });
    expect(io.readStdout()).not.toContain("objectRef");

    io = createMemoryIO();
    expect(await runCli(["graph", "worktrees", SESSION_ID, "--json"], io.io, runtime), io.readStderr()).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ command: "graph.worktrees", result: { workspaces: [] } });
    expect(io.readStdout()).not.toContain("objectRef");
    expect(queryKinds).toEqual(expect.arrayContaining([
      "graph.logs",
      "graph.revisions",
      "graph.status",
      "graph.worktrees",
      "plan.review",
    ]));
    const completed = await new SessionCatalog(workspace).read(SESSION_ID);
    const started = completed.events.find((event) => event.scope === "session" && event.type === "task_graph.started");
    expect(started?.scope === "session" && started.type === "task_graph.started" && "origin" in started.data
      ? started.data.origin
      : null).toMatchObject({
        application_commit: { action_kind: "graph.run" },
        kind: "authenticated_surface",
        surface: "cli",
      });
    expect(model).not.toHaveBeenCalled();
  }, 30_000);
});
