export type EvalCoreErrorCode =
  | "eval_agent_driver_invalid"
  | "eval_case_protocol_invalid"
  | "eval_cli_invalid"
  | "eval_compare_incompatible"
  | "eval_full_suite_forbidden"
  | "eval_harness_invariant"
  | "eval_hidden_grader_invalid"
  | "eval_manifest_invalid"
  | "eval_no_cost_source_forbidden"
  | "eval_observation_invalid"
  | "eval_report_corrupt"
  | "eval_scenario_invalid"
  | "eval_service_unknown"
  | "eval_storage_failed"
  | "eval_workspace_invalid";

export class EvalCoreError extends Error {
  public constructor(
    public readonly code: EvalCoreErrorCode,
    message: string,
    public readonly exitCode: 1 | 2,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "EvalCoreError";
  }
}

export function evalHarnessInvariant(message: string): EvalCoreError {
  return new EvalCoreError("eval_harness_invariant", message, 1);
}
