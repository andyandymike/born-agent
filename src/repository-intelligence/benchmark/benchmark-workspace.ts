import { createHash } from "node:crypto";
import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../completion/canonical-json.js";

export async function benchmarkWorkspaceSha256(root: string): Promise<string> {
  const entries: { path: string; sha256: string }[] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("benchmark workspaces cannot contain links");
      if (entry.isDirectory()) {
        await visit(join(absolute, entry.name), path);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(absolute, entry.name));
        entries.push({ path: path.replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  await visit(root, "");
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256").update(canonicalJson(entries), "utf8").digest("hex");
}
