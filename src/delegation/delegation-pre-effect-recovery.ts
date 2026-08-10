import type {
  TaskMutationContext,
  TaskMutationWriterFactory,
} from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { DelegationError } from "./delegation-errors.js";
import type { DelegationOperationStore } from "./delegation-operation-store.js";
import type { DelegationChildOperationV1 } from "./delegation-operation-schema.js";
import { isAutomaticPreEffectRetryEligible } from "./delegation-retry.js";

async function defaultWriterFactory(context: TaskMutationContext): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

const zero = Object.freeze({
  artifact_bytes: 0,
  attempts: 0,
  changed_bytes: 0,
  changed_files: 0,
  command_executions: 0,
  command_output_bytes: 0,
  duration_ms: 0,
  model_steps: 0,
  reported_tokens: 0,
});

function preEffectUsage(reportedTokens: number | null) {
  return Object.freeze({ ...zero, attempts: 1, reported_tokens: reportedTokens });
}

function released(input: {
  readonly artifact_bytes: number;
  readonly attempts: number;
  readonly changed_bytes: number;
  readonly changed_files: number;
  readonly command_executions: number;
  readonly command_output_bytes: number;
  readonly duration_ms: number;
  readonly model_steps: number;
  readonly reported_tokens: number | null;
}) {
  if (input.attempts < 1) {
    throw new DelegationError("delegation_budget_exhausted", "pre-effect failure has no reserved attempt budget");
  }
  return Object.freeze({
    ...input,
    attempts: input.attempts - 1,
  });
}

export interface DelegationPreEffectRecoveryResultV1 {
  readonly changed: boolean;
  readonly closedGroupId: string | null;
  readonly operation: DelegationChildOperationV1;
  readonly retryEligible: boolean;
}

/**
 * Absorb a proven pre-start-barrier process failure into session authority.
 * The operation sidecar proves cleanup; the session event and settlement make
 * the retry prefix replayable. Either layer alone is intentionally insufficient.
 */
export class DelegationPreEffectRecovery {
  constructor(private readonly writerFactory: TaskMutationWriterFactory = defaultWriterFactory) {}

  async reconcile(input: {
    readonly context: TaskMutationContext;
    readonly releaseAdmissionClaims?: boolean;
    readonly store: DelegationOperationStore;
  }): Promise<DelegationPreEffectRecoveryResultV1> {
    let operation = await input.store.read();
    if (operation === null || !["pre_effect_terminal", "reconciled"].includes(operation.state)) {
      throw new DelegationError("delegation_effect_reconciliation_required", "operation has no proven pre-effect terminal prefix");
    }
    if (operation.failure === undefined || operation.failure === null || operation.failure.phase === "after_start_barrier") {
      throw new DelegationError("delegation_effect_reconciliation_required", "operation failure does not prove a closed start barrier");
    }
    if (
      operation.process !== null &&
      (operation.processCleanup === undefined || operation.processCleanup === null ||
        !operation.processCleanup.verified || operation.processCleanup.pid !== operation.process.pid)
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "operation process tree cleanup is not exact and verified");
    }

    let changed = false;
    let admissionGroupId: string | null = null;
    const writer = await this.writerFactory(input.context);
    try {
      let session = reconstructMultiRunSession(writer.events);
      let revision = session.delegations.revisions.find((candidate) =>
        candidate.delegationId === operation!.delegationId && candidate.parentRunId === operation!.parentRunId);
      let attempt = revision?.attempts.find((candidate) =>
        candidate.attemptId === operation!.childAttemptId && candidate.operationId === operation!.operationId);
      if (revision === undefined || attempt === undefined || attempt.actorId !== operation.childActorId) {
        throw new DelegationError("delegation_child_protocol_invalid", "operation has no exact durable launch attempt");
      }
      const reservation = writer.events.find((event) =>
        event.scope === "session" && event.type === "delegation.budget.reserved" &&
        event.data.reservation_id === attempt!.reservationId &&
        event.data.child_attempt_id === operation!.childAttemptId);
      if (reservation?.scope !== "session" || reservation.type !== "delegation.budget.reserved") {
        throw new DelegationError("delegation_budget_exhausted", "operation has no exact durable budget reservation");
      }
      const reportedTokens = reservation.data.reserved.reported_tokens === null ? null : 0;
      if (attempt.terminalEventId === null) {
        await writer.appendDelegationEvent("delegation.child.terminal", {
          budget_usage: preEffectUsage(reportedTokens),
          child_actor_id: operation.childActorId,
          child_attempt_id: operation.childAttemptId,
          child_run_id: operation.childRunId,
          delegation_id: revision.delegationId,
          delegation_revision: revision.delegationRevision,
          delegation_sha256: revision.delegationSha256,
          diagnostic_code: operation.failure.code,
          operation_id: operation.operationId,
          parent_actor_id: revision.parentActorId,
          parent_run_id: revision.parentRunId,
          terminal: "pre_effect_infrastructure_failure",
          unresolved_effect_ids: [],
        });
        changed = true;
        session = reconstructMultiRunSession(writer.events);
        revision = session.delegations.revisions.find((candidate) =>
          candidate.delegationId === operation!.delegationId && candidate.parentRunId === operation!.parentRunId);
        attempt = revision?.attempts.find((candidate) => candidate.attemptId === operation!.childAttemptId);
      }
      if (revision === undefined || attempt === undefined || attempt.terminal !== "pre_effect_infrastructure_failure") {
        throw new DelegationError("delegation_child_protocol_invalid", "operation terminal is not the expected pre-effect failure");
      }
      if (attempt.budgetSettlementEventId === null) {
        await writer.appendDelegationEvent("delegation.budget.settled", {
          child_attempt_id: operation.childAttemptId,
          delegation_id: revision.delegationId,
          delegation_revision: revision.delegationRevision,
          delegation_sha256: revision.delegationSha256,
          held: Object.freeze({ ...zero, reported_tokens: reportedTokens }),
          parent_actor_id: revision.parentActorId,
          parent_run_id: revision.parentRunId,
          released: released(reservation.data.reserved),
          reservation_id: reservation.data.reservation_id,
          used: preEffectUsage(reportedTokens),
        });
        changed = true;
      }
      if (input.releaseAdmissionClaims === true) {
        session = reconstructMultiRunSession(writer.events);
        const activeSlots = session.delegations.activeActorSlots.filter((claim) =>
          claim.actorId === operation!.childActorId);
        const activeClaims = session.delegations.activeConflictClaims.filter((claim) =>
          claim.actorId === operation!.childActorId);
        if (activeSlots.length > 1 || activeClaims.length > 1) {
          throw new DelegationError(
            "delegation_parallel_limit",
            "pre-effect attempt owns ambiguous admission claims",
          );
        }
        const historicalSlot = [...writer.events].reverse().find((event) =>
          event.scope === "session" && event.type === "delegation.actor_slot.claimed" &&
          event.data.actor_id === operation!.childActorId);
        const historicalClaim = [...writer.events].reverse().find((event) =>
          event.scope === "session" && event.type === "delegation.conflict_claim.granted" &&
          event.data.actor_id === operation!.childActorId);
        const groupId = activeSlots[0]?.groupId ?? activeClaims[0]?.groupId ??
          (historicalSlot?.scope === "session" && historicalSlot.type === "delegation.actor_slot.claimed"
            ? historicalSlot.data.group_id
            : historicalClaim?.scope === "session" && historicalClaim.type === "delegation.conflict_claim.granted"
              ? historicalClaim.data.group_id
              : null);
        if (
          groupId === null ||
          activeSlots.some((claim) => claim.groupId !== groupId) ||
          activeClaims.some((claim) => claim.groupId !== groupId) ||
          (historicalSlot?.scope === "session" && historicalSlot.type === "delegation.actor_slot.claimed" &&
            historicalSlot.data.group_id !== groupId) ||
          (historicalClaim?.scope === "session" && historicalClaim.type === "delegation.conflict_claim.granted" &&
            historicalClaim.data.group_id !== groupId)
        ) {
          throw new DelegationError(
            "delegation_lease_busy",
            "pre-effect attempt has no exact admission group identity",
          );
        }
        admissionGroupId = groupId;
        if (activeClaims[0] !== undefined) {
          await writer.appendDelegationEvent("delegation.conflict_claim.released", {
            actor_id: activeClaims[0].actorId,
            claim_id: activeClaims[0].claimId,
            group_id: groupId,
          });
          changed = true;
        }
        if (activeSlots[0] !== undefined) {
          await writer.appendDelegationEvent("delegation.actor_slot.released", {
            actor_id: activeSlots[0].actorId,
            claim_id: activeSlots[0].claimId,
            group_id: groupId,
            release_reason: "reconciled",
          });
          changed = true;
        }

        session = reconstructMultiRunSession(writer.events);
        const suspended = session.delegations.barriers.filter((barrier) =>
          barrier.status === "suspended" &&
          barrier.parentRunId === operation!.parentRunId &&
          barrier.requiredDelegationIds.includes(operation!.delegationId));
        for (const barrier of suspended) {
          const required = barrier.requiredDelegationIds.map((delegationId) =>
            [...session.delegations.revisions].reverse().find((candidate) =>
              candidate.delegationId === delegationId && candidate.parentRunId === barrier.parentRunId));
          const allKnown = required.every((candidate) => {
            if (candidate === undefined) return false;
            if (["accepted", "failed", "blocked", "cancelled"].includes(candidate.status)) return true;
            const lastAttempt = candidate.attempts.at(-1);
            return candidate.status === "queued" &&
              lastAttempt?.terminal === "pre_effect_infrastructure_failure" &&
              lastAttempt.budgetSettlementEventId !== null;
          });
          const hasActiveAdmission = session.delegations.activeActorSlots.some((claim) =>
            claim.groupId === groupId) || session.delegations.activeConflictClaims.some((claim) =>
            claim.groupId === groupId);
          if (!allKnown || hasActiveAdmission) continue;
          await writer.appendDelegationEvent("delegation.parent.barrier.released", {
            barrier_id: barrier.barrierId,
            parent_actor_id: barrier.parentActorId,
            parent_run_id: barrier.parentRunId,
            receipt_sha256s: required.flatMap((candidate) =>
              candidate?.receipt?.acceptedEventId === null || candidate?.receipt === null || candidate?.receipt === undefined
                ? []
                : [candidate.receipt.sha256]),
            status: "blocked",
          });
          changed = true;
        }
      }
    } finally {
      await writer.close();
    }

    operation = (await input.store.read())!;
    if (operation.state === "pre_effect_terminal") {
      try {
        operation = await input.store.compareAndSwap({
          expectedSha256: operation.operationSha256,
          expectedState: "pre_effect_terminal",
          now: input.context.now(),
          mutate: (current) => ({ ...current, state: "reconciled" }),
        });
        changed = true;
      } catch (error) {
        const observed = await input.store.read();
        if (
          !(error instanceof DelegationError) || error.code !== "delegation_lease_busy" ||
          observed === null || observed.state !== "reconciled" ||
          observed.operationId !== operation.operationId ||
          observed.childAttemptId !== operation.childAttemptId
        ) {
          throw error;
        }
        operation = observed;
      }
    }
    const readWriter = await this.writerFactory(input.context);
    let retryEligible: boolean;
    let closedGroupId: string | null = null;
    try {
      const session = reconstructMultiRunSession(readWriter.events);
      const revision = session.delegations.revisions.find((candidate) =>
        candidate.delegationId === operation.delegationId && candidate.parentRunId === operation.parentRunId);
      retryEligible = revision !== undefined && isAutomaticPreEffectRetryEligible(revision);
      if (admissionGroupId !== null) {
        const groupHasActiveAdmission = session.delegations.activeActorSlots.some((claim) =>
          claim.groupId === admissionGroupId) || session.delegations.activeConflictClaims.some((claim) =>
          claim.groupId === admissionGroupId);
        const groupHasSuspendedBarrier = session.delegations.barriers.some((barrier) =>
          barrier.status === "suspended" && barrier.parentRunId === operation.parentRunId &&
          barrier.requiredDelegationIds.includes(operation.delegationId));
        if (!groupHasActiveAdmission && !groupHasSuspendedBarrier) closedGroupId = admissionGroupId;
      }
    } finally {
      await readWriter.close();
    }
    return Object.freeze({
      changed,
      closedGroupId,
      operation,
      retryEligible,
    });
  }
}
