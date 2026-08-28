import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { runFal0ContextFoldingLab } from "../src/frontier-adapters/context-folding/fal0-runner.ts";

function usage(message) {
  if (message !== undefined) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: pnpm lab:context-folding -- --mode baseline [--report <workspace-path>] [--actual-focused-minutes <integer>]\n",
  );
  process.exitCode = 2;
}

function parseArguments(values) {
  const parsed = {
    actualFocusedMinutes: 0,
    mode: "baseline",
    report: ".bornagent/reports/fal0-context-folding-baseline.json",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") continue;
    const next = values[index + 1];
    if (value === "--mode" && next !== undefined) {
      parsed.mode = next;
      index += 1;
      continue;
    }
    if (value === "--report" && next !== undefined) {
      parsed.report = next;
      index += 1;
      continue;
    }
    if (value === "--actual-focused-minutes" && next !== undefined) {
      parsed.actualFocusedMinutes = Number(next);
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${String(value)}`);
  }
  if (parsed.mode !== "baseline" && parsed.mode !== "compare") {
    throw new Error("--mode must be baseline or compare");
  }
  if (
    !Number.isSafeInteger(parsed.actualFocusedMinutes) ||
    parsed.actualFocusedMinutes < 0
  ) {
    throw new Error("--actual-focused-minutes must be a nonnegative integer");
  }
  return parsed;
}

function workspaceReportPath(repositoryRoot, requested) {
  const selected = resolve(repositoryRoot, requested);
  const difference = relative(repositoryRoot, selected);
  if (
    difference === ".." ||
    difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("--report must remain inside the repository workspace");
  }
  return selected;
}

let input;
try {
  input = parseArguments(process.argv.slice(2));
} catch (error) {
  usage(error instanceof Error ? error.message : "invalid arguments");
}

if (input !== undefined) {
  try {
    const repositoryRoot = process.cwd();
    const reportPath = workspaceReportPath(repositoryRoot, input.report);
    const run = await runFal0ContextFoldingLab({
      actualFocusedMinutes: input.actualFocusedMinutes,
      mode: input.mode,
      repositoryRoot,
    });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(run.receipt, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      cf1Permitted: run.cf1Permitted,
      cf1Reasons: run.cf1Reasons,
      hardGateFailures: run.receipt.aggregate.hardGateFailures,
      outcome: run.receipt.outcome,
      receiptSha256: run.receipt.receiptSha256,
      report: relative(repositoryRoot, reportPath).split("\\").join("/"),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
