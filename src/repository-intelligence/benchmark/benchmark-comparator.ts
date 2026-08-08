import { sha256Canonical } from "../../completion/canonical-json.js";
import { RepositoryIntelligenceError } from "../repository-intelligence-error.js";
import { repositoryBenchmarkReportSchema, type RepositoryBenchmarkReportV1 } from "./benchmark-report-schema.js";

export interface RepositoryBenchmarkComparison {
  readonly baselineSha256: string;
  readonly candidateSha256: string;
  readonly compatible: true;
  readonly contextReductionRatio: number | null;
  readonly exitCode: 0 | 9;
  readonly regressions: readonly string[];
}

export function compareRepositoryBenchmarkReports(
  baselineInput: unknown,
  candidateInput: unknown,
): RepositoryBenchmarkComparison {
  let baseline: RepositoryBenchmarkReportV1;
  let candidate: RepositoryBenchmarkReportV1;
  try {
    baseline = repositoryBenchmarkReportSchema.parse(baselineInput);
    candidate = repositoryBenchmarkReportSchema.parse(candidateInput);
  } catch (error) {
    throw new RepositoryIntelligenceError("repository_benchmark_incompatible", "benchmark report failed strict validation", 1, { cause: error });
  }
  if (
    baseline.suiteId !== candidate.suiteId ||
    baseline.suiteVersion !== candidate.suiteVersion ||
    baseline.suiteSha256 !== candidate.suiteSha256 ||
    baseline.sourceCorpusSha256 !== candidate.sourceCorpusSha256
  ) {
    throw new RepositoryIntelligenceError("repository_benchmark_incompatible", "benchmark reports use incompatible suites", 1);
  }
  const regressions: string[] = [];
  const pairs = [
    ["definition_top1", baseline.metrics.definitionTop1, candidate.metrics.definitionTop1],
    ["definition_top5", baseline.metrics.definitionTop5, candidate.metrics.definitionTop5],
    ["reference_precision", baseline.metrics.referencePrecision, candidate.metrics.referencePrecision],
    ["reference_recall", baseline.metrics.referenceRecall, candidate.metrics.referenceRecall],
    ["outline_precision", baseline.metrics.outlinePrecision, candidate.metrics.outlinePrecision],
    ["outline_recall", baseline.metrics.outlineRecall, candidate.metrics.outlineRecall],
  ] as const;
  for (const [name, baselineValue, candidateValue] of pairs) {
    if (baselineValue !== null && (candidateValue === null || candidateValue < baselineValue)) regressions.push(name);
  }
  if (candidate.metrics.harnessInvalidCount > 0) regressions.push("harness_invalid");
  const contextReductionRatio =
    baseline.metrics.observationBytesMedian === null ||
    candidate.metrics.observationBytesMedian === null ||
    baseline.metrics.observationBytesMedian === 0
      ? null
      : candidate.metrics.observationBytesMedian / baseline.metrics.observationBytesMedian;
  // PHASE17: wall-clock values remain machine-bound evidence and are intentionally excluded from
  // regression authority when the environment fingerprint differs.
  return Object.freeze({
    baselineSha256: sha256Canonical(baseline),
    candidateSha256: sha256Canonical(candidate),
    compatible: true as const,
    contextReductionRatio,
    exitCode: regressions.length === 0 ? 0 : 9,
    regressions: Object.freeze(regressions),
  });
}
