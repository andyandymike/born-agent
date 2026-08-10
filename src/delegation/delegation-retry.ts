import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import { DelegationError } from "./delegation-errors.js";
import type {
  DelegationAttemptProjectionV1,
  DelegationBudgetCountersProjectionV1,
  DelegationRevisionProjectionV1,
} from "./delegation-projector.js";
import type { ChildReceiptBudgetUsageV1 } from "./receipts/child-receipt-schema.js";

const numericBudgetKeys = Object.freeze([
  "maxAttempts",
  "maxDurationMs",
  "maxModelSteps",
  "maxCommandExecutions",
  "maxCommandOutputBytes",
  "maxChangedFiles",
  "maxChangedBytes",
  "maxArtifactBytes",
] as const satisfies readonly Exclude<keyof TaskGraphBudgetV1, "maxReportedTokens">[]);

function usageAsBudget(usage: DelegationBudgetCountersProjectionV1): TaskGraphBudgetV1 {
  return Object.freeze({
    maxArtifactBytes: usage.artifactBytes,
    maxAttempts: usage.attempts,
    maxChangedBytes: usage.changedBytes,
    maxChangedFiles: usage.changedFiles,
    maxCommandExecutions: usage.commandExecutions,
    maxCommandOutputBytes: usage.commandOutputBytes,
    maxDurationMs: usage.durationMs,
    maxModelSteps: usage.modelSteps,
    maxReportedTokens: usage.reportedTokens,
  });
}

function addUsage(
  left: DelegationBudgetCountersProjectionV1,
  right: DelegationBudgetCountersProjectionV1,
): DelegationBudgetCountersProjectionV1 {
  return Object.freeze({
    artifactBytes: left.artifactBytes + right.artifactBytes,
    attempts: left.attempts + right.attempts,
    changedBytes: left.changedBytes + right.changedBytes,
    changedFiles: left.changedFiles + right.changedFiles,
    commandExecutions: left.commandExecutions + right.commandExecutions,
    commandOutputBytes: left.commandOutputBytes + right.commandOutputBytes,
    durationMs: left.durationMs + right.durationMs,
    modelSteps: left.modelSteps + right.modelSteps,
    reportedTokens: left.reportedTokens === null || right.reportedTokens === null
      ? null
      : left.reportedTokens + right.reportedTokens,
  });
}

const zeroUsage: DelegationBudgetCountersProjectionV1 = Object.freeze({
  artifactBytes: 0,
  attempts: 0,
  changedBytes: 0,
  changedFiles: 0,
  commandExecutions: 0,
  commandOutputBytes: 0,
  durationMs: 0,
  modelSteps: 0,
  reportedTokens: 0,
});

export function preEffectInfrastructureUsage(): ChildReceiptBudgetUsageV1 {
  return Object.freeze({
    artifactBytes: 0,
    attempts: 1,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: 0,
    commandOutputBytes: 0,
    durationMs: 0,
    modelSteps: 0,
    reportedTokens: 0,
  });
}

export function isAutomaticPreEffectRetryEligible(
  revision: DelegationRevisionProjectionV1,
): boolean {
  const attempt = revision.attempts.at(-1);
  return revision.status === "queued" &&
    revision.receipt === null &&
    revision.content.retry.maxAttempts === 2 &&
    revision.content.retry.automaticOn.includes("pre_effect_infrastructure_failure") &&
    revision.attempts.length < revision.content.retry.maxAttempts &&
    attempt?.terminal === "pre_effect_infrastructure_failure" &&
    attempt.unresolvedEffectIds.length === 0 &&
    attempt.budgetUsage?.attempts === 1 &&
    attempt.budgetSettlementEventId !== null;
}

export function delegationRemainingBudget(
  revision: DelegationRevisionProjectionV1,
): TaskGraphBudgetV1 {
  const used = revision.attempts.reduce(
    (total, attempt) => addUsage(total, attempt.budgetUsage ?? zeroUsage),
    zeroUsage,
  );
  const usedBudget = usageAsBudget(used);
  const remaining = {} as Record<keyof TaskGraphBudgetV1, number | null>;
  for (const key of numericBudgetKeys) {
    const value = revision.content.budget[key] - usedBudget[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DelegationError("delegation_budget_exhausted", `delegation retry has no remaining ${key}`);
    }
    remaining[key] = value;
  }
  if (revision.content.budget.maxReportedTokens === null) {
    remaining.maxReportedTokens = null;
  } else {
    if (usedBudget.maxReportedTokens === null) {
      throw new DelegationError("delegation_budget_exhausted", "delegation retry token usage is unknown");
    }
    const tokens = revision.content.budget.maxReportedTokens - usedBudget.maxReportedTokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new DelegationError("delegation_budget_exhausted", "delegation retry has no remaining reported-token budget");
    }
    remaining.maxReportedTokens = tokens;
  }
  return Object.freeze(remaining as unknown as TaskGraphBudgetV1);
}

export function requireRetryablePreviousAttempt(
  revision: DelegationRevisionProjectionV1,
): DelegationAttemptProjectionV1 {
  const attempt = revision.attempts.at(-1);
  if (!isAutomaticPreEffectRetryEligible(revision) || attempt === undefined) {
    throw new DelegationError(
      "delegation_revision_conflict",
      "delegation does not have a settled, zero-effect automatic retry prefix",
    );
  }
  return attempt;
}
