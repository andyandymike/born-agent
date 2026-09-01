import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  parseProductionMemoryEffectActorInput,
  runProductionMemoryEffectActor,
} from "../src/production-memory-effect-actor.js";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const [inputPath, ...extra] = process.argv.slice(2);
  if (
    inputPath === undefined ||
    extra.length !== 0 ||
    inputPath.includes("\0") ||
    !isAbsolute(inputPath)
  ) {
    throw new TypeError("MEM-E0 child requires one absolute input JSON path");
  }
  const inputBytes = await readFile(resolve(inputPath));
  if (inputBytes.byteLength < 2 || inputBytes.byteLength > 32_768) {
    throw new TypeError("MEM-E0 child input size is invalid");
  }
  const input = parseProductionMemoryEffectActorInput(JSON.parse(inputBytes.toString("utf8")));
  const observation = await runProductionMemoryEffectActor(input);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

try {
  await main();
} catch (error) {
  const failureClass = error instanceof Error ? error.name : typeof error;
  const failureMessage = error instanceof Error ? error.message : "non_error_throw";
  process.stdout.write(`${JSON.stringify(Object.freeze({
    childPid: process.pid,
    failureClassSha256: sha256Text(failureClass),
    failureMessageSha256: sha256Text(failureMessage),
    failureObservationSha256: sha256Canonical({ failureClass, schemaVersion: 1 }),
    schemaVersion: 1,
    status: "child_failed_closed",
  }))}\n`);
  process.exitCode = 1;
}
