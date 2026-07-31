export interface PlanMutationControl {
  readonly kind: "plan_revision_proposed";
  readonly planId: string;
  readonly reason: "plan_approval_required";
  readonly revision: number;
  readonly sha256: string;
}
