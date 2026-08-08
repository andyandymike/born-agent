import type { RepositoryBenchmarkAttempt, RepositoryBenchmarkMetrics } from "./benchmark-report-schema.js";

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function precisionRecall(attempts: readonly RepositoryBenchmarkAttempt[]): {
  readonly precision: number | null;
  readonly recall: number | null;
} {
  const counts = attempts.reduce(
    (total, attempt) => ({
      fn: total.fn + attempt.grading.falseNegatives,
      fp: total.fp + attempt.grading.falsePositives,
      tp: total.tp + attempt.grading.truePositives,
    }),
    { fn: 0, fp: 0, tp: 0 },
  );
  return {
    precision: ratio(counts.tp, counts.tp + counts.fp),
    recall: ratio(counts.tp, counts.tp + counts.fn),
  };
}

export function calculateRepositoryBenchmarkMetrics(
  attempts: readonly RepositoryBenchmarkAttempt[],
  scheduledAttempts = attempts.length,
): RepositoryBenchmarkMetrics {
  const definition = attempts.filter((attempt) => attempt.category === "definition");
  const references = precisionRecall(attempts.filter((attempt) => attempt.category === "references"));
  const outline = precisionRecall(attempts.filter((attempt) => attempt.category === "outline"));
  const ruleAttempts = attempts.filter((attempt) => attempt.category === "rules");
  // Every scheduled case contributes: an incorrect positive absence claim is as meaningful as
  // failing to confirm a gold absence, including partial/zero-result attempts.
  const absenceAttempts = attempts;
  const bytes = attempts.map((attempt) => attempt.observationBytes);
  const referenceF1 =
    references.precision === null || references.recall === null || references.precision + references.recall === 0
      ? references.precision === 0 && references.recall === 0
        ? 0
        : null
      : (2 * references.precision * references.recall) / (references.precision + references.recall);
  return Object.freeze({
    confirmedAbsenceAccuracy: ratio(
      absenceAttempts.filter((attempt) => attempt.grading.confirmedAbsenceCorrect).length,
      absenceAttempts.length,
    ),
    definitionTop1: ratio(definition.filter((attempt) => attempt.grading.top1Correct).length, definition.length),
    definitionTop5: ratio(definition.filter((attempt) => attempt.grading.top5Correct).length, definition.length),
    harnessInvalidCount: Math.max(0, scheduledAttempts - attempts.length),
    observationBytesMedian: percentile(bytes, 0.5),
    observationBytesP95: percentile(bytes, 0.95),
    observationBytesTotal: bytes.reduce((total, value) => total + value, 0),
    outlinePrecision: outline.precision,
    outlineRecall: outline.recall,
    referenceF1,
    referencePrecision: references.precision,
    referenceRecall: references.recall,
    ruleScopeAccuracy: ratio(
      ruleAttempts.filter((attempt) => attempt.grading.top1Correct).length,
      ruleAttempts.length,
    ),
    scheduledAttempts,
    staleFalseNegativeCount: attempts
      .filter((attempt) => attempt.category === "freshness")
      .reduce((total, attempt) => total + attempt.grading.falseNegatives, 0),
    toolCalls: attempts.reduce((total, attempt) => total + attempt.toolCalls.length, 0),
  });
}
