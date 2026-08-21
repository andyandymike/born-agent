import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { sanitizedRepositoryCacheBenchmarkEnvironment } from "./repository-cache-benchmark-guard.js";
import {
  createRepositoryCacheBenchmarkReport,
  parseRepositoryCacheBenchmarkReport,
  repositoryCacheCandidateDefinitions,
  type RepositoryCacheBenchmarkReportV1,
  type RepositoryCacheCandidateId,
  type RepositoryCacheTraceCaseId,
} from "./repository-cache-evidence.js";

interface Arguments {
  readonly baseline: RepositoryCacheCandidateId;
  readonly candidate: RepositoryCacheCandidateId;
  readonly manifest: string;
  readonly moduleCount?: number;
  readonly reportDirectory: string;
  readonly sampleCount?: number;
}

function argumentsFrom(argv: readonly string[]): Arguments {
  if (argv[0] === "--") return argumentsFrom(argv.slice(1));
  const positional = argv.filter((value) => value !== "--same-patch");
  if (positional.length !== argv.length - 1 || !argv.includes("--same-patch")) {
    throw new TypeError("repository:cache:compare requires the single --same-patch flag");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < positional.length; index += 2) {
    const key = positional[index];
    const value = positional[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) {
      throw new TypeError("repository:cache:compare expects unique flag/value pairs plus --same-patch");
    }
    values.set(key, value);
  }
  const baseline = values.get("--baseline");
  const candidate = values.get("--candidate");
  const manifest = values.get("--manifest");
  const reportDirectory = values.get("--report-dir");
  const allowed = new Set(["--baseline", "--candidate", "--manifest", "--module-count", "--report-dir", "--sample-count"]);
  if (baseline === undefined || candidate === undefined || manifest === undefined || reportDirectory === undefined ||
      [...values.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError("repository:cache:compare requires --baseline, --candidate, --same-patch, --manifest, and --report-dir");
  }
  if (!(baseline in repositoryCacheCandidateDefinitions) || !(candidate in repositoryCacheCandidateDefinitions)) {
    throw new TypeError("repository:cache:compare received an unknown candidate");
  }
  if (baseline !== "monolith_v1" || candidate === baseline) {
    throw new TypeError("repository:cache:compare requires monolith_v1 and a distinct v2 candidate");
  }
  const parseBoundedInteger = (key: string, minimum: number, maximum: number): number | undefined => {
    const source = values.get(key);
    if (source === undefined) return undefined;
    const value = Number(source);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`invalid ${key}`);
    return value;
  };
  const moduleCount = parseBoundedInteger("--module-count", 12, 4_096);
  const sampleCount = parseBoundedInteger("--sample-count", 1, 32);
  return Object.freeze({
    baseline: baseline as RepositoryCacheCandidateId,
    candidate: candidate as RepositoryCacheCandidateId,
    manifest,
    ...(moduleCount === undefined ? {} : { moduleCount }),
    reportDirectory,
    ...(sampleCount === undefined ? {} : { sampleCount }),
  });
}

function containedRelativePath(workspaceRoot: string, supplied: string, label: string): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`)) {
    throw new TypeError(`${label} must remain inside the repository`);
  }
  return difference.split(sep).join("/");
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function runProtectedBenchmark(input: {
  readonly candidate: RepositoryCacheCandidateId;
  readonly manifest: string;
  readonly moduleCount?: number;
  readonly report: string;
  readonly sampleCount?: number;
  readonly workspaceRoot: string;
}): Promise<void> {
  const currentModule = fileURLToPath(import.meta.url);
  const childExtension = currentModule.endsWith(".ts") ? ".ts" : ".js";
  const child = fileURLToPath(new URL(`./run-cache-benchmark-protected-child${childExtension}`, import.meta.url));
  const childArguments = childExtension === ".ts" ? ["--import", "tsx", child] : [child];
  const code = await new Promise<number>((resolveExit, reject) => {
    const processHandle = spawn(process.execPath, [
      ...childArguments,
      "--candidate", input.candidate,
      "--manifest", input.manifest,
      "--report", input.report,
      ...(input.moduleCount === undefined ? [] : ["--module-count", String(input.moduleCount)]),
      ...(input.sampleCount === undefined ? [] : ["--sample-count", String(input.sampleCount)]),
    ], {
      cwd: input.workspaceRoot,
      env: sanitizedRepositoryCacheBenchmarkEnvironment(),
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    processHandle.once("error", reject);
    processHandle.once("exit", (exitCode, signal) => resolveExit(signal === "SIGINT" ? 130 : exitCode ?? 1));
  });
  if (code === 130) {
    process.exitCode = 130;
    throw new Error("repository cache comparator was cancelled");
  }
  if (code !== 0) throw new Error(`protected repository cache benchmark failed with exit ${String(code)}`);
}

function samples(report: RepositoryCacheBenchmarkReportV1, caseId: RepositoryCacheTraceCaseId) {
  return report.cases.find((value) => value.caseId === caseId)?.samples ?? [];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator <= 0 ? null : numerator / denominator;
}

function exactSemanticParity(
  baseline: RepositoryCacheBenchmarkReportV1,
  candidate: RepositoryCacheBenchmarkReportV1,
): readonly string[] {
  const mismatches: string[] = [];
  const queryAndStatusCases = new Set<RepositoryCacheTraceCaseId>([
    "C0", "C1A", "C1B", "C1C", "C2", "C3", "C4", "C5", "C6", "C7", "C8A", "C9",
  ]);
  for (const caseId of ["C0", "C1A", "C1B", "C1C", "C2", "C3", "C4", "C5", "C6", "C7", "C8A", "C9", "C10"] as const) {
    const left = samples(baseline, caseId);
    const right = samples(candidate, caseId);
    if (left.length !== right.length || left.length === 0) {
      mismatches.push(`${caseId}:sample_count`);
      continue;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index]!.generationSha256 !== right[index]!.generationSha256) mismatches.push(`${caseId}:${String(index)}:generation`);
      if (queryAndStatusCases.has(caseId) && left[index]!.outcomeSha256 !== right[index]!.outcomeSha256) {
        mismatches.push(`${caseId}:${String(index)}:outcome`);
      }
      if (left[index]!.errorCode !== right[index]!.errorCode) mismatches.push(`${caseId}:${String(index)}:error`);
    }
  }
  return Object.freeze(mismatches);
}

function compareReports(baseline: RepositoryCacheBenchmarkReportV1, candidate: RepositoryCacheBenchmarkReportV1) {
  if (baseline.checkout.fingerprintSha256 !== candidate.checkout.fingerprintSha256 ||
      baseline.nodeVersion !== candidate.nodeVersion || baseline.platform !== candidate.platform ||
      baseline.manifestSha256 !== candidate.manifestSha256 ||
      baseline.storagePolicySha256 !== candidate.storagePolicySha256 ||
      canonicalJson(baseline.corpus) !== canonicalJson(candidate.corpus) ||
      canonicalJson(baseline.guard) !== canonicalJson(candidate.guard)) {
    throw new Error("repository cache reports are not same-patch comparable");
  }
  const semanticMismatches = exactSemanticParity(baseline, candidate);
  const baselineCold = median(samples(baseline, "C0").flatMap((value) => value.diagnosticDurationMs ?? []));
  const candidateCold = median(samples(candidate, "C0").flatMap((value) => value.diagnosticDurationMs ?? []));
  const baselineLeaf = median(samples(baseline, "C3").flatMap((value) => value.diagnosticDurationMs ?? []));
  const candidateLeaf = median(samples(candidate, "C3").flatMap((value) => value.diagnosticDurationMs ?? []));
  const baselineLogical = samples(baseline, "C0")[0]?.counters.logicalReachableBytes ?? null;
  const candidateLogical = samples(candidate, "C0")[0]?.counters.logicalReachableBytes ?? null;
  const baselineDecoded = samples(baseline, "C1B")[0]?.counters.cacheBytesDecoded ?? baselineLogical;
  const candidateDecoded = samples(candidate, "C1B")[0]?.counters.cacheBytesDecoded ?? null;
  const coldBuildRatio = ratio(candidateCold, baselineCold);
  const leafEditRatio = ratio(candidateLeaf, baselineLeaf);
  const logicalReachableRatio = ratio(candidateLogical, baselineLogical);
  const demandReadRatio = ratio(candidateDecoded, baselineDecoded);
  const queryBytes = samples(candidate, "C1B")[0]?.counters.queryDataObjectBytesDecoded;
  const outlineReadRatio = ratio(queryBytes?.["Q-OUTLINE-SUBTREE"] ?? null, baselineDecoded);
  const referenceReadRatio = ratio(queryBytes?.["Q-REFERENCES-HOT"] ?? null, baselineDecoded);
  const symbolReadRatio = ratio(queryBytes?.["Q-SYMBOL-FUZZY"] ?? null, baselineDecoded);
  const facts = samples(candidate, "C3")[0]?.counters;
  const factDenominator = facts === undefined || facts.factsReused === null || facts.factsRecomputed === null
    ? null
    : facts.factsReused + facts.factsRecomputed;
  const factReuseRatio = facts?.factsReused === null || facts?.factsReused === undefined || factDenominator === null || factDenominator === 0
    ? null
    : facts.factsReused / factDenominator;
  const gates = Object.freeze({
    coldBuildRatio,
    demandReadRatio,
    factReuseRatio,
    leafEditImprovement: leafEditRatio === null ? null : 1 - leafEditRatio,
    logicalReachableRatio,
    outlineReadRatio,
    referenceReadRatio,
    semanticMismatches,
    symbolReadRatio,
  });
  const correctnessPassed = semanticMismatches.length === 0 &&
    candidate.cases.every((value) => value.status === "pass" || value.status === "not_applicable") &&
    samples(candidate, "C12").every((value) =>
      value.counters.activeLeaseCount === 0 && value.counters.gcPendingBytes === 0 &&
      value.counters.tmpBytes === 0 && value.counters.unreachableKnownBytes === 0);
  const isPersistent = candidate.capabilities.includes("persistent_facts_v1");
  const performancePassed = coldBuildRatio !== null && coldBuildRatio <= 1.25 &&
    logicalReachableRatio !== null && logicalReachableRatio <= (isPersistent ? 1.5 : 1.25) &&
    demandReadRatio !== null && demandReadRatio <= 1.1 &&
    outlineReadRatio !== null && outlineReadRatio <= 0.25 &&
    referenceReadRatio !== null && referenceReadRatio <= 0.25 &&
    symbolReadRatio !== null && symbolReadRatio <= 0.6 &&
    (!isPersistent || (factReuseRatio !== null && factReuseRatio >= 0.95 &&
      gates.leafEditImprovement !== null && gates.leafEditImprovement >= 0.3));
  return Object.freeze({ correctnessPassed, gates, performancePassed });
}

async function main(): Promise<number> {
  const args = argumentsFrom(process.argv.slice(2));
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const manifest = containedRelativePath(workspaceRoot, args.manifest, "manifest");
  const reportDirectory = containedRelativePath(workspaceRoot, args.reportDirectory, "report directory");
  if (!reportDirectory.startsWith(".bornagent/evals/repository-cache/")) {
    throw new TypeError("repository cache comparison reports must be below .bornagent/evals/repository-cache");
  }
  const baselinePath = `${reportDirectory}/baseline.json`;
  const candidatePath = `${reportDirectory}/candidate.json`;
  await Promise.all([
    rm(resolve(workspaceRoot, baselinePath), { force: true }),
    rm(resolve(workspaceRoot, candidatePath), { force: true }),
    rm(resolve(workspaceRoot, reportDirectory, "comparison.json"), { force: true }),
    rm(resolve(workspaceRoot, reportDirectory, "comparison-gates.json"), { force: true }),
  ]);
  await runProtectedBenchmark({
    candidate: args.baseline,
    manifest,
    ...(args.moduleCount === undefined ? {} : { moduleCount: args.moduleCount }),
    report: baselinePath,
    ...(args.sampleCount === undefined ? {} : { sampleCount: args.sampleCount }),
    workspaceRoot,
  });
  await runProtectedBenchmark({
    candidate: args.candidate,
    manifest,
    ...(args.moduleCount === undefined ? {} : { moduleCount: args.moduleCount }),
    report: candidatePath,
    ...(args.sampleCount === undefined ? {} : { sampleCount: args.sampleCount }),
    workspaceRoot,
  });
  const [baselineSource, candidateSource] = await Promise.all([
    readFile(resolve(workspaceRoot, baselinePath), "utf8"),
    readFile(resolve(workspaceRoot, candidatePath), "utf8"),
  ]);
  const baseline = parseRepositoryCacheBenchmarkReport(baselineSource);
  const candidate = parseRepositoryCacheBenchmarkReport(candidateSource);
  const result = compareReports(baseline, candidate);
  const { reportSha256: _ignoredReportSha256, ...candidateUnsigned } = candidate;
  void _ignoredReportSha256;
  const comparison = createRepositoryCacheBenchmarkReport({
    ...candidateUnsigned,
    command: ["corepack", "pnpm", "repository:cache:compare", "--", ...process.argv.slice(2)],
  });
  const comparisonPath = resolve(workspaceRoot, reportDirectory, "comparison.json");
  const gates = Object.freeze({
    baselineReportSha256: baseline.reportSha256,
    candidateReportSha256: candidate.reportSha256,
    comparisonReportSha256: comparison.reportSha256,
    gateIdentitySha256: sha256Canonical(result),
    ...result,
  });
  await Promise.all([
    atomicWrite(comparisonPath, `${canonicalJson(comparison)}\n`),
    atomicWrite(resolve(workspaceRoot, reportDirectory, "comparison-gates.json"), `${canonicalJson(gates)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify({ comparison: relative(workspaceRoot, comparisonPath), ...gates })}\n`);
  if (!result.correctnessPassed) return 1;
  return result.performancePassed ? 0 : 9;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (process.exitCode === 130) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } else if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
