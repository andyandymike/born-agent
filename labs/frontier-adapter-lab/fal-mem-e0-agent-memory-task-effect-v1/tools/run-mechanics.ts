import { resolve } from "node:path";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import { runMemE0OfflineMechanics } from "../src/runner.js";
import { observeMemE0SanitizedFailure } from "../src/sanitized-failure.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new TypeError("MEM-E0 mechanics runner accepts no command-line arguments");
  }
  const receipt = await runMemE0OfflineMechanics(resolve("."));
  process.stdout.write(`${canonicalJson(receipt)}\n`);
}

try {
  await main();
} catch (error) {
  const failure = observeMemE0SanitizedFailure("mechanics_command_failed", error);
  process.stderr.write(`${canonicalJson(failure)}\n`);
  process.exitCode = 1;
}
