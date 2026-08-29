import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { benchmarkSplits, type BenchmarkSplit } from "../src/benchmark-schema.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";
import { runSharedReaderWorker } from "../src/reader-worker.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

function absoluteFromRoot(repositoryRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}

const repositoryRoot = resolve(process.cwd());
const splitValue = requiredArgument("--split");
if (!benchmarkSplits.includes(splitValue as BenchmarkSplit)) {
  throw new Error(`invalid shared benchmark split: ${splitValue}`);
}
const split = splitValue as BenchmarkSplit;
const threshold = Number(requiredArgument("--threshold-micros"));
if (!Number.isInteger(threshold) || threshold < -1_000_000 || threshold > 1_000_001) {
  throw new Error("reader threshold must be integer similarity micros");
}
const thresholdRoleValue = requiredArgument("--threshold-role");
if (thresholdRoleValue !== "eligible_operating_point" && thresholdRoleValue !== "diagnostic_only") {
  throw new Error("reader threshold role is invalid");
}
const observationPath = absoluteFromRoot(repositoryRoot, requiredArgument("--retrieval-observation"));
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const result = await runSharedReaderWorker({
  generatedAt: new Date().toISOString(),
  observationInput: parseStrictJson(await readFile(observationPath, "utf8")),
  ollamaBaseUrl: process.env.BORNAGENT_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  onProgress: (progress) => {
    process.stdout.write(`${JSON.stringify({ event: "reader_arm_complete", ...progress })}\n`);
  },
  repositoryRoot,
  split,
  thresholdRole: thresholdRoleValue,
  thresholdSimilarityMicros: threshold,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(result), "utf8");
process.stdout.write(`${JSON.stringify({
  event: "reader_observation_written",
  outputPath,
  readerObservationSha256: result.readerObservationSha256,
  split,
})}\n`);
