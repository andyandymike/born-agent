import { describe, expect, it } from "vitest";

import { VerifiedCompletionPolicy } from "../../src/completion/completion-policy.js";
import type {
  CompletionState,
  VerificationEvidence,
  VerificationSnapshot,
} from "../../src/completion/completion-types.js";

const sessionId = "00000000-0000-4000-8000-000000000701";
const runId = "00000000-0000-4000-8000-000000000702";
const executionId = "00000000-0000-4000-8000-000000000703";
const sha = (character: string) => character.repeat(64);

function snapshot(
  overrides: Partial<VerificationSnapshot> = {},
): VerificationSnapshot {
  return {
    changedFiles: [{ path: "src/clamp.ts", sha256: sha("b") }],
    commandInputs: [{ path: "package.json", sha256: sha("c") }],
    deletedFiles: [],
    generation: 1,
    gitHeadSha256: sha("d"),
    gitIndexSha256: sha("e"),
    journalSha256: sha("f"),
    packageScriptSha256: sha("1"),
    sourceStateSha256: sha("2"),
    ...overrides,
  };
}

function verification(
  overrides: Partial<VerificationEvidence> = {},
): VerificationEvidence {
  const current = snapshot();
  return {
    actionSha256: sha("3"),
    afterSnapshot: current,
    approved: true,
    argv: ["corepack", "pnpm", "test"],
    beforeSnapshot: current,
    classification: "test",
    completedEventPersisted: true,
    cwd: ".",
    durationMs: 842,
    executionId,
    exitCode: 0,
    generationAtCompletion: 1,
    generationAtStart: 1,
    inputsKnown: true,
    output: {
      artifactRefs: [],
      eventRefs: ["event:command.completed:19"],
      stderrSummary: "",
      stdoutSummary: "1 test passed",
      totalBytes: 13,
      truncated: false,
    },
    purpose: "verify",
    stale: false,
    ...overrides,
  };
}

function state(overrides: Partial<CompletionState> = {}): CompletionState {
  return {
    activity: {
      activeApproval: false,
      activeCommand: false,
      activePatch: false,
      mutationMutexLocked: false,
      unknownSideEffect: false,
    },
    changedByRun: [
      {
        addedLines: 1,
        kind: "modify",
        path: "src/clamp.ts",
        postimageSha256: sha("b"),
        preimageSha256: sha("a"),
        removedLines: 1,
      },
    ],
    diffCheck: {
      checkedPaths: ["src/clamp.ts"],
      detail: "hunks apply and whitespace is clean",
      diffSha256: sha("4"),
      status: "passed",
    },
    finalSnapshot: snapshot(),
    generation: 1,
    journal: {
      consistent: true,
      postimagesMatchDisk: true,
      readable: true,
    },
    modelEvidence: {
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    },
    preExistingDirtyPaths: ["notes/user-work.txt"],
    runId,
    sessionId,
    verifications: [verification()],
    ...overrides,
  };
}

describe("Phase 7 VerifiedCompletionPolicy", () => {
  const policy = new VerifiedCompletionPolicy();

  it("accepts only a current approved exit-zero verification and immutable evidence", async () => {
    const decision = await policy.evaluate(
      { status: "completed", summary: "fixed the clamp boundary" },
      state(),
    );

    expect(decision.effect).toBe("accept");
    if (decision.effect !== "accept") {
      return;
    }
    expect(decision.evidence).toMatchObject({
      changedByRun: [{ path: "src/clamp.ts" }],
      modelNarrative: "fixed the clamp boundary",
      preExistingDirtyPaths: ["notes/user-work.txt"],
      verifications: [{ exitCode: 0, generationAtCompletion: 1 }],
    });
    expect(Object.isFrozen(decision.evidence.verifications)).toBe(true);
  });

  it.each([
    ["missing", [], "verification_missing"],
    ["failed", [verification({ exitCode: 1 })], "verification_failed"],
    [
      "old generation",
      [verification({ generationAtCompletion: 0, generationAtStart: 0 })],
      "verification_stale",
    ],
    ["explicitly stale", [verification({ stale: true })], "verification_stale"],
    [
      "unknown inputs",
      [verification({ inputsKnown: false })],
      "verification_inputs_unknown",
    ],
    [
      "empty command inputs",
      [
        verification({
          afterSnapshot: snapshot({ commandInputs: [] }),
          beforeSnapshot: snapshot({ commandInputs: [] }),
        }),
      ],
      "verification_inputs_unknown",
    ],
  ])("continues for %s verification", async (_label, verifications, reason) => {
    const decision = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({ verifications: verifications as readonly VerificationEvidence[] }),
    );
    expect(decision).toMatchObject({ effect: "continue" });
    if (decision.effect === "continue") {
      expect(decision.reasons).toContain(reason);
    }
  });

  it("detects source, HEAD, or index changes after a passing command", async () => {
    const changedAtCompletion = snapshot({
      gitIndexSha256: sha("9"),
      sourceStateSha256: sha("8"),
    });
    const decision = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({ finalSnapshot: changedAtCompletion }),
    );
    expect(decision).toEqual({
      effect: "continue",
      reasons: ["source_state_changed"],
    });
  });

  it("fails closed when a verify command changes source before exiting zero", async () => {
    const after = snapshot({ sourceStateSha256: sha("7") });
    const decision = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({
        finalSnapshot: after,
        verifications: [verification({ afterSnapshot: after })],
      }),
    );
    expect(decision).toMatchObject({
      effect: "continue",
      reasons: ["source_state_changed"],
    });
  });

  it("rejects diff gaps, empty coding journals, and mismatched postimages", async () => {
    const failedDiff = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({ diffCheck: { ...state().diffCheck, status: "failed" } }),
    );
    expect(failedDiff).toMatchObject({
      effect: "continue",
      reasons: ["diff_check_failed"],
    });

    const empty = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({ changedByRun: [], finalSnapshot: snapshot({ changedFiles: [] }) }),
    );
    expect(empty).toEqual({
      effect: "continue",
      reasons: ["no_changes_for_coding_task"],
    });

    const mismatched = await policy.evaluate(
      { status: "completed", summary: "candidate" },
      state({
        finalSnapshot: snapshot({
          changedFiles: [{ path: "src/clamp.ts", sha256: sha("9") }],
        }),
      }),
    );
    expect(mismatched).toEqual({
      effect: "incomplete",
      reason: "change_journal_inconsistent",
    });
  });

  it("makes blocked and pending effects incomplete instead of program failures", async () => {
    await expect(
      policy.evaluate({ status: "blocked", summary: "missing input" }, state()),
    ).resolves.toEqual({ effect: "incomplete", reason: "task_blocked" });

    await expect(
      policy.evaluate(
        { status: "completed", summary: "candidate" },
        state({ activity: { ...state().activity, unknownSideEffect: true } }),
      ),
    ).resolves.toEqual({ effect: "incomplete", reason: "pending_effect" });
  });
});
