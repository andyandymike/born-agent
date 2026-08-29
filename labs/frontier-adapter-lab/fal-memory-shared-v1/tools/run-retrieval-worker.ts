import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalPrettyJson } from "../src/pack-builder.js";
import { runSharedRetrievalWorker } from "../src/retrieval-worker.js";
import { benchmarkSplits, type BenchmarkSplit } from "../src/benchmark-schema.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

const repositoryRoot = resolve(process.cwd());
const splitValue = requiredArgument("--split");
if (!benchmarkSplits.includes(splitValue as BenchmarkSplit)) {
  throw new Error(`invalid shared benchmark split: ${splitValue}`);
}
const split = splitValue as BenchmarkSplit;
const outputArgument = requiredArgument("--output");
const outputPath = isAbsolute(outputArgument)
  ? resolve(outputArgument)
  : resolve(repositoryRoot, outputArgument);
await mkdir(dirname(outputPath), { recursive: true });

const result = await runSharedRetrievalWorker({
  generatedAt: new Date().toISOString(),
  onProgress: (progress) => {
    process.stdout.write(`${JSON.stringify({ event: "timeline_complete", ...progress })}\n`);
  },
  repositoryRoot,
  split,
  stateParent: join(dirname(outputPath), ".retrieval-worker-state"),
});
await writeFile(outputPath, canonicalPrettyJson(result), "utf8");
process.stdout.write(`${JSON.stringify({
  event: "retrieval_observation_written",
  observationSha256: result.observationSha256,
  outputPath,
  split,
  timelines: result.timelines.length,
})}\n`);
