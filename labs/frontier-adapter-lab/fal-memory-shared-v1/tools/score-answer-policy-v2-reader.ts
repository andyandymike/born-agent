import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  loadSharedAnswerPolicyV2Split,
  type AnswerPolicyV2PublicSplit,
} from "../src/answer-policy-v2.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";
import { scoreSharedReader } from "../src/reader-scorer.js";
import {
  calibrationScenarioSeeds,
  developmentScenarioSeeds,
} from "./public-scenario-seeds.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function publicSplit(value: string): AnswerPolicyV2PublicSplit {
  if (value !== "development" && value !== "calibration") {
    throw new Error(`answer-policy v2 split must be development or calibration: ${value}`);
  }
  return value;
}

function absoluteFromRoot(repositoryRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}

const repositoryRoot = resolve(process.cwd());
const split = publicSplit(requiredArgument("--split"));
const readerObservationPath = absoluteFromRoot(
  repositoryRoot,
  requiredArgument("--reader-observation"),
);
const retrievalScorePath = absoluteFromRoot(repositoryRoot, requiredArgument("--retrieval-score"));
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const revised = await loadSharedAnswerPolicyV2Split({
  repositoryRoot,
  seeds: split === "development" ? developmentScenarioSeeds : calibrationScenarioSeeds,
  split,
});
const result = await scoreSharedReader({
  answerPolicyV2GoldensInput: revised.goldens,
  readerObservationInput: parseStrictJson(await readFile(readerObservationPath, "utf8")),
  repositoryRoot,
  retrievalScoreInput: parseStrictJson(await readFile(retrievalScorePath, "utf8")) as
    Readonly<Record<string, unknown>>,
  scoredAt: new Date().toISOString(),
  split,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(result), { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  event: "answer_policy_v2_reader_score_written",
  outputPath,
  readerScoreSha256: result.readerScoreSha256,
  arms: result.arms,
  contrasts: result.contrasts,
  gates: result.gates,
  policyBreakdown: result.policyBreakdown,
  split,
})}\n`);
