import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
if (!workspace) process.exit(2);
const moduleUrl = pathToFileURL(resolve(workspace, "src/output-contract.mjs")).href;
const { outputMarker } = await import(moduleUrl);
if (outputMarker() !== "AURORA_PUBLIC_731") {
  console.error("hidden output contract mismatch");
  process.exit(1);
}
console.log("MEM-E0 hidden pass: mem-e0-output-contract");
