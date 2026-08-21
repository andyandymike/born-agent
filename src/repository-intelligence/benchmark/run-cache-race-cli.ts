import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { RepositoryIndexV2Store } from "../index-v2-store.js";
import { DefaultRepositoryNavigationService } from "../navigation-service.js";
import { readRepositoryCacheEvidenceManifest } from "./repository-cache-evidence.js";

const scenarioIds = Object.freeze(["publisher_gc", "reader_gc"] as const);
type ScenarioId = (typeof scenarioIds)[number];

interface Arguments {
  readonly candidate: "production_v2";
  readonly manifest: string;
  readonly repeat: number;
  readonly report: string;
  readonly scenarios: readonly ScenarioId[];
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] === "--") return parseArguments(argv.slice(1));
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) {
      throw new TypeError("repository:cache:race expects unique flag/value pairs");
    }
    values.set(key, value);
  }
  const allowed = new Set(["--candidate", "--manifest", "--repeat", "--report", "--scenarios"]);
  if ([...values.keys()].some((key) => !allowed.has(key)) || values.get("--candidate") !== "production_v2") {
    throw new TypeError("repository:cache:race requires --candidate production_v2");
  }
  const manifest = values.get("--manifest");
  const report = values.get("--report");
  const repeat = Number(values.get("--repeat"));
  const scenarios = values.get("--scenarios")?.split(",").sort() ?? [];
  if (manifest === undefined || report === undefined || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20 ||
      scenarios.length !== scenarioIds.length || scenarios.some((value, index) => value !== scenarioIds[index])) {
    throw new TypeError("repository:cache:race requires the exact reader_gc,publisher_gc scenarios, --repeat 1..20, --manifest, and --report");
  }
  return Object.freeze({
    candidate: "production_v2",
    manifest,
    repeat,
    report,
    scenarios: scenarioIds,
  });
}

function contained(workspaceRoot: string, supplied: string, label: string): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`)) {
    throw new TypeError(`${label} must remain inside the repository`);
  }
  return absolute;
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
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function sweepToFixedPoint(store: RepositoryIndexV2Store, signal: AbortSignal): Promise<number> {
  let reclaimed = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const result = await store.collectGarbage({ dryRun: false, signal });
    reclaimed += result.gcReclaimedEntries;
    if (result.unreachableKnownEntries === 0) return reclaimed;
  }
  throw new Error("repository race GC did not reach a bounded fixed point");
}

async function runReaderGc(root: string, signal: AbortSignal): Promise<Readonly<Record<string, number>>> {
  const source = join(root, "reader.ts");
  await writeFile(source, "export const readerValue = 1;\n", "utf8");
  await (await DefaultRepositoryNavigationService.create(root)).rebuild(signal);
  const store = await RepositoryIndexV2Store.openExisting(root);
  if (store === null) throw new Error("repository race v2 store is absent");
  const lease = await store.acquireCurrentLease();
  if (lease === null) throw new Error("repository race current lease is absent");
  const leasedRoot = `${lease.root.storageManifestSha256}.json`;
  try {
    await writeFile(source, "export const readerValue = 2;\n", "utf8");
    await (await DefaultRepositoryNavigationService.create(root)).rebuild(signal);
    const [units, firstGc] = await Promise.all([
      lease.readUnits(),
      store.collectGarbage({ dryRun: false, signal }),
    ]);
    if (units.length !== 1 || !(await readdir(store.paths.rootsRoot)).includes(leasedRoot)) {
      throw new Error("repository race GC reclaimed a leased reader root");
    }
    return Object.freeze({ activeLeaseCount: firstGc.activeLeaseCount, leasedUnitsRead: units.length });
  } finally {
    await lease.release();
    await sweepToFixedPoint(store, signal);
  }
}

async function runPublisherGc(root: string, signal: AbortSignal): Promise<Readonly<Record<string, number>>> {
  const source = join(root, "publisher.ts");
  await writeFile(source, "export const publisherValue = 0;\n", "utf8");
  const service = await DefaultRepositoryNavigationService.create(root);
  await service.rebuild(signal);
  const store = await RepositoryIndexV2Store.openExisting(root);
  if (store === null) throw new Error("repository race v2 store is absent");
  let reclaimedEntries = 0;
  for (let mutation = 1; mutation <= 4; mutation += 1) {
    await writeFile(source, `export const publisherValue = ${String(mutation)};\n`, "utf8");
    const [, gc] = await Promise.all([
      service.rebuild(signal),
      store.collectGarbage({ dryRun: false, signal }),
    ]);
    reclaimedEntries += gc.gcReclaimedEntries;
  }
  reclaimedEntries += await sweepToFixedPoint(store, signal);
  const [status, roots, pending, leases] = await Promise.all([
    DefaultRepositoryNavigationService.inspect(root),
    readdir(store.paths.rootsRoot),
    readdir(store.paths.gcPendingRoot),
    readdir(store.paths.leasesRoot),
  ]);
  if (status.indexState !== "ready" || roots.length !== 1 || pending.length !== 0 || leases.length !== 0) {
    throw new Error("repository publisher/GC race did not converge to one ready root");
  }
  return Object.freeze({ reclaimedEntries, remainingRoots: roots.length });
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const manifestPath = contained(workspaceRoot, args.manifest, "manifest");
  const reportPath = contained(workspaceRoot, args.report, "report");
  const reportRelative = relative(workspaceRoot, reportPath).split(sep).join("/");
  if (!reportRelative.startsWith(".bornagent/evals/repository-cache/")) {
    throw new TypeError("repository cache race report must be below .bornagent/evals/repository-cache");
  }
  const [{ manifest }, manifestSource] = await Promise.all([
    readRepositoryCacheEvidenceManifest(manifestPath),
    readFile(manifestPath),
  ]);
  const profile = manifest.candidateProfiles.find((value) => value.candidateId === args.candidate);
  if (profile === undefined || !profile.capabilities.includes("rooted_gc_v2") || !profile.capabilities.includes("production_selected_v2")) {
    throw new Error("repository cache race candidate lacks its required capabilities");
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("repository cache race cancelled"));
  process.once("SIGINT", interrupt);
  const attempts: Array<Readonly<Record<string, unknown>>> = [];
  try {
    for (let iteration = 0; iteration < args.repeat; iteration += 1) {
      for (const scenario of args.scenarios) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const root = await mkdtemp(join(tmpdir(), `bornagent-cache-race-${scenario}-`));
        try {
          const counters = scenario === "reader_gc"
            ? await runReaderGc(root, controller.signal)
            : await runPublisherGc(root, controller.signal);
          attempts.push(Object.freeze({ counters, iteration, scenario, status: "pass" }));
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
  }
  const body = Object.freeze({
    attempts: Object.freeze(attempts),
    candidate: args.candidate,
    manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
    platform: process.platform,
    repeat: args.repeat,
    scenarios: args.scenarios,
    schemaVersion: 1,
    status: "pass",
  });
  const report = Object.freeze({ ...body, reportSha256: sha256Canonical(body) });
  await atomicWrite(reportPath, `${canonicalJson(report)}\n`);
  process.stdout.write(`${canonicalJson({ path: reportRelative, reportSha256: report.reportSha256, status: report.status })}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof Error && error.message.includes("cancelled")) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 130;
  } else {
    throw error;
  }
}
