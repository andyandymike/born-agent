#!/usr/bin/env node
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

try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    { stderr: process.stderr, stdout: process.stdout },
    createNodeRuntime({
      cwd: process.cwd(),
      env: process.env,
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
