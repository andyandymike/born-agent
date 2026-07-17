export type UsageCompleteness = "complete" | "partial" | "none";

export interface ReportedTokenUsage {
  readonly completeness: UsageCompleteness;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
}

export interface DistributionMetric {
  readonly scheduledN: number;
  readonly observedN: number;
  readonly median: number | null;
  readonly p95: number | null;
}

export interface EvalAttemptMetricRow {
  readonly status: "valid" | "harness_invalid" | "cancelled" | "missing";
  readonly taskPassed: boolean | null;
  readonly falseComplete: boolean | null;
  readonly solvedIncomplete: boolean | null;
  readonly safetyViolation: boolean | null;
}

export interface EvalDenominators {
  readonly scheduled: number;
  readonly valid: number;
  readonly harnessInvalid: number;
  readonly cancelled: number;
  readonly missing: number;
  readonly taskPasses: number;
  readonly taskPassDenominator: number;
  readonly falseCompletes: number;
  readonly solvedIncomplete: number;
  readonly safetyViolations: number;
}

function sumKnown(rows: readonly ReportedTokenUsage[], field: keyof Omit<ReportedTokenUsage, "completeness">): number | null {
  const values = rows.map((row) => row[field]);
  return values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

export function aggregateReportedUsage(rows: readonly ReportedTokenUsage[]): ReportedTokenUsage {
  const completeness: UsageCompleteness =
    rows.length === 0 || rows.every((row) => row.completeness === "none")
      ? "none"
      : rows.every((row) => row.completeness === "complete")
        ? "complete"
        : "partial";
  // PHASE14: reported usage, estimates, and billing are different evidence; missing tokens and local cost stay null rather than becoming a fictitious zero.
  return Object.freeze({
    completeness,
    inputTokens: sumKnown(rows, "inputTokens"),
    outputTokens: sumKnown(rows, "outputTokens"),
    cacheReadTokens: sumKnown(rows, "cacheReadTokens"),
    cacheWriteTokens: sumKnown(rows, "cacheWriteTokens"),
    reasoningTokens: sumKnown(rows, "reasoningTokens"),
    totalTokens: sumKnown(rows, "totalTokens"),
  });
}

export function summarizeDistribution(values: readonly (number | null)[]): DistributionMetric {
  const observed = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (observed.length === 0) {
    return Object.freeze({ scheduledN: values.length, observedN: 0, median: null, p95: null });
  }
  const middle = Math.floor(observed.length / 2);
  const median =
    observed.length % 2 === 0
      ? ((observed[middle - 1] ?? 0) + (observed[middle] ?? 0)) / 2
      : (observed[middle] ?? null);
  const p95Index = Math.max(0, Math.ceil(observed.length * 0.95) - 1);
  return Object.freeze({
    scheduledN: values.length,
    observedN: observed.length,
    median,
    p95: observed[p95Index] ?? null,
  });
}

export function aggregateEvalDenominators(rows: readonly EvalAttemptMetricRow[]): EvalDenominators {
  const valid = rows.filter((row) => row.status === "valid");
  // PHASE14: scheduled, valid, and harness-invalid denominators are all visible so broken harness rows cannot improve the displayed pass rate.
  return Object.freeze({
    scheduled: rows.length,
    valid: valid.length,
    harnessInvalid: rows.filter((row) => row.status === "harness_invalid").length,
    cancelled: rows.filter((row) => row.status === "cancelled").length,
    missing: rows.filter((row) => row.status === "missing").length,
    taskPasses: valid.filter((row) => row.taskPassed === true).length,
    taskPassDenominator: valid.length,
    falseCompletes: valid.filter((row) => row.falseComplete === true).length,
    solvedIncomplete: valid.filter((row) => row.solvedIncomplete === true).length,
    safetyViolations: valid.filter((row) => row.safetyViolation === true).length,
  });
}
