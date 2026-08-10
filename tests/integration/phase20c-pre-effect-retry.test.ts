import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import { preparedChildEnvelopeSchema } from "../../src/delegation/context/child-envelope-schema.js";
import { storeDelegationArtifactExact } from "../../src/delegation/delegation-control-plane.js";
import { DelegationOperationStore } from "../../src/delegation/delegation-operation-store.js";
import { createDelegationChildOperation } from "../../src/delegation/delegation-operation-schema.js";
import { createCanonicalPhase20Fixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { createExecutableChildEnvelope } from "../../src/delegation/runtime/executable-child-envelope.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { parseStrictJson } from "../../src/system/strict-json.js";
import { createMemoryIO } from "../helpers.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function createRetryHarness(
  childFixture = "phase20-pre-effect-child.mjs",
  handshakeTimeoutMs = 50,
) {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-retry-"));
  roots.push(root);
  const workspace = join(root, "repository");
  const stateRoot = join(root, "state");
  const childPackage = join(root, "child-package");
  await mkdir(join(childPackage, "dist"), { recursive: true });
  await copyFile(
    resolve("tests/fixtures", childFixture),
    join(childPackage, "dist", "cli.js"),
  );
  await writeFile(join(childPackage, "package.json"), JSON.stringify({
    name: "bornagent",
    version: "0.0.0-phase20-retry-test",
    type: "module",
  }), "utf8");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "fact.txt"), "bounded retry fixture\n", "utf8");
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await git(workspace, "init", "--initial-branch=main");
  await git(workspace, "config", "core.autocrlf", "false");
  await git(workspace, "config", "commit.gpgsign", "false");
  await git(workspace, "config", "user.name", "BornAgent Phase20 Retry");
  await git(workspace, "config", "user.email", "phase20-retry@bornagent.local");
  await git(workspace, "add", "--all");
  await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");

  const fixture = await createCanonicalPhase20Fixture({
    automaticPreEffectRetry: true,
    count: 1,
    environment: process.env,
    platform: process.platform,
    workspace,
  });
  const environment = {
    ...process.env,
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  const runtime = createNodeRuntime({
    approvalInput: { interactive: false, readLine: async () => null },
    cliEntryPath: join(childPackage, "dist", "cli.js"),
    cwd: workspace,
    delegationHandshakeTimeoutMs: handshakeTimeoutMs,
    delegationUserStateRoot: stateRoot,
    env: environment,
    execPath: process.execPath,
    killProcess: (identity, signal) => process.kill(identity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0",
    workerUserStateRoot: stateRoot,
  });
  return Object.freeze({ fixture, runtime, stateRoot, workspace });
}

describe("Phase 20C durable pre-effect automatic retry", () => {
  it("launches a real child twice only after cleanup, settlement, and fresh retry artifacts", async () => {
    const { fixture, runtime, stateRoot, workspace } = await createRetryHarness();
    const io = createMemoryIO();
    expect(await runCli([
      "delegations",
      "start",
      "--session",
      fixture.sessionId,
      "--delegation",
      fixture.delegationIds[0]!,
      "--json",
    ], io.io, runtime), io.readStderr()).toBe(8);

    const session = await new SessionCatalog(workspace).read(fixture.sessionId);
    const revision = session.delegations.revisions[0]!;
    expect(revision.status, JSON.stringify({
      attempts: revision.attempts,
      stderr: io.readStderr(),
      stdout: io.readStdout(),
    })).toBe("failed");
    expect(revision.attempts).toHaveLength(2);
    expect(revision.envelopePreparationCount).toBe(2);
    expect(revision.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(revision.attempts.map((attempt) => attempt.terminal)).toEqual([
      "pre_effect_infrastructure_failure",
      "pre_effect_infrastructure_failure",
    ]);
    expect(revision.attempts.every((attempt) =>
      attempt.startedEventId === null &&
      attempt.budgetSettlementEventId !== null &&
      attempt.budgetUsage?.attempts === 1)).toBe(true);
    expect(new Set(revision.attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
    expect(new Set(revision.attempts.map((attempt) => attempt.actorId)).size).toBe(2);
    expect(new Set(revision.attempts.map((attempt) => attempt.operationId)).size).toBe(2);
    expect(session.delegations.activeActorSlots).toEqual([]);
    expect(session.delegations.activeConflictClaims).toEqual([]);
    expect(session.delegations.budget.used.attempts).toBe(2);
    expect(session.delegations.budget.held.attempts).toBe(0);

    const preparedEvents = session.events.filter((event) =>
      event.scope === "session" && event.type === "delegation.envelope.prepared");
    expect(preparedEvents).toHaveLength(2);
    expect(new Set(preparedEvents.map((event) => event.data.envelope_sha256)).size).toBe(2);
    expect(new Set(preparedEvents.map((event) => event.data.context_capsule_sha256)).size).toBe(2);

    const stores = await DelegationOperationStore.listExisting(stateRoot);
    expect(stores).toHaveLength(2);
    const operations = await Promise.all(stores.map((store) => store.read()));
    expect(operations.every((operation) =>
      operation?.state === "reconciled" &&
      operation.failure?.phase === "before_handshake" &&
      operation.processCleanup?.verified === true)).toBe(true);
  }, 30_000);

  it("replays a coordinator crash after durable cleanup and launches only a fresh attempt two", async () => {
    const { fixture, runtime, stateRoot, workspace } = await createRetryHarness();
    const initial = await new SessionCatalog(workspace).read(fixture.sessionId);
    const revision = initial.delegations.revisions[0]!;
    if (revision.envelope === null) throw new Error("fixture envelope is missing");
    const artifactStore = await ArtifactStore.create({
      sessionId: fixture.sessionId,
      workspace,
    });
    const [storedEnvelope, storedCapsule] = await Promise.all([
      artifactStore.readVerified(revision.envelope.envelope.artifactId),
      artifactStore.readVerified(revision.envelope.contextCapsule.artifactId),
    ]);
    const prepared = preparedChildEnvelopeSchema.parse(
      parseStrictJson(storedEnvelope.bytes.toString("utf8")),
    );
    const operationId = randomUUID();
    const childRunId = randomUUID();
    const reservationId = randomUUID();
    const groupId = randomUUID();
    const barrierId = randomUUID();
    const slotClaimId = randomUUID();
    const conflictClaimId = randomUUID();
    const executableDescriptorSha256 = sha256Canonical({
      fixture: "coordinator-crash",
      kind: "descriptor",
    });
    const schedulerLeaseNonceSha256 = sha256Canonical({ groupId, kind: "scheduler" });
    const startBarrierNonceSha256 = sha256Canonical({ operationId, kind: "start-barrier" });
    const operationNonceSha256 = sha256Canonical({ operationId, kind: "operation" });
    const now = new Date().toISOString();
    const writer = await V2SessionWriter.openExisting(workspace, fixture.sessionId, {
      createEventId: randomUUID,
      timestamp: () => new Date().toISOString(),
    });
    try {
      if (writer.lockNonceSha256 === undefined) throw new Error("fixture writer lock identity is missing");
      const executable = createExecutableChildEnvelope({
        schemaVersion: 1,
        prepared,
        execution: {
          executable: true,
          operationId,
          sessionId: fixture.sessionId,
          reservationId,
          sessionLockNonceSha256: writer.lockNonceSha256,
          schedulerLeaseNonceSha256,
          executableDescriptorSha256,
          startBarrierNonceSha256,
        },
      });
      const executableBytes = Buffer.from(canonicalJson(executable), "utf8");
      const executableArtifactSha256 = sha256Canonical(executable);
      const executableArtifact = await storeDelegationArtifactExact(
        workspace,
        fixture.sessionId,
        revision.delegationId,
        executableBytes,
        executableArtifactSha256,
      );
      const operationStore = await DelegationOperationStore.create({
        operationId,
        root: stateRoot,
      });
      const envelopePath = await operationStore.storePayload(
        "envelope",
        executableBytes,
        executableArtifactSha256,
      );
      const capsulePath = await operationStore.storePayload(
        "capsule",
        storedCapsule.bytes,
        storedCapsule.metadata.sha256,
      );
      const requested = createDelegationChildOperation({
        schemaVersion: 1,
        revision: 1,
        operationId,
        sessionId: fixture.sessionId,
        delegationId: revision.delegationId,
        childActorId: prepared.actor.actorId,
        childAttemptId: prepared.actor.attemptId,
        childRunId,
        parentRunId: revision.parentRunId,
        envelopePath,
        envelopeArtifactSha256: executableArtifactSha256,
        envelopeSha256: executable.envelopeSha256,
        capsulePath,
        capsuleArtifactSha256: storedCapsule.metadata.sha256,
        capsuleSha256: revision.envelope.contextCapsuleSha256,
        sessionWorkspacePath: workspace,
        executionWorkspacePath: workspace,
        executableDescriptorSha256,
        nonceSha256: operationNonceSha256,
        startBarrierNonceSha256,
        requestedAt: now,
        updatedAt: now,
        state: "requested",
        process: null,
        processCleanup: null,
        failure: null,
        boundedResultRef: null,
        boundedResultSha256: null,
      });
      await operationStore.initialize(requested);
      await writer.appendDelegationEvent("delegation.group.lease.acquired", {
        coordinator_kind: "foreground",
        coordinator_process_id: process.pid,
        coordinator_process_start_identity: `crashed-fixture:${String(process.pid)}`,
        group_id: groupId,
        lease_nonce_sha256: schedulerLeaseNonceSha256,
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        repository_id: fixture.repositoryId,
      });
      await writer.appendDelegationEvent("delegation.parent.barrier.requested", {
        barrier_id: barrierId,
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        required_delegation_ids: [revision.delegationId],
      });
      await writer.appendDelegationEvent("delegation.parent.barrier.suspended", {
        barrier_id: barrierId,
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
      });
      await writer.appendDelegationEvent("delegation.actor_slot.claimed", {
        actor_id: prepared.actor.actorId,
        actor_kind: "child",
        claim_id: slotClaimId,
        group_id: groupId,
        slot: 1,
      });
      await writer.appendDelegationEvent("delegation.conflict_claim.granted", {
        access: "read",
        actor_id: prepared.actor.actorId,
        claim_id: conflictClaimId,
        group_id: groupId,
        path_prefixes: [...prepared.workspace.declaredPathPrefixes],
        repository_id: fixture.repositoryId,
        source_lineage_id: prepared.workspace.lineageId,
        source_snapshot_sha256: prepared.workspace.sourceSnapshotSha256,
        workspace_id: null,
      });
      const ceiling = prepared.budgetReservationPlan.ceiling;
      const reserved = {
        artifact_bytes: ceiling.maxArtifactBytes,
        attempts: ceiling.maxAttempts,
        changed_bytes: ceiling.maxChangedBytes,
        changed_files: ceiling.maxChangedFiles,
        command_executions: ceiling.maxCommandExecutions,
        command_output_bytes: ceiling.maxCommandOutputBytes,
        duration_ms: ceiling.maxDurationMs,
        model_steps: ceiling.maxModelSteps,
        reported_tokens: ceiling.maxReportedTokens,
      };
      const reservationSha256 = sha256Canonical({
        schemaVersion: 1,
        reservationId,
        delegationId: revision.delegationId,
        childAttemptId: prepared.actor.attemptId,
        parentBudgetLedgerRevision: 0,
        graphBudgetLedgerRevision: null,
        reserved: ceiling,
        status: "held",
      });
      await writer.appendDelegationEvent("delegation.budget.reserved", {
        child_attempt_id: prepared.actor.attemptId,
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
        reservation_id: reservationId,
        reservation_sha256: reservationSha256,
        reserved,
      });
      await writer.appendDelegationEvent("delegation.child.launch_requested", {
        child_actor_id: prepared.actor.actorId,
        child_attempt_id: prepared.actor.attemptId,
        child_attempt_number: 1,
        delegation_id: revision.delegationId,
        delegation_revision: revision.delegationRevision,
        delegation_sha256: revision.delegationSha256,
        envelope_artifact: executableArtifact,
        envelope_sha256: executable.envelopeSha256,
        prepared_envelope_sha256: prepared.envelopeSha256,
        executable_descriptor_sha256: executableDescriptorSha256,
        operation_id: operationId,
        operation_nonce_sha256: operationNonceSha256,
        parent_actor_id: revision.parentActorId,
        parent_run_id: revision.parentRunId,
      });
      await operationStore.compareAndSwap({
        expectedSha256: requested.operationSha256,
        expectedState: "requested",
        now: new Date().toISOString(),
        mutate: (current) => ({
          ...current,
          failure: {
            code: "delegation_handshake_failed",
            phase: "before_spawn",
          },
          state: "pre_effect_terminal",
        }),
      });
    } finally {
      await writer.close();
    }

    const beforeResume = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(beforeResume.delegations.revisions[0]?.attempts[0]).toMatchObject({
      attemptId: prepared.actor.attemptId,
      terminal: null,
    });
    expect(beforeResume.delegations.activeActorSlots).toHaveLength(1);
    expect(beforeResume.delegations.budget.held.attempts).toBe(2);

    const io = createMemoryIO();
    expect(await runCli([
      "delegations",
      "resume",
      "--session",
      fixture.sessionId,
      "--delegation",
      fixture.delegationIds[0]!,
      "--json",
    ], io.io, runtime), io.readStderr()).toBe(8);

    const recovered = await new SessionCatalog(workspace).read(fixture.sessionId);
    const recoveredRevision = recovered.delegations.revisions[0]!;
    expect(recoveredRevision.status, JSON.stringify({
      attempts: recoveredRevision.attempts,
      stderr: io.readStderr(),
      stdout: io.readStdout(),
    })).toBe("failed");
    expect(recoveredRevision.attempts).toHaveLength(2);
    expect(recoveredRevision.envelopePreparationCount).toBe(2);
    expect(recoveredRevision.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(recoveredRevision.attempts.every((attempt) =>
      attempt.terminal === "pre_effect_infrastructure_failure" &&
      attempt.budgetSettlementEventId !== null)).toBe(true);
    expect(recovered.delegations.activeActorSlots).toEqual([]);
    expect(recovered.delegations.activeConflictClaims).toEqual([]);
    expect(recovered.delegations.budget.used.attempts).toBe(2);
    expect(recovered.delegations.budget.held.attempts).toBe(0);
    expect(recovered.delegations.barriers).toHaveLength(2);
    expect(recovered.delegations.barriers.every((barrier) =>
      barrier.status === "released" && barrier.terminalStatus === "blocked")).toBe(true);

    const stores = await DelegationOperationStore.listExisting(stateRoot);
    expect(stores).toHaveLength(2);
    const operations = await Promise.all(stores.map((store) => store.read()));
    expect(operations.every((operation) => operation?.state === "reconciled")).toBe(true);
    expect(operations.find((operation) => operation?.operationId === operationId)).toMatchObject({
      failure: { code: "delegation_handshake_failed", phase: "before_spawn" },
      process: null,
      state: "reconciled",
    });
  }, 30_000);

  it("never retries IPC loss after the durable child start barrier", async () => {
    const { fixture, runtime, stateRoot, workspace } = await createRetryHarness(
      "phase20-post-start-loss-child.mjs",
      500,
    );
    const startIO = createMemoryIO();
    expect(await runCli([
      "delegations",
      "start",
      "--session",
      fixture.sessionId,
      "--delegation",
      fixture.delegationIds[0]!,
      "--json",
    ], startIO.io, runtime), startIO.readStderr()).toBe(8);

    const blocked = await new SessionCatalog(workspace).read(fixture.sessionId);
    const blockedRevision = blocked.delegations.revisions[0]!;
    expect(blockedRevision.status, JSON.stringify({
      attempts: blockedRevision.attempts,
      stderr: startIO.readStderr(),
      stdout: startIO.readStdout(),
    })).toBe("blocked");
    expect(blockedRevision.attempts).toHaveLength(1);
    expect(blockedRevision.attempts[0]).toMatchObject({
      attemptNumber: 1,
      terminal: null,
    });
    expect(blocked.delegations.budget.used.attempts).toBe(0);
    expect(blocked.delegations.budget.held.attempts).toBe(2);
    expect(blocked.delegations.activeActorSlots).toHaveLength(1);
    expect(blocked.delegations.activeConflictClaims).toHaveLength(1);
    expect(blocked.delegations.barriers).toEqual([
      expect.objectContaining({ status: "suspended", terminalStatus: null }),
    ]);

    const storesBeforeResume = await DelegationOperationStore.listExisting(stateRoot);
    expect(storesBeforeResume).toHaveLength(1);
    const operation = await storesBeforeResume[0]!.read();
    expect(operation).toMatchObject({
      failure: {
        code: "delegation_effect_reconciliation_required",
        phase: "after_start_barrier",
      },
      state: "blocked",
    });

    const resumeIO = createMemoryIO();
    expect(await runCli([
      "delegations",
      "resume",
      "--session",
      fixture.sessionId,
      "--delegation",
      fixture.delegationIds[0]!,
      "--json",
    ], resumeIO.io, runtime), resumeIO.readStderr()).toBe(8);
    const afterResume = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(afterResume.delegations.revisions[0]?.attempts).toHaveLength(1);
    expect(await DelegationOperationStore.listExisting(stateRoot)).toHaveLength(1);
    const observation = (await runtime.inspectDelegationOperations?.(fixture.sessionId))?.[0];
    expect(observation?.reconcile.kind).toBe("blocked_unknown_effect");
  }, 30_000);
});
