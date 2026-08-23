import { spawn } from "node:child_process";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
// GitHub stores only about 4 KiB for one check annotation. Preserve the actual
// process tail so Vitest's final failure and stack are not displaced by earlier
// PTY screen output.
const failureTailLimit = 3_500;
const stages = Object.freeze([
  Object.freeze({ label: "lint", script: "lint" }),
  Object.freeze({ label: "typecheck", script: "typecheck" }),
  Object.freeze({ label: "test:non-pty", script: "test:non-pty" }),
  Object.freeze({ label: "test:pty", script: "test:pty" }),
  Object.freeze({ label: "clean build", script: "build" }),
]);

function appendTail(current, chunk) {
  const combined = `${current}${chunk}`;
  return combined.length <= failureTailLimit
    ? combined
    : combined.slice(combined.length - failureTailLimit);
}

function escapeWorkflowCommand(message) {
  return message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function runStage(pnpmCliPath, stage) {
  return new Promise((resolveStage) => {
    process.stdout.write(`repository_check_stage_start: ${stage.label}\n`);
    const child = spawn(process.execPath, [pnpmCliPath, stage.script], {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let failureTail = "";
    let settled = false;

    const forward = (stream, chunk) => {
      const text = chunk.toString("utf8");
      failureTail = appendTail(failureTail, text);
      stream.write(text);
    };
    child.stdout.on("data", (chunk) => forward(process.stdout, chunk));
    child.stderr.on("data", (chunk) => forward(process.stderr, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolveStage(Object.freeze({ error, failureTail, status: null, signal: null }));
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      resolveStage(Object.freeze({ error: null, failureTail, status, signal }));
    });
  });
}

async function main() {
  const pnpmCliPath = process.env.npm_execpath;
  if (!pnpmCliPath) {
    throw new Error("repository check must run from a pnpm script");
  }

  for (const stage of stages) {
    const result = await runStage(pnpmCliPath, stage);
    if (result.error === null && result.status === 0) {
      process.stdout.write(`repository_check_stage_passed: ${stage.label}\n`);
      continue;
    }

    const failure = [
      `stage=${stage.label}`,
      `exitCode=${result.status === null ? "null" : String(result.status)}`,
      `signal=${result.signal ?? "none"}`,
      result.error?.message,
      result.failureTail.trim(),
    ].filter(Boolean).join("\n");
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::error title=Repository check failed - ${stage.label}::${escapeWorkflowCommand(failure)}\n`);
    }
    throw new Error(failure);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`repository_check_failed: ${message}\n`);
  process.exitCode = 1;
});
