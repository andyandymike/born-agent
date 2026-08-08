import { describe, expect, it } from "vitest";

import { calculateRepositoryBenchmarkMetrics } from "../../src/repository-intelligence/benchmark/benchmark-metrics.js";
import type { RepositoryBenchmarkAttempt } from "../../src/repository-intelligence/benchmark/benchmark-report-schema.js";

function attempt(
  category: RepositoryBenchmarkAttempt["category"],
  grading: RepositoryBenchmarkAttempt["grading"],
  observationBytes: number,
): RepositoryBenchmarkAttempt {
  return {
    candidates: [],
    caseId: `${category}-${observationBytes}`,
    category,
    confirmedAbsent: false,
    coverage: "complete",
    durationMs: 1,
    errorCode: null,
    evidenceLevel: "textual_fallback",
    grading,
    observationBytes,
    sourceBytesScanned: null,
    status: "completed",
    toolCalls: [],
  };
}

describe("Phase 17A benchmark metrics", () => {
  it("includes zero-result/partial cases in denominators and keeps null distinct from zero", () => {
    const attempts = [
      attempt("definition", { confirmedAbsenceCorrect: true, falseNegatives: 0, falsePositives: 0, top1Correct: true, top5Correct: true, truePositives: 1 }, 10),
      attempt("definition", { confirmedAbsenceCorrect: false, falseNegatives: 1, falsePositives: 0, top1Correct: false, top5Correct: false, truePositives: 0 }, 20),
      attempt("references", { confirmedAbsenceCorrect: true, falseNegatives: 1, falsePositives: 1, top1Correct: false, top5Correct: true, truePositives: 1 }, 30),
    ];
    const metrics = calculateRepositoryBenchmarkMetrics(attempts, 4);
    expect(metrics).toMatchObject({
      definitionTop1: 0.5,
      definitionTop5: 0.5,
      harnessInvalidCount: 1,
      observationBytesMedian: 20,
      observationBytesP95: 30,
      outlinePrecision: null,
      referenceF1: 0.5,
      referencePrecision: 0.5,
      referenceRecall: 0.5,
    });
  });
});
