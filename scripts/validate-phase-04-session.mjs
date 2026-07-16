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
  if (!candidates[0]) throw new Error(`no session files found in ${directory}`);
  return candidates[0].path;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Phase 4 gate failed: ${message}`);
}

const requestedPath = process.argv.slice(2).find((argument) => argument !== "--");
const path = requestedPath
  ? resolve(requestedPath)
  : await latestSession(process.cwd());
const raw = await readFile(path, "utf8");
const secret = process.env.OPENAI_API_KEY;
requireCondition(!secret || !raw.includes(secret), "session contains OPENAI_API_KEY");
requireCondition(
  !/Authorization\s*:\s*Bearer\s+\S+/iu.test(raw) &&
    !/\bsk-[A-Za-z0-9_-]{8,}/u.test(raw),
  "session contains token-like secret text",
);

const events = await readSession(path);
const reconstructed = reconstructSession(events);
requireCondition(reconstructed.started.command === "agent", "command is not agent");
requireCondition(
  reconstructed.terminal.type === "run.completed",
  `terminal is ${reconstructed.terminal.type}`,
);
requireCondition(
  reconstructed.agentSteps.length >= 4,
  "expected multiple model steps",
);
const completedTools = reconstructed.toolCalls.filter(
  (call) => call.completed !== undefined && !call.interrupted,
);
const toolNames = new Set(
  completedTools.map((call) => call.requested.tool_name),
);
requireCondition(completedTools.length >= 3, "fewer than 3 completed tool calls");
requireCondition(toolNames.size >= 2, "fewer than 2 distinct tool names");
requireCondition(
  reconstructed.toolCalls.every((call) => !call.interrupted),
  "completed run contains an interrupted tool call",
);
requireCondition(reconstructed.usage !== undefined, "aggregate usage is absent");

const requiredAnswerFragments = [
  "fixtures/phase-04-cross-file-answer/src/config.ts",
  "fixtures/phase-04-cross-file-answer/src/loader.ts",
  "fixtures/phase-04-cross-file-answer/src/output.ts",
  "channel=aurora;retries=4",
];
for (const fragment of requiredAnswerFragments) {
  requireCondition(
    reconstructed.output.includes(fragment),
    `final answer is missing ${fragment}`,
  );
}

process.stdout.write(
  [
    `session=${path}`,
    `steps=${reconstructed.agentSteps.length}`,
    `tool_calls=${completedTools.length}`,
    `tools=${[...toolNames].sort().join(",")}`,
    `total_tokens=${reconstructed.usage?.total_tokens ?? 0}`,
    "phase4_gate=ok",
  ].join(" ") + "\n",
);
