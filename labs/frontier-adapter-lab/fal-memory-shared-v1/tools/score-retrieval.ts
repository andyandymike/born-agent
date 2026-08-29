import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { benchmarkSplits, type BenchmarkSplit } from "../src/benchmark-schema.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";
import { scoreSharedRetrieval } from "../src/shared-scorer.js";

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
const observationPath = absoluteFromRoot(repositoryRoot, requiredArgument("--observation"));
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const report = await scoreSharedRetrieval({
  observationInput: parseStrictJson(await readFile(observationPath, "utf8")),
  repositoryRoot,
  scoredAt: new Date().toISOString(),
  split,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(report), "utf8");
process.stdout.write(`${JSON.stringify({
  event: "retrieval_score_written",
  outputPath,
  scoreSha256: report.scoreSha256,
  selection: report.selection,
  split,
})}\n`);
