import type { PersistedCompletionEvidence } from "../completion/completion-evidence-schema.js";
import { hashVerificationSnapshot } from "../completion/verification-snapshot.js";
import type { RunEvent } from "./run-event.js";

type CommandRequestedData = Extract<
  RunEvent,
  { type: "command.execution.requested" }
>["data"];
type CommandOutputData = Extract<RunEvent, { type: "command.output" }>["data"];
type CommandCompletedData = Extract<
  RunEvent,
  { type: "command.completed" }
>["data"];
type VerificationStartedData = Extract<
  RunEvent,
  { type: "verification.started" }
>["data"];
type VerificationCompletedData = Extract<
  RunEvent,
  { type: "verification.completed" }
>["data"];

export interface VerificationEventFacts {
  readonly commandCompleted: CommandCompletedData;
  readonly commandOutput: readonly CommandOutputData[];
  readonly commandRequested: CommandRequestedData;
  readonly verificationCompleted: VerificationCompletedData;
  readonly verificationStarted: VerificationStartedData;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function summarize(chunks: readonly string[]): string {
  const normalized = chunks
    .join("")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  return [...normalized].slice(0, 1_024).join("");
}

export function completionVerificationIdsMatch(
  projection: PersistedCompletionEvidence,
  verificationIds: readonly string[],
): boolean {
  const persistedIds = projection.evidence.verifications.map(
    (verification) => verification.verificationId,
  );
  return (
    persistedIds.every((id): id is string => id !== undefined) &&
    arraysEqual(persistedIds, verificationIds)
  );
}

export function completionVerificationsMatchEvents(
  projection: PersistedCompletionEvidence,
  resolve: (verificationId: string) => VerificationEventFacts | undefined,
  hasCompletedUnclassifiedVerification: boolean,
): boolean {
  // PHASE7: the projection hash proves only internal consistency. Every report
  // verification must also be reducible to the already-persisted command stream.
  return projection.evidence.verifications.every((evidence) => {
    if (evidence.verificationId === undefined) return false;
    const facts = resolve(evidence.verificationId);
    if (facts === undefined) return false;

    const { commandCompleted, commandOutput, commandRequested } = facts;
    const { verificationCompleted, verificationStarted } = facts;
    const stdout = commandOutput
      .filter((event) => event.channel === "stdout")
      .map((event) => event.chunk);
    const stderr = commandOutput
      .filter((event) => event.channel === "stderr")
      .map((event) => event.chunk);

    return (
      evidence.actionSha256 === commandRequested.action_sha256 &&
      evidence.actionSha256 === verificationStarted.action_sha256 &&
      evidence.actionSha256 === verificationCompleted.action_sha256 &&
      evidence.approved &&
      arraysEqual(evidence.argv, commandRequested.redacted_argv) &&
      evidence.cwd === commandRequested.cwd &&
      evidence.classification === verificationStarted.kind &&
      evidence.completedEventPersisted &&
      evidence.durationMs === commandCompleted.duration_ms &&
      evidence.durationMs === verificationCompleted.duration_ms &&
      evidence.executionId === commandRequested.execution_id &&
      evidence.executionId === verificationStarted.command_execution_id &&
      evidence.executionId === verificationCompleted.command_execution_id &&
      evidence.exitCode === verificationCompleted.exit_code &&
      evidence.generationAtStart === verificationStarted.generation &&
      evidence.generationAtStart === verificationCompleted.started_generation &&
      evidence.generationAtCompletion ===
        verificationCompleted.completed_generation &&
      (evidence.inputsKnown || hasCompletedUnclassifiedVerification) &&
      evidence.output.artifactRefs.length === 0 &&
      arraysEqual(evidence.output.eventRefs, [
        `command:${commandRequested.execution_id}`,
      ]) &&
      evidence.output.stderrSummary === summarize(stderr) &&
      evidence.output.stdoutSummary === summarize(stdout) &&
      evidence.output.totalBytes === commandCompleted.total_bytes &&
      evidence.output.truncated === commandCompleted.truncated &&
      evidence.purpose === commandRequested.purpose &&
      evidence.purpose === "verify" &&
      evidence.stale === verificationCompleted.stale &&
      hashVerificationSnapshot(evidence.beforeSnapshot) ===
        verificationStarted.snapshot_sha256 &&
      hashVerificationSnapshot(evidence.beforeSnapshot) ===
        verificationCompleted.before_snapshot_sha256 &&
      hashVerificationSnapshot(evidence.afterSnapshot) ===
        verificationCompleted.after_snapshot_sha256
    );
  });
}
