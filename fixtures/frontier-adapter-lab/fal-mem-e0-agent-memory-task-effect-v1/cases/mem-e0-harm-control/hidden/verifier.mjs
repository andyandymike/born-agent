import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
if (!workspace) process.exit(2);
const moduleUrl = pathToFileURL(resolve(workspace, "src/harm-control.mjs")).href;
const { harmControlMarker } = await import(moduleUrl);
if (harmControlMarker() !== "HARM_PUBLIC_214") {
  console.error("hidden harm-control contract mismatch");
  process.exit(1);
}
console.log("MEM-E0 hidden pass: mem-e0-harm-control");
