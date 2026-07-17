import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalPrompt,
} from "../approvals/approval-types.js";
import type {
  CoreApprovalDecision,
  CoreApprovalPort,
} from "./approval-controller.js";
import type { ApprovalView, TuiViewState } from "./tui-view-state.js";

interface PendingApproval {
  readonly actionSha256: string;
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly settle: (decision: ApprovalDecision) => void;
}

function previewActionSha256(preview: ApprovalPreview): string {
  return preview.actionKind === "apply_patch"
    ? preview.planId
    : preview.actionSha256;
}

function matchesPreview(
  approval: ApprovalView,
  preview: ApprovalPreview,
): boolean {
  return (
    approval.expiresState.status === "active" &&
    approval.actionKind === preview.actionKind &&
    approval.actionSha256 === previewActionSha256(preview)
  );
}

export class TuiApprovalPrompt implements ApprovalPrompt, CoreApprovalPort {
  private pending: PendingApproval | null = null;

  public constructor(private readonly currentView: () => TuiViewState) {}

  public get hasPendingRequest(): boolean {
    return this.pending !== null;
  }

  public async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) return "cancelled";
    if (this.pending !== null) {
      throw new Error("only one TUI approval request may be pending");
    }
    const approval = this.currentView().approval;
    if (approval === null || !matchesPreview(approval, preview)) {
      return "denied";
    }

    return await new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.pending?.requestId === approval.requestId) this.pending = null;
        resolve(decision);
      };
      const onAbort = (): void => settle("cancelled");
      // PHASE11: the prompt binds the already-durable request id and action
      // hash. Resolving this promise only returns to the core gate; the gate
      // still must durably append approval.decided before any side effect.
      this.pending = {
        actionSha256: approval.actionSha256,
        requestId: approval.requestId,
        runId: approval.runId,
        sessionId: approval.sessionId,
        settle,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  public async decideApproval(decision: CoreApprovalDecision): Promise<void> {
    const pending = this.pending;
    if (
      pending === null ||
      pending.requestId !== decision.requestId ||
      pending.actionSha256 !== decision.actionSha256 ||
      pending.runId !== decision.runId ||
      pending.sessionId !== decision.sessionId
    ) {
      throw new Error("TUI approval decision is stale");
    }
    pending.settle(decision.decision);
  }
}
