import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundDeferredApprovalPrompt } from "../../src/background/background-approval-prompt.js";
import { queueBackgroundWorkerCancel } from "../../src/background/background-worker-control.js";
import { observeBackgroundWorkerLive } from "../../src/background/background-worker-live-status.js";
import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";

const REPOSITORY = "a".repeat(64);
const OPERATION = "10000000-0000-4000-8000-000000000019";
const WORKER = "20000000-0000-4000-8000-000000000019";
const GRAPH = "30000000-0000-4000-8000-000000000019";
const SESSION = "70000000-0000-4000-8000-000000000019";
const APPLICATION = "80000000-0000-4000-8000-000000000019";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function descriptor() {
  return {
    cliEntryPathSha256: "1".repeat(64),
    cliEntrySha256: "2".repeat(64),
    nodeExecutablePathSha256: "3".repeat(64),
    nodeExecutableSha256: "4".repeat(64),
    nodeVersion: "22.23.1",
    packageName: "bornagent" as const,
    packageRootInventorySha256: "5".repeat(64),
    packageVersion: "0.0.0",
    schemaVersion: 1 as const,
    workerProtocolVersion: 1 as const,
  };
}

describe("Phase 19D background protocol contracts", () => {
  it("keeps heartbeat live-only, queues an exact cancel, and consumes it once", async () => {
    const root = await mkdtemp(join(tmpdir(), "b19d-protocol-"));
    roots.push(root);
    const store = await BackgroundOperationStore.create({ operationId: OPERATION, repositoryId: REPOSITORY, root });
    await store.createHandoff({
      graphSha256: "b".repeat(64),
      operationId: OPERATION,
      owner: "worker",
      ownerPid: 1234,
      ownerProcessStartIdentity: "worker-start",
      parentNonceSha256: "c".repeat(64),
      schemaVersion: 1,
      state: "worker_owned",
      updatedAt: "2026-08-09T00:00:00.000Z",
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
    });
    await store.writeHeartbeat({
      activeAttemptId: null,
      graphSha256: "b".repeat(64),
      lastDurableSessionSeq: 12,
      observedAt: "2026-08-09T00:00:05.000Z",
      operationId: OPERATION,
      schemaVersion: 1,
      sequence: 1,
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
      workerPid: 1234,
      workerProcessStartIdentity: "worker-start",
    }, "nonce-one");
    await expect(store.writeHeartbeat({
      activeAttemptId: null,
      graphSha256: "b".repeat(64),
      lastDurableSessionSeq: 12,
      observedAt: "2026-08-09T00:00:06.000Z",
      operationId: OPERATION,
      schemaVersion: 1,
      sequence: 1,
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
      workerPid: 1234,
      workerProcessStartIdentity: "worker-start",
    }, "nonce-two")).rejects.toMatchObject({ code: "worker_handoff_conflict" });

    const current = {
      acceptedControlIds: [],
      descriptor: descriptor(),
      descriptorSha256: sha256Canonical(descriptor()),
      graphId: GRAPH,
      graphRevision: 1,
      graphSha256: "b".repeat(64),
      operationId: OPERATION,
      repositoryId: REPOSITORY,
      spawnEventId: "40000000-0000-4000-8000-000000000019",
      startedEventId: "50000000-0000-4000-8000-000000000019",
      status: "running" as const,
      terminal: null,
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
    };
    const live = await observeBackgroundWorkerLive({
      current,
      now: () => new Date("2026-08-09T00:00:10.000Z"),
      ownerProbe: { probe: async () => "matching" },
      userStateRoot: root,
    });
    expect(live).toMatchObject({ evidenceLevel: "process_and_heartbeat", heartbeatAgeMs: 5_000, state: "observed_running" });

    const queued = await queueBackgroundWorkerCancel({
      current,
      graphRevision: 1,
      graphSha256: "b".repeat(64),
      now: () => "2026-08-09T00:00:11.000Z",
      randomUuid: () => "60000000-0000-4000-8000-000000000019",
      reason: "stop exact worker",
      userStateRoot: root,
    });
    expect(queued.controlSha256).toBe(sha256Canonical(queued.control));
    expect(await store.listCancelControls()).toEqual([queued.control]);
    await store.consumeCancel(queued.control, "consume-once");
    expect(await store.listCancelControls()).toEqual([]);
    await expect(store.consumeCancel(queued.control, "consume-twice")).rejects.toMatchObject({ code: "worker_control_stale" });
  });

  it("defers the first exact approval without exposing a reusable allow decision", async () => {
    let deferred = 0;
    const prompt = new BackgroundDeferredApprovalPrompt(() => { deferred += 1; });
    const preview = {
      actionKind: "run_command" as const,
      actionSha256: "e".repeat(64),
      args: ["verify.mjs"],
      cwd: ".",
      executable: "node",
      purpose: "verify" as const,
      reviewLines: [],
      riskWarning: "local command",
    };
    expect(await prompt.request(preview, new AbortController().signal)).toBe("cancelled");
    expect(prompt.deferred?.requestedActionRef).toMatch(/^approval\/sha256\/[a-f0-9]{64}$/u);
    expect(await prompt.request(preview, new AbortController().signal)).toBe("cancelled");
    expect(deferred).toBe(1);
  });

  it("keeps an authenticated application cancel idempotent across active and consumed evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "b21a-control-"));
    roots.push(root);
    const store = await BackgroundOperationStore.create({ operationId: OPERATION, repositoryId: REPOSITORY, root });
    await store.createHandoff({
      graphSha256: "b".repeat(64),
      operationId: OPERATION,
      owner: "worker",
      ownerPid: 1234,
      ownerProcessStartIdentity: "worker-start",
      parentNonceSha256: "c".repeat(64),
      schemaVersion: 1,
      state: "worker_owned",
      updatedAt: "2026-08-12T00:00:00.000Z",
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
    });
    const current = {
      acceptedControlIds: [],
      descriptor: descriptor(),
      descriptorSha256: sha256Canonical(descriptor()),
      graphId: GRAPH,
      graphRevision: 1,
      graphSha256: "b".repeat(64),
      operationId: OPERATION,
      repositoryId: REPOSITORY,
      spawnEventId: "40000000-0000-4000-8000-000000000019",
      startedEventId: "50000000-0000-4000-8000-000000000019",
      status: "running" as const,
      terminal: null,
      workerId: WORKER,
      workerNonceSha256: "d".repeat(64),
    };
    const authenticatedMutation = {
      actionIdentitySha256: "e".repeat(64),
      applicationCommit: {
        actionKind: "graph.cancel",
        authorizationDecisionSha256: "f".repeat(64),
        operationId: APPLICATION,
        preparedActionSha256: "1".repeat(64),
        principalId: "phase21a-local-owner",
        schemaVersion: 1 as const,
      },
      authenticationId: "phase21a-authentication",
      requestId: "90000000-0000-4000-8000-000000000019",
      surface: { clientId: "phase21a-client", connectionId: "phase21a-connection", surface: "cli" as const },
    };
    const exact = {
      authenticatedMutation,
      current,
      graphRevision: 1,
      graphSha256: "b".repeat(64),
      now: () => "2026-08-12T00:00:02.000Z",
      randomUuid: () => "should-not-be-used",
      reason: "stop through the application operation",
      repositoryId: REPOSITORY,
      requestId: APPLICATION,
      requestedAt: "2026-08-12T00:00:01.000Z",
      sessionCancel: {
        eventId: "a0000000-0000-4000-8000-000000000019",
        rawEventSha256: "2".repeat(64),
        sessionSeq: 19,
      },
      sessionId: SESSION,
      userStateRoot: root,
    };
    expect(await store.readCancelEvidence(APPLICATION)).toBeNull();
    const first = await queueBackgroundWorkerCancel(exact);
    const retry = await queueBackgroundWorkerCancel(exact);
    expect(retry).toEqual(first);
    expect(await store.listCancelControls()).toEqual([first.control]);
    await store.consumeCancel(first.control, "response-lost");
    expect(await store.readCancelEvidence(APPLICATION)).toEqual(first.control);
    expect(await queueBackgroundWorkerCancel(exact)).toEqual(first);
    await expect(queueBackgroundWorkerCancel({ ...exact, reason: "different semantic request" }))
      .rejects.toMatchObject({ code: "worker_handoff_conflict" });
  });
});
