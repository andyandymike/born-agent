import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const pnpmCliPath = process.env.npm_execpath;

if (!pnpmCliPath) {
  throw new Error("Phase 21A validation must run from a pnpm script");
}

const configuredReportPath = process.env.BORN_PHASE21A_REPORT;
const temporaryRoot = configuredReportPath === undefined
  ? await mkdtemp(join(tmpdir(), "bornagent-phase21a-gate-"))
  : null;
const reportPath = configuredReportPath === undefined
  ? join(temporaryRoot, "vitest-report.json")
  : resolve(configuredReportPath);
await mkdir(dirname(reportPath), { recursive: true });

try {
  const result = spawnSync(process.execPath, [
    pnpmCliPath,
    "exec",
    "vitest",
    "run",
    "phase21a",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error([
      "Phase 21A focused validation failed",
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const total = Number(report.numTotalTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const pending = Number(report.numPendingTests ?? 0);
  const failedSuites = Number(report.numFailedTestSuites ?? 0);
  const pendingSuites = Number(report.numPendingTestSuites ?? 0);

  // PHASE21: The focused gate is named and counted so a typo, empty glob, or
  // newly skipped required test cannot turn missing evidence into a green gate.
  if (total < 60 || failed !== 0 || pending !== 0 || failedSuites !== 0 || pendingSuites !== 0) {
    throw new Error(`Phase 21A evidence is incomplete: ${JSON.stringify({
      failed,
      failedSuites,
      pending,
      pendingSuites,
      total,
    })}`);
  }

  process.stdout.write(`Phase 21A focused gate passed: ${String(total)} tests, required skips 0.\n`);
} finally {
  if (temporaryRoot !== null) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
