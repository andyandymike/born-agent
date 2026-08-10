import type { DelegationRevisionProjectionV1 } from "./delegation-projector.js";

export interface DelegationCancelTargetV1 {
  readonly delegationId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly sequence: number;
}

export function delegationCancelCascade(
  revisions: readonly DelegationRevisionProjectionV1[],
  parentActorId: string,
): readonly DelegationCancelTargetV1[] {
  const active = revisions.filter((revision) =>
    revision.parentActorId === parentActorId &&
    ["approved", "queued", "active", "waiting_approval", "cancelling", "reconciling", "receipt_ready"].includes(revision.status));
  return Object.freeze(active.map((revision) => Object.freeze({
    delegationId: revision.delegationId,
    revision: revision.delegationRevision,
    sha256: revision.delegationSha256,
    sequence: revision.content.sequence,
  })).sort((left, right) =>
    left.sequence - right.sequence ||
    (left.delegationId < right.delegationId ? -1 : left.delegationId > right.delegationId ? 1 : 0)));
}
