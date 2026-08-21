import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../../completion/canonical-json.js";
import {
  installRepositoryCacheBenchmarkGuard,
} from "./repository-cache-benchmark-guard.js";

interface Arguments {
  readonly candidate: string;
  readonly manifest: string;
  readonly moduleCount?: number;
  readonly report: string;
  readonly sampleCount?: number;
}

function argumentsFrom(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) {
      throw new TypeError("protected repository cache benchmark expects unique flag/value pairs");
    }
    values.set(key, value);
  }
  const candidate = values.get("--candidate");
  const manifest = values.get("--manifest");
  const report = values.get("--report");
  const allowed = new Set(["--candidate", "--manifest", "--module-count", "--report", "--sample-count"]);
  if (candidate === undefined || manifest === undefined || report === undefined || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError("protected repository cache benchmark requires --candidate, --manifest, and --report");
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
    candidate,
    manifest,
    ...(moduleCount === undefined ? {} : { moduleCount }),
    report,
    ...(sampleCount === undefined ? {} : { sampleCount }),
  });
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

const args = argumentsFrom(process.argv.slice(2));
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const guard = installRepositoryCacheBenchmarkGuard();
try {
  const [{ runRepositoryCacheCandidate }, { readRepositoryCacheEvidenceManifest, repositoryCacheCandidateDefinitions }] = await Promise.all([
    import("./repository-cache-baseline-runner.js"),
    import("./repository-cache-evidence.js"),
  ]);
  if (!(args.candidate in repositoryCacheCandidateDefinitions)) throw new TypeError(`unknown repository cache candidate ${args.candidate}`);
  const manifestPath = resolve(workspaceRoot, args.manifest);
  const reportPath = resolve(workspaceRoot, args.report);
  const { manifest, source: manifestSource } = await readRepositoryCacheEvidenceManifest(manifestPath);
  const report = await runRepositoryCacheCandidate({
    candidateId: args.candidate as keyof typeof repositoryCacheCandidateDefinitions,
    command: [
      "corepack", "pnpm", "repository:cache:benchmark", "--",
      "--candidate", args.candidate,
      "--manifest", args.manifest,
      "--report", args.report,
    ],
    guard,
    manifest,
    manifestSource,
    ...(args.moduleCount === undefined ? {} : { moduleCount: args.moduleCount }),
    ...(args.sampleCount === undefined ? {} : { sampleCount: args.sampleCount }),
    workspaceRoot,
  });
  guard.assertClean();
  await atomicWrite(reportPath, `${canonicalJson(report)}\n`);
  process.stdout.write(`${JSON.stringify({ report: args.report, reportSha256: report.reportSha256 })}\n`);
} finally {
  guard.restore();
}
