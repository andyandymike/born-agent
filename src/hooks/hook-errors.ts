export type HookErrorCode =
  | "hook_manifest_invalid"
  | "hook_event_unsupported"
  | "hook_match_limit_exceeded"
  | "hook_invocation_limit_exceeded"
  | "hook_gate_denied"
  | "hook_gate_output_invalid"
  | "hook_invocation_approval_required"
  | "hook_invocation_timeout"
  | "hook_invocation_cancelled"
  | "hook_effect_unknown"
  | "hook_changed_original_precondition"
  | "hook_original_action_stale"
  | "hook_observer_degraded"
  | "hook_recursion_blocked";

export class HookError extends Error {
  override readonly name = "HookError";

  constructor(
    readonly code: HookErrorCode,
    message: string,
    readonly exitCode: 1 | 8 | 130 = code === "hook_invocation_cancelled" ? 130 : code === "hook_effect_unknown" ? 1 : 8,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
