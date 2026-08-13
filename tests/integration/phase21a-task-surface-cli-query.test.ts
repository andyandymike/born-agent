import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { canonicalTaskGraphIdentity } from "../../src/task-graph/task-graph-identity.js";
import { taskGraphRevisionContentSchema } from "../../src/task-graph/task-graph-schema.js";
import { DefaultApplicationQueryService } from "../../src/control-plane/application-query-service.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import type { StableSessionApplicationSnapshotV1 } from "../../src/control-plane/session-projection-service.js";
import { createTaskSurfaceQueryDefinitions } from "../../src/control-plane/use-cases/task-surface-queries.js";
import type { DelegationChildOperationV1 } from "../../src/delegation/delegation-operation-schema.js";
import { createCanonicalPhase20Fixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { createDelegationChildOperation } from "../../src/delegation/delegation-operation-schema.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const execFile = promisify(nodeExecFile);
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
});

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

describe("Phase 21A task surface named queries", () => {
  it("hydrates verified Graph artifacts once and remains stable if storage mutates before execute", async () => {
    const workspace = await directory("bornagent-phase21a-graph-hydration-");
    const repositoryId = randomUUID();
    const sessionId = randomUUID();
    const graphId = randomUUID();
    const goalId = randomUUID();
    const planId = randomUUID();
    const content = taskGraphRevisionContentSchema.parse({
      binding: { goalId, goalRevision: 1, planId, planRevision: 1, planSha256: "a".repeat(64), sessionId },
      graphBudget: {
        maxArtifactBytes: 4096,
        maxAttempts: 1,
        maxChangedBytes: 0,
        maxChangedFiles: 0,
        maxCommandExecutions: 0,
        maxCommandOutputBytes: 0,
        maxDurationMs: 60_000,
        maxModelSteps: 1,
        maxReportedTokens: 100,
      },
      graphId,
      nodes: [{
        agent: { mode: "plan", taskProfile: "read-only" },
        budget: {
          maxArtifactBytes: 4096,
          maxAttempts: 1,
          maxChangedBytes: 0,
          maxChangedFiles: 0,
          maxCommandExecutions: 0,
          maxCommandOutputBytes: 0,
          maxDurationMs: 60_000,
          maxModelSteps: 1,
          maxReportedTokens: 100,
        },
        dependsOn: [],
        kind: "agent",
        nodeId: "inspect",
        objective: "Inspect bound artifact bytes.",
        planItemIds: ["inspect"],
        requiredCapabilities: [],
        retry: { automaticOn: [], maxAttempts: 1 },
        sequence: 1,
        title: "Inspect",
        workspace: { declaredPathPrefixes: [], mode: "origin_read_only" },
      }],
      schemaVersion: 1,
      title: "Bound Graph",
    });
    const identity = canonicalTaskGraphIdentity(content);
    const store = await ArtifactStore.create({ sessionId, workspace });
    const capturedArtifact = await store.storeSanitizedText({
      chunks: [identity.bytes],
      maximumBytes: identity.byteLength,
      runId: sessionId,
    });
    if (capturedArtifact.artifact === null) throw new TypeError("Graph hydration fixture artifact was not stored");
    const revision = Object.freeze({
      approvedEventId: null,
      artifact: Object.freeze({
        artifactId: capturedArtifact.artifact.artifactId,
        bytes: identity.byteLength,
        objectRef: capturedArtifact.artifact.objectRef,
        sha256: identity.graphSha256,
      }),
      binding: content.binding,
      content,
      createdEventId: randomUUID(),
      decisionEventId: null,
      graphId,
      graphSha256: identity.graphSha256,
      revision: 1,
      status: "draft" as const,
      terminalEventId: null,
    });
    const scope = Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null });
    const head = Object.freeze({ eventId: null, eventIntegrityToken: null, schemaVersion: 1 as const, sequence: 0, sessionId });
    const resourceVersion = Object.freeze({ head, kind: "session_ledger_head" as const });
    const baseSnapshot = Object.freeze({
      projection: Object.freeze({ projection: Object.freeze({
        taskGraph: Object.freeze({
          currentApproved: null,
          currentDraft: Object.freeze({ binding: content.binding, graphId, graphSha256: identity.graphSha256, revision: 1 }),
          currentExecution: null,
          lastSessionSeq: 0,
          revisions: Object.freeze([revision]),
          trackingMode: "phase19",
        }),
        taskState: Object.freeze({ blockers: Object.freeze([]), goals: Object.freeze([]), lastSessionSeq: 0, plans: Object.freeze([]), trackingMode: "phase16" }),
      }) }),
      resourceScope: scope,
    }) as unknown as StableSessionApplicationSnapshotV1;
    let repositoryReads = 0;
    const definitions = createTaskSurfaceQueryDefinitions({
      operations: { inspectDelegationOperationSidecars: async () => Object.freeze([]) },
      readSessionSnapshot: async () => Object.freeze({ resourceScope: scope, resourceVersion, snapshot: baseSnapshot, snapshotIdentitySha256: "4".repeat(64) }),
      repositories: {
        get: async () => { repositoryReads += 1; return Object.freeze({ status: "active" }); },
        readRoot: async () => workspace,
      },
    });
    const query = definitions.find((definition) => definition.queryKind === "graph.revisions")!;
    const payload = { revision: null };
    const captured = await query.readStableSnapshot(scope, null, { paginationBinding: null, payload });
    const metadataPath = join(workspace, ".bornagent", "artifacts", sessionId, "objects", `${identity.graphSha256}.meta.json`);
    const beforeMetadata = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, beforeMetadata.replace(identity.graphSha256, "f".repeat(64)), "utf8");
    const executed = await query.execute({
      authorizationDecisionSha256: "5".repeat(64),
      authorizedResourceScope: scope,
      authorizedResourceVersion: resourceVersion,
      call: {} as never,
      paginationBinding: null,
      stableSnapshot: captured,
    }, payload);
    expect(executed.result).toMatchObject({ revisions: [{ graphSha256: identity.graphSha256 }] });
    expect(repositoryReads).toBe(1);
    expect(Object.isFrozen((captured.snapshot as { taskSurfaceHydration: { value: unknown } }).taskSurfaceHydration.value)).toBe(true);
  });

  it("binds delegation sidecars into the stable snapshot before execute", async () => {
    const repositoryId = randomUUID();
    const sessionId = randomUUID();
    const scope = Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null });
    const head = Object.freeze({
      eventId: null,
      eventIntegrityToken: null,
      schemaVersion: 1 as const,
      sequence: 0,
      sessionId,
    });
    const resourceVersion = Object.freeze({ head, kind: "session_ledger_head" as const });
    const baseSnapshot = Object.freeze({
      internalEvents: Object.freeze([]),
      projection: Object.freeze({
        projection: Object.freeze({
          delegations: Object.freeze({
            activeActorSlots: Object.freeze([]),
            activeConflictClaims: Object.freeze([]),
            trackingMode: "phase20",
          }),
        }),
      }),
      resourceScope: scope,
    }) as unknown as StableSessionApplicationSnapshotV1;
    const liveSidecarArray: DelegationChildOperationV1[] = [];
    const definitions = createTaskSurfaceQueryDefinitions({
      operations: {
        inspectDelegationOperationSidecars: async () => liveSidecarArray,
      },
      readSessionSnapshot: async () => Object.freeze({
        resourceScope: scope,
        resourceVersion,
        snapshot: baseSnapshot,
        snapshotIdentitySha256: "a".repeat(64),
      }),
      repositories: {
        get: async () => null,
        readRoot: async () => {
          throw new Error("doctor query must not read an artifact root");
        },
      },
    });
    const doctor = definitions.find((definition) => definition.queryKind === "delegation.doctor")!;
    const captured = await doctor.readStableSnapshot(scope, null);
    liveSidecarArray.push({} as DelegationChildOperationV1);
    const executed = await doctor.execute({
      authorizationDecisionSha256: "b".repeat(64),
      authorizedResourceScope: scope,
      authorizedResourceVersion: resourceVersion,
      call: {} as never,
      paginationBinding: null,
      stableSnapshot: captured,
    }, { delegationId: null, limit: 128, status: null });
    expect(executed.result).toMatchObject({ operations: [] });
    expect(captured.snapshotIdentitySha256).not.toBe("a".repeat(64));
  });

  it("fails closed for an orphan same-session delegation sidecar", async () => {
    const repositoryId = randomUUID();
    const sessionId = randomUUID();
    const scope = Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null });
    const head = Object.freeze({ eventId: null, eventIntegrityToken: null, schemaVersion: 1 as const, sequence: 0, sessionId });
    const resourceVersion = Object.freeze({ head, kind: "session_ledger_head" as const });
    const orphan = createDelegationChildOperation({
      boundedResultRef: null,
      boundedResultSha256: null,
      capsuleArtifactSha256: "a".repeat(64),
      capsulePath: "C:/other-repository/capsule.json",
      capsuleSha256: "b".repeat(64),
      childActorId: randomUUID(),
      childAttemptId: randomUUID(),
      childRunId: randomUUID(),
      delegationId: randomUUID(),
      envelopeArtifactSha256: "c".repeat(64),
      envelopePath: "C:/other-repository/envelope.json",
      envelopeSha256: "d".repeat(64),
      executableDescriptorSha256: "e".repeat(64),
      executionWorkspacePath: "C:/other-repository",
      failure: null,
      nonceSha256: "f".repeat(64),
      operationId: randomUUID(),
      parentRunId: randomUUID(),
      process: null,
      processCleanup: null,
      requestedAt: "2026-08-12T00:00:00.000Z",
      revision: 1,
      schemaVersion: 1,
      sessionId,
      sessionWorkspacePath: "C:/other-repository",
      startBarrierNonceSha256: "1".repeat(64),
      state: "requested",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    const baseSnapshot = Object.freeze({
      internalEvents: Object.freeze([]),
      projection: Object.freeze({ projection: Object.freeze({
        delegations: Object.freeze({ activeActorSlots: Object.freeze([]), activeConflictClaims: Object.freeze([]), trackingMode: "phase20" }),
      }) }),
      resourceScope: scope,
    }) as unknown as StableSessionApplicationSnapshotV1;
    const definitions = createTaskSurfaceQueryDefinitions({
      operations: { inspectDelegationOperationSidecars: async () => Object.freeze([orphan]) },
      readSessionSnapshot: async () => Object.freeze({ resourceScope: scope, resourceVersion, snapshot: baseSnapshot, snapshotIdentitySha256: "2".repeat(64) }),
      repositories: { get: async () => null, readRoot: async () => "" },
    });
    const doctor = definitions.find((definition) => definition.queryKind === "delegation.doctor")!;
    const captured = await doctor.readStableSnapshot(scope, null);
    await expect(doctor.execute({
      authorizationDecisionSha256: "3".repeat(64),
      authorizedResourceScope: scope,
      authorizedResourceVersion: resourceVersion,
      call: {} as never,
      paginationBinding: null,
      stableSnapshot: captured,
    }, { delegationId: null, limit: 128, status: null })).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });
  });

  it("registers only fixed task queries and rejects generic artifact/raw-event routes", async () => {
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => Object.freeze({ exitCode: 0 }) },
      stateRoot: await directory("bornagent-phase21a-task-query-registry-"),
    });
    const fixedKinds = [
      "delegation.doctor",
      "delegation.parent",
      "delegation.receipt",
      "delegation.summaries",
      "graph.logs",
      "graph.revisions",
      "graph.status",
      "graph.worktrees",
      "plan.review",
    ] as const;
    const context = plane.context("cli", randomUUID());
    for (const queryKind of fixedKinds) {
      const response = await plane.queries.query(context, {
        atVersion: null,
        pageCursor: null,
        payload: queryKind === "graph.status" ? { live: false } : {},
        queryKind,
        requestId: randomUUID(),
        resourceScope: plane.repositories.resourceScope,
        schemaVersion: 1,
      });
      expect(response).toMatchObject({ error: { code: "control_target_invalid" }, status: "rejected" });
    }
    for (const queryKind of ["artifact.content", "artifact.raw", "session.raw_events", "workspace.read_file"]) {
      const response = await plane.queries.query(context, {
        atVersion: null,
        pageCursor: null,
        payload: {},
        queryKind,
        requestId: randomUUID(),
        resourceScope: plane.repositories.resourceScope,
        schemaVersion: 1,
      });
      expect(response).toMatchObject({ error: { code: "control_query_unknown" }, status: "rejected" });
    }
  });

  it("binds Graph live observation to the stable worker subject and keeps it out of projection bytes", async () => {
    const repositoryId = "a".repeat(64);
    const sessionId = randomUUID();
    const operationId = randomUUID();
    const workerId = randomUUID();
    const scope = Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null });
    const head = Object.freeze({ eventId: null, eventIntegrityToken: null, schemaVersion: 1 as const, sequence: 0, sessionId });
    const resourceVersion = Object.freeze({ head, kind: "session_ledger_head" as const });
    const current = Object.freeze({
      acceptedControlIds: Object.freeze([]),
      descriptorSha256: "b".repeat(64),
      graphId: randomUUID(),
      graphRevision: 1,
      graphSha256: "c".repeat(64),
      operationId,
      repositoryId,
      spawnEventId: randomUUID(),
      startedEventId: randomUUID(),
      status: "running",
      terminal: null,
      workerId,
      workerNonceSha256: "d".repeat(64),
    });
    const snapshot = Object.freeze({
      projection: Object.freeze({ projection: Object.freeze({
        background: Object.freeze({ current, lastSessionSeq: 0, workers: Object.freeze([current]) }),
        taskExecution: null,
        taskGraph: null,
        worktrees: Object.freeze({
          lastSessionSeq: 0,
          originVerifications: Object.freeze([]),
          pendingOperationIds: Object.freeze([]),
          promotions: Object.freeze([]),
          trackingMode: "phase19",
          workspaces: Object.freeze([]),
        }),
      }) }),
      resourceScope: scope,
    }) as unknown as StableSessionApplicationSnapshotV1;
    let observedSubject: unknown = null;
    const definitions = createTaskSurfaceQueryDefinitions({
      operations: {
        inspectDelegationOperationSidecars: async () => Object.freeze([]),
        observeBackgroundWorkerLive: async (input) => {
          observedSubject = input;
          return Object.freeze({
            evidenceLevel: "process_and_heartbeat" as const,
            heartbeatAgeMs: 5,
            heartbeatSequence: 7,
            observedAt: "2026-08-12T00:00:00.000Z",
            operationId,
            state: "observed_running" as const,
            workerId,
          });
        },
      },
      readSessionSnapshot: async () => Object.freeze({
        resourceScope: scope,
        resourceVersion,
        snapshot,
        snapshotIdentitySha256: "e".repeat(64),
      }),
      repositories: { get: async () => null, readRoot: async () => "" },
    });
    const query = definitions.find((definition) => definition.queryKind === "graph.status")!;
    const captured = await query.readStableSnapshot(scope, null, { paginationBinding: null, payload: { live: true } });
    const executed = await query.execute({
      authorizationDecisionSha256: "f".repeat(64),
      authorizedResourceScope: scope,
      authorizedResourceVersion: resourceVersion,
      call: {} as never,
      paginationBinding: null,
      stableSnapshot: captured,
    }, { live: true });
    expect(observedSubject).toMatchObject({ current: { operationId, workerId }, repositoryId, sessionId });
    expect(executed.result).not.toHaveProperty("liveWorker");
    expect(executed.liveObservation).toMatchObject({
      coordinator: { kind: "background_worker", state: "observed_alive" },
      evidenceLevel: "observation",
      sessionId,
    });

    const staleDefinitions = createTaskSurfaceQueryDefinitions({
      operations: {
        inspectDelegationOperationSidecars: async () => Object.freeze([]),
        observeBackgroundWorkerLive: async () => Object.freeze({
          evidenceLevel: "process_only" as const,
          heartbeatAgeMs: null,
          heartbeatSequence: null,
          observedAt: "2026-08-12T00:00:00.000Z",
          operationId: randomUUID(),
          state: "owner_unknown" as const,
          workerId,
        }),
      },
      readSessionSnapshot: async () => Object.freeze({ resourceScope: scope, resourceVersion, snapshot, snapshotIdentitySha256: "e".repeat(64) }),
      repositories: { get: async () => null, readRoot: async () => "" },
    });
    const stale = staleDefinitions.find((definition) => definition.queryKind === "graph.status")!;
    await expect(stale.readStableSnapshot(scope, null, { paginationBinding: null, payload: { live: true } }))
      .rejects.toMatchObject({ code: "control_stale_projection" });

    const malformedDefinitions = createTaskSurfaceQueryDefinitions({
      operations: {
        inspectDelegationOperationSidecars: async () => Object.freeze([]),
        observeBackgroundWorkerLive: async () => Object.freeze({
          evidenceLevel: "process_and_heartbeat" as const,
          heartbeatAgeMs: -1,
          heartbeatSequence: null,
          observedAt: "not-a-timestamp",
          operationId,
          state: "observed_running" as const,
          workerId,
          injected: "must-not-cross-query-boundary",
        }) as never,
      },
      readSessionSnapshot: async () => Object.freeze({ resourceScope: scope, resourceVersion, snapshot, snapshotIdentitySha256: "e".repeat(64) }),
      repositories: { get: async () => null, readRoot: async () => "" },
    });
    const malformed = malformedDefinitions.find((definition) => definition.queryKind === "graph.status")!;
    await expect(malformed.readStableSnapshot(scope, null, { paginationBinding: null, payload: { live: true } }))
      .rejects.toMatchObject({ code: "control_session_history_missing_or_corrupt" });
  });

  it("routes product graph status live through its authorized query without a command-layer raw probe", async () => {
    const root = await directory("bornagent-phase21a-graph-live-query-");
    const workspace = join(root, "repository");
    const stateRoot = join(root, "control");
    await mkdir(workspace, { recursive: true });
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase21 Live Query");
    await git(workspace, "config", "user.email", "phase21-live-query@bornagent.local");
    await writeFile(join(workspace, "README.md"), "live query fixture\n", "utf8");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    const runtime = createRuntime({
      controlPlaneStateRoot: stateRoot,
      cwd: workspace,
      observeBackgroundWorkerLive: vi.fn(async () => {
        throw new Error("no worker subject should not invoke the live probe");
      }),
    });
    const queryKinds: string[] = [];
    const original = DefaultApplicationQueryService.prototype.query;
    vi.spyOn(DefaultApplicationQueryService.prototype, "query").mockImplementation(async function (
      this: DefaultApplicationQueryService,
      context,
      request,
    ) {
      queryKinds.push(request.queryKind);
      return original.call(this, context, request);
    });
    const io = createMemoryIO();
    const exit = await runCli(["graph", "status", randomUUID(), "--live", "--json"], io.io, runtime);
    expect(exit).toBe(2);
    expect(queryKinds).toContain("graph.status");
    expect(runtime.observeBackgroundWorkerLive).not.toHaveBeenCalled();
    expect(io.readStdout()).not.toContain("live query fixture");
    expect(io.readStderr()).not.toContain("no worker subject");
  });

  it("renders delegation list/show/doctor through strict named-query adapters", async () => {
    const root = await directory("bornagent-phase21a-delegation-query-");
    const workspace = join(root, "repository");
    const stateRoot = join(root, "control");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "fact.txt"), "fixed query fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase21 Query Fixture");
    await git(workspace, "config", "user.email", "phase21-query@bornagent.local");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    const fixture = await createCanonicalPhase20Fixture({ count: 1, workspace });
    const runtime = createRuntime({
      controlPlaneStateRoot: stateRoot,
      cwd: workspace,
      doctorDelegationChild: async () => Object.freeze({
        descriptorSha256: "a".repeat(64),
        packageVersion: "0.0.0-test",
        productEntrypointPath: join(root, "private-entrypoint.js"),
        productEntrypointSha256: "b".repeat(64),
        protocolVersion: 1,
        runtimeExecutablePath: join(root, "private-node.exe"),
        runtimeExecutableSha256: "c".repeat(64),
      }),
      env: {},
      randomUUID,
    });
    const queryKinds: string[] = [];
    const original = DefaultApplicationQueryService.prototype.query;
    vi.spyOn(DefaultApplicationQueryService.prototype, "query").mockImplementation(async function (
      this: DefaultApplicationQueryService,
      context,
      request,
    ) {
      queryKinds.push(request.queryKind);
      return original.call(this, context, request);
    });

    const listed = createMemoryIO();
    expect(await runCli(["delegations", "list", "--session", fixture.sessionId, "--json"], listed.io, runtime), listed.readStderr()).toBe(0);
    expect(JSON.parse(listed.readStdout())).toMatchObject({
      command: "delegations.list",
      result: { records: [{ delegationId: fixture.delegationIds[0] }], truncated: false },
    });

    const shown = createMemoryIO();
    expect(await runCli([
      "delegations", "show", "--session", fixture.sessionId, "--delegation", fixture.delegationIds[0]!, "--json",
    ], shown.io, runtime), shown.readStderr()).toBe(0);
    expect(JSON.parse(shown.readStdout())).toMatchObject({
      command: "delegations.show",
      result: { delegationId: fixture.delegationIds[0], objective: expect.any(String) },
    });

    const doctor = createMemoryIO();
    expect(await runCli(["delegations", "doctor", "--session", fixture.sessionId, "--json"], doctor.io, runtime), doctor.readStderr()).toBe(0);
    expect(JSON.parse(doctor.readStdout())).toMatchObject({
      command: "delegations.doctor",
      result: { activeActorSlots: 0, operations: [], valid: true },
    });
    const receipt = createMemoryIO();
    expect(await runCli([
      "delegations", "receipt", "--session", fixture.sessionId, "--delegation", fixture.delegationIds[0]!, "--json",
    ], receipt.io, runtime)).toBe(2);
    expect(receipt.readStderr()).toContain("control_target_invalid");
    const wire = `${listed.readStdout()}${shown.readStdout()}${doctor.readStdout()}${receipt.readStdout()}`;
    expect(wire).not.toContain("objectRef");
    expect(wire).not.toContain("runtimeExecutablePath");
    expect(wire).not.toContain("productEntrypointPath");
    expect(wire).not.toContain("application_commit");
    expect(queryKinds).toEqual(expect.arrayContaining([
      "delegation.doctor",
      "delegation.receipt",
      "delegation.summaries",
    ]));
  }, 30_000);
});
