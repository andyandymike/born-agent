import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
if (!workspace) process.exit(2);
const moduleUrl = pathToFileURL(resolve(workspace, "src/retry-schedule.mjs")).href;
const { retrySchedule } = await import(moduleUrl);
const actual = retrySchedule();
const expected = [1739, 4253, 7919];
if (!Object.isFrozen(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("hidden retry schedule mismatch");
  process.exit(1);
}
console.log("MEM-E0 hidden pass: mem-e0-retry-schedule");
