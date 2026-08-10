import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  TaskMutationContext,
  TaskMutationWriterFactory,
} from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type {
  ProcessIdentity,
  ProcessIdentityProbe,
} from "../sessions/process-identity.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { DelegationError } from "./delegation-errors.js";
import { DelegationGroupLeaseStore } from "./delegation-group-lease-store.js";
import { DelegationOperationStore } from "./delegation-operation-store.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

function currentEventNonce(
  events: readonly ReturnType<typeof reconstructMultiRunSession>["events"][number][],
  groupId: string,
): string | null {
  for (const event of [...events].reverse()) {
    if (event.scope !== "session") continue;
    if (event.type === "delegation.group.takeover" && event.data.group_id === groupId) {
      return event.data.new_lease_nonce_sha256;
    }
    if (event.type === "delegation.group.lease.acquired" && event.data.group_id === groupId) {
      return event.data.lease_nonce_sha256;
    }
  }
  return null;
}

function isKnownTerminal(status: string): boolean {
  return status === "accepted" || status === "failed" || status === "cancelled";
}

export interface DelegationGroupTakeoverResultV1 {
  readonly changed: boolean;
  readonly groupId: string;
  readonly previousNonceSha256: string;
  readonly releasedLeaseSha256: string;
  readonly takeoverEventId: string;
}

/**
 * Closes the coordinator-crash prefix after every admitted child has already
 * reached a known terminal operation. It never guesses through an active or
 * unknown-effect child, and the repository sidecar is the takeover CAS.
 */
export class DelegationGroupTakeoverReconciler {
  constructor(private readonly options: {
    readonly context: TaskMutationContext;
    readonly currentIdentity: ProcessIdentity;
    readonly operationRoot: string;
    readonly ownerBackgroundOperationId: string | null;
    readonly ownerKind: "foreground" | "phase19_background_worker";
    readonly ownerProbe: ProcessIdentityProbe;
    readonly writerFactory?: TaskMutationWriterFactory;
  }) {}

  async reconcile(input: { readonly delegationId: string }): Promise<DelegationGroupTakeoverResultV1> {
    const writerFactory = this.options.writerFactory ?? defaultWriterFactory;
    let writer = await writerFactory(this.options.context);
    let groupId: string;
    let sessionNonceSha256: string;
    let changed = false;
    try {
      const session = reconstructMultiRunSession(writer.events);
      const revision = [...session.delegations.revisions].reverse().find((candidate) =>
        candidate.delegationId === input.delegationId);
      const actorId = revision?.attempts.at(-1)?.actorId;
      if (revision === undefined || actorId === null || actorId === undefined) {
        throw new DelegationError("delegation_revision_conflict", "delegation takeover has no exact child attempt");
      }
      const activeGroups = new Set([
        ...session.delegations.activeActorSlots.filter((claim) => claim.actorId === actorId).map((claim) => claim.groupId),
        ...session.delegations.activeConflictClaims.filter((claim) => claim.actorId === actorId).map((claim) => claim.groupId),
      ]);
      if (activeGroups.size === 0) {
        const historical = [...writer.events].reverse().find((event) =>
          event.scope === "session" && event.type === "delegation.actor_slot.claimed" &&
          event.data.actor_id === actorId);
        if (historical?.scope === "session" && historical.type === "delegation.actor_slot.claimed") {
          activeGroups.add(historical.data.group_id);
        }
      }
      if (activeGroups.size !== 1) {
        throw new DelegationError("delegation_lease_busy", "delegation attempt has no unique coordinator group");
      }
      groupId = [...activeGroups][0]!;
      const nonce = currentEventNonce(session.events, groupId);
      if (nonce === null) {
        throw new DelegationError("delegation_lease_busy", "delegation group has no durable session lease identity");
      }
      sessionNonceSha256 = nonce;

      const activeSlots = session.delegations.activeActorSlots.filter((claim) => claim.groupId === groupId);
      const activeClaims = session.delegations.activeConflictClaims.filter((claim) => claim.groupId === groupId);
      if (
        activeSlots.some((slot) => !activeClaims.some((claim) => claim.actorId === slot.actorId)) ||
        activeClaims.some((claim) => !activeSlots.some((slot) => slot.actorId === claim.actorId))
      ) {
        throw new DelegationError("delegation_effect_reconciliation_required", "delegation group admission claims are incomplete");
      }
      const operationStores = await DelegationOperationStore.listExisting(this.options.operationRoot);
      const operations = [];
      for (const store of operationStores) {
        const operation = await store.read();
        if (operation !== null && operation.sessionId === this.options.context.sessionId) operations.push(operation);
      }
      for (const slot of activeSlots) {
        const operation = operations.find((candidate) => candidate.childActorId === slot.actorId);
        const terminalRevision = session.delegations.revisions.find((candidate) =>
          candidate.parentRunId === revision.parentRunId &&
          candidate.attempts.some((attempt) => attempt.actorId === slot.actorId && attempt.operationId === operation?.operationId));
        if (
          operation?.state !== "reconciled" || terminalRevision === undefined ||
          !isKnownTerminal(terminalRevision.status)
        ) {
          throw new DelegationError(
            "delegation_effect_reconciliation_required",
            "delegation group contains a live, ambiguous, or unabsorbed child operation",
          );
        }
      }
    } finally {
      await writer.close();
    }

    const leaseStores = await DelegationGroupLeaseStore.listExisting(this.options.operationRoot);
    const matching = [];
    for (const store of leaseStores) {
      const current = await store.read();
      if (
        current?.state === "active" && current.groupId === groupId &&
        current.sessionId === this.options.context.sessionId
      ) {
        matching.push({ current, store });
      }
    }
    if (matching.length !== 1) {
      throw new DelegationError("delegation_lease_busy", "delegation takeover has no unique durable repository lease");
    }
    const match = matching[0]!;
    const nextNonceSha256 = sha256Canonical({
      groupId,
      nonce: this.options.context.randomUuid(),
      previousLeaseSha256: match.current.leaseSha256,
      sessionId: this.options.context.sessionId,
    });
    let taken = match.current;
    if (
      taken.nonceSha256 === sessionNonceSha256 ||
      taken.ownerPid !== this.options.currentIdentity.pid ||
      taken.ownerProcessStartIdentity !== this.options.currentIdentity.startIdentity
    ) {
      taken = await match.store.takeover({
        effectsReconciled: true,
        expectedLeaseSha256: match.current.leaseSha256,
        newNonceSha256: nextNonceSha256,
        newOwnerBackgroundOperationId: this.options.ownerBackgroundOperationId,
        newOwnerKind: this.options.ownerKind,
        newOwnerPid: this.options.currentIdentity.pid,
        newOwnerProcessStartIdentity: this.options.currentIdentity.startIdentity,
        now: this.options.context.now(),
        ownerProbe: this.options.ownerProbe,
      });
      changed = true;
    }
    if (taken.nonceSha256 === sessionNonceSha256) {
      throw new DelegationError("delegation_lease_busy", "delegation takeover did not advance the coordinator nonce");
    }

    writer = await writerFactory(this.options.context);
    let takeoverEventId: string;
    try {
      let session = reconstructMultiRunSession(writer.events);
      const projectedNonce = currentEventNonce(session.events, groupId);
      if (projectedNonce === sessionNonceSha256) {
        const event = await writer.appendDelegationEvent("delegation.group.takeover", {
          group_id: groupId,
          new_lease_nonce_sha256: taken.nonceSha256,
          previous_lease_nonce_sha256: sessionNonceSha256,
          reason: "owner_confirmed_dead_and_effects_reconciled",
        });
        takeoverEventId = event.eventId;
        changed = true;
      } else if (projectedNonce === taken.nonceSha256) {
        const existing = [...writer.events].reverse().find((event) =>
          event.scope === "session" && event.type === "delegation.group.takeover" &&
          event.data.group_id === groupId && event.data.new_lease_nonce_sha256 === taken.nonceSha256);
        if (existing === undefined) {
          throw new DelegationError("delegation_lease_busy", "delegation takeover event identity is missing");
        }
        takeoverEventId = existing.eventId;
      } else {
        throw new DelegationError("delegation_lease_busy", "delegation session lease changed during takeover");
      }

      session = reconstructMultiRunSession(writer.events);
      for (const claim of session.delegations.activeConflictClaims.filter((candidate) => candidate.groupId === groupId)) {
        await writer.appendDelegationEvent("delegation.conflict_claim.released", {
          actor_id: claim.actorId,
          claim_id: claim.claimId,
          group_id: groupId,
        });
        changed = true;
      }
      session = reconstructMultiRunSession(writer.events);
      for (const slot of session.delegations.activeActorSlots.filter((candidate) => candidate.groupId === groupId)) {
        await writer.appendDelegationEvent("delegation.actor_slot.released", {
          actor_id: slot.actorId,
          claim_id: slot.claimId,
          group_id: groupId,
          release_reason: "reconciled",
        });
        changed = true;
      }
      session = reconstructMultiRunSession(writer.events);
      for (const barrier of session.delegations.barriers.filter((candidate) => candidate.status === "suspended")) {
        const required = barrier.requiredDelegationIds.map((delegationId) =>
          [...session.delegations.revisions].reverse().find((candidate) =>
            candidate.delegationId === delegationId && candidate.parentRunId === barrier.parentRunId));
        if (required.some((candidate) => candidate === undefined || !isKnownTerminal(candidate.status))) continue;
        await writer.appendDelegationEvent("delegation.parent.barrier.released", {
          barrier_id: barrier.barrierId,
          parent_actor_id: barrier.parentActorId,
          parent_run_id: barrier.parentRunId,
          receipt_sha256s: required.flatMap((candidate) =>
            candidate?.receipt?.acceptedEventId === null || candidate?.receipt === null || candidate?.receipt === undefined
              ? []
              : [candidate.receipt.sha256]),
          status: required.every((candidate) => candidate?.status === "accepted") ? "completed" : "blocked",
        });
        changed = true;
      }
    } finally {
      await writer.close();
    }

    const released = await match.store.release({
      effectsReconciled: true,
      expectedLeaseSha256: taken.leaseSha256,
      now: this.options.context.now(),
      reason: "reconciled",
    });
    return Object.freeze({
      changed,
      groupId,
      previousNonceSha256: sessionNonceSha256,
      releasedLeaseSha256: released.leaseSha256,
      takeoverEventId,
    });
  }
}
