import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

const [outputArgument, ...ids] = process.argv.slice(2);
if (outputArgument === undefined || ids.length === 0) {
  throw new Error("usage: write-architecture-command-report.mjs <output> <passed-case-id> [passed-case-id ...]");
}
if (ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length) {
  throw new Error("architecture command evidence IDs must be valid and unique");
}

const output = resolve(outputArgument);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  reportId: "architecture-command-report-v1",
  results: ids.sort((left, right) => left.localeCompare(right, "en")).map((id) => ({ id, status: "passed" })),
  schemaVersion: 1,
}, null, 2)}\n`, "utf8");
process.stdout.write(`Architecture command report written: ${output}\n`);
