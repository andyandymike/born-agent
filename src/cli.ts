#!/usr/bin/env node
import packageJson from "../package.json" with { type: "json" };

import { createNodeRuntime } from "./cli/node-runtime.js";
import { runCli } from "./cli/run-cli.js";

function oneLineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}

try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    { stderr: process.stderr, stdout: process.stdout },
    createNodeRuntime(packageJson.version),
  );
} catch (error) {
  process.stderr.write(`born: internal error: ${oneLineError(error)}\n`);
  process.exitCode = 1;
}

