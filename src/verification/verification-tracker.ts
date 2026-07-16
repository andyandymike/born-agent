import type { ExecutionTermination } from "../execution/execution-types.js";
import {
  VERIFICATION_COMMAND_KINDS,
  type VerificationCommandKind,
} from "./verification-command-classifier.js";
import {
  verificationSnapshotSha256,
  verificationSnapshotsEqual,
  type VerificationSnapshot,
} from "./verification-snapshot.js";

export type VerificationStaleReason =
  | "generation_changed"
  | "generation_marked_stale"
  | "source_state_changed";

export type VerificationStatus = "failed" | "passed" | "stale";

export interface VerificationStartedRecord {
  readonly actionSha256: string;
  readonly beforeSnapshot: VerificationSnapshot;
  readonly beforeSnapshotSha256: string;
  readonly commandExecutionId: string;
  readonly generation: number;
  readonly kind: VerificationCommandKind;
  readonly verificationId: string;
}

export interface VerificationCompletedRecord extends VerificationStartedRecord {
  readonly afterSnapshot: VerificationSnapshot;
  readonly afterSnapshotSha256: string;
  readonly completedGeneration: number;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly staleReasons: readonly VerificationStaleReason[];
  readonly status: VerificationStatus;
  readonly termination: ExecutionTermination;
}

export interface StartVerificationInput {
  readonly actionSha256: string;
  readonly approved: true;
  readonly beforeSnapshot: VerificationSnapshot;
  readonly commandExecutionId: string;
  readonly kind: VerificationCommandKind;
  readonly verificationId: string;
}

export interface CompleteVerificationInput {
  readonly afterSnapshot: VerificationSnapshot;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly termination: ExecutionTermination;
  readonly verificationId: string;
}

export class VerificationTrackerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VerificationTrackerError";
  }
}

interface ActiveVerification {
  readonly started: VerificationStartedRecord;
}

function cloneSnapshot(snapshot: VerificationSnapshot): VerificationSnapshot {
  const deletedFiles: readonly never[] = Object.freeze([]);
  return Object.freeze({
    changedFiles: Object.freeze(
      snapshot.changedFiles.map((file) => Object.freeze({ ...file })),
    ),
    commandInputs: Object.freeze(
      snapshot.commandInputs.map((file) => Object.freeze({ ...file })),
    ),
    deletedFiles,
    generation: snapshot.generation,
    gitHeadSha256: snapshot.gitHeadSha256,
    gitIndexSha256: snapshot.gitIndexSha256,
    journalSha256: snapshot.journalSha256,
    ...(snapshot.packageScriptSha256 === undefined
      ? {}
      : { packageScriptSha256: snapshot.packageScriptSha256 }),
    sourceStateSha256: snapshot.sourceStateSha256,
  });
}

function isIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !value.includes("\0");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export class VerificationTracker {
  private generation = 0;
  private readonly active = new Map<string, ActiveVerification>();
  private readonly completed: VerificationCompletedRecord[] = [];
  private readonly seenIds = new Set<string>();
  private readonly staleGenerations = new Set<number>();

  currentGeneration(): number {
    return this.generation;
  }

  activeCount(): number {
    return this.active.size;
  }

  recordPatchApplied(): number {
    if (this.generation === Number.MAX_SAFE_INTEGER) {
      throw new VerificationTrackerError(
        "verification_generation_exhausted",
        "verification generation can no longer be incremented safely",
      );
    }
    // PHASE7: every confirmed patch advances generation. A passing test from the
    // prior source image is historical evidence, never proof for the new bytes.
    this.generation += 1;
    return this.generation;
  }

  markCurrentGenerationStale(): void {
    this.staleGenerations.add(this.generation);
  }

  start(input: StartVerificationInput): VerificationStartedRecord {
    if (
      !isIdentifier(input.verificationId) ||
      !isIdentifier(input.commandExecutionId) ||
      !isSha256(input.actionSha256) ||
      !VERIFICATION_COMMAND_KINDS.includes(input.kind)
    ) {
      throw new VerificationTrackerError(
        "invalid_verification_start",
        "verification start identity or classification is invalid",
      );
    }
    if (this.seenIds.has(input.verificationId)) {
      throw new VerificationTrackerError(
        "duplicate_verification_id",
        "verification identifiers may be used only once",
      );
    }
    if (input.beforeSnapshot.generation !== this.generation) {
      throw new VerificationTrackerError(
        "verification_generation_mismatch",
        "verification before snapshot does not match the current generation",
      );
    }

    const beforeSnapshot = cloneSnapshot(input.beforeSnapshot);
    const started = Object.freeze({
      actionSha256: input.actionSha256,
      beforeSnapshot,
      beforeSnapshotSha256: verificationSnapshotSha256(beforeSnapshot),
      commandExecutionId: input.commandExecutionId,
      generation: this.generation,
      kind: input.kind,
      verificationId: input.verificationId,
    });
    this.seenIds.add(input.verificationId);
    this.active.set(input.verificationId, {
      started,
    });
    return started;
  }

  complete(input: CompleteVerificationInput): VerificationCompletedRecord {
    const active = this.active.get(input.verificationId);
    if (active === undefined) {
      throw new VerificationTrackerError(
        "verification_not_active",
        "verification completion must uniquely match an active start",
      );
    }
    if (
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 0 ||
      (input.exitCode !== null &&
        (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0))
    ) {
      throw new VerificationTrackerError(
        "invalid_verification_result",
        "verification duration and exit code are invalid",
      );
    }

    const afterSnapshot = cloneSnapshot(input.afterSnapshot);
    const staleReasons: VerificationStaleReason[] = [];
    if (
      active.started.generation !== this.generation ||
      afterSnapshot.generation !== active.started.generation
    ) {
      staleReasons.push("generation_changed");
    }
    if (this.staleGenerations.has(active.started.generation)) {
      staleReasons.push("generation_marked_stale");
    }
    if (!verificationSnapshotsEqual(active.started.beforeSnapshot, afterSnapshot)) {
      staleReasons.push("source_state_changed");
    }
    const uniqueReasons = Object.freeze([...new Set(staleReasons)]);
    const status: VerificationStatus =
      uniqueReasons.length > 0
        ? "stale"
        : input.termination === "exit" && input.exitCode === 0
          ? "passed"
          : "failed";
    const completed = Object.freeze({
      ...active.started,
      afterSnapshot,
      afterSnapshotSha256: verificationSnapshotSha256(afterSnapshot),
      completedGeneration: this.generation,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      staleReasons: uniqueReasons,
      status,
      termination: input.termination,
    });
    this.active.delete(input.verificationId);
    this.completed.push(completed);
    return completed;
  }

  records(): readonly VerificationCompletedRecord[] {
    return [...this.completed];
  }

  successfulCurrent(
    completionSnapshot: VerificationSnapshot,
  ): readonly VerificationCompletedRecord[] {
    if (completionSnapshot.generation !== this.generation) {
      return [];
    }
    return this.completed.filter(
      (record) =>
        record.status === "passed" &&
        record.generation === this.generation &&
        !this.staleGenerations.has(record.generation) &&
        verificationSnapshotsEqual(record.afterSnapshot, completionSnapshot),
    );
  }
}
