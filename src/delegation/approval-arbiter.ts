import { DelegationError } from "./delegation-errors.js";

export interface DelegationApprovalRequestV1 {
  readonly approvalRequestId: string;
  readonly actorId: string;
  readonly childAttemptId: string;
  readonly actionDigest: string;
  readonly actionKind: string;
  readonly requestedSessionSeq: number;
}

export interface ApprovalArbiterLeaseV1 {
  readonly leaseId: string;
  readonly approvalRequestId: string;
  readonly actorId: string;
}

export class DelegationApprovalArbiter {
  #pending = new Map<string, DelegationApprovalRequestV1>();
  #presented: ApprovalArbiterLeaseV1 | null = null;

  enqueue(request: DelegationApprovalRequestV1): void {
    if (this.#pending.has(request.approvalRequestId) || this.#presented?.approvalRequestId === request.approvalRequestId) {
      throw new DelegationError("delegation_decision_mismatch", "child approval request identity was reused");
    }
    this.#pending.set(request.approvalRequestId, Object.freeze({ ...request }));
  }

  presentNext(createLeaseId: () => string): ApprovalArbiterLeaseV1 | null {
    if (this.#presented !== null) return this.#presented;
    const next = [...this.#pending.values()].sort((left, right) =>
      left.requestedSessionSeq - right.requestedSessionSeq ||
      (left.actorId < right.actorId ? -1 : left.actorId > right.actorId ? 1 : 0))[0];
    if (next === undefined) return null;
    // PHASE20: one global presentation lease prevents two child modals from
    // binding one user's decision to the wrong actor/action digest.
    this.#presented = Object.freeze({
      leaseId: createLeaseId(),
      approvalRequestId: next.approvalRequestId,
      actorId: next.actorId,
    });
    return this.#presented;
  }

  release(input: { readonly leaseId: string; readonly approvalRequestId: string }): void {
    if (this.#presented?.leaseId !== input.leaseId || this.#presented.approvalRequestId !== input.approvalRequestId) {
      throw new DelegationError("delegation_decision_mismatch", "approval arbiter release does not match the presented request");
    }
    this.#pending.delete(input.approvalRequestId);
    this.#presented = null;
  }

  get pending(): readonly DelegationApprovalRequestV1[] {
    return Object.freeze([...this.#pending.values()]);
  }
}
