import { readFile } from "node:fs/promises";
const expected = JSON.parse(await readFile(new URL("expected.json", import.meta.url), "utf8"));
const text = await readFile(process.argv[2], "utf8");
const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
const parseObserved = () => {
  try { return lines.length === 1 ? JSON.parse(lines[0]) : null; }
  catch { return null; }
};
const observed = parseObserved();
process.exitCode = observed !== null &&
  Object.keys(observed).sort().join(",") === "case_id,value" &&
  observed.case_id === "static" && observed.value === expected.utf8 ? 0 : 1;
