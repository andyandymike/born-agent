import type { ProcessIdentityProbeResult } from "../sessions/process-identity.js";
import type { ReconstructedRunProjection } from "../sessions/reconstruct-multi-run-session.js";
import type { DelegationChildOperationV1 } from "./delegation-operation-schema.js";
import type { DelegationRevisionProjectionV1 } from "./delegation-projector.js";

export type DelegationReconcileOutcomeV1 =
  | { readonly kind: "resume_same_child"; readonly attemptId: string }
  | { readonly kind: "terminal_backfilled"; readonly receiptSha256: string }
  | { readonly kind: "retry_pre_effect_allowed" }
  | { readonly kind: "pre_effect_failure_terminal"; readonly attemptId: string }
  | { readonly kind: "cancelled_clean"; readonly receiptSha256: string }
  | { readonly kind: "blocked_unknown_effect"; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "corrupt"; readonly code: string };

function evidence(input: {
  readonly operation: DelegationChildOperationV1;
  readonly run?: ReconstructedRunProjection;
}): readonly string[] {
  return Object.freeze([
    `sha256:${input.operation.operationSha256}`,
    ...(input.run === undefined ? [] : input.run.events.map((event) => `event:${event.eventId}`)),
  ]);
}

export function classifyDelegationReconcileOutcome(input: {
  readonly authenticatedChannelAvailable?: boolean;
  readonly operation: DelegationChildOperationV1;
  readonly ownerObservation: ProcessIdentityProbeResult | "not_started";
  readonly revision?: DelegationRevisionProjectionV1;
  readonly run?: ReconstructedRunProjection;
}): DelegationReconcileOutcomeV1 {
  const { operation, revision, run } = input;
  const attempt = revision?.attempts.find((candidate) =>
    candidate.attemptId === operation.childAttemptId &&
    candidate.operationId === operation.operationId);
  const preEffectRecorded =
    operation.failure !== undefined && operation.failure !== null &&
    operation.failure.phase !== "after_start_barrier" &&
    (operation.process === null || (
      operation.processCleanup !== undefined && operation.processCleanup !== null &&
      operation.processCleanup.verified && operation.processCleanup.pid === operation.process.pid
    ));
  if (
    (revision !== undefined && (
      revision.delegationId !== operation.delegationId ||
      revision.parentRunId !== operation.parentRunId ||
      attempt === undefined ||
      attempt.actorId !== operation.childActorId ||
      (attempt.childRunId !== operation.childRunId &&
        !(preEffectRecorded && attempt.childRunId === null)))) ||
    (run !== undefined && run.runId !== operation.childRunId)
  ) {
    return Object.freeze({ kind: "corrupt", code: "delegation_operation_binding_mismatch" });
  }
  if (revision?.receipt !== null && revision?.receipt !== undefined) {
    if (revision.receipt.status === "cancelled") {
      return Object.freeze({ kind: "cancelled_clean", receiptSha256: revision.receipt.sha256 });
    }
    return Object.freeze({ kind: "terminal_backfilled", receiptSha256: revision.receipt.sha256 });
  }
  const automaticRetryEligible =
    preEffectRecorded &&
    attempt?.terminal === "pre_effect_infrastructure_failure" &&
    attempt.budgetSettlementEventId !== null &&
    revision?.status === "queued" &&
    revision.content.retry.maxAttempts === 2 &&
    revision.content.retry.automaticOn.includes("pre_effect_infrastructure_failure") &&
    revision.attempts.length < revision.content.retry.maxAttempts;
  if (automaticRetryEligible) {
    return Object.freeze({ kind: "retry_pre_effect_allowed" });
  }
  if (preEffectRecorded && attempt?.terminal === "pre_effect_infrastructure_failure") {
    return Object.freeze({ kind: "pre_effect_failure_terminal", attemptId: operation.childAttemptId });
  }
  if (operation.state === "reconciled") {
    return Object.freeze({ kind: "corrupt", code: "delegation_reconciled_without_receipt" });
  }
  if (
    input.authenticatedChannelAvailable === true &&
    input.ownerObservation === "matching" &&
    operation.state === "running" &&
    run?.terminal === undefined
  ) {
    return Object.freeze({ kind: "resume_same_child", attemptId: operation.childAttemptId });
  }
  // PHASE20: exit code, PID liveness, heartbeat age, and an IPC disconnect do
  // not prove provider/tool/effect terminality. Unless a durable receipt or a
  // provably pre-barrier prefix exists, recovery must retain budget and block.
  return Object.freeze({
    kind: "blocked_unknown_effect",
    evidenceRefs: evidence({ operation, ...(run === undefined ? {} : { run }) }),
  });
}

export interface DelegationOperationInspectionV1 {
  readonly childAttemptId: string;
  readonly childRunId: string;
  readonly delegationId: string;
  readonly operationId: string;
  readonly operationSha256: string;
  readonly ownerObservation: ProcessIdentityProbeResult | "not_started";
  readonly reconcile: DelegationReconcileOutcomeV1;
  readonly state: DelegationChildOperationV1["state"];
}
