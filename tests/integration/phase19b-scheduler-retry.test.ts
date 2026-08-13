import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { planeForRuntime } from "../../src/control-plane/adapters/agent-cli-adapter.js";
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
    maxArtifactBytes: 12_288,
    maxAttempts: 3,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 180_000,
    maxModelSteps: 6,
    maxReportedTokens: 8192,
    ...overrides,
  };
}

describe("Phase 19B deterministic scheduler retry", () => {
  it("requires an exact failed terminal and marks the fresh attempt as user-authorized", async () => {
    const workspace = await temporaryWorkspace();
    await writeLegacySession(workspace);
    await writeFile(join(workspace, "plan.json"), JSON.stringify({
      items: [{ acceptance: "A failed attempt can be retried exactly once.", id: "retry", required: true, title: "Retry safely" }],
      schema_version: 1,
      title: "Scheduler retry",
    }), "utf8");
    let calls = 0;
    const runtime = createRuntime({
      controlPlaneStateRoot: join(workspace, "phase21a-control"),
      createTaskAttemptExecutor: () => ({
        start: async () => {
          calls += 1;
          return {
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
              ...(calls === 1 ? { diagnosticCode: "fixture_known_failure" } : {}),
              receiptArtifactId: null,
              receiptSha256: null,
              terminal: calls === 1 ? "known_failed" as const : "succeeded" as const,
              usageCompleteness: "complete" as const,
            }),
          };
        },
        supports: () => true,
      }),
      cwd: workspace,
    });

    expect(await runCli(["goal", "set", SESSION_ID, "--text", "Exercise manual Graph retry"], createMemoryIO().io, runtime)).toBe(0);
    const goal = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.goals[0]!;
    expect(await runCli(["plan", "replace", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--file", "plan.json"], createMemoryIO().io, runtime)).toBe(0);
    const plan = (await new SessionCatalog(workspace).read(SESSION_ID)).taskState.pendingDraft!;
    expect(await runCli(["plan", "approve", SESSION_ID, "--goal-id", goal.content.goalId, "--goal-revision", "1", "--plan-id", plan.planId, "--revision", "1", "--sha256", plan.planSha256], createMemoryIO().io, runtime)).toBe(0);
    await writeFile(join(workspace, "graph.json"), JSON.stringify({
      binding: { goalId: goal.content.goalId, goalRevision: 1, planId: plan.planId, planRevision: 1, planSha256: plan.planSha256, sessionId: SESSION_ID },
      graphBudget: budget(),
      graphId: "93000000-0000-4000-8000-000000000019",
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: budget({ maxArtifactBytes: 4096, maxAttempts: 2, maxDurationMs: 60_000, maxModelSteps: 2, maxReportedTokens: 4096 }),
        dependsOn: [],
        kind: "agent",
        nodeId: "retry",
        objective: "Fail once, then succeed with fresh user authority.",
        planItemIds: ["retry"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Retry node",
        workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Manual retry Graph",
    }), "utf8");
    expect(await runCli(["graph", "replace", SESSION_ID, "--file", "graph.json"], createMemoryIO().io, runtime)).toBe(0);
    const graph = (await new SessionCatalog(workspace).read(SESSION_ID)).taskGraph.currentDraft!;
    expect(await runCli(["graph", "approve", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
    expect(await runCli(["graph", "enqueue", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256], createMemoryIO().io, runtime)).toBe(0);
    expect(await runCli(["graph", "run", SESSION_ID, "--foreground"], createMemoryIO().io, runtime)).toBe(8);

    let session = await new SessionCatalog(workspace).read(SESSION_ID);
    const failed = session.taskExecution?.nodes[0]?.attempts[0];
    expect(session.taskExecution?.status).toBe("failed");
    expect(failed?.terminal).toBe("known_failed");
    const stale = createMemoryIO();
    expect(await runCli(["graph", "retry", SESSION_ID, "--node", "retry", "--attempt", "1", "--terminal-event", "00000000-0000-4000-8000-000000000099"], stale.io, runtime)).toBe(8);
    expect(stale.readStderr()).toContain("control_stale_projection");
    expect(stale.readStderr()).not.toContain("control_operation_busy");
    expect(stale.readStderr()).not.toContain("Authorize attempt 1");
    expect((await (await planeForRuntime(runtime, createMemoryIO().io)).operations.list())
      .filter((candidate) => candidate.actionKind === "graph.retry")).toEqual([]);
    expect((await new SessionCatalog(workspace).read(SESSION_ID)).events
      .filter((event) => event.scope === "session" && event.type === "task_node.retry.requested")).toEqual([]);

    const retryIo = createMemoryIO();
    expect(await runCli(["graph", "retry", SESSION_ID, "--node", "retry", "--attempt", "1", "--terminal-event", failed!.terminalEventId!, "--json"], retryIo.io, runtime)).toBe(0);
    expect(JSON.parse(retryIo.readStdout())).toMatchObject({
      command: "graph.retry",
      result: { execution: { nodes: [{ nextAttemptOrigin: "user", status: "pending" }] }, resumeRequired: true },
    });
    expect(retryIo.readStderr()).toContain("Authorize attempt 1 of node retry for one fresh retry.");
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    const retryEvent = session.events.find((event) => event.scope === "session" && event.type === "task_node.retry.requested");
    expect(retryEvent?.scope === "session" && retryEvent.type === "task_node.retry.requested" && "origin" in retryEvent.data
      ? retryEvent.data
      : null).toMatchObject({
        origin: {
          application_commit: { action_kind: "graph.retry" },
          kind: "authenticated_surface",
        },
        previous_terminal: "known_failed",
      });
    const operation = (await (await planeForRuntime(runtime, createMemoryIO().io)).operations.list())
      .find((candidate) =>
        candidate.actionKind === "graph.retry" &&
        candidate.domainRecordRefs.some((reference) => reference.recordId === retryEvent?.eventId)
      );
    expect(operation).toMatchObject({
      domainRecordRefs: [{ recordId: retryEvent?.eventId }],
      state: "completed",
      underlyingOperationRefs: [],
    });
    const rawLine = (await readFile(join(workspace, ".bornagent", "sessions", `${SESSION_ID}.jsonl`), "utf8"))
      .trimEnd()
      .split("\n")
      .find((line) => (JSON.parse(line) as { event_id: string }).event_id === retryEvent?.eventId);
    expect(operation?.primaryDomainRecord?.recordSha256).toBe(createHash("sha256").update(rawLine!, "utf8").digest("hex"));
    expect(await runCli(["graph", "resume", SESSION_ID, "--revision", "1", "--sha256", graph.graphSha256, "--foreground"], createMemoryIO().io, runtime)).toBe(0);
    session = await new SessionCatalog(workspace).read(SESSION_ID);
    expect(session.taskExecution?.status).toBe("completed");
    expect(session.taskExecution?.nodes[0]?.attempts.map((attempt) => attempt.retryOrigin)).toEqual(["initial", "user"]);

    const logs = createMemoryIO();
    expect(await runCli(["graph", "logs", SESSION_ID, "--node", "retry", "--json"], logs.io, runtime)).toBe(0);
    const logDocument = JSON.parse(logs.readStdout()) as { readonly result: { readonly records: readonly unknown[] } };
    expect(logDocument.result.records).toHaveLength(2);
    expect(logs.readStdout()).toContain("fixture_known_failure");
  }, 30_000);
});
