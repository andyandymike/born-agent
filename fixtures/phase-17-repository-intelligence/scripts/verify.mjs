import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "packages/core/src/session.ts",
  "packages/core/src/session-store.ts",
  "packages/ui/src/session-view.ts",
  "packages/shared/src/types.ts",
];

for (const path of required) {
  const source = await readFile(resolve(path), "utf8");
  if (source.length === 0) throw new Error(`empty fixture source: ${path}`);
}

process.stdout.write("phase17 fixture verified\n");
