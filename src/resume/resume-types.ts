import type { BackendIdentity } from "../model/model-backend.js";
import type { ResumeCapability } from "../model/backend-resume.js";

export type ResumeMode = "exact" | "canonical_degraded";

export type ResumableRunState =
  | "interrupted"
  | "cancelled"
  | "incomplete"
  | "budget_exceeded"
  | "completed"
  | "failed";

export type PendingToolKind =
  | "read_only"
  | "apply_patch"
  | "run_command"
  | "finish_task"
  | "unknown";

export interface ApprovalExpiry {
  readonly actionKind: "apply_patch" | "run_command";
  readonly actionSha256: string | null;
  readonly approvalRequestId: string;
  readonly callId: string;
  readonly decision: "approved" | "cancelled" | "denied" | null;
  readonly sourceRunId: string;
}

export interface PendingToolCall {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly kind: PendingToolKind;
  readonly providerResponseId: string | null;
  readonly sourceRunId: string;
  readonly step: number;
  readonly toolName: string;
}

export interface PendingPatchFile {
  readonly kind: "create" | "modify";
  readonly path: string;
  readonly postSha256: string | null;
  readonly preSha256: string | null;
}

export interface PendingPatchEffect {
  readonly approvalRequestId: string;
  readonly callId: string;
  readonly files: readonly PendingPatchFile[];
  readonly planId: string;
  readonly sourceRunId: string;
  readonly step: number;
}

export interface UnknownCommandEffect {
  readonly actionSha256: string;
  readonly callId: string;
  readonly executionId: string;
  readonly sourceRunId: string;
  readonly stage: "requested" | "started";
  readonly step: number;
}

export interface RecoveredInnerEffect {
  readonly callId: string;
  readonly effectId: string;
  readonly kind: "patch" | "command";
  readonly observation: RecoveredToolObservation;
  readonly sourceRunId: string;
  readonly step: number;
}

export interface RecoveredToolObservation {
  readonly errorCategory?:
    | "cancelled"
    | "invalid_arguments"
    | "limit"
    | "not_found"
    | "permission"
    | "system"
    | "tool";
  readonly errorCode?: string;
  readonly output: string;
  readonly retryable?: boolean;
  readonly status: "error" | "success";
  readonly truncated: boolean;
}

export interface CheckpointPendingCall {
  readonly call: PendingToolCall;
  readonly recoveredObservation: RecoveredToolObservation | null;
}

export interface PendingEffectLedger {
  readonly approvalsToExpire: readonly ApprovalExpiry[];
  readonly pendingPatches: readonly PendingPatchEffect[];
  readonly pendingToolCalls: readonly PendingToolCall[];
  readonly recoveredInnerEffects: readonly RecoveredInnerEffect[];
  readonly unknownCommands: readonly UnknownCommandEffect[];
}

export interface VerifiedCheckpointProjection {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly checkpointId: string;
  readonly codecVersion: string;
  readonly model: string;
  readonly provider: BackendIdentity["provider"];
  readonly relativeRef: string;
  readonly turnNumber: number;
}

export interface BackendResumeProjection {
  readonly canonicalBoundaryClosed: boolean;
  readonly capability: ResumeCapability;
  readonly checkpoint: VerifiedCheckpointProjection | null;
  readonly checkpointPendingCall: CheckpointPendingCall | null;
  readonly exactCheckpointUsable: boolean;
  readonly identity: BackendIdentity;
  readonly supportsCanonicalDegradedResume: boolean;
}

export type ResumeBlockReason =
  | "backend_adapter_mismatch"
  | "backend_model_mismatch"
  | "backend_provider_mismatch"
  | "backend_resume_unsupported"
  | "canonical_boundary_open"
  | "checkpoint_corrupt"
  | "checkpoint_incompatible"
  | "checkpoint_missing"
  | "completed_run_requires_message"
  | "degraded_resume_requires_confirmation"
  | "failed_run_not_recoverable"
  | "multiple_pending_calls"
  | "pending_call_requires_exact_checkpoint"
  | "pending_command_effect_unknown"
  | "pending_patch_ambiguous"
  | "run_id_collision"
  | "workspace_root_mismatch";

export interface ResumeReconciliationFact {
  readonly callId: string;
  readonly observed: "applied" | "not_applied";
  readonly planId: string;
}

export interface ReadyResumePlan {
  readonly approvalsToExpire: readonly ApprovalExpiry[];
  readonly fingerprintMismatches: readonly string[];
  readonly inheritedPendingCall: PendingToolCall | null;
  readonly mode: ResumeMode;
  readonly newRunId: string;
  readonly recoveredInnerEffect: RecoveredInnerEffect | null;
  readonly recoveredToolObservation: RecoveredToolObservation | null;
  readonly reconciliations: readonly ResumeReconciliationFact[];
  readonly resetRunBudgets: true;
  readonly resumeOfRunId: string;
  readonly sessionId: string;
  readonly status: "ready";
}

export interface BlockedResumePlan {
  readonly details: readonly string[];
  readonly offeredMode: "canonical_degraded" | null;
  readonly reasons: readonly ResumeBlockReason[];
  readonly resumeOfRunId: string;
  readonly sessionId: string;
  readonly status: "blocked";
}

export type ResumePlan = ReadyResumePlan | BlockedResumePlan;
