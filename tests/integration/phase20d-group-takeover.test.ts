import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { DelegationGroupLeaseStore } from "../../src/delegation/delegation-group-lease-store.js";
import { DelegationGroupTakeoverReconciler } from "../../src/delegation/delegation-group-takeover.js";
import { createDelegationChildOperation } from "../../src/delegation/delegation-operation-schema.js";
import { DelegationOperationStore } from "../../src/delegation/delegation-operation-store.js";
import { createCanonicalPhase20Fixture } from "../../src/delegation/runtime/canonical-phase20-fixture.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { currentProcessIdentity } from "../../src/sessions/process-identity.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, env: process.env, windowsHide: true });
}

function counters(input: {
  readonly maxArtifactBytes: number;
  readonly maxAttempts: number;
  readonly maxChangedBytes: number;
  readonly maxChangedFiles: number;
  readonly maxCommandExecutions: number;
  readonly maxCommandOutputBytes: number;
  readonly maxDurationMs: number;
  readonly maxModelSteps: number;
  readonly maxReportedTokens: number | null;
}) {
  return {
    artifact_bytes: input.maxArtifactBytes,
    attempts: input.maxAttempts,
    changed_bytes: input.maxChangedBytes,
    changed_files: input.maxChangedFiles,
    command_executions: input.maxCommandExecutions,
    command_output_bytes: input.maxCommandOutputBytes,
    duration_ms: input.maxDurationMs,
    model_steps: input.maxModelSteps,
    reported_tokens: input.maxReportedTokens,
  };
}

describe("Phase 20D coordinator takeover recovery", () => {
  it("takes over a dead coordinator only after its terminal child operation is absorbed", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase20-takeover-"));
    roots.push(root);
    const workspace = join(root, "repository");
    const stateRoot = join(root, "state");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "fact.txt"), "takeover fixture\n", "utf8");
    await git(workspace, "init", "--initial-branch=main");
    await git(workspace, "config", "user.name", "Phase20 Takeover");
    await git(workspace, "config", "user.email", "phase20-takeover@bornagent.local");
    await git(workspace, "add", "--all");
    await git(workspace, "commit", "--no-verify", "-m", "fixture baseline");
    const fixture = await createCanonicalPhase20Fixture({
      count: 1,
      environment: process.env,
      platform: process.platform,
      workspace,
    });
    const initial = await new SessionCatalog(workspace).read(fixture.sessionId);
    const revision = initial.delegations.revisions[0]!;
    if (revision.envelope === null) throw new Error("prepared fixture envelope is missing");
    const groupId = randomUUID();
    const barrierId = randomUUID();
    const slotClaimId = randomUUID();
    const conflictClaimId = randomUUID();
    const reservationId = randomUUID();
    const operationId = randomUUID();
    const childActorId = randomUUID();
    const childRunId = randomUUID();
    const executableEnvelopeSha256 = "a".repeat(64);
    const operationNonceSha256 = "b".repeat(64);
    const descriptorSha256 = "c".repeat(64);
    const leaseNonceSha256 = "d".repeat(64);
    const startBarrierNonceSha256 = "e".repeat(64);
    const reserved = counters(revision.content.budget);
    const used = {
      ...counters({
        ...revision.content.budget,
        maxArtifactBytes: 0,
        maxAttempts: 1,
        maxChangedBytes: 0,
        maxChangedFiles: 0,
        maxCommandExecutions: 0,
        maxCommandOutputBytes: 0,
        maxDurationMs: 1,
        maxModelSteps: 1,
        maxReportedTokens: revision.content.budget.maxReportedTokens === null ? null : 1,
      }),
    };
    const released = {
      artifact_bytes: reserved.artifact_bytes - used.artifact_bytes,
      attempts: reserved.attempts - used.attempts,
      changed_bytes: reserved.changed_bytes - used.changed_bytes,
      changed_files: reserved.changed_files - used.changed_files,
      command_executions: reserved.command_executions - used.command_executions,
      command_output_bytes: reserved.command_output_bytes - used.command_output_bytes,
      duration_ms: reserved.duration_ms - used.duration_ms,
      model_steps: reserved.model_steps - used.model_steps,
      reported_tokens: reserved.reported_tokens === null || used.reported_tokens === null
        ? null
        : reserved.reported_tokens - used.reported_tokens,
    };
    const exact = {
      delegation_id: revision.delegationId,
      delegation_revision: revision.delegationRevision,
      delegation_sha256: revision.delegationSha256,
      parent_actor_id: revision.parentActorId,
      parent_run_id: revision.parentRunId,
    };
    const writer = await V2SessionWriter.openExisting(workspace, fixture.sessionId);
    try {
      await writer.appendDelegationEvent("delegation.group.lease.acquired", {
        coordinator_kind: "foreground",
        coordinator_process_id: 2_000_000_000,
        coordinator_process_start_identity: "dead-coordinator-start",
        group_id: groupId,
        lease_nonce_sha256: leaseNonceSha256,
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
        actor_id: childActorId,
        actor_kind: "child",
        claim_id: slotClaimId,
        group_id: groupId,
        slot: 1,
      });
    } finally {
      await writer.close();
    }

    let session = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(session.delegations.activeActorSlots[0]!.actorId).toBe(childActorId);
    const childAttemptId = randomUUID();
    const mutation = await V2SessionWriter.openExisting(workspace, fixture.sessionId);
    try {
      await mutation.appendDelegationEvent("delegation.conflict_claim.granted", {
        access: "read",
        actor_id: childActorId,
        claim_id: conflictClaimId,
        group_id: groupId,
        path_prefixes: ["src"],
        repository_id: fixture.repositoryId,
        source_lineage_id: revision.binding.parentWorkspaceLineageId,
        source_snapshot_sha256: fixture.sourceSnapshotSha256,
        workspace_id: null,
      });
      await mutation.appendDelegationEvent("delegation.budget.reserved", {
        ...exact,
        child_attempt_id: childAttemptId,
        reservation_id: reservationId,
        reservation_sha256: sha256Canonical({ childAttemptId, reservationId }),
        reserved,
      });
      await mutation.appendDelegationEvent("delegation.child.launch_requested", {
        ...exact,
        child_actor_id: childActorId,
        child_attempt_id: childAttemptId,
        child_attempt_number: 1,
        envelope_artifact: {
          artifact_id: `sha256:${executableEnvelopeSha256}`,
          bytes: 1,
          object_ref: `objects/${executableEnvelopeSha256}`,
          sha256: executableEnvelopeSha256,
        },
        envelope_sha256: executableEnvelopeSha256,
        executable_descriptor_sha256: descriptorSha256,
        operation_id: operationId,
        operation_nonce_sha256: operationNonceSha256,
        prepared_envelope_sha256: revision.envelope.envelopeSha256,
      });
      await mutation.appendDelegationEvent("delegation.child.started", {
        ...exact,
        child_actor_id: childActorId,
        child_attempt_id: childAttemptId,
        child_attempt_number: 1,
        child_run_id: childRunId,
        envelope_sha256: executableEnvelopeSha256,
        operation_id: operationId,
        process_id: 2_000_000_001,
        process_start_identity: "terminal-child-start",
      });
      await mutation.appendDelegationEvent("delegation.child.terminal", {
        ...exact,
        budget_usage: used,
        child_actor_id: childActorId,
        child_attempt_id: childAttemptId,
        child_run_id: childRunId,
        diagnostic_code: "known_child_failure",
        operation_id: operationId,
        terminal: "known_failed",
        unresolved_effect_ids: [],
      });
      await mutation.appendDelegationEvent("delegation.budget.settled", {
        ...exact,
        child_attempt_id: childAttemptId,
        held: { ...used, attempts: 0, duration_ms: 0, model_steps: 0, reported_tokens: used.reported_tokens === null ? null : 0 },
        released,
        reservation_id: reservationId,
        used,
      });
    } finally {
      await mutation.close();
    }

    const operationStore = await DelegationOperationStore.create({ operationId, root: stateRoot });
    await operationStore.initialize(createDelegationChildOperation({
      boundedResultRef: null,
      boundedResultSha256: null,
      capsuleArtifactSha256: "f".repeat(64),
      capsulePath: join(stateRoot, "capsule.json"),
      capsuleSha256: "f".repeat(64),
      childActorId,
      childAttemptId,
      childRunId,
      delegationId: revision.delegationId,
      envelopeArtifactSha256: executableEnvelopeSha256,
      envelopePath: join(stateRoot, "envelope.json"),
      envelopeSha256: executableEnvelopeSha256,
      executableDescriptorSha256: descriptorSha256,
      executionWorkspacePath: workspace,
      failure: null,
      nonceSha256: operationNonceSha256,
      operationId,
      parentRunId: revision.parentRunId,
      process: { pid: 2_000_000_001, processStartIdentity: "terminal-child-start" },
      processCleanup: null,
      requestedAt: "2026-08-10T00:00:00.000Z",
      revision: 1,
      schemaVersion: 1,
      sessionId: fixture.sessionId,
      sessionWorkspacePath: workspace,
      startBarrierNonceSha256,
      state: "reconciled",
      updatedAt: "2026-08-10T00:00:01.000Z",
    }));
    const leaseStore = await DelegationGroupLeaseStore.create({ repositoryId: fixture.repositoryId, root: stateRoot });
    await leaseStore.acquire({
      acquiredAt: "2026-08-10T00:00:00.000Z",
      graphBindingSha256: null,
      groupId,
      nonceSha256: leaseNonceSha256,
      ownerBackgroundOperationId: null,
      ownerKind: "foreground",
      ownerPid: 2_000_000_000,
      ownerProcessStartIdentity: "dead-coordinator-start",
      parentActorId: revision.parentActorId,
      parentRunId: revision.parentRunId,
      sessionId: fixture.sessionId,
    });

    const currentIdentity = currentProcessIdentity();
    const contenders = [
      currentIdentity,
      { pid: currentIdentity.pid + 100_000, startIdentity: `${currentIdentity.startIdentity}:contender` },
    ].map((identity) => new DelegationGroupTakeoverReconciler({
      context: {
        inputSurface: "cli" as const,
        now: () => new Date().toISOString(),
        randomUuid: randomUUID,
        sessionId: fixture.sessionId,
        workspace,
      },
      currentIdentity: identity,
      operationRoot: stateRoot,
      ownerBackgroundOperationId: null,
      ownerKind: "foreground" as const,
      ownerProbe: { probe: async () => "missing" as const },
    }));
    const race = await Promise.allSettled(contenders.map((contender) =>
      contender.reconcile({ delegationId: revision.delegationId })));
    const fulfilled = race.filter((outcome) => outcome.status === "fulfilled");
    const rejected = race.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const result = fulfilled[0]!.value;
    expect(result.groupId).toBe(groupId);
    session = await new SessionCatalog(workspace).read(fixture.sessionId);
    expect(session.delegations.activeActorSlots).toEqual([]);
    expect(session.delegations.activeConflictClaims).toEqual([]);
    expect(session.delegations.barriers[0]).toMatchObject({ status: "released", terminalStatus: "blocked" });
    expect(session.delegations.takeoverCount).toBe(1);
    expect(await leaseStore.read()).toMatchObject({ state: "released", releaseReason: "reconciled" });
  });
});
