export type DelegationErrorCode =
  | "delegation_invalid"
  | "delegation_too_large"
  | "delegation_parent_not_active"
  | "delegation_binding_stale"
  | "delegation_revision_conflict"
  | "delegation_decision_mismatch"
  | "delegation_decision_unauthorized"
  | "delegation_authority_expansion"
  | "delegation_context_unavailable"
  | "delegation_context_too_large"
  | "delegation_model_unqualified"
  | "delegation_budget_exhausted"
  | "delegation_parallel_limit"
  | "delegation_workspace_conflict"
  | "delegation_lease_busy"
  | "delegation_handshake_failed"
  | "delegation_child_protocol_invalid"
  | "delegation_effect_reconciliation_required"
  | "delegation_receipt_invalid"
  | "delegation_receipt_stale"
  | "delegation_cancelled"
  | "delegation_unsupported_depth"
  | "delegation_artifact_invalid"
  | "delegation_busy";

function exitCode(code: DelegationErrorCode): 1 | 2 | 3 | 7 | 8 {
  switch (code) {
    case "delegation_invalid":
    case "delegation_too_large":
    case "delegation_revision_conflict":
    case "delegation_decision_mismatch":
    case "delegation_decision_unauthorized":
    case "delegation_authority_expansion":
    case "delegation_unsupported_depth":
      return 2;
    case "delegation_child_protocol_invalid":
    case "delegation_handshake_failed":
      return 3;
    case "delegation_budget_exhausted":
      return 7;
    case "delegation_artifact_invalid":
      return 1;
    default:
      return 8;
  }
}

export class DelegationError extends Error {
  override readonly name = "DelegationError";
  readonly exitCode: 1 | 2 | 3 | 7 | 8;

  constructor(
    readonly code: DelegationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.exitCode = exitCode(code);
  }
}
