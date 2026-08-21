import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizedRepositoryCacheBenchmarkEnvironment } from "./repository-cache-benchmark-guard.js";
import { repositoryCacheCandidateDefinitions } from "./repository-cache-evidence.js";

interface Arguments {
  readonly candidate: string;
  readonly manifest: string;
  readonly report: string;
}

function argumentsFrom(argv: readonly string[]): Arguments {
  if (argv[0] === "--") return argumentsFrom(argv.slice(1));
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) {
      throw new TypeError("repository:cache:benchmark expects unique flag/value pairs");
    }
    values.set(key, value);
  }
  const candidate = values.get("--candidate");
  const manifest = values.get("--manifest");
  const report = values.get("--report");
  if (candidate === undefined || manifest === undefined || report === undefined || values.size !== 3) {
    throw new TypeError("repository:cache:benchmark requires --candidate, --manifest, and --report");
  }
  if (!(candidate in repositoryCacheCandidateDefinitions)) throw new TypeError(`unknown repository cache candidate ${candidate}`);
  return Object.freeze({ candidate, manifest, report });
}

function repositoryPath(workspaceRoot: string, supplied: string, label: string): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`)) {
    throw new TypeError(`${label} must remain inside the repository`);
  }
  return difference.split(sep).join("/");
}

async function main(): Promise<number> {
  const args = argumentsFrom(process.argv.slice(2));
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const normalized = {
    candidate: args.candidate,
    manifest: repositoryPath(workspaceRoot, args.manifest, "manifest"),
    report: repositoryPath(workspaceRoot, args.report, "report"),
  };
  if (!normalized.report.startsWith(".bornagent/evals/repository-cache/")) {
    throw new TypeError("repository cache reports must be written below .bornagent/evals/repository-cache");
  }
  const currentModule = fileURLToPath(import.meta.url);
  const childExtension = currentModule.endsWith(".ts") ? ".ts" : ".js";
  const child = fileURLToPath(new URL(`./run-cache-benchmark-protected-child${childExtension}`, import.meta.url));
  const childArguments = childExtension === ".ts" ? ["--import", "tsx", child] : [child];
  const result = await new Promise<number>((resolveExit, reject) => {
    const processHandle = spawn(process.execPath, [
      ...childArguments,
      "--candidate", normalized.candidate,
      "--manifest", normalized.manifest,
      "--report", normalized.report,
    ], {
      cwd: workspaceRoot,
      env: sanitizedRepositoryCacheBenchmarkEnvironment(),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    processHandle.once("error", reject);
    processHandle.once("exit", (code, signal) => resolveExit(signal === "SIGINT" ? 130 : code ?? 1));
  });
  return result;
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
