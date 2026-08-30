import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { benchmarkSplits, type BenchmarkSplit } from "../src/benchmark-schema.js";
import { runSharedDeepSeekReaderWorker } from "../src/deepseek-reader-worker.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

function integerArgument(name: string, minimum: number, maximum: number): number {
  const value = Number(requiredArgument(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function absoluteFromRoot(repositoryRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}

const repositoryRoot = resolve(process.cwd());
const splitValue = requiredArgument("--split");
if (!benchmarkSplits.includes(splitValue as BenchmarkSplit) || splitValue === "evaluation") {
  throw new Error(`DeepSeek reader split must be public development or calibration: ${splitValue}`);
}
const split = splitValue as BenchmarkSplit;
const threshold = integerArgument("--threshold-micros", -1_000_000, 1_000_001);
const thresholdRoleValue = requiredArgument("--threshold-role");
if (thresholdRoleValue !== "eligible_operating_point" && thresholdRoleValue !== "diagnostic_only") {
  throw new Error("reader threshold role is invalid");
}
const observationPath = absoluteFromRoot(repositoryRoot, requiredArgument("--retrieval-observation"));
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const maxApiCalls = integerArgument("--max-api-calls", 1, 96);
const maxEstimatedCostUsdMicros = integerArgument(
  "--max-cost-usd-micros",
  1,
  10_000_000,
);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (apiKey === undefined) {
  throw new Error("DEEPSEEK_API_KEY is not visible to the current process");
}
const result = await runSharedDeepSeekReaderWorker({
  apiKey,
  generatedAt: new Date().toISOString(),
  maxApiCalls,
  maxEstimatedCostUsdMicros,
  observationInput: parseStrictJson(await readFile(observationPath, "utf8")),
  onProgress: (progress) => {
    process.stdout.write(`${JSON.stringify({ event: "deepseek_reader_arm_complete", ...progress })}\n`);
  },
  repositoryRoot,
  split,
  thresholdRole: thresholdRoleValue,
  thresholdSimilarityMicros: threshold,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(result), "utf8");
const actualCostUsdMicros = result.timelines.flatMap((timeline) => timeline.arms)
  .flatMap((arm) => arm.callReceipts)
  .reduce((sum, receipt) => sum + receipt.estimatedCostUsdMicros, 0);
process.stdout.write(`${JSON.stringify({
  event: "deepseek_reader_observation_written",
  outputPath,
  readerObservationSha256: result.readerObservationSha256,
  split,
  externalNetworkCalls: result.reader.externalNetworkCalls,
  estimatedCostUsdMicros: actualCostUsdMicros,
})}\n`);
