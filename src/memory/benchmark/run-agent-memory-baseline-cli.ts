import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizedAgentMemoryBenchmarkEnvironment } from "./agent-memory-benchmark-guard.js";

interface Arguments {
  readonly manifest: string;
  readonly reportDirectory: string;
}

function argumentsFrom(argv: readonly string[]): Arguments {
  if (argv[0] === "--") return argumentsFrom(argv.slice(1));
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key)
    ) {
      throw new TypeError(
        "memory:baseline expects unique flag/value pairs",
      );
    }
    values.set(key, value);
  }
  if ([...values.keys()].some((key) => !["--manifest", "--report-dir"].includes(key))) {
    throw new TypeError(
      "memory:baseline accepts only --manifest and --report-dir",
    );
  }
  return Object.freeze({
    manifest: values.get("--manifest") ?? "tests/evidence/agent-memory-v1.json",
    reportDirectory:
      values.get("--report-dir") ??
      ".bornagent/evals/agent-memory/reports",
  });
}

function repositoryPath(
  workspaceRoot: string,
  supplied: string,
  label: string,
): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`)
  ) {
    throw new TypeError(`${label} must remain inside the repository`);
  }
  return difference.split(sep).join("/");
}

async function main(): Promise<number> {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const args = argumentsFrom(process.argv.slice(2));
  const manifest = repositoryPath(workspaceRoot, args.manifest, "manifest");
  const reportDirectory = repositoryPath(
    workspaceRoot,
    args.reportDirectory,
    "report directory",
  );
  if (
    reportDirectory !== ".bornagent/evals/agent-memory/reports" &&
    !reportDirectory.startsWith(
      ".bornagent/evals/agent-memory/reports/",
    )
  ) {
    throw new TypeError(
      "agent memory reports must be written below .bornagent/evals/agent-memory/reports",
    );
  }
  const currentModule = fileURLToPath(import.meta.url);
  const childExtension = currentModule.endsWith(".ts") ? ".ts" : ".js";
  const child = fileURLToPath(
    new URL(
      `./run-agent-memory-baseline-protected-child${childExtension}`,
      import.meta.url,
    ),
  );
  const childArguments = childExtension === ".ts"
    ? ["--import", "tsx", child]
    : [child];
  return new Promise<number>((resolveExit, reject) => {
    const processHandle = spawn(
      process.execPath,
      [
        ...childArguments,
        "--manifest",
        manifest,
        "--report-dir",
        reportDirectory,
      ],
      {
        cwd: workspaceRoot,
        env: sanitizedAgentMemoryBenchmarkEnvironment(),
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    processHandle.once("error", reject);
    processHandle.once("exit", (code, signal) => {
      resolveExit(signal === "SIGINT" ? 130 : (code ?? 1));
    });
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
