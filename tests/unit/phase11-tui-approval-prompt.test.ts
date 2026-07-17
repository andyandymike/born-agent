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
    await expect(
      missing.request(
        {
          actionKind: "apply_patch",
          addedLines: 1,
          paths: [{ kind: "modify", path: "a.ts" }],
          planId: HASH,
          preview: "diff",
          previewTruncated: false,
          removedLines: 1,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("denied");

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
});
