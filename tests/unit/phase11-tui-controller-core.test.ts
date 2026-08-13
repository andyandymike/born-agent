import { describe, expect, it, vi } from "vitest";

import { ApprovalController } from "../../src/tui/approval-controller.js";
import {
  createInitialTuiEphemeralState,
  enterApprovalDecision,
  openApprovalDialog,
  setApprovalFocus,
  setDraftInput,
} from "../../src/tui/tui-ephemeral-state.js";
import {
  beginSingleActiveRun,
  createSingleActiveRunState,
  finishSingleActiveRun,
  resolveCtrlC,
} from "../../src/tui/single-active-run.js";
import { createInitialTuiViewState } from "../../src/tui/tui-view-state.js";
import type { TuiViewState } from "../../src/tui/tui-view-state.js";

const HASH = "a".repeat(64);

function approvalView(): TuiViewState {
  const initial = createInitialTuiViewState();
  return {
    ...initial,
    approval: {
      actionKind: "run_command",
      actionSha256: HASH,
      callId: "call-1",
      decision: null,
      expiresState: { status: "active" },
      preview: "pnpm test",
      previewSha256: "b".repeat(64),
      previewTruncated: false,
      requestId: "request-1",
      runId: "run-1",
      sessionId: "session-1",
    },
    session: { ...initial.session, id: "session-1" },
  };
}

describe("Phase 11 approval and controller core", () => {
  it("defaults Enter to deny and requires an explicit focus move to allow", () => {
    const initial = createInitialTuiEphemeralState();
    expect(enterApprovalDecision(initial, "request-1", HASH).decision).toBe(
      "denied",
    );
    expect(
      enterApprovalDecision(
        setApprovalFocus(openApprovalDialog(initial, "request-1"), "allow"),
        "request-1",
        HASH,
      ).decision,
    ).toBe("approved");
    expect(
      enterApprovalDecision(
        openApprovalDialog(
          setApprovalFocus(openApprovalDialog(initial, "request-1"), "allow"),
          "request-2",
        ),
        "request-2",
        HASH,
      ).decision,
    ).toBe("denied");
  });

  it("delegates only an exact request and action binding to core", async () => {
    const decideApproval = vi.fn(async () => undefined);
    const view = approvalView();
    const controller = new ApprovalController(() => view, { decideApproval });

    await expect(
      controller.decide({
        actionSha256: HASH,
        decision: "approved",
        requestId: "request-1",
        type: "decide_approval",
      }),
    ).resolves.toEqual({ status: "delegated" });
    expect(decideApproval).toHaveBeenCalledWith({
      actionSha256: HASH,
      decision: "approved",
      requestId: "request-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    await expect(
      controller.decide({
        actionSha256: "c".repeat(64),
        decision: "approved",
        requestId: "request-1",
        type: "decide_approval",
      }),
    ).resolves.toEqual({ status: "stale" });
    expect(decideApproval).toHaveBeenCalledTimes(1);
  });

  it("fails closed for expired and storage-failed decisions while preserving an exact active-owner approval", async () => {
    const base = approvalView();
    const expired: TuiViewState = {
      ...base,
      approval: {
        ...base.approval!,
        expiresState: { reason: "run_terminal", status: "expired" },
      },
    };
    const blocked: TuiViewState = {
      ...base,
      session: { ...base.session, actionBlocked: true },
    };
    const intent = {
      actionSha256: HASH,
      decision: "approved" as const,
      requestId: "request-1",
      type: "decide_approval" as const,
    };

    await expect(
      new ApprovalController(() => expired, {
        decideApproval: async () => undefined,
      }).decide(intent),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      new ApprovalController(() => blocked, {
        decideApproval: async () => undefined,
      }).decide(intent),
    ).resolves.toEqual({ status: "delegated" });
    const failed = await new ApprovalController(() => base, {
      decideApproval: async () => {
        throw new Error("durable write failed");
      },
    }).decide(intent);
    expect(failed.status).toBe("failed");
  });

  it("enforces one active run and the three Ctrl+C states", () => {
    const first = beginSingleActiveRun(createSingleActiveRunState(), "run-1");
    expect(first.status).toBe("accepted");
    const firstState = first.state;
    expect(beginSingleActiveRun(firstState, "run-2")).toMatchObject({
      activeRunId: "run-1",
      status: "busy",
    });

    const active = resolveCtrlC(
      createInitialTuiViewState(),
      createInitialTuiEphemeralState(),
      firstState,
    );
    expect(active.intent).toEqual({ type: "cancel_active_run" });
    expect(active.runState.cancellationRequested).toBe(true);

    const finished = finishSingleActiveRun(active.runState, "run-1");
    const withDraft = resolveCtrlC(
      createInitialTuiViewState(),
      setDraftInput(createInitialTuiEphemeralState(), "draft"),
      finished,
    );
    expect(withDraft.intent).toBeNull();
    expect(withDraft.ephemeral.draftInput).toBe("");

    const idle = resolveCtrlC(
      createInitialTuiViewState(),
      withDraft.ephemeral,
      finished,
    );
    expect(idle.intent).toEqual({ type: "exit" });
  });
});
