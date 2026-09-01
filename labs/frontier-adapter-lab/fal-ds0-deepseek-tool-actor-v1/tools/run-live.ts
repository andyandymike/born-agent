import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runDs0Cli } from "../src/live-runner.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const exitCode = await runDs0Cli(process.argv.slice(2), {
  env: process.env,
  io: {
    stderr: { write: (value) => process.stderr.write(value) },
    stdout: { write: (value) => process.stdout.write(value) },
  },
  repositoryRoot,
});

process.exitCode = exitCode;
