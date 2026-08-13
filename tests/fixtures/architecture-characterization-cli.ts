import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../../src/completion/canonical-json.js";
import {
  ARCHITECTURE_CHARACTERIZATION_BASELINE_PATH,
  architectureCharacterizationMetrics,
  architectureCharacterizationSha256,
  architectureCharacterizationSource,
  generateArchitectureCharacterization,
  readTrackedArchitectureCharacterization,
} from "../helpers/architecture-characterization.js";

interface Options {
  readonly check: boolean;
  readonly report: string | null;
  readonly write: boolean;
}

function argumentsFor(argv: readonly string[]): Options {
  let check = false;
  let report: string | null = null;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--check") check = true;
    else if (option === "--write") write = true;
    else if (option === "--report") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--report requires a path");
      report = value;
      index += 1;
    } else throw new Error(`unknown architecture characterization option ${String(option)}`);
  }
  if (check === write) throw new Error("choose exactly one of --check or --write");
  if (write && report !== null) throw new Error("--report is valid only with --check");
  return Object.freeze({ check, report, write });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const options = argumentsFor(process.argv.slice(2));
const workspaceRoot = resolve(import.meta.dirname, "../..");
const actual = await generateArchitectureCharacterization(workspaceRoot);
const baselinePath = resolve(workspaceRoot, ARCHITECTURE_CHARACTERIZATION_BASELINE_PATH);

if (options.write) {
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, architectureCharacterizationSource(actual), "utf8");
  process.stdout.write(`AS0.2 architecture characterization baseline written: ${baselinePath}\n`);
} else {
  const expected = await readTrackedArchitectureCharacterization(workspaceRoot);
  const checks = [
    ["as0.2.characterization.baseline", same(actual, expected)],
    ["as0.2.characterization.dependency-boundaries", same(actual.dependencyBoundaries, expected.dependencyBoundaries)],
    ["as0.2.characterization.handoff", same(actual.backgroundHandoff, expected.backgroundHandoff)],
    ["as0.2.characterization.workspace", same(actual.workspaceSnapshot, expected.workspaceSnapshot)],
    ["as0.2.characterization.session-reads", same(actual.sessionReads, expected.sessionReads)],
    ["as0.2.characterization.agent-terminals", same(actual.agentTerminalGoldens, expected.agentTerminalGoldens)],
    ["as0.2.characterization.surface-routes", same(actual.surfaceRoutes, expected.surfaceRoutes)],
  ] as const;
  const report = Object.freeze({
    metrics: architectureCharacterizationMetrics(actual),
    reportId: "architecture-command-report-v1" as const,
    results: checks.map(([id, passed]) => Object.freeze({ id, status: passed ? "passed" as const : "failed" as const })),
    schemaVersion: 1 as const,
  });
  if (options.report !== null) {
    const reportPath = resolve(options.report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  const failed = report.results.filter((result) => result.status !== "passed");
  if (failed.length > 0) {
    throw new Error(`AS0.2 characterization drift: ${failed.map((result) => result.id).join(", ")}; expected=${architectureCharacterizationSha256(expected)} actual=${architectureCharacterizationSha256(actual)}`);
  }
  process.stdout.write(`AS0.2 architecture characterization matches ${architectureCharacterizationSha256(actual)}.\n`);
}
