export type ApplicationControlErrorCode =
  | "control_artifact_forbidden"
  | "control_artifact_invalid"
  | "control_authentication_failed"
  | "control_authorization_denied"
  | "control_catalog_conflict"
  | "control_catalog_corrupt"
  | "control_idempotency_conflict"
  | "control_identity_corrupt"
  | "control_operation_busy"
  | "control_operation_corrupt"
  | "control_operation_not_found"
  | "control_payload_invalid"
  | "control_prepared_action_consumed"
  | "control_prepared_action_expired"
  | "control_prepared_action_mismatch"
  | "control_prepared_action_not_found"
  | "control_query_unknown"
  | "control_resync_required"
  | "control_session_history_missing_or_corrupt"
  | "control_session_not_started"
  | "control_stale_projection"
  | "control_target_invalid"
  | "control_unknown_action";

const EXIT_CODE: Readonly<Record<ApplicationControlErrorCode, 1 | 2 | 8>> = {
  control_artifact_forbidden: 2,
  control_artifact_invalid: 1,
  control_authentication_failed: 2,
  control_authorization_denied: 2,
  control_catalog_conflict: 8,
  control_catalog_corrupt: 1,
  control_idempotency_conflict: 2,
  control_identity_corrupt: 1,
  control_operation_busy: 8,
  control_operation_corrupt: 1,
  control_operation_not_found: 2,
  control_payload_invalid: 2,
  control_prepared_action_consumed: 8,
  control_prepared_action_expired: 8,
  control_prepared_action_mismatch: 2,
  control_prepared_action_not_found: 2,
  control_query_unknown: 2,
  control_resync_required: 8,
  control_session_history_missing_or_corrupt: 1,
  control_session_not_started: 8,
  control_stale_projection: 8,
  control_target_invalid: 2,
  control_unknown_action: 2,
};

export class ApplicationControlError extends Error {
  override readonly name = "ApplicationControlError";

  constructor(
    readonly code: ApplicationControlErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }

  get exitCode(): 1 | 2 | 8 {
    return EXIT_CODE[this.code];
  }
}

