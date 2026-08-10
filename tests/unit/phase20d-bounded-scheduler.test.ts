import { describe, expect, it } from "vitest";

import { DelegationApprovalArbiter } from "../../src/delegation/approval-arbiter.js";
import { BoundedDelegationScheduler } from "../../src/delegation/bounded-delegation-scheduler.js";
import { DelegationBudgetLedger } from "../../src/delegation/delegation-budget-ledger.js";
import { delegationCancelCascade } from "../../src/delegation/delegation-cancel-cascade.js";
import { createDelegationConflictClaim, delegationConflict } from "../../src/delegation/delegation-conflict-claim.js";
import { DelegationGroupLeaseCoordinator } from "../../src/delegation/delegation-group-lease.js";
import { IDS, SHA, phase20Budget, phase20Revision } from "../phase20-test-helpers.js";

let uuid = 100;
const nextUuid = () => `a0000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;

describe("Phase 20D bounded deterministic scheduler", () => {
  it("admits at most two deterministic non-conflicting children and defers the third", () => {
    const ledger = new DelegationBudgetLedger(phase20Budget({ maxAttempts: 3, maxModelSteps: 12, maxDurationMs: 180_000, maxArtifactBytes: 12_288, maxReportedTokens: 12_288 }));
    const scheduler = new BoundedDelegationScheduler({ groupId: nextUuid(), ledger, randomUuid: nextUuid });
    const candidates = [IDS.delegation3, IDS.delegation2, IDS.delegation].map((delegationId, index) => ({
      revision: phase20Revision({ delegationId, envelope: true, sequence: 3 - index, status: "queued" }),
      childActorId: nextUuid(),
      childAttemptId: nextUuid(),
      requestedBudget: phase20Budget(),
      conflict: { access: "read" as const, repositoryId: SHA, workspaceId: null, sourceLineageId: SHA, sourceSnapshotSha256: SHA, pathPrefixes: ["src"] },
    }));
    const result = scheduler.admit({ ready: candidates, parentModelActive: false });
    expect(result.admitted.map((entry) => entry.candidate.revision.content.sequence)).toEqual([1, 2]);
    expect(result.admitted.map((entry) => entry.actorSlot)).toEqual([1, 2]);
    expect(result.deferred).toEqual([{ delegationId: IDS.delegation3, reason: "actor_limit" }]);
  });

  it("conservatively defers overlapping writers and retains unknown-effect budget", () => {
    const ledger = new DelegationBudgetLedger(phase20Budget({ maxAttempts: 2, maxModelSteps: 8, maxDurationMs: 120_000, maxArtifactBytes: 8192, maxChangedBytes: 8192, maxChangedFiles: 2, maxReportedTokens: 8192 }));
    const scheduler = new BoundedDelegationScheduler({ groupId: nextUuid(), ledger, randomUuid: nextUuid });
    const ready = [IDS.delegation, IDS.delegation2].map((delegationId, index) => ({
      revision: phase20Revision({ coding: true, delegationId, envelope: true, sequence: index + 1, status: "queued" }),
      childActorId: nextUuid(), childAttemptId: nextUuid(), requestedBudget: phase20Budget({ maxChangedFiles: 1, maxChangedBytes: 4096 }),
      conflict: { access: "write" as const, repositoryId: SHA, workspaceId: IDS.workspace, sourceLineageId: SHA, sourceSnapshotSha256: SHA, pathPrefixes: [index === 0 ? "src" : "src/nested"] },
    }));
    const result = scheduler.admit({ ready, parentModelActive: false });
    expect(result.admitted).toHaveLength(1);
    expect(result.deferred[0]?.reason).toBe("workspace_conflict");
    const blocked = ledger.settle({ expectedRevision: ledger.state.revision, reservationId: result.admitted[0]!.reservation.reservationId, usage: { artifactBytes: 0, attempts: 1, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 1, modelSteps: 1, reportedTokens: 1 }, unresolvedEffect: true });
    expect(blocked.status).toBe("blocked");
    expect(ledger.state.held.maxAttempts).toBe(1);
  });

  it("honors policy caps zero and one without relaxing the hard actor cap", () => {
    const candidate = {
      revision: phase20Revision({ envelope: true, status: "queued" }),
      childActorId: nextUuid(),
      childAttemptId: nextUuid(),
      requestedBudget: phase20Budget(),
      conflict: { access: "read" as const, repositoryId: SHA, workspaceId: null, sourceLineageId: SHA, sourceSnapshotSha256: SHA, pathPrefixes: ["src"] },
    };
    const disabled = new BoundedDelegationScheduler({
      groupId: nextUuid(),
      ledger: new DelegationBudgetLedger(phase20Budget()),
      randomUuid: nextUuid,
    }).admit({ maximumChildren: 0, parentModelActive: false, ready: [candidate] });
    expect(disabled.admitted).toEqual([]);
    expect(disabled.deferred[0]?.reason).toBe("actor_limit");

    const one = new BoundedDelegationScheduler({
      groupId: nextUuid(),
      ledger: new DelegationBudgetLedger(phase20Budget({ maxAttempts: 2, maxModelSteps: 8, maxDurationMs: 120_000, maxArtifactBytes: 8192, maxReportedTokens: 8192 })),
      randomUuid: nextUuid,
    }).admit({ maximumChildren: 1, parentModelActive: false, ready: [
      candidate,
      { ...candidate, revision: phase20Revision({ delegationId: IDS.delegation2, envelope: true, sequence: 2, status: "queued" }), childActorId: nextUuid(), childAttemptId: nextUuid() },
    ] });
    expect(one.admitted).toHaveLength(1);
    expect(one.deferred[0]?.reason).toBe("actor_limit");
  });

  it("allows immutable origin reads and disjoint writers while folding overlapping paths", () => {
    const common = {
      groupId: nextUuid(),
      repositoryId: SHA,
      sourceLineageId: SHA,
      sourceSnapshotSha256: SHA,
    };
    const read = createDelegationConflictClaim({ ...common, claimId: nextUuid(), actorId: nextUuid(), workspaceId: null, access: "read", pathPrefixes: ["SRC"] });
    const managedWrite = createDelegationConflictClaim({ ...common, claimId: nextUuid(), actorId: nextUuid(), workspaceId: IDS.workspace, access: "write", pathPrefixes: ["src"] });
    const overlappingWrite = createDelegationConflictClaim({ ...common, claimId: nextUuid(), actorId: nextUuid(), workspaceId: nextUuid(), access: "write", pathPrefixes: ["src/nested"] });
    const disjointWrite = createDelegationConflictClaim({ ...common, claimId: nextUuid(), actorId: nextUuid(), workspaceId: nextUuid(), access: "write", pathPrefixes: ["tests"] });
    expect(delegationConflict(read, managedWrite)).toBe(false);
    expect(delegationConflict(managedWrite, overlappingWrite)).toBe(true);
    expect(delegationConflict(managedWrite, disjointWrite)).toBe(false);
  });

  it("orders cancel-all targets by delegation sequence and identity", () => {
    const revisions = [
      phase20Revision({ delegationId: IDS.delegation3, sequence: 3, status: "queued" }),
      phase20Revision({ delegationId: IDS.delegation, sequence: 1, status: "accepted" }),
      phase20Revision({ delegationId: IDS.delegation2, sequence: 2, status: "active" }),
    ];
    expect(delegationCancelCascade(revisions, IDS.parent).map((target) => target.delegationId)).toEqual([
      IDS.delegation2,
      IDS.delegation3,
    ]);
  });

  it("serializes approval presentation and requires proven-dead takeover", () => {
    const arbiter = new DelegationApprovalArbiter();
    arbiter.enqueue({ approvalRequestId: nextUuid(), actorId: IDS.actor, childAttemptId: IDS.attempt, actionDigest: SHA, actionKind: "patch", requestedSessionSeq: 2 });
    arbiter.enqueue({ approvalRequestId: nextUuid(), actorId: IDS.parent, childAttemptId: nextUuid(), actionDigest: SHA, actionKind: "command", requestedSessionSeq: 1 });
    const first = arbiter.presentNext(nextUuid)!;
    expect(first.actorId).toBe(IDS.parent);
    expect(arbiter.presentNext(nextUuid)).toBe(first);
    arbiter.release({ leaseId: first.leaseId, approvalRequestId: first.approvalRequestId });
    expect(arbiter.presentNext(nextUuid)?.actorId).toBe(IDS.actor);

    const leases = new DelegationGroupLeaseCoordinator();
    const acquired = leases.acquire({ groupId: nextUuid(), repositoryId: SHA, sessionId: IDS.session, parentActorId: IDS.parent, parentRunId: IDS.parent, ownerPid: 42, ownerProcessStartIdentity: SHA, nonceSha256: SHA });
    expect(() => leases.takeover({ expectedLeaseSha256: acquired.leaseSha256, newOwnerPid: 43, newOwnerProcessStartIdentity: "b".repeat(64), newNonceSha256: "c".repeat(64), effectsReconciled: false, probe: { observe: () => "dead" } })).toThrow(/effects/u);
    const taken = leases.takeover({ expectedLeaseSha256: acquired.leaseSha256, newOwnerPid: 43, newOwnerProcessStartIdentity: "b".repeat(64), newNonceSha256: "c".repeat(64), effectsReconciled: true, probe: { observe: () => "dead" } });
    expect(taken.revision).toBe(2);
    expect(() => leases.takeover({ expectedLeaseSha256: acquired.leaseSha256, newOwnerPid: 44, newOwnerProcessStartIdentity: "d".repeat(64), newNonceSha256: "e".repeat(64), effectsReconciled: true, probe: { observe: () => "dead" } })).toThrow(/CAS/u);
  });
});
