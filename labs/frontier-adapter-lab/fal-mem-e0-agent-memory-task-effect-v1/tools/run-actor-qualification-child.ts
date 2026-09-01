import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  parseMemE0LiveActorQualificationInput,
  runMemE0LiveActorQualification,
} from "../src/live-actor-qualification-executor.js";
import { observeMemE0SanitizedFailure } from "../src/sanitized-failure.js";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (process.argv.length !== 3 || inputPath === undefined) {
    throw new TypeError("qualification child requires one input envelope");
  }
  const raw = await readFile(resolve(inputPath), "utf8");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new TypeError("qualification child input exceeds its byte limit");
  }
  const input = parseMemE0LiveActorQualificationInput(parseStrictJson(raw));
  const output = await runMemE0LiveActorQualification(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(observeMemE0SanitizedFailure(
    "qualification_actor_failed",
    error,
  ))}\n`);
  process.exitCode = 1;
});
