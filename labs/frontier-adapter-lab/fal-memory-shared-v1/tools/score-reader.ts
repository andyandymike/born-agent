import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { benchmarkSplits, type BenchmarkSplit } from "../src/benchmark-schema.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";
import { scoreSharedReader } from "../src/reader-scorer.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
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
const readerObservationPath = absoluteFromRoot(
  repositoryRoot,
  requiredArgument("--reader-observation"),
);
const retrievalScorePath = absoluteFromRoot(repositoryRoot, requiredArgument("--retrieval-score"));
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const result = await scoreSharedReader({
  readerObservationInput: parseStrictJson(await readFile(readerObservationPath, "utf8")),
  repositoryRoot,
  retrievalScoreInput: parseStrictJson(await readFile(retrievalScorePath, "utf8")) as
    Readonly<Record<string, unknown>>,
  scoredAt: new Date().toISOString(),
  split,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(result), "utf8");
process.stdout.write(`${JSON.stringify({
  event: "reader_score_written",
  outputPath,
  readerScoreSha256: result.readerScoreSha256,
  arms: result.arms,
  contrasts: result.contrasts,
  gates: result.gates,
  split,
})}\n`);
