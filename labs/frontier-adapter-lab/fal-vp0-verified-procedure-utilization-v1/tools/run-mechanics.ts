import { resolve } from "node:path";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import { runFalVp0Mechanics } from "../src/mechanics-runner.js";

function readOption(argv: readonly string[], option: string): string | null {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = readOption(argv, "--mode");
  const output = readOption(argv, "--output");
  const known = new Set(["--mode", "--output"]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (option === undefined || !known.has(option)) throw new Error(`unknown option: ${option ?? "<missing>"}`);
  }
  if (mode !== "mechanics") {
    throw new Error("VP0a currently permits only --mode mechanics; provider-backed modes remain disabled");
  }
  if (output === null) throw new Error("--output is required and must name a new directory");
  const summary = await runFalVp0Mechanics({
    outputDirectory: resolve(output),
    repositoryRoot: process.cwd(),
  });
  process.stdout.write(`${canonicalJson({
    actorLane: summary.actorLane,
    actorPreflightStatus: summary.actorPreflightStatus,
    canaryClassesPassed: summary.canaryResults.filter((entry) => entry.passed).length,
    canaryVariantsPassed: summary.canaryResults.filter((entry) => entry.passed).length * 2,
    mechanicsSummarySha256: summary.summarySha256,
    providerCalls: summary.providerCalls,
    qualityRunStatus: summary.qualityRunStatus,
    status: summary.status,
  })}\n`);
}

await main();
