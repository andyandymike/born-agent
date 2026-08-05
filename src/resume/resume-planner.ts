import type { BackendResumeProjection, PendingEffectLedger, ResumeBlockReason, ResumePlan, ResumeReconciliationFact, ResumableRunState } from "./resume-types.js";
import type { PatchReconciliation } from "./patch-reconciler.js";
import { isLocallyVerifiedCheckpointProjection } from "./backend-resume-projection-builder.js";
import {
  compareWorkspaceResumeFingerprints,
  type ResumeFingerprintMismatch,
  type WorkspaceResumeFingerprint,
} from "./workspace-resume-fingerprint.js";

export interface ResumePlannerInput {
  readonly allowDegradedResume: boolean;
  readonly approvedPlanContinuation?: boolean;
  readonly backend: BackendResumeProjection;
  readonly currentFingerprint: WorkspaceResumeFingerprint;
  readonly expectedFingerprint: WorkspaceResumeFingerprint;
  readonly failedRunRecoverable?: boolean;
  readonly ledger: PendingEffectLedger;
  readonly message?: string;
  readonly patchReconciliations: readonly PatchReconciliation[];
  readonly sessionId: string;
  readonly sourceRunId: string;
  readonly sourceRunState: ResumableRunState;
}

export interface ResumePlannerOptions {
  readonly createRunId: () => string;
}

export interface ResumePendingEffectPreflightInput {
  readonly ledger: PendingEffectLedger;
  readonly sessionId: string;
  readonly sourceRunId: string;
}

interface PlanningBlock {
  readonly detail: string;
  readonly reason: ResumeBlockReason;
}

function addBlock(
  blocks: PlanningBlock[],
  reason: ResumeBlockReason,
  detail: string,
): void {
  if (!blocks.some((block) => block.reason === reason && block.detail === detail)) {
    blocks.push({ detail, reason });
  }
}

function addHardFingerprintBlocks(
  blocks: PlanningBlock[],
  mismatches: readonly ResumeFingerprintMismatch[],
): void {
  for (const mismatch of mismatches.filter(({ kind }) => kind === "hard")) {
    const reason =
      mismatch.field === "canonical_root_identity"
        ? "workspace_root_mismatch"
        : mismatch.field === "backend.provider"
          ? "backend_provider_mismatch"
          : mismatch.field === "backend.model"
            ? "backend_model_mismatch"
            : "backend_adapter_mismatch";
    addBlock(blocks, reason, mismatch.field);
  }
}

function checkpointIsCompatible(input: ResumePlannerInput): boolean {
  const checkpoint = input.backend.checkpoint;
  if (
    checkpoint === null ||
    !isLocallyVerifiedCheckpointProjection(checkpoint)
  ) {
    return false;
  }
  const current = input.backend.identity;
  return (
    checkpoint.provider === current.provider &&
    checkpoint.model === current.model &&
    checkpoint.adapter === current.adapter &&
    checkpoint.adapterVersion === current.adapterVersion &&
    checkpoint.codecVersion === input.currentFingerprint.checkpointCodecVersion
  );
}

function collectPatchFacts(
  input: ResumePlannerInput,
  blocks: PlanningBlock[],
): readonly ResumeReconciliationFact[] {
  const reconciliationByPlan = new Map(
    input.patchReconciliations.map((reconciliation) => [
      reconciliation.planId,
      reconciliation,
    ]),
  );
  const facts: ResumeReconciliationFact[] = [];
  for (const effect of input.ledger.pendingPatches) {
    const reconciliation = reconciliationByPlan.get(effect.planId);
    if (reconciliation === undefined) {
      addBlock(
        blocks,
        "pending_patch_ambiguous",
        `${effect.planId}:missing_reconciliation`,
      );
      continue;
    }
    if (reconciliation.status === "blocked") {
      addBlock(
        blocks,
        "pending_patch_ambiguous",
        `${effect.planId}:${reconciliation.reason}`,
      );
      continue;
    }
    if (reconciliation.observed === "applied") {
      // PHASE9: hashes prove that the mutation landed, but the current v1
      // patch evidence cannot rebuild the byte-complete ChangeJournal. Until a
      // verified recovery artifact exists, continuing would execute the same
      // patch again or let completion claim changes it cannot attribute.
      addBlock(
        blocks,
        "pending_patch_ambiguous",
        `${effect.planId}:applied_effect_requires_recovered_journal`,
      );
      continue;
    }
    facts.push(Object.freeze({
      callId: effect.callId,
      observed: reconciliation.observed,
      planId: effect.planId,
    }));
  }
  return Object.freeze(facts);
}

function blockedPlan(
  input: ResumePlannerInput,
  blocks: readonly PlanningBlock[],
  offeredMode: "canonical_degraded" | null,
): ResumePlan {
  return Object.freeze({
    details: Object.freeze(blocks.map(({ detail }) => detail)),
    offeredMode,
    reasons: Object.freeze([...new Set(blocks.map(({ reason }) => reason))]),
    resumeOfRunId: input.sourceRunId,
    sessionId: input.sessionId,
    status: "blocked" as const,
  });
}

export class ResumePlanner {
  readonly #createRunId: () => string;

  constructor(options: ResumePlannerOptions) {
    this.#createRunId = options.createRunId;
  }

  preflightPendingEffects(
    input: ResumePendingEffectPreflightInput,
  ): ResumePlan | null {
    const blocks: PlanningBlock[] = [];
    for (const command of input.ledger.unknownCommands) {
      addBlock(
        blocks,
        "pending_command_effect_unknown",
        `${command.executionId}:${command.stage}`,
      );
    }
    for (const server of input.ledger.unknownMcpServers ?? []) {
      addBlock(
        blocks,
        "pending_mcp_effect_unknown",
        `${server.serverId}:${server.stage}`,
      );
    }
    for (const call of input.ledger.unknownMcpCalls ?? []) {
      addBlock(
        blocks,
        "pending_mcp_effect_unknown",
        `${call.serverId}:${call.callId}:${call.stage}`,
      );
    }
    if (input.ledger.pendingToolCalls.length > 1) {
      addBlock(
        blocks,
        "multiple_pending_calls",
        "more than one inherited provider call is unresolved",
      );
    }
    if (input.ledger.recoveredInnerEffects.length > 1) {
      addBlock(
        blocks,
        "multiple_pending_calls",
        "more than one completed inner effect lacks an outer observation",
      );
    }
    const pendingCall = input.ledger.pendingToolCalls[0] ?? null;
    const recovered = input.ledger.recoveredInnerEffects[0] ?? null;
    if (
      recovered !== null &&
      (pendingCall === null ||
        recovered.callId !== pendingCall.callId ||
        recovered.sourceRunId !== pendingCall.sourceRunId)
    ) {
      addBlock(
        blocks,
        "multiple_pending_calls",
        "completed inner effect does not match the inherited provider call",
      );
    }
    return blocks.length === 0
      ? null
      : Object.freeze({
          details: Object.freeze(blocks.map(({ detail }) => detail)),
          offeredMode: null,
          reasons: Object.freeze([...new Set(blocks.map(({ reason }) => reason))]),
          resumeOfRunId: input.sourceRunId,
          sessionId: input.sessionId,
          status: "blocked" as const,
        });
  }

  plan(input: ResumePlannerInput): ResumePlan {
    const pendingPreflight = this.preflightPendingEffects({
      ledger: input.ledger,
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
    });
    if (pendingPreflight !== null) return pendingPreflight;
    const blocks: PlanningBlock[] = [];
    if (
      input.sourceRunState === "completed" &&
      input.approvedPlanContinuation !== true &&
      (input.message === undefined || input.message.trim().length === 0)
    ) {
      addBlock(
        blocks,
        "completed_run_requires_message",
        "completed run needs a new user message",
      );
    }
    if (
      input.sourceRunState === "failed" &&
      input.failedRunRecoverable !== true
    ) {
      addBlock(
        blocks,
        "failed_run_not_recoverable",
        "failed run category is not recoverable",
      );
    }

    const fingerprintMismatches = compareWorkspaceResumeFingerprints(
      input.expectedFingerprint,
      input.currentFingerprint,
    );
    addHardFingerprintBlocks(blocks, fingerprintMismatches);

    const reconciliations = collectPatchFacts(input, blocks);

    const ledgerPendingCall = input.ledger.pendingToolCalls[0] ?? null;
    const checkpointPendingCall = input.backend.checkpointPendingCall?.call ?? null;
    const samePendingCall =
      ledgerPendingCall !== null &&
      checkpointPendingCall !== null &&
      ledgerPendingCall.callId === checkpointPendingCall.callId &&
      ledgerPendingCall.sourceRunId === checkpointPendingCall.sourceRunId &&
      ledgerPendingCall.step === checkpointPendingCall.step &&
      ledgerPendingCall.toolName === checkpointPendingCall.toolName &&
      ledgerPendingCall.argumentsJson === checkpointPendingCall.argumentsJson;
    if (
      ledgerPendingCall !== null &&
      checkpointPendingCall !== null &&
      !samePendingCall
    ) {
      addBlock(
        blocks,
        "multiple_pending_calls",
        "checkpoint pending call does not match the durable effect ledger",
      );
    }
    const pendingCall = checkpointPendingCall ?? ledgerPendingCall;
    const recoveredInnerEffect = input.ledger.recoveredInnerEffects[0] ?? null;
    const recoveredToolObservation =
      input.backend.checkpointPendingCall?.recoveredObservation ??
      recoveredInnerEffect?.observation ??
      null;

    if (blocks.length > 0) return blockedPlan(input, blocks, null);

    const exactFingerprintCompatible = !fingerprintMismatches.some(
      ({ kind }) => kind === "exact_only",
    );
    let exactCheckpointReady = false;
    if (input.backend.capability === "exact_checkpoint") {
      if (input.backend.checkpoint === null) {
        addBlock(blocks, "checkpoint_missing", "no checkpoint artifact is referenced");
      } else if (
        !isLocallyVerifiedCheckpointProjection(input.backend.checkpoint)
      ) {
        // PHASE9: a caller-authored boolean is not evidence. The projection
        // builder registers the exact immutable object only after local store
        // hash/readback validation and backend codec decode have succeeded.
        addBlock(
          blocks,
          "checkpoint_corrupt",
          "checkpoint was not verified by the local projection builder",
        );
      } else if (!checkpointIsCompatible(input)) {
        addBlock(
          blocks,
          "checkpoint_incompatible",
          "checkpoint backend identity or codec does not match",
        );
      } else if (!input.backend.exactCheckpointUsable) {
        addBlock(
          blocks,
          "canonical_boundary_open",
          "latest exact checkpoint was superseded by an uncheckpointed model turn",
        );
      } else if (
        pendingCall?.kind === "finish_task" &&
        recoveredToolObservation !== null
      ) {
        // PHASE9: the outer observation lacks CompletionControl. Exact adoption cannot
        // invent it; an explicit canonical degradation may instead re-plan and
        // reevaluate completion from current evidence.
        addBlock(
          blocks,
          "checkpoint_incompatible",
          "completed finish_task requires explicit canonical re-evaluation",
        );
      } else if (exactFingerprintCompatible) {
        exactCheckpointReady = true;
      }
    } else if (input.backend.capability === "none") {
      addBlock(
        blocks,
        "backend_resume_unsupported",
        "selected backend declares resume capability none",
      );
    }

    if (exactCheckpointReady) {
      const newRunId = this.#createRunId();
      if (newRunId === input.sourceRunId) {
        addBlock(blocks, "run_id_collision", "new run id equals source run id");
        return blockedPlan(input, blocks, null);
      }
      // PHASE9: a resumed session still starts a distinct run. Appending facts
      // to an interrupted run would fabricate continuity across a process crash
      // and would make run-local budgets and effect pairing impossible to audit.
      return Object.freeze({
        approvalsToExpire: input.ledger.approvalsToExpire,
        fingerprintMismatches: Object.freeze([]),
        // PHASE9: returning an inherited call is only a plan. The persistence
        // layer must emit resume.pending_call.adopted in the new run before it
        // can submit the old provider call result; otherwise event pairing
        // would falsely attach a post-crash observation to the previous run.
        inheritedPendingCall: pendingCall,
        mode: "exact" as const,
        newRunId,
        recoveredInnerEffect,
        recoveredToolObservation,
        reconciliations,
        resetRunBudgets: true as const,
        resumeOfRunId: input.sourceRunId,
        sessionId: input.sessionId,
        status: "ready" as const,
      });
    }

    if (pendingCall !== null && recoveredToolObservation === null) {
      addBlock(
        blocks,
        "pending_call_requires_exact_checkpoint",
        "an unresolved provider call can only be adopted from exact state",
      );
      return blockedPlan(input, blocks, null);
    }
    if (!input.backend.canonicalBoundaryClosed) {
      addBlock(
        blocks,
        "canonical_boundary_open",
        "canonical transcript ends inside a model or tool turn",
      );
      return blockedPlan(input, blocks, null);
    }
    if (!input.backend.supportsCanonicalDegradedResume) {
      if (input.backend.capability !== "none") {
        addBlock(
          blocks,
          "backend_resume_unsupported",
          "backend does not support canonical degraded resume",
        );
      }
      return blockedPlan(input, blocks, null);
    }
    if (!input.allowDegradedResume) {
      // PHASE9: exact failure never silently falls back to a transcript. The
      // caller must surface the loss of provider-private state and receive an
      // explicit --allow-degraded-resume decision before a new run can exist.
      addBlock(
        blocks,
        "degraded_resume_requires_confirmation",
        "canonical degraded resume requires explicit confirmation",
      );
      return blockedPlan(input, blocks, "canonical_degraded");
    }

    const newRunId = this.#createRunId();
    if (newRunId === input.sourceRunId) {
      addBlock(blocks, "run_id_collision", "new run id equals source run id");
      return blockedPlan(input, blocks, null);
    }
    return Object.freeze({
      approvalsToExpire: input.ledger.approvalsToExpire,
      fingerprintMismatches: Object.freeze(
        fingerprintMismatches.map(({ field }) => field),
      ),
      inheritedPendingCall: null,
      mode: "canonical_degraded" as const,
      newRunId,
      recoveredInnerEffect: null,
      recoveredToolObservation: null,
      reconciliations,
      resetRunBudgets: true as const,
      resumeOfRunId: input.sourceRunId,
      sessionId: input.sessionId,
      status: "ready" as const,
    });
  }
}
