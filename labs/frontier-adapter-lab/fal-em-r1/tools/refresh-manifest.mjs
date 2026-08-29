import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = process.cwd();
const directory = resolve(
  repositoryRoot,
  "fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const current = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const files = {};
for (const path of Object.keys(current.files)) {
  const bytes = await readFile(resolve(directory, path));
  files[path] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
}
const content = { ...current };
delete content.manifestSha256;
const refreshed = { ...content, files };
process.stdout.write(`${JSON.stringify({
  ...refreshed,
  manifestSha256: sha256(canonical(refreshed)),
}, null, 2)}\n`);
