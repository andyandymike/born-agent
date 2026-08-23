import { relative, resolve, sep } from "node:path";

import { installAgentMemoryBenchmarkGuard } from "./agent-memory-benchmark-guard.js";

interface Arguments {
  readonly manifest: string;
  readonly reportDirectory: string;
}

function containedPath(
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
  return absolute;
}

function argumentsFrom(argv: readonly string[]): Arguments {
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
        "agent memory protected baseline expects unique flag/value pairs",
      );
    }
    values.set(key, value);
  }
  const manifest = values.get("--manifest");
  const reportDirectory = values.get("--report-dir");
  if (
    manifest === undefined ||
    reportDirectory === undefined ||
    values.size !== 2
  ) {
    throw new TypeError(
      "agent memory protected baseline requires --manifest and --report-dir",
    );
  }
  return Object.freeze({ manifest, reportDirectory });
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const args = argumentsFrom(process.argv.slice(2));
  const manifestPath = containedPath(workspaceRoot, args.manifest, "manifest");
  const reportDirectory = containedPath(
    workspaceRoot,
    args.reportDirectory,
    "report directory",
  );
  const guard = installAgentMemoryBenchmarkGuard();
  try {
    const [runner, evidence] = await Promise.all([
      import("./agent-memory-baseline-runner.js"),
      import("./agent-memory-evidence.js"),
    ]);
    const { manifest, source } =
      await evidence.readAgentMemoryEvidenceManifest(manifestPath);
    const result = await runner.runAgentMemoryBaseline({
      guard,
      manifest,
      manifestSource: source,
      workspaceRoot,
    });
    const path = await evidence.writeAgentMemoryBaselineReport(
      reportDirectory,
      result.report,
    );
    process.stdout.write(`${JSON.stringify({
      deterministicResultSha256: result.report.deterministicResultSha256,
      path,
      reportSha256: result.report.reportSha256,
      status: result.receipt.status,
    })}\n`);
  } finally {
    guard.restore();
  }
}

await main();
