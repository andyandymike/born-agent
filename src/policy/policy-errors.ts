export type RuntimePolicyErrorCode =
  | "policy_builtin_invariant"
  | "policy_config_invalid"
  | "policy_config_untrusted_path"
  | "policy_profile_duplicate"
  | "policy_profile_unknown"
  | "policy_profile_not_explicit"
  | "policy_provider_denied"
  | "policy_model_denied"
  | "policy_endpoint_denied"
  | "policy_eval_suite_denied"
  | "policy_attempt_ceiling_exceeded"
  | "policy_request_ceiling_exceeded"
  | "policy_profile_drift"
  | "policy_docker_artifact_denied";

export class RuntimePolicyError extends Error {
  override readonly name = "RuntimePolicyError";

  constructor(
    readonly code: RuntimePolicyErrorCode,
    message: string,
    readonly exitCode: 1 | 2 = 2,
    options: ErrorOptions = {},
  ) {
    super(`${code}: ${message}`, options);
  }
}
