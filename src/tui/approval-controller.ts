import type { ApprovalView, TuiViewState } from "./tui-view-state.js";
import type { UserIntent } from "./user-intent.js";

export interface CoreApprovalDecision {
  readonly actionSha256: string;
  readonly decision: "approved" | "denied";
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
}

export interface CoreApprovalPort {
  decideApproval(decision: CoreApprovalDecision): Promise<void>;
}

export type ApprovalControllerResult =
  | { readonly status: "blocked" | "expired" | "stale" }
  | { readonly error: unknown; readonly status: "failed" }
  | { readonly status: "delegated" };

function matchesApproval(
  approval: ApprovalView,
  intent: Extract<UserIntent, { type: "decide_approval" }>,
): boolean {
  // PHASE11: request id prevents replaying an old dialog decision, while the
  // action hash prevents a changed command/patch from inheriting authority.
  return (
    approval.requestId === intent.requestId &&
    approval.actionSha256 === intent.actionSha256
  );
}

export class ApprovalController {
  public constructor(
    private readonly currentView: () => TuiViewState,
    private readonly core: CoreApprovalPort,
  ) {}

  public async decide(
    intent: Extract<UserIntent, { type: "decide_approval" }>,
  ): Promise<ApprovalControllerResult> {
    const view = this.currentView();
    if (view.session.actionBlocked) return { status: "blocked" };
    if (view.approval === null || !matchesApproval(view.approval, intent)) {
      return { status: "stale" };
    }
    if (view.approval.expiresState.status !== "active") {
      return { status: "expired" };
    }

    try {
      // The port is the existing core approval API: it owns durable
      // approval.decided before any effect. This controller never invokes an
      // executor or patch applier directly.
      await this.core.decideApproval({
        actionSha256: intent.actionSha256,
        decision: intent.decision,
        requestId: intent.requestId,
        runId: view.approval.runId,
        sessionId: view.approval.sessionId,
      });
      return { status: "delegated" };
    } catch (error) {
      return { error, status: "failed" };
    }
  }
}
