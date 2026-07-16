#!/usr/bin/env node
import { createInterface } from "node:readline";

import packageJson from "../package.json" with { type: "json" };

import { createNodeRuntime } from "./cli/node-runtime.js";
import { runCli } from "./cli/run-cli.js";
import { redactSensitiveText } from "./security/redact.js";

function oneLineError(error: unknown, secret: string | undefined): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret && secret.length > 0) {
    message = redactSensitiveText(message, [secret]);
  } else {
    message = redactSensitiveText(message);
  }
  return message.replace(/\s+/gu, " ").trim();
}

function readApprovalLine(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin, terminal: false });
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      input.close();
      resolve(value);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    input.once("line", (line) => finish(line));
    input.once("close", () => finish(null));
    if (signal.aborted) onAbort();
  });
}

try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    { stderr: process.stderr, stdout: process.stdout },
    createNodeRuntime({
      approvalInput: {
        interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
        readLine: readApprovalLine,
      },
      cwd: process.cwd(),
      env: process.env,
      execPath: process.execPath,
      killProcess: (processIdentity, signal) => {
        process.kill(processIdentity, signal);
      },
      nodeVersion: process.versions.node,
      onCancel: (listener) => {
        process.once("SIGINT", listener);
        return () => process.off("SIGINT", listener);
      },
      platform: process.platform,
      version: packageJson.version,
    }),
  );
} catch (error) {
  process.stderr.write(
    `born: internal error: ${oneLineError(error, process.env.OPENAI_API_KEY)}\n`,
  );
  process.exitCode = 1;
}
