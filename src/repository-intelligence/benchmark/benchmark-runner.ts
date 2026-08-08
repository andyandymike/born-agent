import { cp, mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { RepositoryIntelligenceError } from "../repository-intelligence-error.js";
import {
  loadHiddenExpected,
  loadRepositoryBenchmarkSuite,
  loadVisibleQuery,
  resolveBenchmarkRef,
  type RepositoryHiddenExpected,
} from "./benchmark-schema.js";
import { calculateRepositoryBenchmarkMetrics } from "./benchmark-metrics.js";
import {
  repositoryBenchmarkAttemptSchema,
  repositoryBenchmarkReportSchema,
  type RepositoryBenchmarkAttempt,
  type RepositoryBenchmarkReportV1,
} from "./benchmark-report-schema.js";
import { benchmarkWorkspaceSha256 } from "./benchmark-workspace.js";
import type { RepositoryBenchmarkAdapter } from "./benchmark-adapter.js";
import { LegacyScanAdapter } from "./legacy-scan-adapter.js";

function matchCandidate(
  actual: { readonly path: string; readonly line: number | null; readonly column: number | null },
  expected: RepositoryHiddenExpected["expected"][number],
): boolean {
  return (
    actual.path === expected.path &&
    (expected.line === null || actual.line === expected.line) &&
    (expected.column === null || actual.column === expected.column)
  );
}

function grade(
  attempt: Omit<RepositoryBenchmarkAttempt, "grading">,
  expected: RepositoryHiddenExpected,
): RepositoryBenchmarkAttempt["grading"] {
  const unmatched = new Set(expected.expected.map((_, index) => index));
  let truePositives = 0;
  let falsePositives = 0;
  for (const candidate of attempt.candidates) {
    const expectedIndex = [...unmatched].find((index) => matchCandidate(candidate, expected.expected[index]!));
    if (expectedIndex === undefined) falsePositives += 1;
    else {
      truePositives += 1;
      unmatched.delete(expectedIndex);
    }
  }
  return Object.freeze({
    confirmedAbsenceCorrect: attempt.confirmedAbsent === expected.confirmedAbsent,
    falseNegatives: unmatched.size,
    falsePositives,
    top1Correct:
      expected.expected.length === 0
        ? attempt.confirmedAbsent === expected.confirmedAbsent
        : attempt.candidates[0] !== undefined && expected.expected.some((candidate) => matchCandidate(attempt.candidates[0]!, candidate)),
    top5Correct:
      expected.expected.length === 0
        ? attempt.confirmedAbsent === expected.confirmedAbsent
        : attempt.candidates.slice(0, 5).some((actual) => expected.expected.some((candidate) => matchCandidate(actual, candidate))),
    truePositives,
  });
}

function environmentFingerprint(): string {
  return sha256Canonical({
    architecture: process.arch,
    cpuLogicalCount: globalThis.navigator?.hardwareConcurrency ?? null,
    node: process.version,
    platform: process.platform,
  });
}

export interface RepositoryBenchmarkRunOptions {
  readonly adapter?: RepositoryBenchmarkAdapter;
  readonly mode: "full" | "smoke";
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly suitePath: string;
}

export async function runRepositoryBenchmark(
  options: RepositoryBenchmarkRunOptions,
): Promise<RepositoryBenchmarkReportV1> {
  const loaded = await loadRepositoryBenchmarkSuite(options.suitePath);
  const selected =
    options.mode === "smoke"
      ? loaded.suite.cases.filter((entry) => loaded.suite.smokeCaseIds.includes(entry.id))
      : loaded.suite.cases;
  const adapter = options.adapter ?? new LegacyScanAdapter();
  const attempts: RepositoryBenchmarkAttempt[] = [];
  const externalSignal = options.signal ?? new AbortController().signal;

  for (const entry of selected) {
    if (externalSignal.aborted) {
      throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", "benchmark was cancelled", 130);
    }
    const sourceWorkspace = resolveBenchmarkRef(loaded.root, entry.workspaceRef);
    if ((await benchmarkWorkspaceSha256(sourceWorkspace)) !== entry.workspaceSha256) {
      throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", `workspace hash mismatch for ${entry.id}`);
    }
    const visiblePath = resolveBenchmarkRef(loaded.root, entry.visibleQueryRef);
    const hiddenPath = resolveBenchmarkRef(loaded.root, entry.hiddenExpectedRef);
    // PHASE17: hidden gold is opened only by this supervisor path. It is never copied into the
    // candidate workspace, tool result, model context, or durable session observation.
    const [visible, expected] = await Promise.all([
      loadVisibleQuery(visiblePath),
      loadHiddenExpected(hiddenPath, entry.id),
    ]);
    if (visible.requestKind !== entry.category) {
      throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", `category mismatch for ${entry.id}`);
    }
    const temporary = await mkdtemp(join(tmpdir(), "bornagent-repository-benchmark-"));
    try {
      const workspace = join(temporary, "workspace");
      await cp(sourceWorkspace, workspace, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
      const controller = new AbortController();
      const onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("benchmark case timeout")), entry.limits.timeoutMs);
      try {
        const observed = await adapter.run(entry.id, entry.category, workspace, visible, controller.signal);
        if (observed.attempt.observationBytes > entry.limits.maxObservationBytes) {
          throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", `observation budget exceeded for ${entry.id}`);
        }
        attempts.push(repositoryBenchmarkAttemptSchema.parse({ ...observed.attempt, grading: grade(observed.attempt, expected) }));
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener("abort", onAbort);
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  const sourceCorpusSha256 = createHash("sha256")
    .update(canonicalJson(loaded.suite.cases.map((entry) => ({ id: entry.id, version: entry.version, workspaceSha256: entry.workspaceSha256 }))), "utf8")
    .digest("hex");
  // PHASE17: this is model-free retrieval evidence. A fake/in-process integration run cannot be
  // promoted to model quality, and no provider or credential path is constructed here.
  return repositoryBenchmarkReportSchema.parse({
    attempts,
    engineIdentitySha256: sha256Canonical(adapter.identity),
    environmentFingerprint: environmentFingerprint(),
    metrics: calculateRepositoryBenchmarkMetrics(attempts, selected.length),
    modelFreeRetrieval: true,
    modelQualityEvidence: "not_measured",
    remoteExecution: "not_run_by_policy",
    runId: options.runId ?? `repo-${randomUUID()}`,
    schemaVersion: 1,
    sourceCorpusSha256,
    suiteId: loaded.suite.id,
    suiteSha256: loaded.suiteSha256,
    suiteVersion: loaded.suite.suiteVersion,
  });
}
