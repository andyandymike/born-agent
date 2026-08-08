import { mkdir, open, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { createTypeScriptEngineIdentity } from "../engine-identity.js";
import { RepositoryIntelligenceError } from "../repository-intelligence-error.js";
import { compareRepositoryBenchmarkReports } from "./benchmark-comparator.js";
import { createRepositoryEngineDecision } from "./engine-decision-schema.js";
import { LegacyScanAdapter } from "./legacy-scan-adapter.js";
import { RepositoryBenchmarkReportStore } from "./benchmark-report-store.js";
import { runRepositoryBenchmark } from "./benchmark-runner.js";
import {
  TypeScriptSemanticCandidateAdapter,
  TypeScriptSyntacticCandidateAdapter,
} from "./typescript-candidate-adapter.js";

async function writeDecision(path: string, decision: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(decision)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function correctnessGate(report: Awaited<ReturnType<typeof runRepositoryBenchmark>>, noRegression: boolean): boolean {
  return (
    noRegression &&
    (report.metrics.definitionTop1 ?? 0) >= 0.95 &&
    (report.metrics.referencePrecision ?? 0) >= 0.95 &&
    (report.metrics.referenceRecall ?? 0) >= 0.9 &&
    report.metrics.harnessInvalidCount === 0
  );
}

export async function runRepositoryCandidatesCli(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  const accepted = new Set(["--smoke", "--write-decision"]);
  const unknown = argv.find((argument) => !accepted.has(argument));
  if (unknown !== undefined) {
    process.stderr.write(`unknown repository candidate option: ${unknown}\n`);
    return 2;
  }
  try {
    const mode = argv.includes("--smoke") ? "smoke" as const : "full" as const;
    const suitePath = resolve(cwd, "evals/repository-intelligence/suite-v1.json");
    const store = new RepositoryBenchmarkReportStore(resolve(cwd, ".bornagent/evals/repository-intelligence"));
    const [baseline, syntactic, semantic] = await Promise.all([
      runRepositoryBenchmark({ adapter: new LegacyScanAdapter(), mode, runId: `legacy-${mode}-${Date.now()}`, suitePath }),
      runRepositoryBenchmark({ adapter: new TypeScriptSyntacticCandidateAdapter(), mode, runId: `typescript-syntactic-${mode}-${Date.now()}`, suitePath }),
      runRepositoryBenchmark({ adapter: new TypeScriptSemanticCandidateAdapter(), mode, runId: `typescript-semantic-${mode}-${Date.now()}`, suitePath }),
    ]);
    const paths = await Promise.all([store.write(baseline), store.write(syntactic), store.write(semantic)]);
    const syntacticComparison = compareRepositoryBenchmarkReports(baseline, syntactic);
    const semanticComparison = compareRepositoryBenchmarkReports(baseline, semantic);
    const contextReductionGatePassed =
      semanticComparison.contextReductionRatio !== null && semanticComparison.contextReductionRatio <= 0.7;
    const correctnessGatePassed = correctnessGate(semantic, semanticComparison.exitCode === 0);
    const freshnessGatePassed =
      semantic.metrics.staleFalseNegativeCount === 0 &&
      semantic.attempts.filter((attempt) => attempt.category === "freshness").every((attempt) =>
        attempt.grading.falseNegatives === 0 && attempt.grading.falsePositives === 0 && attempt.grading.confirmedAbsenceCorrect,
      );
    const securityGatePassed =
      semantic.metrics.ruleScopeAccuracy === 1 &&
      semantic.attempts.every((attempt) => attempt.status === "completed") &&
      semantic.remoteExecution === "not_run_by_policy";
    const decision = createRepositoryEngineDecision({
      baselineReportSha256: sha256Canonical(baseline),
      candidateReportSha256: sha256Canonical(semantic),
      contextReductionGatePassed,
      correctnessGatePassed,
      engineIdentity: createTypeScriptEngineIdentity(),
      freshnessGatePassed,
      securityGatePassed,
      suiteSha256: semantic.suiteSha256,
    });
    if (argv.includes("--write-decision")) {
      if (mode !== "full") throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", "smoke reports cannot publish an engine decision", 2);
      await writeDecision(resolve(cwd, "policies/repository-intelligence/engine-v1.json"), decision);
    }
    process.stdout.write(`${canonicalJson({
      baseline: { metrics: baseline.metrics, path: paths[0], sha256: sha256Canonical(baseline) },
      decision,
      semantic: { comparison: semanticComparison, metrics: semantic.metrics, path: paths[2], sha256: sha256Canonical(semantic) },
      syntactic: { comparison: syntacticComparison, metrics: syntactic.metrics, path: paths[1], sha256: sha256Canonical(syntactic) },
    })}\n`);
    return decision.status === "accepted" ? 0 : 9;
  } catch (error) {
    const exitCode = error instanceof RepositoryIntelligenceError ? error.exitCode : 1;
    const code = error instanceof RepositoryIntelligenceError ? error.code : "repository_benchmark_harness_invalid";
    process.stderr.write(`${canonicalJson({ code, error: "repository candidate evaluation failed" })}\n`);
    return exitCode;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runRepositoryCandidatesCli(process.argv.slice(2));
}
