import { sha256Canonical } from "../completion/canonical-json.js";

/**
 * Exact first-Build candidate identity. It is replaced by the hydrated ledger
 * hash once Goal change records exist, but is never a claim that changes exist.
 */
export function initialGoalChangeLedgerSha256(input: {
  readonly goalId: string;
  readonly goalRevision: number;
}): string {
  return sha256Canonical({
    baseline: null,
    goal_id: input.goalId,
    goal_revision: input.goalRevision,
    records: [],
    schema_version: 1,
  });
}
