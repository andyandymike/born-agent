export type AttemptPrimaryCategory =
  | "harness"
  | "environment"
  | "provider"
  | "permission"
  | "tool"
  | "context"
  | "completion"
  | "model";

export type AttemptQuadrant =
  | "completed_solved"
  | "completed_unsolved"
  | "incomplete_solved"
  | "incomplete_unsolved";

export interface AttemptOutcome {
  readonly agentCompleted: boolean;
  readonly pathPolicyPassed: boolean;
  readonly gradersPassed: boolean;
  readonly solutionPassed: boolean;
  readonly taskPassed: boolean;
  readonly falseComplete: boolean;
  readonly solvedIncomplete: boolean;
  readonly safetyViolation: boolean;
  readonly quadrant: AttemptQuadrant;
}

export interface AttemptFailureEvidence {
  readonly harness?: boolean;
  readonly environment?: boolean;
  readonly provider?: boolean;
  readonly permission?: boolean;
  readonly tool?: boolean;
  readonly context?: boolean;
  readonly completion?: boolean;
  readonly secondaryCodes?: readonly string[];
}

export interface ClassifiedAttempt {
  readonly validAttempt: boolean;
  readonly outcome: AttemptOutcome;
  readonly primaryCategory: AttemptPrimaryCategory | null;
  readonly secondaryCodes: readonly string[];
}

const PRIMARY_PRIORITY: readonly AttemptPrimaryCategory[] = [
  "harness",
  "environment",
  "provider",
  "permission",
  "tool",
  "context",
  "completion",
  "model",
];

export function computeAttemptOutcome(input: {
  readonly agentCompleted: boolean;
  readonly pathPolicyPassed: boolean;
  readonly gradersPassed: boolean;
  readonly safetyViolation: boolean;
}): AttemptOutcome {
  const solutionPassed = input.pathPolicyPassed && input.gradersPassed;
  const quadrant: AttemptQuadrant = input.agentCompleted
    ? solutionPassed
      ? "completed_solved"
      : "completed_unsolved"
    : solutionPassed
      ? "incomplete_solved"
      : "incomplete_unsolved";
  // PHASE14: grader success and Agent completion remain separate so false-complete and solved-incomplete reliability failures cannot disappear.
  return Object.freeze({
    ...input,
    solutionPassed,
    taskPassed: solutionPassed && input.agentCompleted && !input.safetyViolation,
    falseComplete: input.agentCompleted && !solutionPassed,
    solvedIncomplete: solutionPassed && !input.agentCompleted,
    quadrant,
  });
}

export function classifyAttempt(
  outcomeInput: Parameters<typeof computeAttemptOutcome>[0],
  evidence: AttemptFailureEvidence,
): ClassifiedAttempt {
  const outcome = computeAttemptOutcome(outcomeInput);
  let primaryCategory: AttemptPrimaryCategory | null = null;
  if (!outcome.taskPassed) {
    // PHASE14: a fixed evidence priority makes operational categories comparable; reviewers may annotate but cannot rewrite the observed cause.
    primaryCategory = PRIMARY_PRIORITY.find((category) =>
      category === "model"
        ? true
        : category === "completion"
          ? evidence.completion === true || outcome.solvedIncomplete
          : evidence[category] === true,
    ) ?? "model";
  }
  return Object.freeze({
    validAttempt: evidence.harness !== true,
    outcome,
    primaryCategory,
    secondaryCodes: Object.freeze([...new Set(evidence.secondaryCodes ?? [])].sort()),
  });
}
