import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import { DelegationError } from "./delegation-errors.js";
import type { ChildReceiptBudgetUsageV1 } from "./receipts/child-receipt-schema.js";

export interface DelegationBudgetReservationV1 {
  readonly schemaVersion: 1;
  readonly reservationId: string;
  readonly delegationId: string;
  readonly childAttemptId: string;
  readonly parentBudgetLedgerRevision: number;
  readonly graphBudgetLedgerRevision: number | null;
  readonly reserved: TaskGraphBudgetV1;
  readonly status: "held" | "settled" | "blocked";
  readonly reservationSha256: string;
}

export interface DelegationBudgetLedgerProjectionV1 {
  readonly revision: number;
  readonly maximum: TaskGraphBudgetV1;
  readonly held: TaskGraphBudgetV1;
  readonly used: ChildReceiptBudgetUsageV1;
  readonly reservations: readonly DelegationBudgetReservationV1[];
  readonly ledgerSha256: string;
}

const numericKeys = Object.freeze([
  "maxAttempts",
  "maxDurationMs",
  "maxModelSteps",
  "maxCommandExecutions",
  "maxCommandOutputBytes",
  "maxChangedFiles",
  "maxChangedBytes",
  "maxArtifactBytes",
] as const satisfies readonly Exclude<keyof TaskGraphBudgetV1, "maxReportedTokens">[]);

function zeroBudget(): TaskGraphBudgetV1 {
  return {
    maxAttempts: 0,
    maxDurationMs: 0,
    maxModelSteps: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    maxArtifactBytes: 0,
    maxReportedTokens: 0,
  };
}

function add(left: TaskGraphBudgetV1, right: TaskGraphBudgetV1): TaskGraphBudgetV1 {
  const result = zeroBudget() as Record<keyof TaskGraphBudgetV1, number | null>;
  for (const key of numericKeys) result[key] = left[key] + right[key];
  result.maxReportedTokens = left.maxReportedTokens === null || right.maxReportedTokens === null
    ? null
    : left.maxReportedTokens + right.maxReportedTokens;
  return Object.freeze(result as unknown as TaskGraphBudgetV1);
}

function fits(maximum: TaskGraphBudgetV1, held: TaskGraphBudgetV1, requested: TaskGraphBudgetV1): boolean {
  if (numericKeys.some((key) => held[key] + requested[key] > maximum[key])) return false;
  if (maximum.maxReportedTokens === null) return true;
  return held.maxReportedTokens !== null && requested.maxReportedTokens !== null &&
    held.maxReportedTokens + requested.maxReportedTokens <= maximum.maxReportedTokens;
}

function usageToBudget(usage: ChildReceiptBudgetUsageV1): TaskGraphBudgetV1 {
  return Object.freeze({
    maxAttempts: usage.attempts,
    maxDurationMs: usage.durationMs,
    maxModelSteps: usage.modelSteps,
    maxCommandExecutions: usage.commandExecutions,
    maxCommandOutputBytes: usage.commandOutputBytes,
    maxChangedFiles: usage.changedFiles,
    maxChangedBytes: usage.changedBytes,
    maxArtifactBytes: usage.artifactBytes,
    maxReportedTokens: usage.reportedTokens,
  });
}

function projection(input: Omit<DelegationBudgetLedgerProjectionV1, "ledgerSha256">): DelegationBudgetLedgerProjectionV1 {
  return Object.freeze({ ...input, ledgerSha256: sha256Canonical(input) });
}

export class DelegationBudgetLedger {
  #state: DelegationBudgetLedgerProjectionV1;

  constructor(maximum: TaskGraphBudgetV1) {
    this.#state = projection({
      revision: 0,
      maximum,
      held: zeroBudget(),
      used: {
        artifactBytes: 0,
        attempts: 0,
        changedBytes: 0,
        changedFiles: 0,
        commandExecutions: 0,
        commandOutputBytes: 0,
        durationMs: 0,
        modelSteps: 0,
        reportedTokens: 0,
      },
      reservations: [],
    });
  }

  get state(): DelegationBudgetLedgerProjectionV1 {
    return this.#state;
  }

  reserve(input: {
    readonly expectedRevision: number;
    readonly reservationId: string;
    readonly delegationId: string;
    readonly childAttemptId: string;
    readonly graphBudgetLedgerRevision: number | null;
    readonly requested: TaskGraphBudgetV1;
  }): DelegationBudgetReservationV1 {
    if (input.expectedRevision !== this.#state.revision) {
      throw new DelegationError("delegation_lease_busy", "budget ledger revision changed before reservation");
    }
    if (this.#state.reservations.some((item) => item.reservationId === input.reservationId || item.childAttemptId === input.childAttemptId)) {
      throw new DelegationError("delegation_budget_exhausted", "budget reservation identity is already used");
    }
    if (!fits(this.#state.maximum, this.#state.held, input.requested)) {
      throw new DelegationError("delegation_budget_exhausted", "delegation budget would oversubscribe the parent ledger");
    }
    const content = {
      schemaVersion: 1 as const,
      reservationId: input.reservationId,
      delegationId: input.delegationId,
      childAttemptId: input.childAttemptId,
      parentBudgetLedgerRevision: this.#state.revision,
      graphBudgetLedgerRevision: input.graphBudgetLedgerRevision,
      reserved: input.requested,
      status: "held" as const,
    };
    const reservation = Object.freeze({ ...content, reservationSha256: sha256Canonical(content) });
    this.#state = projection({
      ...this.#state,
      revision: this.#state.revision + 1,
      held: add(this.#state.held, input.requested),
      reservations: Object.freeze([...this.#state.reservations, reservation]),
    });
    return reservation;
  }

  settle(input: {
    readonly expectedRevision: number;
    readonly reservationId: string;
    readonly usage: ChildReceiptBudgetUsageV1;
    readonly unresolvedEffect: boolean;
  }): DelegationBudgetReservationV1 {
    if (input.expectedRevision !== this.#state.revision) {
      throw new DelegationError("delegation_lease_busy", "budget ledger revision changed before settlement");
    }
    const index = this.#state.reservations.findIndex((item) => item.reservationId === input.reservationId);
    const current = this.#state.reservations[index];
    if (current === undefined || current.status !== "held") {
      throw new DelegationError("delegation_budget_exhausted", "budget reservation is absent or already settled");
    }
    if (input.unresolvedEffect) {
      const blocked = Object.freeze({ ...current, status: "blocked" as const });
      this.#state = projection({
        ...this.#state,
        revision: this.#state.revision + 1,
        reservations: Object.freeze(this.#state.reservations.map((item, offset) => offset === index ? blocked : item)),
      });
      // PHASE20: an unknown effect keeps its worst-case hold. PID exit and
      // timeout do not release budget that may already have been consumed.
      return blocked;
    }
    const actual = usageToBudget(input.usage);
    if (!fits(current.reserved, zeroBudget(), actual)) {
      throw new DelegationError("delegation_budget_exhausted", "reported child usage exceeds the reserved ceiling");
    }
    const settled = Object.freeze({ ...current, status: "settled" as const });
    const held = zeroBudget() as Record<keyof TaskGraphBudgetV1, number | null>;
    for (const key of numericKeys) held[key] = this.#state.held[key] - current.reserved[key];
    held.maxReportedTokens = this.#state.held.maxReportedTokens === null || current.reserved.maxReportedTokens === null
      ? null
      : this.#state.held.maxReportedTokens - current.reserved.maxReportedTokens;
    const used = {
      artifactBytes: this.#state.used.artifactBytes + input.usage.artifactBytes,
      attempts: this.#state.used.attempts + input.usage.attempts,
      changedBytes: this.#state.used.changedBytes + input.usage.changedBytes,
      changedFiles: this.#state.used.changedFiles + input.usage.changedFiles,
      commandExecutions: this.#state.used.commandExecutions + input.usage.commandExecutions,
      commandOutputBytes: this.#state.used.commandOutputBytes + input.usage.commandOutputBytes,
      durationMs: this.#state.used.durationMs + input.usage.durationMs,
      modelSteps: this.#state.used.modelSteps + input.usage.modelSteps,
      reportedTokens: this.#state.used.reportedTokens === null || input.usage.reportedTokens === null
        ? null
        : this.#state.used.reportedTokens + input.usage.reportedTokens,
    };
    this.#state = projection({
      ...this.#state,
      revision: this.#state.revision + 1,
      held: Object.freeze(held as unknown as TaskGraphBudgetV1),
      used: Object.freeze(used),
      reservations: Object.freeze(this.#state.reservations.map((item, offset) => offset === index ? settled : item)),
    });
    return settled;
  }
}
