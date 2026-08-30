import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  loadSharedAnswerPolicyV2ExecutorSplit,
  type AnswerPolicyV2PublicSplit,
} from "../src/answer-policy-v2.js";
import { answerPolicyV2QuerySeedsFor } from "../src/answer-policy-v2-query-seeds.js";
import { canonicalPrettyJson } from "../src/pack-builder.js";
import { runSharedRetrievalWorker } from "../src/retrieval-worker.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

function publicSplit(value: string): AnswerPolicyV2PublicSplit {
  if (value !== "development" && value !== "calibration") {
    throw new Error(`answer-policy v2 split must be development or calibration: ${value}`);
  }
  return value;
}

const repositoryRoot = resolve(process.cwd());
const split = publicSplit(requiredArgument("--split"));
const outputArgument = requiredArgument("--output");
const outputPath = isAbsolute(outputArgument)
  ? resolve(outputArgument)
  : resolve(repositoryRoot, outputArgument);
const stateParent = join(repositoryRoot, ".cache", "fal-memory-v2-state");
const executor = await loadSharedAnswerPolicyV2ExecutorSplit({
  repositoryRoot,
  seeds: answerPolicyV2QuerySeedsFor(split),
  split,
});
await mkdir(dirname(outputPath), { recursive: true });
const result = await runSharedRetrievalWorker({
  answerPolicyV2ExecutorInput: executor,
  generatedAt: new Date().toISOString(),
  onProgress: (progress) => {
    process.stdout.write(`${JSON.stringify({ event: "v2_timeline_complete", ...progress })}\n`);
  },
  repositoryRoot,
  split,
  stateParent,
});
await writeFile(outputPath, canonicalPrettyJson(result), { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  event: "answer_policy_v2_retrieval_observation_written",
  benchmarkId: result.benchmarkId,
  executorSha256: "executorSha256" in result ? result.executorSha256 : null,
  observationSha256: result.observationSha256,
  outputPath,
  split,
  timelines: result.timelines.length,
})}\n`);
