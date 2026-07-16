import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ChangeJournalEntry } from "../../src/changes/change-journal.js";
import type { VerificationSnapshot } from "../../src/completion/completion-types.js";
import type { SourceStateDigest } from "../../src/verification/source-state-digest.js";
import {
  buildVerificationSnapshot,
  VerificationSnapshotError,
} from "../../src/verification/verification-snapshot.js";
import { VerificationTracker } from "../../src/verification/verification-tracker.js";

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalEntry(
  preimage: string,
  postimage: string,
  overrides: Partial<ChangeJournalEntry> = {},
): ChangeJournalEntry {
  const before = Buffer.from(preimage);
  const after = Buffer.from(postimage);
  return {
    addedLines: 1,
    appliedAt: "2026-07-17T00:00:00.000Z",
    diff: "fixture diff\n",
    kind: "modify",
    path: "src/value.ts",
    planId: "plan-1",
    postimage: after,
    postimageSha256: sha(after),
    preimage: before,
    preimageSha256: sha(before),
    removedLines: 1,
    ...overrides,
  };
}

function sourceState(source = "a"): SourceStateDigest {
  return {
    files: [
      { bytesSha256: "1".repeat(64), path: "package.json", type: "file" },
      { bytesSha256: "2".repeat(64), path: "pnpm-lock.yaml", type: "file" },
      { bytesSha256: "3".repeat(64), path: "src/value.ts", type: "file" },
    ],
    gitHeadSha256: "b".repeat(64),
    gitIndexSha256: "c".repeat(64),
    sourceStateSha256: source.repeat(64),
  };
}

function snapshot(generation: number, source = "a"): VerificationSnapshot {
  return {
    changedFiles: [{ path: "src/value.ts", sha256: "3".repeat(64) }],
    commandInputs: [{ path: "package.json", sha256: "1".repeat(64) }],
    deletedFiles: [],
    generation,
    gitHeadSha256: "b".repeat(64),
    gitIndexSha256: "c".repeat(64),
    journalSha256: "d".repeat(64),
    sourceStateSha256: source.repeat(64),
  };
}

describe("Phase 7 verification snapshot", () => {
  it("binds current journal postimages and explicit command input fingerprints", () => {
    const first = journalEntry("old\n", "middle\n");
    const second = journalEntry("middle\n", "new\n", {
      appliedAt: "2026-07-17T00:01:00.000Z",
      planId: "plan-2",
    });
    const built = buildVerificationSnapshot({
      commandInputPaths: ["pnpm-lock.yaml", "package.json"],
      generation: 2,
      journalEntries: [first, second],
      packageScriptSha256: "e".repeat(64),
      sourceState: sourceState(),
    });

    expect(built.changedFiles).toEqual([
      { path: "src/value.ts", sha256: second.postimageSha256 },
    ]);
    expect(built.commandInputs).toEqual([
      { path: "package.json", sha256: "1".repeat(64) },
      { path: "pnpm-lock.yaml", sha256: "2".repeat(64) },
    ]);
  });

  it("fails closed for an unknown input or broken journal image chain", () => {
    expect(() =>
      buildVerificationSnapshot({
        commandInputPaths: ["missing.json"],
        generation: 1,
        journalEntries: [journalEntry("old\n", "new\n")],
        sourceState: sourceState(),
      }),
    ).toThrowError(VerificationSnapshotError);

    const first = journalEntry("old\n", "middle\n");
    const broken = journalEntry("different\n", "new\n", { planId: "plan-2" });
    expect(() =>
      buildVerificationSnapshot({
        commandInputPaths: ["package.json"],
        generation: 2,
        journalEntries: [first, broken],
        sourceState: sourceState(),
      }),
    ).toThrowError(/image chain is broken/u);
  });
});

describe("Phase 7 verification generation tracker", () => {
  it("accepts an exit-zero record only for the unchanged current generation", () => {
    const tracker = new VerificationTracker();
    expect(tracker.recordPatchApplied()).toBe(1);
    const before = snapshot(1);
    tracker.start({
      actionSha256: "a".repeat(64),
      approved: true,
      beforeSnapshot: before,
      commandExecutionId: "execution-1",
      kind: "test",
      verificationId: "verification-1",
    });
    const completed = tracker.complete({
      afterSnapshot: before,
      durationMs: 42,
      exitCode: 0,
      termination: "exit",
      verificationId: "verification-1",
    });
    expect(completed.status).toBe("passed");
    expect(tracker.successfulCurrent(before)).toHaveLength(1);

    tracker.recordPatchApplied();
    expect(tracker.successfulCurrent(snapshot(2))).toEqual([]);
  });

  it("marks verification stale when a patch or source change occurs during execution", () => {
    const tracker = new VerificationTracker();
    tracker.recordPatchApplied();
    tracker.start({
      actionSha256: "a".repeat(64),
      approved: true,
      beforeSnapshot: snapshot(1),
      commandExecutionId: "execution-patch",
      kind: "test",
      verificationId: "verification-patch",
    });
    tracker.recordPatchApplied();
    const patchedDuringRun = tracker.complete({
      afterSnapshot: snapshot(2),
      durationMs: 10,
      exitCode: 0,
      termination: "exit",
      verificationId: "verification-patch",
    });
    expect(patchedDuringRun.status).toBe("stale");
    expect(patchedDuringRun.staleReasons).toContain("generation_changed");

    const sourceTracker = new VerificationTracker();
    sourceTracker.recordPatchApplied();
    sourceTracker.start({
      actionSha256: "b".repeat(64),
      approved: true,
      beforeSnapshot: snapshot(1, "a"),
      commandExecutionId: "execution-source",
      kind: "lint",
      verificationId: "verification-source",
    });
    const changedDuringRun = sourceTracker.complete({
      afterSnapshot: snapshot(1, "e"),
      durationMs: 11,
      exitCode: 0,
      termination: "exit",
      verificationId: "verification-source",
    });
    expect(changedDuringRun.status).toBe("stale");
    expect(changedDuringRun.staleReasons).toContain("source_state_changed");
  });

  it("keeps a journal-mismatched generation permanently stale", () => {
    const tracker = new VerificationTracker();
    tracker.recordPatchApplied();
    tracker.markCurrentGenerationStale();
    tracker.start({
      actionSha256: "c".repeat(64),
      approved: true,
      beforeSnapshot: snapshot(1),
      commandExecutionId: "execution-stale",
      kind: "check",
      verificationId: "verification-stale",
    });
    const completed = tracker.complete({
      afterSnapshot: snapshot(1),
      durationMs: 1,
      exitCode: 0,
      termination: "exit",
      verificationId: "verification-stale",
    });
    expect(completed.status).toBe("stale");
    expect(completed.staleReasons).toEqual(["generation_marked_stale"]);
  });

  it.each([
    "cancelled",
    "cleanup_failed",
    "output_limit_exceeded",
    "signal",
    "spawn_error",
    "stale",
    "timeout",
  ] as const)(
    "never passes a %s termination even when an exit code of zero was observed",
    (termination) => {
      const tracker = new VerificationTracker();
      tracker.recordPatchApplied();
      const unchanged = snapshot(1);
      tracker.start({
        actionSha256: "d".repeat(64),
        approved: true,
        beforeSnapshot: unchanged,
        commandExecutionId: `execution-${termination}`,
        kind: "test",
        verificationId: `verification-${termination}`,
      });

      const completed = tracker.complete({
        afterSnapshot: unchanged,
        durationMs: 1,
        exitCode: 0,
        termination,
        verificationId: `verification-${termination}`,
      });

      expect(completed).toMatchObject({
        exitCode: 0,
        status: "failed",
        termination,
      });
      expect(tracker.successfulCurrent(unchanged)).toEqual([]);
    },
  );
});
