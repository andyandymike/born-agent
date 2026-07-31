import {
  COMPLETION_REASON_CODES,
  type CompletionDecision,
  type CompletionEvidence,
  type CompletionPolicy,
  type CompletionReason,
  type CompletionState,
  type FinishTaskInput,
  type VerificationEvidence,
} from "./completion-types.js";
import { verificationSnapshotsEqual } from "./verification-snapshot.js";

const COMPLETION_REASON_ORDER = new Map<CompletionReason, number>(
  COMPLETION_REASON_CODES.map((reason, index) => [reason, index]),
);

function orderedReasons(
  reasons: ReadonlySet<CompletionReason>,
): readonly CompletionReason[] {
  return Object.freeze(
    [...reasons].sort(
      (left, right) =>
        (COMPLETION_REASON_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (COMPLETION_REASON_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

function isCurrentVerification(
  verification: VerificationEvidence,
  generation: number,
): boolean {
  return (
    verification.generationAtStart === generation &&
    verification.generationAtCompletion === generation
  );
}

function hasPendingEffect(state: CompletionState): boolean {
  return (
    state.activity.activeApproval ||
    state.activity.activeCommand ||
    state.activity.activePatch ||
    state.activity.mutationMutexLocked ||
    state.activity.unknownSideEffect
  );
}

function journalMatchesSnapshot(state: CompletionState): boolean {
  if (state.finalSnapshot === null) {
    return true;
  }
  const journalFiles = state.changedByRun
    .map((entry) => `${entry.path}\0${entry.postimageSha256}`)
    .sort();
  const snapshotFiles = state.finalSnapshot.changedFiles
    .map((entry) => `${entry.path}\0${entry.sha256}`)
    .sort();
  return (
    journalFiles.length === snapshotFiles.length &&
    journalFiles.every((entry, index) => entry === snapshotFiles[index])
  );
}

function assertCandidate(candidate: FinishTaskInput): void {
  const characters = [...candidate.summary].length;
  if (characters < 1 || characters > 2_000 || candidate.summary.includes("\0")) {
    throw new TypeError("finish_task summary must contain 1..2000 NUL-free characters");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function freezeEvidence(evidence: CompletionEvidence): CompletionEvidence {
  return deepFreeze(structuredClone(evidence));
}

export class VerifiedCompletionPolicy implements CompletionPolicy {
  async evaluate(
    candidate: FinishTaskInput,
    state: CompletionState,
  ): Promise<CompletionDecision> {
    assertCandidate(candidate);

    if (candidate.status === "blocked") {
      return { effect: "incomplete", reason: "task_blocked" };
    }

    if (hasPendingEffect(state)) {
      return { effect: "incomplete", reason: "pending_effect" };
    }
    if (
      !state.journal.readable ||
      !state.journal.consistent ||
      !state.journal.postimagesMatchDisk ||
      !journalMatchesSnapshot(state)
    ) {
      return { effect: "incomplete", reason: "change_journal_inconsistent" };
    }
    if (state.changedByRun.length === 0) {
      return {
        effect: "continue",
        reasons: Object.freeze(["no_changes_for_coding_task"]),
      };
    }

    const reasons = new Set<CompletionReason>();
    if (state.verificationInputsUnknown === true) {
      reasons.add("verification_inputs_unknown");
    }
    if (state.diffCheck.status !== "passed") {
      reasons.add("diff_check_failed");
    }
    const changedPaths = [...new Set(state.changedByRun.map((entry) => entry.path))].sort();
    const checkedPaths = [...new Set(state.diffCheck.checkedPaths)].sort();
    if (
      changedPaths.length !== checkedPaths.length ||
      changedPaths.some((path, index) => path !== checkedPaths[index])
    ) {
      reasons.add("diff_check_failed");
    }

    const approved = state.verifications.filter(
      (verification) =>
        verification.approved &&
        verification.completedEventPersisted &&
        verification.purpose === "verify",
    );
    if (approved.length === 0) {
      reasons.add("verification_missing");
    }

    const current = approved.filter((verification) =>
      isCurrentVerification(verification, state.generation),
    );
    if (approved.length > 0 && current.length === 0) {
      reasons.add("verification_stale");
    }
    if (current.some((verification) => !verification.inputsKnown)) {
      reasons.add("verification_inputs_unknown");
    }
    if (
      current.some(
        (verification) =>
          verification.beforeSnapshot.commandInputs.length === 0 ||
          verification.afterSnapshot.commandInputs.length === 0,
      )
    ) {
      reasons.add("verification_inputs_unknown");
    }
    if (current.some((verification) => verification.stale)) {
      reasons.add("verification_stale");
    }

    const currentWithKnownInputs = current.filter(
      (verification) => verification.inputsKnown && !verification.stale,
    );
    const successful = currentWithKnownInputs.filter(
      (verification) => verification.exitCode === 0,
    );
    if (
      currentWithKnownInputs.length > 0 &&
      successful.length === 0 &&
      currentWithKnownInputs.some((verification) => verification.exitCode !== 0)
    ) {
      reasons.add("verification_failed");
    }
    if (successful.length === 0 && reasons.size === 0) {
      reasons.add("verification_missing");
    }

    if (state.finalSnapshot === null) {
      reasons.add("source_state_changed");
    } else {
      if (state.finalSnapshot.generation !== state.generation) {
        reasons.add("verification_stale");
      }
      for (const verification of successful) {
        // PHASE7: A test that changes source, HEAD, or index cannot establish its own
        // new baseline. Before, after, and completion-time snapshots must all agree.
        if (
          !verificationSnapshotsEqual(
            verification.beforeSnapshot,
            verification.afterSnapshot,
          ) ||
          !verificationSnapshotsEqual(
            verification.afterSnapshot,
            state.finalSnapshot,
          ) ||
          verification.beforeSnapshot.generation !== state.generation ||
          verification.afterSnapshot.generation !== state.generation
        ) {
          reasons.add("source_state_changed");
        }
      }
    }

    if (reasons.size > 0) {
      return { effect: "continue", reasons: orderedReasons(reasons) };
    }

    const finalSnapshot = state.finalSnapshot;
    if (finalSnapshot === null) {
      return {
        effect: "continue",
        reasons: Object.freeze(["source_state_changed"]),
      };
    }

    // PHASE7: This returned acceptance is still not user-visible success. AgentLoop
    // must durably persist completion.evaluated and the matching tool result first.
    const evidence = freezeEvidence({
      ...(state.attributionScope === undefined
        ? {}
        : { attributionScope: state.attributionScope }),
      changedByRun: state.changedByRun,
      diffCheck: state.diffCheck,
      finalSnapshot,
      modelEvidence: state.modelEvidence,
      modelNarrative: candidate.summary,
      // PHASE7: Baseline-dirty paths are reported separately so changes that existed
      // before this run can never be attributed to the Agent's ChangeJournal.
      preExistingDirtyPaths: state.preExistingDirtyPaths,
      runId: state.runId,
      sessionId: state.sessionId,
      verifications: successful,
    });
    return { effect: "accept", evidence };
  }
}
