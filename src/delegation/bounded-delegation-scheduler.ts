import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import type { DelegationBudgetLedger, DelegationBudgetReservationV1 } from "./delegation-budget-ledger.js";
import {
  assertConflictClaimAdmissible,
  createDelegationConflictClaim,
  type DelegationConflictClaimV1,
} from "./delegation-conflict-claim.js";
import { DelegationError } from "./delegation-errors.js";
import type { DelegationRevisionProjectionV1 } from "./delegation-projector.js";

export interface ReadyDelegationV1 {
  readonly revision: DelegationRevisionProjectionV1;
  readonly childActorId: string;
  readonly childAttemptId: string;
  readonly requestedBudget: TaskGraphBudgetV1;
  readonly conflict: {
    readonly access: "read" | "write";
    readonly repositoryId: string;
    readonly workspaceId: string | null;
    readonly sourceLineageId: string;
    readonly sourceSnapshotSha256: string;
    readonly pathPrefixes: readonly string[];
  };
}

export interface DelegationAdmissionV1 {
  readonly actorSlot: 1 | 2;
  readonly candidate: ReadyDelegationV1;
  readonly conflictClaim: DelegationConflictClaimV1;
  readonly reservation: DelegationBudgetReservationV1;
}

export interface DelegationAdmissionResultV1 {
  readonly admitted: readonly DelegationAdmissionV1[];
  readonly deferred: readonly {
    readonly delegationId: string;
    readonly reason: "actor_limit" | "budget" | "workspace_conflict";
  }[];
}

export class BoundedDelegationScheduler {
  constructor(private readonly input: {
    readonly groupId: string;
    readonly ledger: DelegationBudgetLedger;
    readonly randomUuid: () => string;
  }) {}

  admit(input: {
    readonly ready: readonly ReadyDelegationV1[];
    readonly parentModelActive: boolean;
    readonly maximumChildren?: 0 | 1 | 2;
    readonly activeClaims?: readonly DelegationConflictClaimV1[];
    readonly activeChildCount?: number;
    readonly activeActorSlots?: readonly (1 | 2)[];
  }): DelegationAdmissionResultV1 {
    const ordered = [...input.ready].filter((candidate) =>
      candidate.revision.status === "queued" && candidate.revision.envelope !== null)
      .sort((left, right) =>
        left.revision.content.sequence - right.revision.content.sequence ||
        (left.revision.delegationId < right.revision.delegationId ? -1 : 1));
    const activeClaims = [...(input.activeClaims ?? [])];
    const admitted: DelegationAdmissionV1[] = [];
    const deferred: DelegationAdmissionResultV1["deferred"][number][] = [];
    // PHASE20: policy may lower the child cap to one or zero, but can never
    // raise the hard maximum of two model actors or make a live parent plus
    // two children admissible.
    const maximumChildren = Math.min(
      input.maximumChildren ?? 2,
      input.parentModelActive ? 1 : 2,
    );
    let active = input.activeChildCount ?? 0;
    const occupiedSlots = new Set<1 | 2>(
      input.activeActorSlots ?? Array.from({ length: active }, (_, index) => (index + 1) as 1 | 2),
    );
    if (
      input.activeActorSlots !== undefined &&
      (occupiedSlots.size !== input.activeActorSlots.length || occupiedSlots.size !== active)
    ) {
      throw new DelegationError(
        "delegation_lease_busy",
        "active child count and exact actor slot ownership are inconsistent",
      );
    }
    for (const candidate of ordered) {
      if (active >= maximumChildren) {
        deferred.push({ delegationId: candidate.revision.delegationId, reason: "actor_limit" });
        continue;
      }
      const actorSlot = ([1, 2] as const).find((slot) => !occupiedSlots.has(slot));
      if (actorSlot === undefined) {
        deferred.push({ delegationId: candidate.revision.delegationId, reason: "actor_limit" });
        continue;
      }
      const claim = createDelegationConflictClaim({
        claimId: this.input.randomUuid(),
        groupId: this.input.groupId,
        actorId: candidate.childActorId,
        repositoryId: candidate.conflict.repositoryId,
        workspaceId: candidate.conflict.workspaceId,
        sourceLineageId: candidate.conflict.sourceLineageId,
        sourceSnapshotSha256: candidate.conflict.sourceSnapshotSha256,
        access: candidate.conflict.access,
        pathPrefixes: candidate.conflict.pathPrefixes,
      });
      try {
        assertConflictClaimAdmissible(claim, activeClaims);
      } catch (error) {
        if (error instanceof DelegationError && error.code === "delegation_workspace_conflict") {
          deferred.push({ delegationId: candidate.revision.delegationId, reason: "workspace_conflict" });
          continue;
        }
        throw error;
      }
      let reservation: DelegationBudgetReservationV1;
      try {
        reservation = this.input.ledger.reserve({
          expectedRevision: this.input.ledger.state.revision,
          reservationId: this.input.randomUuid(),
          delegationId: candidate.revision.delegationId,
          childAttemptId: candidate.childAttemptId,
          graphBudgetLedgerRevision: candidate.revision.binding.graphRevision,
          requested: candidate.requestedBudget,
        });
      } catch (error) {
        if (error instanceof DelegationError && error.code === "delegation_budget_exhausted") {
          deferred.push({ delegationId: candidate.revision.delegationId, reason: "budget" });
          continue;
        }
        throw error;
      }
      admitted.push(Object.freeze({ actorSlot, candidate, conflictClaim: claim, reservation }));
      activeClaims.push(claim);
      occupiedSlots.add(actorSlot);
      active += 1;
    }
    return Object.freeze({ admitted: Object.freeze(admitted), deferred: Object.freeze(deferred) });
  }

  async execute<T>(
    admissions: readonly DelegationAdmissionV1[],
    runner: (admission: DelegationAdmissionV1) => Promise<T>,
  ): Promise<readonly PromiseSettledResult<T>[]> {
    if (admissions.length > 2) {
      throw new DelegationError("delegation_parallel_limit", "scheduler cannot execute more than two child actors");
    }
    return Promise.allSettled(admissions.map((admission) => runner(admission)));
  }
}
