import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
if (!workspace) process.exit(2);
const moduleUrl = pathToFileURL(resolve(workspace, "src/path-convention.mjs")).href;
const { generatedOutputPath } = await import(moduleUrl);
if (generatedOutputPath() !== "generated/public-synthetic/nebula-593/output.mjs") {
  console.error("hidden path convention mismatch");
  process.exit(1);
}
console.log("MEM-E0 hidden pass: mem-e0-path-convention");
