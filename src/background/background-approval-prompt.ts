import type { ApprovalDecision, ApprovalPreview, ApprovalPrompt } from "../approvals/approval-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";

export interface DeferredBackgroundApprovalV1 {
  readonly reason: "approval_required";
  readonly requestedActionRef: string;
}

export class BackgroundDeferredApprovalPrompt implements ApprovalPrompt {
  #deferred: DeferredBackgroundApprovalV1 | null = null;

  constructor(private readonly onDeferred: () => void) {}

  get deferred(): DeferredBackgroundApprovalV1 | null {
    return this.#deferred;
  }

  async request(preview: ApprovalPreview, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return "cancelled";
    if (this.#deferred === null) {
      // PHASE19: a background worker may persist that one exact action needs a
      // human, but it never waits on stdin and never converts Graph approval
      // into effect approval.
      this.#deferred = Object.freeze({
        reason: "approval_required",
        requestedActionRef: `approval/sha256/${sha256Canonical(preview)}`,
      });
      this.onDeferred();
    }
    return "cancelled";
  }
}
