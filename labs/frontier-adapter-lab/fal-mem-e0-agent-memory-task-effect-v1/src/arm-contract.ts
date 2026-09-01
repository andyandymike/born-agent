import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

const SUCCESS_TOOL_SEQUENCE = Object.freeze([
  "read_file",
  "apply_patch",
  "run_command",
  "finish_task",
] as const);
const SUCCESS_DECISION_COUNTS = Object.freeze({
  emit_finish_task: 1,
  emit_patch: 1,
  emit_public_verifier: 1,
  emit_read_file: 1,
});
const FAIL_CLOSED_DECISION_COUNTS = Object.freeze({ fail_closed_memory_missing: 1 });

export interface MemE0ArmContractObservation {
  readonly agentExitCode: number;
  readonly approvalObservationSha256s: readonly string[];
  readonly canonicalContextSha256s: readonly string[];
  readonly decisionCounts: Readonly<Record<string, number>>;
  readonly orchestrationFailure: boolean;
  readonly toolArgumentSha256s: readonly string[];
  readonly toolNames: readonly string[];
}

export interface MemE0ArmContractInput {
  readonly changedPathsExact: boolean;
  readonly expectsSuccessfulEffect: boolean;
  readonly hiddenVerifierPassed: boolean;
  readonly observation: MemE0ArmContractObservation;
  readonly publicVerifierPassed: boolean;
  readonly workspaceUnchanged: boolean;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

export function observeMemE0ArmContract(
  input: MemE0ArmContractInput,
): boolean {
  const observation = input.observation;
  if (observation.orchestrationFailure) return false;
  if (!input.expectsSuccessfulEffect) {
    return observation.agentExitCode !== 0 &&
      canonicalEqual(observation.decisionCounts, FAIL_CLOSED_DECISION_COUNTS) &&
      observation.toolNames.length === 0 &&
      observation.toolArgumentSha256s.length === 0 &&
      observation.approvalObservationSha256s.length === 0 &&
      input.workspaceUnchanged &&
      !input.hiddenVerifierPassed;
  }
  return observation.agentExitCode === 0 &&
    canonicalEqual(observation.decisionCounts, SUCCESS_DECISION_COUNTS) &&
    canonicalEqual(observation.toolNames, SUCCESS_TOOL_SEQUENCE) &&
    observation.toolArgumentSha256s.length === 4 &&
    new Set(observation.toolArgumentSha256s).size === 4 &&
    observation.approvalObservationSha256s.length === 2 &&
    observation.canonicalContextSha256s.length === 4 &&
    input.changedPathsExact &&
    input.publicVerifierPassed &&
    input.hiddenVerifierPassed;
}
