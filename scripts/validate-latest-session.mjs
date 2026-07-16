import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { readSession } from "../dist/sessions/read-session.js";
import { reconstructSession } from "../dist/sessions/reconstruct-session.js";

async function latestSession(workspace) {
  const directory = resolve(workspace, ".bornagent", "sessions");
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const candidates = await Promise.all(
    names.map(async (name) => {
      const path = resolve(directory, name);
      return { modified: (await stat(path)).mtimeMs, path };
    }),
  );
  candidates.sort((left, right) => right.modified - left.modified);
  if (!candidates[0]) {
    throw new Error(`no session files found in ${directory}`);
  }
  return candidates[0].path;
}

const requestedPath = process.argv[2];
const path = requestedPath
  ? resolve(requestedPath)
  : await latestSession(process.cwd());
const raw = await readFile(path, "utf8");
const secret = process.env.OPENAI_API_KEY;
if (secret && raw.includes(secret)) {
  throw new Error("session contains OPENAI_API_KEY");
}
if (/Authorization\s*:\s*Bearer\s+\S+/iu.test(raw) || /\bsk-[A-Za-z0-9_-]{8,}/u.test(raw)) {
  throw new Error("session contains token-like secret text");
}

const events = await readSession(path);
const reconstructed = reconstructSession(events);
const usage = reconstructed.usage;
process.stdout.write(
  [
    `session=${path}`,
    `events=${events.length}`,
    `terminal=${reconstructed.terminal.type}`,
    `output_chars=${reconstructed.output.length}`,
    usage === undefined ? "usage=absent" : `total_tokens=${usage.total_tokens}`,
    "validation=ok",
  ].join(" ") + "\n",
);
