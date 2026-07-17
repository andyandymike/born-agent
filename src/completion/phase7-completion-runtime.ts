import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ChangeJournal, ChangeJournalEntry } from "../changes/change-journal.js";
import {
  EventPersistenceError,
  type EventPublisher,
} from "../events/event-publisher.js";
import type { ExecutionResult, PreparedExecution } from "../execution/execution-types.js";
import {
  FatalToolExecutionError,
  type CompletionControlSignal,
  type CompletionRuntimeLike,
} from "../tools/tool-types.js";
import {
  type RegistryVerificationClassification,
} from "../verification/verification-command-classifier.js";
import {
  NodeGitArgvRunner,
  type GitArgvRunner,
} from "../verification/git-argv-runner.js";
import {
  RunLocalDiffChecker,
  type RunLocalDiffFileStat,
} from "../verification/run-local-diff-checker.js";
import { SourceStateDigestBuilder } from "../verification/source-state-digest.js";
import {
  buildVerificationSnapshot,
  type VerificationSnapshot as RuntimeVerificationSnapshot,
} from "../verification/verification-snapshot.js";
import {
  VerificationTracker,
  type VerificationStartedRecord,
} from "../verification/verification-tracker.js";
import { sha256Canonical } from "./canonical-json.js";
import {
  renderRunReport,
} from "./completion-report-renderer.js";
import { createPersistedCompletionEvidence } from "./completion-evidence-schema.js";
import type {
  ChangedFileEvidence,
  CompletionReason,
  CompletionState,
  ModelEvidence,
  VerificationEvidence,
} from "./completion-types.js";
import {
  createIncompleteEvidence,
  EvidenceLedger,
} from "./evidence-ledger.js";

export type PreparedVerificationClassification =
  RegistryVerificationClassification;

export type PreparedVerificationClassifier = (
  prepared: PreparedExecution,
) => Promise<PreparedVerificationClassification | null>;

export interface Phase7CompletionRuntimeOptions {
  readonly classifier: PreparedVerificationClassifier;
  readonly journal: ChangeJournal;
  readonly modelEvidence: ModelEvidence;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly gitRunner?: GitArgvRunner;
}

export interface ActiveVerificationContext {
  readonly classification: PreparedVerificationClassification;
  readonly prepared: PreparedExecution;
  readonly started: VerificationStartedRecord;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeNulPaths(value: Buffer): readonly string[] {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (decoded.length === 0) return [];
  if (!decoded.endsWith("\0")) {
    throw new Error("Git path list was not NUL terminated");
  }
  return decoded
    .slice(0, -1)
    .split("\0")
    .filter(
      (path) =>
        path !== ".bornagent" &&
        !path.startsWith(".bornagent/") &&
        path !== ".git" &&
        !path.startsWith(".git/"),
    );
}

async function inspectDirtyPaths(
  workspace: string,
  runner: GitArgvRunner,
): Promise<readonly string[]> {
  const results = await Promise.all([
    runner.run(workspace, ["diff", "--name-only", "-z", "--no-ext-diff"]),
    runner.run(workspace, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-ext-diff",
    ]),
    runner.run(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (results.some((result) => result.exitCode !== 0)) {
    throw new Error("could not inspect the pre-existing Git dirty baseline");
  }
  // PHASE7: Dirty paths are captured before any Agent mutation and never inferred
  // from the final worktree, so a user's existing edits cannot be claimed by the run.
  return Object.freeze(
    [...new Set(results.flatMap((result) => decodeNulPaths(result.stdout)))].sort(),
  );
}

function aggregateJournal(
  entries: readonly ChangeJournalEntry[],
  fileStats: readonly RunLocalDiffFileStat[],
): readonly ChangedFileEvidence[] {
  const grouped = new Map<
    string,
    { first: ChangeJournalEntry; latest: ChangeJournalEntry }
  >();
  for (const entry of entries) {
    const current = grouped.get(entry.path);
    if (current === undefined) {
      grouped.set(entry.path, {
        first: entry,
        latest: entry,
      });
    } else {
      current.latest = entry;
    }
  }
  const exactStats = new Map(fileStats.map((stat) => [stat.path, stat]));
  return Object.freeze(
    [...grouped.entries()]
      .filter(([, value]) => !value.first.preimage.equals(value.latest.postimage))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, value]) => {
        const stat = exactStats.get(path);
        return Object.freeze({
          // PHASE7: repeated patches are reported as the exact first-preimage to
          // latest-postimage Git diff, never as an inflated sum of intermediate edits.
          addedLines: stat?.addedLines ?? 0,
          kind: value.first.kind,
          path,
          postimageSha256: value.latest.postimageSha256,
          preimageSha256:
            value.first.kind === "create" ? null : value.first.preimageSha256,
          removedLines: stat?.removedLines ?? 0,
        });
      }),
  );
}

function summarize(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return [...normalized].slice(0, 1_024).join("");
}

export class Phase7CompletionRuntime implements CompletionRuntimeLike {
  private readonly classifier: PreparedVerificationClassifier;
  private readonly diffChecker: RunLocalDiffChecker;
  private readonly journal: ChangeJournal;
  private readonly modelEvidence: ModelEvidence;
  private readonly preExistingDirtyPaths: readonly string[];
  private readonly publisher: EventPublisher;
  private readonly randomUUID: () => string;
  private readonly runId: string;
  private readonly sessionId: string;
  private readonly sourceState: SourceStateDigestBuilder;
  private readonly tracker = new VerificationTracker();
  private readonly verifications: VerificationEvidence[] = [];
  private readonly workspace: string;
  private verificationInputsUnknown = false;

  private constructor(
    options: Phase7CompletionRuntimeOptions,
    preExistingDirtyPaths: readonly string[],
    runner: GitArgvRunner,
  ) {
    this.classifier = options.classifier;
    this.diffChecker = new RunLocalDiffChecker(runner);
    this.journal = options.journal;
    this.modelEvidence = structuredClone(options.modelEvidence);
    this.preExistingDirtyPaths = preExistingDirtyPaths;
    this.publisher = options.publisher;
    this.randomUUID = options.randomUUID;
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.sourceState = new SourceStateDigestBuilder(runner);
    this.workspace = options.workspace;
  }

  static async create(
    options: Phase7CompletionRuntimeOptions,
  ): Promise<Phase7CompletionRuntime> {
    const runner = options.gitRunner ?? new NodeGitArgvRunner();
    const dirty = await inspectDirtyPaths(options.workspace, runner);
    return new Phase7CompletionRuntime(options, dirty, runner);
  }

  recordPatchApplied(): number {
    return this.tracker.recordPatchApplied();
  }

  private async publish(
    draft: Parameters<EventPublisher["publish"]>[0],
    workspaceMayHaveChanged: boolean,
  ): Promise<void> {
    try {
      await this.publisher.publish(draft);
    } catch (error) {
      if (error instanceof EventPersistenceError) {
        throw new FatalToolExecutionError(
          "storage",
          "verification evidence could not be persisted",
          { cause: error, workspaceMayHaveChanged },
        );
      }
      throw error;
    }
  }

  private async snapshot(
    classification: PreparedVerificationClassification,
  ): Promise<RuntimeVerificationSnapshot> {
    return buildVerificationSnapshot({
      commandInputPaths: classification.inputPaths,
      generation: this.tracker.currentGeneration(),
      journalEntries: this.journal.entries(),
      ...(classification.packageScriptSha256 === undefined
        ? {}
        : { packageScriptSha256: classification.packageScriptSha256 }),
      sourceState: await this.sourceState.build(this.workspace),
    });
  }

  async prepareVerification(
    prepared: PreparedExecution,
    commandExecutionId: string,
  ): Promise<ActiveVerificationContext | null> {
    if (prepared.actionIdentity.purpose !== "verify") return null;
    const classification = await this.classifier(prepared);
    if (classification === null || classification.inputPaths.length === 0) {
      this.verificationInputsUnknown = true;
      return null;
    }
    this.verificationInputsUnknown = false;
    const beforeSnapshot = await this.snapshot(classification);
    const started = this.tracker.start({
      actionSha256: prepared.actionSha256,
      approved: true,
      beforeSnapshot,
      commandExecutionId,
      kind: classification.kind,
      verificationId: this.randomUUID(),
    });
    return { classification, prepared, started };
  }

  async publishVerificationStarted(
    context: ActiveVerificationContext,
    callId: string,
    step: number,
  ): Promise<void> {
    await this.publish(
      {
        data: {
          action_sha256: context.started.actionSha256,
          call_id: callId,
          command_execution_id: context.started.commandExecutionId,
          generation: context.started.generation,
          kind: context.started.kind,
          snapshot_sha256: context.started.beforeSnapshotSha256,
          step,
          verification_id: context.started.verificationId,
        },
        type: "verification.started",
      },
      this.journal.entries().length > 0,
    );
  }

  async completeVerification(
    context: ActiveVerificationContext,
    result: ExecutionResult,
    callId: string,
    step: number,
  ): Promise<void> {
    const afterSnapshot = await this.snapshot(context.classification);
    const completed = this.tracker.complete({
      afterSnapshot,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      termination: result.termination,
      verificationId: context.started.verificationId,
    });
    // PHASE7: A process can expose an observed zero exit code after timeout,
    // cancellation, output limiting, or failed cleanup. Only a normal exit owns
    // verification exit evidence; every other first-cause termination fails closed.
    const verificationExitCode =
      completed.termination === "exit" ? completed.exitCode : null;
    const evidence: VerificationEvidence = {
      actionSha256: completed.actionSha256,
      afterSnapshot: completed.afterSnapshot,
      approved: true,
      argv: [
        context.prepared.actionIdentity.logicalExecutable,
        ...context.prepared.actionIdentity.argv,
      ],
      beforeSnapshot: completed.beforeSnapshot,
      classification: completed.kind,
      completedEventPersisted: true,
      cwd: context.prepared.actionIdentity.canonicalCwd,
      durationMs: completed.durationMs,
      executionId: completed.commandExecutionId,
      ...(context.prepared.environmentEvidence === undefined
        ? {}
        : { executionEnvironment: context.prepared.environmentEvidence }),
      exitCode: verificationExitCode,
      generationAtCompletion: completed.completedGeneration,
      generationAtStart: completed.generation,
      inputsKnown: true,
      output: {
        artifactRefs: [],
        eventRefs: [`command:${completed.commandExecutionId}`],
        stderrSummary: summarize(result.stderr),
        stdoutSummary: summarize(result.stdout),
        totalBytes: result.stderrBytes + result.stdoutBytes,
        truncated: result.truncated,
      },
      purpose: "verify",
      ...(result.sandboxEphemeralChanges === undefined
        ? {}
        : { sandboxEphemeralChanges: result.sandboxEphemeralChanges }),
      stale: completed.status === "stale",
      verificationId: completed.verificationId,
    };
    await this.publish(
      {
        data: {
          action_sha256: completed.actionSha256,
          after_snapshot_sha256: completed.afterSnapshotSha256,
          before_snapshot_sha256: completed.beforeSnapshotSha256,
          call_id: callId,
          command_execution_id: completed.commandExecutionId,
          completed_generation: completed.completedGeneration,
          duration_ms: completed.durationMs,
          exit_code: verificationExitCode,
          stale: completed.status === "stale",
          stale_reasons: [...completed.staleReasons],
          started_generation: completed.generation,
          status: completed.status,
          step,
          verification_id: completed.verificationId,
        },
        type: "verification.completed",
      },
      this.journal.entries().length > 0,
    );
    this.verifications.push(evidence);
  }

  private async postimagesMatchDisk(
    entries: readonly ChangeJournalEntry[],
  ): Promise<boolean> {
    const latest = new Map(entries.map((entry) => [entry.path, entry]));
    try {
      const matches = await Promise.all(
        [...latest.values()].map(async (entry) =>
          sha256(await readFile(resolve(this.workspace, ...entry.path.split("/")))) ===
          entry.postimageSha256,
        ),
      );
      return matches.every(Boolean);
    } catch {
      return false;
    }
  }

  async state(): Promise<CompletionState> {
    const entries = this.journal.entries();
    const diff = await this.diffChecker.check(entries);
    const changedByRun = aggregateJournal(entries, diff.fileStats);
    const latest = [...this.verifications]
      .reverse()
      .find(
        (verification) =>
          verification.generationAtCompletion === this.tracker.currentGeneration(),
      );
    let finalSnapshot: RuntimeVerificationSnapshot | null = null;
    if (latest !== undefined) {
      try {
        finalSnapshot = await this.snapshot({
          inputPaths: latest.afterSnapshot.commandInputs.map((input) => input.path),
          kind: latest.classification,
          ...(latest.afterSnapshot.packageScriptSha256 === undefined
            ? {}
            : { packageScriptSha256: latest.afterSnapshot.packageScriptSha256 }),
        });
      } catch {
        finalSnapshot = null;
      }
    }
    return {
      activity: {
        activeApproval: false,
        activeCommand: this.tracker.activeCount() > 0,
        activePatch: false,
        mutationMutexLocked: false,
        unknownSideEffect: false,
      },
      changedByRun,
      diffCheck: {
        checkedPaths: diff.checkedPaths,
        detail: diff.detail,
        diffSha256: diff.diffSha256,
        status: diff.status,
      },
      finalSnapshot,
      generation: this.tracker.currentGeneration(),
      journal: {
        consistent: diff.errorCode !== "journal_inconsistent",
        postimagesMatchDisk: await this.postimagesMatchDisk(entries),
        readable: true,
      },
      modelEvidence: this.modelEvidence,
      preExistingDirtyPaths: this.preExistingDirtyPaths,
      runId: this.runId,
      sessionId: this.sessionId,
      verifications: this.verifications.map((verification) =>
        this.verificationInputsUnknown
          ? { ...verification, inputsKnown: false }
          : verification,
      ),
      verificationInputsUnknown: this.verificationInputsUnknown,
    };
  }

  async createIncomplete(
    reason: string,
    summary: string,
  ): Promise<Extract<CompletionControlSignal, { readonly effect: "incomplete" }>> {
    const state = await this.state();
    const safeReason = reason as CompletionReason;
    const proposed = createIncompleteEvidence(
      state,
      { status: "blocked", summary },
      safeReason,
    );
    const projection = createPersistedCompletionEvidence(proposed);
    await this.publish(
      { data: projection, type: "completion.evidence" },
      state.changedByRun.length > 0,
    );
    const evidence = EvidenceLedger.fromPersistedProjection(projection).snapshot();
    if (!("reason" in evidence)) {
      throw new TypeError("incomplete evidence projection changed outcome");
    }
    const report = projection.report;
    return {
      effect: "incomplete",
      evidenceSha256: sha256Canonical(evidence),
      kind: "completion",
      reason: safeReason,
      reportJson: renderRunReport(report, "json"),
      reportSha256: report.report_hash,
      reportText: renderRunReport(report, "text"),
    };
  }
}
