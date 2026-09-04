import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { memE0RawSha256 } from "../src/fixture.js";
import { runMemE0EffectChild } from "../src/live-effect-actor.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

try {
  const [path, ...extra] = process.argv.slice(2);
  if (path === undefined || extra.length !== 0 || !isAbsolute(path)) throw new Error("effect child requires one input file");
  const bytes = await readFile(path);
  if (bytes.length > 512 * 1_024) throw new Error("effect child input exceeds its bound");
  const output = await runMemE0EffectChild(parseStrictJson(bytes.toString("utf8")));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: "mem_e0_effect_child_failed",
    failureSha256: memE0RawSha256(error instanceof Error ? `${error.name}:${error.message}` : "non_error_throw") })}\n`);
  process.exitCode = 1;
}
