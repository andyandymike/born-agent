import { canonicalJson } from "../completion/canonical-json.js";
import { selectEvalExitCode, type EvalExitCode } from "./eval-exit-code.js";

export interface EvalTaskCompatibility {
  readonly id: string;
  readonly taskVersion: number;
  readonly workspaceSha256: string;
  readonly graderSha256: string;
  readonly scenarioSchemaVersion: number;
  readonly scenarioKind: "single_run" | "scripted_v1";
  readonly scenarioSha256: string;
  readonly scenarioConfigSha256: string;
  readonly serviceSetSha256: string;
}

export interface EvalRunCompatibility {
  readonly suiteVersion: number;
  readonly tasks: readonly EvalTaskCompatibility[];
  readonly repetitionPolicySha256: string;
  readonly attemptInclusionRule: string;
  readonly reportSchemaVersion: number;
  readonly metricDefinitionVersion: number;
  readonly priceCurrency: "USD";
  readonly repetitions?: number;
}

export interface ComparableTaskResult {
  readonly taskId: string;
  readonly passed: boolean;
  readonly falseComplete: boolean;
  readonly solvedIncomplete: boolean;
  readonly safetyViolation: boolean;
}

export interface ComparableEvalRun {
  readonly compatibility: EvalRunCompatibility;
  readonly config: Readonly<Record<string, unknown>>;
  readonly tasks: readonly ComparableTaskResult[];
  readonly harnessInvalidCount: number;
  readonly reportCorrupt: boolean;
}

export interface EvalComparison {
  readonly compatible: boolean;
  readonly incompatibilities: readonly string[];
  readonly configDiff: readonly string[];
  readonly regressions: readonly string[];
  readonly exitCode: EvalExitCode;
  readonly statisticalClaim: null;
  readonly limitation: string;
}

function sortedTasks(tasks: readonly EvalTaskCompatibility[]): readonly EvalTaskCompatibility[] {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

function compatibilityDiff(
  baseline: EvalRunCompatibility,
  candidate: EvalRunCompatibility,
): readonly string[] {
  const checks: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["suiteVersion", baseline.suiteVersion, candidate.suiteVersion],
    ["tasks", sortedTasks(baseline.tasks), sortedTasks(candidate.tasks)],
    ["repetitionPolicySha256", baseline.repetitionPolicySha256, candidate.repetitionPolicySha256],
    ["attemptInclusionRule", baseline.attemptInclusionRule, candidate.attemptInclusionRule],
    ["reportSchemaVersion", baseline.reportSchemaVersion, candidate.reportSchemaVersion],
    ["metricDefinitionVersion", baseline.metricDefinitionVersion, candidate.metricDefinitionVersion],
    ["priceCurrency", baseline.priceCurrency, candidate.priceCurrency],
    ["repetitions", baseline.repetitions ?? null, candidate.repetitions ?? null],
  ];
  return checks
    .filter(([, left, right]) => canonicalJson(left) !== canonicalJson(right))
    .map(([field]) => field);
}

function configDiff(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): readonly string[] {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return keys.filter((key) => canonicalJson(baseline[key] ?? null) !== canonicalJson(candidate[key] ?? null));
}

export function compareEvalRuns(baseline: ComparableEvalRun, candidate: ComparableEvalRun): EvalComparison {
  const incompatibilities = compatibilityDiff(baseline.compatibility, candidate.compatibility);
  const corrupt = baseline.reportCorrupt || candidate.reportCorrupt;
  const invalid = baseline.harnessInvalidCount > 0 || candidate.harnessInvalidCount > 0;
  const regressions: string[] = [];
  if (incompatibilities.length === 0 && !corrupt && !invalid) {
    const candidateById = new Map(candidate.tasks.map((task) => [task.taskId, task]));
    for (const before of baseline.tasks) {
      const after = candidateById.get(before.taskId);
      if (after === undefined) {
        regressions.push(`missing_candidate_task:${before.taskId}`);
        continue;
      }
      if (before.passed && !after.passed) regressions.push(`pass_to_fail:${before.taskId}`);
      if (!before.falseComplete && after.falseComplete) regressions.push(`false_complete_increase:${before.taskId}`);
      if (after.safetyViolation) regressions.push(`safety_violation:${before.taskId}`);
    }
  }
  const exitFacts: EvalExitCode[] = [
    corrupt || invalid ? 1 : 0,
    incompatibilities.length > 0 ? 2 : 0,
    regressions.length > 0 ? 9 : 0,
  ];
  // PHASE14: a small task set supports descriptive paired deltas only; it cannot justify significance claims or a general model ranking.
  return Object.freeze({
    compatible: incompatibilities.length === 0,
    incompatibilities: Object.freeze(incompatibilities),
    configDiff: Object.freeze(configDiff(baseline.config, candidate.config)),
    regressions: Object.freeze(regressions.sort()),
    exitCode: selectEvalExitCode(exitFacts),
    statisticalClaim: null,
    limitation: "descriptive_only_no_statistical_significance_claim",
  });
}
