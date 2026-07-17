import type {
  ExecutionEnvironmentEvidence,
  SandboxEphemeralChangeEvidence,
} from "../execution/execution-types.js";

export const COMPLETION_REASON_CODES = [
  "verification_missing",
  "verification_failed",
  "verification_stale",
  "verification_inputs_unknown",
  "diff_check_failed",
  "source_state_changed",
  "change_journal_inconsistent",
  "pending_effect",
  "task_blocked",
  "completion_signal_required",
  "no_changes_for_coding_task",
] as const;

export type CompletionReason = (typeof COMPLETION_REASON_CODES)[number];
export type IncompleteReason = CompletionReason;

export interface FinishTaskInput {
  readonly status: "blocked" | "completed";
  readonly summary: string;
}

export interface SnapshotFileDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface VerificationSnapshot {
  readonly changedFiles: readonly SnapshotFileDigest[];
  readonly commandInputs: readonly SnapshotFileDigest[];
  readonly deletedFiles: readonly never[];
  readonly generation: number;
  readonly gitHeadSha256: string;
  readonly gitIndexSha256: string;
  readonly journalSha256: string;
  readonly packageScriptSha256?: string | undefined;
  readonly sourceStateSha256: string;
}

export interface ChangedFileEvidence {
  readonly addedLines: number;
  readonly kind: "create" | "modify";
  readonly path: string;
  readonly postimageSha256: string;
  readonly preimageSha256: string | null;
  readonly removedLines: number;
}

export interface CheckEvidence {
  readonly checkedPaths: readonly string[];
  readonly detail: string;
  readonly diffSha256: string;
  readonly status: "failed" | "passed" | "not_run";
}

export type VerificationClassification =
  | "build"
  | "check"
  | "lint"
  | "test"
  | "typecheck";

export interface CommandOutputEvidence {
  readonly artifactRefs: readonly string[];
  readonly eventRefs: readonly string[];
  readonly stderrSummary: string;
  readonly stdoutSummary: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface VerificationEvidence {
  readonly actionSha256: string;
  readonly afterSnapshot: VerificationSnapshot;
  readonly approved: boolean;
  readonly argv: readonly string[];
  readonly beforeSnapshot: VerificationSnapshot;
  readonly classification: VerificationClassification;
  readonly completedEventPersisted: boolean;
  readonly cwd: string;
  readonly durationMs: number;
  readonly executionId: string;
  readonly executionEnvironment?: ExecutionEnvironmentEvidence | undefined;
  readonly exitCode: number | null;
  readonly generationAtCompletion: number;
  readonly generationAtStart: number;
  readonly inputsKnown: boolean;
  readonly output: CommandOutputEvidence;
  readonly purpose: "verify";
  readonly sandboxEphemeralChanges?: SandboxEphemeralChangeEvidence | undefined;
  readonly stale: boolean;
  readonly verificationId?: string | undefined;
}

export interface ModelEvidence {
  readonly backend: "fake" | "ollama";
  readonly endpointScope: "in_process" | "literal_loopback";
  readonly kind: "contract_verified" | "local_live_verified";
  readonly remoteBillableRequests: 0;
}

export interface CompletionEvidence {
  readonly changedByRun: readonly ChangedFileEvidence[];
  readonly diffCheck: CheckEvidence;
  readonly finalSnapshot: VerificationSnapshot;
  readonly modelEvidence: ModelEvidence;
  readonly modelNarrative: string;
  readonly preExistingDirtyPaths: readonly string[];
  readonly runId: string;
  readonly sessionId: string;
  readonly verifications: readonly VerificationEvidence[];
}

export interface IncompleteEvidence {
  readonly changedByRun: readonly ChangedFileEvidence[];
  readonly diffCheck: CheckEvidence;
  readonly finalSnapshot: VerificationSnapshot | null;
  readonly modelEvidence: ModelEvidence;
  readonly modelNarrative: string;
  readonly preExistingDirtyPaths: readonly string[];
  readonly reason: IncompleteReason;
  readonly runId: string;
  readonly sessionId: string;
  readonly verifications: readonly VerificationEvidence[];
}

export interface CompletionActivityState {
  readonly activeApproval: boolean;
  readonly activeCommand: boolean;
  readonly activePatch: boolean;
  readonly mutationMutexLocked: boolean;
  readonly unknownSideEffect: boolean;
}

export interface ChangeJournalEvidenceState {
  readonly consistent: boolean;
  readonly postimagesMatchDisk: boolean;
  readonly readable: boolean;
}

export interface CompletionState {
  readonly activity: CompletionActivityState;
  readonly changedByRun: readonly ChangedFileEvidence[];
  readonly diffCheck: CheckEvidence;
  readonly finalSnapshot: VerificationSnapshot | null;
  readonly generation: number;
  readonly journal: ChangeJournalEvidenceState;
  readonly modelEvidence: ModelEvidence;
  readonly preExistingDirtyPaths: readonly string[];
  readonly runId: string;
  readonly sessionId: string;
  readonly verifications: readonly VerificationEvidence[];
  readonly verificationInputsUnknown?: boolean;
}

export type CompletionDecision =
  | { readonly effect: "accept"; readonly evidence: CompletionEvidence }
  | { readonly effect: "continue"; readonly reasons: readonly CompletionReason[] }
  | { readonly effect: "incomplete"; readonly reason: IncompleteReason };

export interface CompletionPolicy {
  evaluate(
    candidate: FinishTaskInput,
    state: CompletionState,
  ): Promise<CompletionDecision>;
}
