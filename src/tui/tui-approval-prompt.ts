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
    ? (preview.actionSha256 ?? preview.planId)
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
  private earlyDecision: CoreApprovalDecision | null = null;
  private pending: PendingApproval | null = null;
  private readonly viewWaiters = new Set<() => void>();

  public constructor(private readonly currentView: () => TuiViewState) {}

  public get hasPendingRequest(): boolean {
    return this.pending !== null || this.earlyDecision !== null;
  }

  /** Notify the prompt that a complete durable TUI view was installed. */
  public notifyViewChanged(): void {
    for (const notify of this.viewWaiters) notify();
  }

  public async request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      this.earlyDecision = null;
      return "cancelled";
    }
    if (this.pending !== null) {
      throw new Error("only one TUI approval request may be pending");
    }
    const approval = await this.waitForApprovalView(preview, signal);
    if (approval === null) return signal.aborted ? "cancelled" : "denied";
    const early = this.earlyDecision;
    if (early !== null) {
      this.earlyDecision = null;
      if (
        early.requestId !== approval.requestId ||
        early.actionSha256 !== approval.actionSha256 ||
        early.runId !== approval.runId ||
        early.sessionId !== approval.sessionId
      ) {
        throw new Error("TUI approval decision is stale");
      }
      return early.decision;
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
    if (pending === null) {
      const approval = this.currentView().approval;
      if (
        this.earlyDecision !== null ||
        approval === null ||
        approval.expiresState.status !== "active" ||
        approval.requestId !== decision.requestId ||
        approval.actionSha256 !== decision.actionSha256 ||
        approval.runId !== decision.runId ||
        approval.sessionId !== decision.sessionId
      ) {
        throw new Error("TUI approval decision is stale");
      }
      // PHASE16: The durable request can reach the renderer one microtask before the
      // core calls request(). Keep exactly one fully-bound decision so fast
      // keyboard input cannot turn a valid approval into a fatal race.
      this.earlyDecision = decision;
      return;
    }
    if (
      pending.requestId !== decision.requestId ||
      pending.actionSha256 !== decision.actionSha256 ||
      pending.runId !== decision.runId ||
      pending.sessionId !== decision.sessionId
    ) {
      throw new Error("TUI approval decision is stale");
    }
    pending.settle(decision.decision);
  }

  private async waitForApprovalView(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalView | null> {
    for (;;) {
      const view = this.currentView();
      const approval = view.approval;
      if (approval !== null) {
        if (matchesPreview(approval, preview)) return approval;
        if (approval.expiresState.status === "active") {
          this.earlyDecision = null;
          return null;
        }
        // A decided request remains in the reconstructed view until the next
        // durable request reaches the typed projection. It is not a competing
        // authority and must not turn that delivery gap into a denial.
      }
      if (signal.aborted) {
        this.earlyDecision = null;
        return null;
      }
      // The request is already durable when ApprovalPrompt.request is called,
      // but Phase21 TUI facts arrive through a named-query refresh. Wait for a
      // complete view notification instead of treating that expected delivery
      // gap as a user denial. The bound preview/hash check above remains the
      // authority edge and any different observed request fails closed.
      await new Promise<void>((resolve) => {
        const observedApproval = approval;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", finish);
          this.viewWaiters.delete(finish);
          resolve();
        };
        this.viewWaiters.add(finish);
        signal.addEventListener("abort", finish, { once: true });
        // Avoid a lost wake-up when the view changed between the read above
        // and waiter registration. This microtask is only a recheck; unlike a
        // bounded spin it never interprets delivery latency as denial.
        queueMicrotask(() => {
          const current = this.currentView();
          if (
            signal.aborted ||
            current.approval !== observedApproval
          ) finish();
        });
      });
    }
  }
}
