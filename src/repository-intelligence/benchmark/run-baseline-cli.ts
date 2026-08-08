import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../completion/canonical-json.js";
import { RepositoryIntelligenceError } from "../repository-intelligence-error.js";
import { RepositoryBenchmarkReportStore } from "./benchmark-report-store.js";
import { runRepositoryBenchmark } from "./benchmark-runner.js";

export async function runRepositoryBaselineCli(
  argv: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  const unknown = argv.filter((argument) => argument !== "--smoke");
  if (unknown.length > 0) {
    process.stderr.write(`unknown repository baseline option: ${unknown[0]}\n`);
    return 2;
  }
  try {
    const report = await runRepositoryBenchmark({
      mode: argv.includes("--smoke") ? "smoke" : "full",
      suitePath: resolve(cwd, "evals/repository-intelligence/suite-v1.json"),
    });
    const store = new RepositoryBenchmarkReportStore(
      resolve(cwd, ".bornagent/evals/repository-intelligence"),
    );
    const path = await store.write(report);
    process.stdout.write(`${canonicalJson({ metrics: report.metrics, path, report: report.runId })}\n`);
    return 0;
  } catch (error) {
    const exitCode = error instanceof RepositoryIntelligenceError ? error.exitCode : 1;
    const code = error instanceof RepositoryIntelligenceError ? error.code : "repository_benchmark_harness_invalid";
    process.stderr.write(`${canonicalJson({ code, error: "repository baseline failed" })}\n`);
    return exitCode;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await runRepositoryBaselineCli(process.argv.slice(2));
}
