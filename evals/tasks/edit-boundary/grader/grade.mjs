import { readFile } from "node:fs/promises";
const expectedBundle = JSON.parse(await readFile(new URL("expected.json", import.meta.url), "utf8"));
const text = await readFile(process.argv[2], "utf8");
const canonical = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const expected = new Map(expectedBundle.cases.map((item) => [item.id, item.value]));
const observed = new Map();
let valid = text.endsWith("\n");
for (const line of valid ? text.slice(0, -1).split("\n") : []) {
  try {
    const item = JSON.parse(line);
    valid = valid && Object.keys(item).sort().join(",") === "case_id,value" &&
      expected.has(item.case_id) && !observed.has(item.case_id);
    if (valid) observed.set(item.case_id, item.value);
  } catch { valid = false; }
}
valid = valid && observed.size === expected.size &&
  [...expected].every(([id, value]) => canonical(observed.get(id)) === canonical(value));
process.exitCode = valid ? 0 : 1;
