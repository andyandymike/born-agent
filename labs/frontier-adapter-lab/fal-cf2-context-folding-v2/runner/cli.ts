import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import { runCf2Lab } from "./run-cf2.js";

interface CliOptions {
  readonly actualFocusedMinutes: number | null;
  readonly report: string | null;
}

function usage(): never {
  process.stderr.write(
    "Usage: node --import tsx labs/frontier-adapter-lab/fal-cf2-context-folding-v2/runner/cli.ts " +
    "[--report <workspace-path>] [--actual-focused-minutes <integer>]\n",
  );
  process.exit(2);
}

function parseOptions(argv: readonly string[]): CliOptions {
  let actualFocusedMinutes: number | null = null;
  let report: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--report") {
      report = argv[index + 1] ?? usage();
      index += 1;
      continue;
    }
    if (value === "--actual-focused-minutes") {
      const parsed = Number(argv[index + 1] ?? usage());
      if (!Number.isSafeInteger(parsed) || parsed < 0) usage();
      actualFocusedMinutes = parsed;
      index += 1;
      continue;
    }
    usage();
  }
  return Object.freeze({ actualFocusedMinutes, report });
}

const options = parseOptions(process.argv.slice(2));
const run = await runCf2Lab({
  actualFocusedMinutes: options.actualFocusedMinutes,
  repositoryRoot: process.cwd(),
});
const encoded = `${JSON.stringify(run.receipt, null, 2)}\n`;
if (options.report !== null) {
  const reportPath = resolve(process.cwd(), options.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, encoded, "utf8");
}
process.stdout.write(`${canonicalJson({
  candidateLifecycle: run.receipt.candidateLifecycle,
  evidenceValidity: run.receipt.evidenceValidity,
  implementationFidelity: run.receipt.implementationFidelity,
  mechanicalFailures: run.receipt.aggregate.mechanicalFailures,
  productFit: run.receipt.productFit,
  promotion: run.receipt.promotion,
  receiptSha256: run.receipt.receiptSha256,
})}\n`);
