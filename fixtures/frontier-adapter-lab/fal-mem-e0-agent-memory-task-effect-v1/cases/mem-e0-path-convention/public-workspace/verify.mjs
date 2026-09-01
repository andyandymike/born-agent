import { generatedOutputPath } from "./src/path-convention.mjs";

const path = generatedOutputPath();
if (
  typeof path !== "string" ||
  !path.startsWith("generated/") ||
  !path.endsWith(".mjs") ||
  path.includes("\\") ||
  path.split("/").includes("..")
) {
  console.error("generated output path must be a normalized relative .mjs path");
  process.exit(1);
}
console.log("MEM-E0 public shape pass: path convention");
