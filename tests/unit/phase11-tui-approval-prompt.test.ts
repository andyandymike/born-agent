import { describe, expect, it } from "vitest";

import { TuiApprovalPrompt } from "../../src/tui/tui-approval-prompt.js";
import {
  createInitialTuiViewState,
  type TuiViewState,
} from "../../src/tui/tui-view-state.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

function approvalView(): TuiViewState {
  return {
    ...createInitialTuiViewState(),
    approval: {
      actionKind: "run_command",
      actionSha256: HASH,
      callId: "command-1",
      decision: null,
      expiresState: { status: "active" },
      preview: "pnpm test",
      previewSha256: HASH,
      previewTruncated: false,
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
    },
  };
}

describe("Phase 11 TUI approval prompt bridge", () => {
  it("resolves through the core decision port without writing a side effect", async () => {
    const prompt = new TuiApprovalPrompt(approvalView);
    const decision = prompt.request(
      {
        actionKind: "run_command",
        actionSha256: HASH,
        args: ["test"],
        cwd: ".",
        executable: "pnpm",
        purpose: "verify",
        reviewLines: [],
        riskWarning: "fixture",
      },
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(prompt.hasPendingRequest).toBe(true);

    await prompt.decideApproval({
      actionSha256: HASH,
      decision: "approved",
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
    });
    await expect(decision).resolves.toBe("approved");
    expect(prompt.hasPendingRequest).toBe(false);
  });

  it("fails closed for missing/stale identities and aborts as cancelled", async () => {
    const missing = new TuiApprovalPrompt(createInitialTuiViewState);
    const abortMissing = new AbortController();
    const missingDecision = missing.request(
        {
          actionKind: "apply_patch",
          addedLines: 1,
          paths: [{ kind: "modify", path: "a.ts" }],
          planId: HASH,
          preview: "diff",
          previewTruncated: false,
          removedLines: 1,
        },
        abortMissing.signal,
      );
    abortMissing.abort();
    await expect(missingDecision).resolves.toBe("cancelled");

    const abort = new AbortController();
    const prompt = new TuiApprovalPrompt(approvalView);
    const pending = prompt.request(
      {
        actionKind: "run_command",
        actionSha256: HASH,
        args: [],
        cwd: ".",
        executable: "pnpm",
        purpose: "verify",
        reviewLines: [],
        riskWarning: "fixture",
      },
      abort.signal,
    );
    await expect(
      prompt.decideApproval({
        actionSha256: "b".repeat(64),
        decision: "approved",
        requestId: REQUEST_ID,
        runId: RUN_ID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow("stale");
    abort.abort();
    await expect(pending).resolves.toBe("cancelled");
  });

  it("accepts one exact durable decision before the core prompt registers", async () => {
    const prompt = new TuiApprovalPrompt(approvalView);
    await prompt.decideApproval({
      actionSha256: HASH,
      decision: "approved",
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
    });
    expect(prompt.hasPendingRequest).toBe(true);

    await expect(
      prompt.request(
        {
          actionKind: "run_command",
          actionSha256: HASH,
          args: ["test"],
          cwd: ".",
          executable: "pnpm",
          purpose: "verify",
          reviewLines: [],
          riskWarning: "fixture",
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("approved");
    expect(prompt.hasPendingRequest).toBe(false);
  });

  it("waits for the exact durable request to reach the typed TUI view", async () => {
    let view = createInitialTuiViewState();
    const prompt = new TuiApprovalPrompt(() => view);
    const decision = prompt.request(
      {
        actionKind: "run_command",
        actionSha256: HASH,
        args: ["test"],
        cwd: ".",
        executable: "pnpm",
        purpose: "verify",
        reviewLines: [],
        riskWarning: "fixture",
      },
      new AbortController().signal,
    );
    await Promise.resolve();
    view = approvalView();
    prompt.notifyViewChanged();
    await prompt.decideApproval({
      actionSha256: HASH,
      decision: "approved",
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
    });
    await expect(decision).resolves.toBe("approved");
  });

  it("waits past a previously decided request but rejects another active request", async () => {
    let view: TuiViewState = {
      ...approvalView(),
      approval: {
        ...approvalView().approval!,
        decision: "approved",
        expiresState: { reason: "decided", status: "expired" },
      },
    };
    const prompt = new TuiApprovalPrompt(() => view);
    const preview = {
      actionKind: "run_command" as const,
      actionSha256: "b".repeat(64),
      args: ["next"],
      cwd: ".",
      executable: "pnpm",
      purpose: "verify" as const,
      reviewLines: [],
      riskWarning: "fixture",
    };
    const pending = prompt.request(preview, new AbortController().signal);
    // A previously decided request must wait for a real projection change.
    // Yield through a timer so a self-rescheduling microtask loop would make
    // this regression test hang instead of silently starving query I/O.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(prompt.hasPendingRequest).toBe(false);

    view = {
      ...approvalView(),
      approval: {
        ...approvalView().approval!,
        actionSha256: preview.actionSha256,
        requestId: "33333333-3333-4333-8333-333333333336",
      },
    };
    prompt.notifyViewChanged();
    await prompt.decideApproval({
      actionSha256: preview.actionSha256,
      decision: "approved",
      requestId: "33333333-3333-4333-8333-333333333336",
      runId: RUN_ID,
      sessionId: SESSION_ID,
    });
    await expect(pending).resolves.toBe("approved");

    const conflict = new TuiApprovalPrompt(approvalView);
    await expect(conflict.request(preview, new AbortController().signal)).resolves.toBe("denied");
  });

});
