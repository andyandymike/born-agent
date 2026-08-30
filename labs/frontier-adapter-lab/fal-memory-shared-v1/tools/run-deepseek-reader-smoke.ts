import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalPrettyJson } from "../src/pack-builder.js";
import { runDeepSeekReaderSmoke } from "../src/deepseek-reader-smoke.js";

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
const outputPath = absoluteFromRoot(repositoryRoot, requiredArgument("--output"));
const apiKey = process.env.DEEPSEEK_API_KEY;
if (apiKey === undefined) {
  throw new Error("DEEPSEEK_API_KEY is not visible to the current process");
}
const result = await runDeepSeekReaderSmoke({
  apiKey,
  generatedAt: new Date().toISOString(),
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalPrettyJson(result), "utf8");
process.stdout.write(`${JSON.stringify({
  event: "deepseek_reader_smoke_written",
  outputPath,
  passed: result.passed,
  parseState: result.parseState,
  estimatedCostUsdMicros: (result.callReceipt as { readonly estimatedCostUsdMicros: number })
    .estimatedCostUsdMicros,
  smokeReceiptSha256: result.smokeReceiptSha256,
})}\n`);
