import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { FakeStreamingChatClient, waitForAbort } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A real CLI application adapter", () => {
  it("turns product CLI SIGINT into one durable typed cancel before signalling Agent", async () => {
    const cwd = await directory("bornagent-phase21a-agent-sigint-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-agent-sigint-state-");
    const memory = createMemoryIO();
    const client = new FakeStreamingChatClient(waitForAbort());
    const hostSigintListeners = new Set<() => void>();
    const runtime = createRuntime({
      controlPlaneStateRoot,
      createModelBackend: () => client,
      cwd,
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
    });

    const execution = runCli([
      "agent",
      "wait for CLI SIGINT",
      "--mode",
      "plan",
      "--provider",
      "ollama",
      "--task-profile",
      "read-only",
      "--max-steps",
      "2",
    ], memory.io, runtime);
    await vi.waitFor(() => expect(client.calls).toHaveLength(1), { timeout: 10_000 });
    expect(hostSigintListeners.size).toBeGreaterThan(0);
    for (const listener of [...hostSigintListeners]) listener();
    await expect(execution).resolves.toBe(130);
    expect(memory.readStderr()).toContain("cancel requested:");

    const file = (await readdir(join(cwd, ".bornagent", "sessions")))
      .find((name) => name.endsWith(".jsonl"));
    if (file === undefined) throw new TypeError("Agent session file is unavailable");
    const events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    const requestIndex = events.findIndex((event) => event.type === "run.cancel.requested");
    const terminalIndex = events.findIndex((event) => event.type === "run.cancelled");
    expect(requestIndex).toBeGreaterThan(events.findIndex((event) => event.type === "run.started"));
    expect(terminalIndex).toBeGreaterThan(requestIndex);
    const request = events[requestIndex]!;
    expect(events[terminalIndex]?.data).toMatchObject({
      application_cancel_request: { request_event_id: request.eventId },
      reason: "user",
    });

    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.map((operation) => operation.actionKind).sort()).toEqual([
      "repository.register",
      "run.cancel",
      "session.create",
      "session.message.submit",
    ].sort());
    expect(operations.every((operation) => operation.state === "completed")).toBe(true);
  }, 20_000);

  it("re-prepares CLI cancellation at a fresh head after an owner append races the first prepare", async () => {
    const cwd = await directory("bornagent-phase21a-agent-cancel-head-race-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-agent-cancel-head-race-state-");
    const memory = createMemoryIO();
    let releaseDelta: (() => void) | undefined;
    let markModelStarted: (() => void) | undefined;
    const deltaGate = new Promise<void>((resolve) => { releaseDelta = resolve; });
    const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
    const client = new FakeStreamingChatClient(async function* (_request, signal) {
      markModelStarted?.();
      await deltaGate;
      yield { delta: "racing durable owner append", type: "text_delta" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const hostSigintListeners = new Set<() => void>();
    const runtime = createRuntime({
      controlPlaneStateRoot,
      createModelBackend: () => client,
      cwd,
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
    });
    const originalPrepare = DefaultAgentRunApplicationService.prototype.prepare;
    let injected = false;
    const runCancelPrepareHeads: number[] = [];
    vi.spyOn(DefaultAgentRunApplicationService.prototype, "prepare").mockImplementation(async function (
      this: DefaultAgentRunApplicationService,
      context,
      request,
    ) {
      const result = await originalPrepare.call(this, context, request);
      if (request.actionKind !== "run.cancel" || result.result === null) return result;
      const target = result.result.prepared.target;
      if (
        target.kind !== "existing_resource" ||
        target.expectedVersion.kind !== "session_ledger_head"
      ) throw new TypeError("run.cancel did not prepare an exact session head");
      const preparedHeadSequence = target.expectedVersion.head.sequence;
      runCancelPrepareHeads.push(preparedHeadSequence);
      if (!injected) {
        injected = true;
        releaseDelta?.();
        await vi.waitFor(async () => {
          const file = (await readdir(join(cwd, ".bornagent", "sessions")))
            .find((name) => name.endsWith(".jsonl"));
          if (file === undefined) throw new Error("session file is not available");
          const events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
          expect(events.length).toBeGreaterThan(preparedHeadSequence);
        }, { timeout: 10_000 });
      }
      return result;
    });

    const execution = runCli([
      "agent",
      "race cancellation against an owner append",
      "--mode",
      "plan",
      "--provider",
      "ollama",
      "--task-profile",
      "read-only",
      "--max-steps",
      "2",
    ], memory.io, runtime);
    await modelStarted;
    for (const listener of [...hostSigintListeners]) listener();
    expect(await execution, memory.readStderr()).toBe(130);
    expect(runCancelPrepareHeads.length).toBeGreaterThanOrEqual(2);
    expect(runCancelPrepareHeads[1]).toBeGreaterThan(runCancelPrepareHeads[0]!);
    expect(memory.readStderr()).not.toContain("control_stale_projection");
    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.filter((operation) => operation.actionKind === "run.cancel")).toHaveLength(1);
  }, 20_000);

  it("runs a fresh Agent through repository/session/message operations", async () => {
    const cwd = await directory("bornagent-phase21a-cli-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-cli-state-");
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["agent", "inspect the bounded fixture", "--task-profile", "read-only", "--max-steps", "1"],
      memory.io,
      createRuntime({ controlPlaneStateRoot, cwd }),
    );
    expect(exitCode, memory.readStderr()).toBe(0);
    expect(memory.readStderr()).toContain("Register this local repository with the BornAgent controller.");
    expect(memory.readStderr()).toContain("Submit a build Agent task to session");
    expect(memory.readStderr()).toContain("warning: The canonical root locator remains Host-internal");
    const names = await readdir(join(cwd, ".bornagent", "sessions"));
    const sessionFiles = names.filter((name) => name.endsWith(".jsonl"));
    expect(sessionFiles).toHaveLength(1);
    const events = await readStoredSession(join(cwd, ".bornagent", "sessions", sessionFiles[0]!));
    const started = events.find((event) => event.type === "run.started");
    expect(started?.data).toMatchObject({
      application_commit: {
        action_kind: "session.message.submit",
        principal_id: "local_owner",
      },
    });
    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.map((operation) => operation.actionKind).sort()).toEqual([
      "repository.register",
      "session.create",
      "session.message.submit",
    ].sort());
    expect(operations.every((operation) => operation.state === "completed")).toBe(true);
  });

  it("keeps Goal and Plan CLI syntax while committing authenticated domain events", async () => {
    const cwd = await directory("bornagent-phase21a-task-cli-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-task-cli-state-");
    const runtime = createRuntime({ controlPlaneStateRoot, cwd });
    const first = createMemoryIO();
    expect(await runCli(
      ["agent", "prepare a bounded plan", "--task-profile", "read-only", "--max-steps", "1"],
      first.io,
      runtime,
    ), first.readStderr()).toBe(0);
    const file = (await readdir(join(cwd, ".bornagent", "sessions"))).find((name) => name.endsWith(".jsonl"))!;
    const sessionId = file.slice(0, -".jsonl".length);
    const revised = createMemoryIO();
    expect(await runCli([
      "goal", "set", sessionId,
      "--text", "Ship the authenticated action registry",
    ], revised.io, runtime), revised.readStderr()).toBe(0);
    let events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    const initialGoal = events.find((event) => event.type === "goal.created");
    expect(initialGoal?.data).toMatchObject({
      origin: {
        application_commit: { action_kind: "goal.propose", principal_id: "local_owner" },
        kind: "authenticated_surface",
      },
      revision: 1,
    });
    const goalData = initialGoal!.data as { goal_id: string; revision: number };

    await writeFile(join(cwd, "phase21a-plan.json"), JSON.stringify({
      items: [{ acceptance: "Focused tests pass", id: "verify", required: true, title: "Verify Phase 21A" }],
      schema_version: 1,
      title: "Authenticated local control plane",
    }), "utf8");
    const proposed = createMemoryIO();
    expect(await runCli([
      "plan", "replace", sessionId,
      "--file", "phase21a-plan.json",
      "--goal-id", goalData.goal_id,
      "--goal-revision", "1",
    ], proposed.io, runtime), proposed.readStderr()).toBe(0);
    events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    const plan = events.find((event) => event.type === "plan.proposed");
    expect(plan?.data).toMatchObject({ origin: { application_commit: { action_kind: "plan.propose" } } });
    const planData = plan!.data as { content: { goalId: string; goalRevision: number; planId: string; revision: number }; plan_sha256: string };
    const approved = createMemoryIO();
    expect(await runCli([
      "plan", "approve", sessionId,
      "--goal-id", planData.content.goalId,
      "--goal-revision", String(planData.content.goalRevision),
      "--plan-id", planData.content.planId,
      "--revision", String(planData.content.revision),
      "--sha256", planData.plan_sha256,
    ], approved.io, runtime), approved.readStderr()).toBe(0);
    events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    expect(events.find((event) => event.type === "plan.approved")?.data).toMatchObject({
      origin: { application_commit: { action_kind: "plan.decide" }, kind: "authenticated_surface" },
    });

    const graphBudget = {
      maxArtifactBytes: 1_024,
      maxAttempts: 1,
      maxChangedBytes: 0,
      maxChangedFiles: 0,
      maxCommandExecutions: 0,
      maxCommandOutputBytes: 0,
      maxDurationMs: 60_000,
      maxModelSteps: 2,
      maxReportedTokens: 2_048,
    };
    await writeFile(join(cwd, "phase21a-graph.json"), JSON.stringify({
      binding: {
        goalId: planData.content.goalId,
        goalRevision: planData.content.goalRevision,
        planId: planData.content.planId,
        planRevision: planData.content.revision,
        planSha256: planData.plan_sha256,
        sessionId,
      },
      graphBudget,
      graphId: runtime.randomUUID(),
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: graphBudget,
        dependsOn: [],
        kind: "agent",
        nodeId: "verify",
        objective: "Verify the authenticated local control plane.",
        planItemIds: ["verify"],
        requiredCapabilities: [],
        retry: { automaticOn: ["pre_effect_infrastructure_failure"], maxAttempts: 1 },
        sequence: 1,
        title: "Verify Phase 21A",
        workspace: { declaredPathPrefixes: ["."], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Phase 21A Graph",
    }), "utf8");
    const graphProposed = createMemoryIO();
    expect(await runCli([
      "graph", "replace", sessionId,
      "--file", "phase21a-graph.json",
    ], graphProposed.io, runtime), graphProposed.readStderr()).toBe(0);
    events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    const graph = events.find((event) => event.type === "task_graph.proposed");
    expect(graph?.data).toMatchObject({ origin: { application_commit: { action_kind: "graph.propose" } } });
    const graphData = graph!.data as { graph_revision: number; graph_sha256: string };
    const graphApproved = createMemoryIO();
    expect(await runCli([
      "graph", "approve", sessionId,
      "--revision", String(graphData.graph_revision),
      "--sha256", graphData.graph_sha256,
    ], graphApproved.io, runtime), graphApproved.readStderr()).toBe(0);
    events = await readStoredSession(join(cwd, ".bornagent", "sessions", file));
    expect(events.find((event) => event.type === "task_graph.approved")?.data).toMatchObject({
      origin: { application_commit: { action_kind: "graph.decide" }, kind: "authenticated_surface" },
    });
    const authenticatedClientIds = events.flatMap((event) => {
      const origin = typeof event.data === "object" && event.data !== null && "origin" in event.data
        ? (event.data as { readonly origin?: { readonly client_id?: unknown; readonly kind?: unknown } }).origin
        : undefined;
      return origin?.kind === "authenticated_surface" && typeof origin.client_id === "string"
        ? [origin.client_id]
        : [];
    });
    expect(authenticatedClientIds.length).toBeGreaterThan(1);
    expect(new Set(authenticatedClientIds)).toHaveLength(1);
    for (const argv of [
      ["goal", "show", sessionId, "--json"],
      ["plan", "show", sessionId, "--json"],
      ["graph", "show", sessionId, "--json"],
    ]) {
      const shown = createMemoryIO();
      expect(await runCli(argv, shown.io, runtime), shown.readStderr()).toBe(0);
      expect(JSON.parse(shown.readStdout())).toMatchObject({ schemaVersion: 1, sessionId });
    }
  }, 30_000);
});
