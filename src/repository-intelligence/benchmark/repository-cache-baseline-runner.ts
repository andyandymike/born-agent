import { spawn } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { RepositoryIndexStore } from "../index-store.js";
import { RepositoryIndexV2Store, type RepositoryCacheRuntimeCountersV2 } from "../index-v2-store.js";
import { allRepositoryObjectRefsV2 } from "../index-v2-schema.js";
import type { DefaultRepositoryNavigationService, RepositoryNavigationService } from "../navigation-service.js";
import type { RepositoryCacheStorageVersion } from "../repository-cache-version.js";
import { createRepositoryEngineDecision } from "./engine-decision-schema.js";
import {
  materializeRepositoryCacheCorpus,
  repositoryCacheCorpusDefinitionSha256,
  repositoryCacheCorpusGeneratorVersion,
  repositoryCacheCorpusSeed,
  repositoryCacheCorpusWorkspaceSha256,
  repositoryCacheMediumCorpusV1,
  repositoryCacheMediumModuleCount,
  repositoryCacheModulePath,
  repositoryCacheQueryInputHashesV1,
} from "./repository-cache-corpus.js";
import type { RepositoryCacheBenchmarkGuard } from "./repository-cache-benchmark-guard.js";
import {
  createRepositoryCacheBenchmarkReport,
  repositoryCacheCandidateDefinitions,
  sha256Bytes,
  type RepositoryCacheCandidateId,
  type RepositoryCacheCapability,
  type RepositoryCacheBenchmarkReportV1,
  type RepositoryCacheEvidenceManifestV1,
  type RepositoryCacheTraceCaseId,
  type RepositoryCacheWorkCountersV1,
} from "./repository-cache-evidence.js";
import { captureRepositoryCacheCheckoutFingerprint } from "./repository-cache-checkout-fingerprint.js";

interface TraceSample {
  readonly buildMode: "cold" | "incremental" | "rejected" | "reused" | null;
  readonly counters: RepositoryCacheWorkCountersV1;
  readonly diagnosticDurationMs: number | null;
  readonly errorCode: string | null;
  readonly generationSha256: string | null;
  readonly outcomeSha256: string;
}

export interface RepositoryCacheBaselineRunnerOptions {
  readonly command: readonly string[];
  readonly guard: RepositoryCacheBenchmarkGuard;
  readonly manifest: RepositoryCacheEvidenceManifestV1;
  readonly manifestSource: string;
  readonly moduleCount?: number;
  readonly sampleCount?: number;
  readonly workspaceRoot: string;
}

export interface RepositoryCacheCandidateRunnerOptions extends RepositoryCacheBaselineRunnerOptions {
  readonly candidateId: RepositoryCacheCandidateId;
  readonly evidenceId?: string;
}

function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function withoutCursors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCursors);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    key === "nextCursor" || key === "repositoryStatusSha256" ? [] : [[key, withoutCursors(entry)]]));
}

async function treeMeasurements(root: string): Promise<{ readonly bytes: number; readonly files: number }> {
  let bytes = 0;
  let files = 0;
  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) return;
    if (metadata.isSymbolicLink()) throw new Error("repository cache benchmark refuses cache symlinks");
    if (metadata.isFile()) {
      bytes += metadata.size;
      files += 1;
      return;
    }
    if (!metadata.isDirectory()) throw new Error("repository cache benchmark encountered an unknown cache entry");
    for (const name of (await readdir(path)).sort((left, right) => left.localeCompare(right, "en"))) {
      await visit(join(path, name));
    }
  }
  await visit(root);
  return Object.freeze({ bytes, files });
}

function runtimeCounterProjection(runtime: RepositoryCacheRuntimeCountersV2 | null): Partial<RepositoryCacheWorkCountersV1> {
  return runtime === null ? {} : {
    cacheBytesDecoded: runtime.cacheBytesDecoded,
    cacheBytesRead: runtime.cacheBytesRead,
    cacheBytesWritten: runtime.cacheBytesWritten,
    dataObjectBytesDecodedByKind: runtime.dataObjectBytesReadByKind,
    dataObjectBytesReadByKind: runtime.dataObjectBytesReadByKind,
    objectsCreated: runtime.objectsCreated,
    objectsOpened: runtime.objectsOpened,
    objectsReused: runtime.objectsReused,
    pointerBytesRead: runtime.pointerBytesRead,
    rootMetadataBytesRead: runtime.rootMetadataBytesRead,
  };
}

async function counters(
  workspace: string,
  storageVersion: RepositoryCacheStorageVersion,
  runtime: RepositoryCacheRuntimeCountersV2 | null = null,
  overrides: Partial<RepositoryCacheWorkCountersV1> = {},
  includeGcState = false,
): Promise<RepositoryCacheWorkCountersV1> {
  const cacheRoot = join(workspace, ".bornagent", "cache", "repository-intelligence");
  const observed = await treeMeasurements(join(cacheRoot, storageVersion));
  const protectedV1 = await treeMeasurements(join(cacheRoot, "v1"));
  let v1Reachable: number | null = null;
  let v2State: Partial<RepositoryCacheWorkCountersV1> = {};
  if (storageVersion === "v1") {
    const store = await RepositoryIndexStore.openExisting(workspace);
    const current = await store?.readCurrent();
    if (store !== null && store !== undefined && current !== null && current !== undefined) {
      v1Reachable = (await treeMeasurements(store.paths.generationPath(current.generation.generationSha256))).bytes;
    }
  } else {
    const store = await RepositoryIndexV2Store.openExisting(workspace);
    if (store !== null) {
      const lease = await store.acquireCurrentLease();
      if (lease !== null) {
        try {
          const [rootMetadata, pointerMetadata] = await Promise.all([
            lstat(store.paths.rootManifestPath(lease.root.storageManifestSha256)),
            lstat(store.paths.currentPointerPath()),
          ]);
          v2State = {
            logicalReachableBytes: allRepositoryObjectRefsV2(lease.root).reduce(
              (total, ref) => total + ref.bytes,
              rootMetadata.size + pointerMetadata.size,
            ),
          };
        } finally {
          await lease.release();
        }
      }
    }
    if (store !== null && includeGcState) {
      const gc = await store.collectGarbage({ dryRun: true });
      const [leases, pending, quarantine, tmp] = await Promise.all([
        treeMeasurements(store.paths.leasesRoot),
        treeMeasurements(store.paths.gcPendingRoot),
        treeMeasurements(store.paths.quarantineRoot),
        treeMeasurements(store.paths.temporaryRoot),
      ]);
      v2State = {
        ...v2State,
        activeLeaseBytes: leases.bytes,
        activeLeaseCount: gc.activeLeaseCount,
        activeManagedBytes: observed.bytes - quarantine.bytes - tmp.bytes - pending.bytes,
        gcPendingBytes: pending.bytes,
        liveReachableBytes: gc.liveReachableBytes,
        logicalReachableBytes: gc.liveReachableBytes,
        managedPhysicalBytes: observed.bytes,
        quarantineBytes: quarantine.bytes,
        tmpBytes: tmp.bytes,
        unmanagedV2Bytes: 0,
        unreachableKnownBytes: gc.unreachableKnownBytes,
      };
    }
  }
  return Object.freeze({
    activeLeaseBytes: null,
    activeLeaseCount: null,
    activeManagedBytes: null,
    cacheBytesDecoded: null,
    cacheBytesRead: null,
    cacheBytesWritten: null,
    canonicalMismatchCount: 0,
    cleanFullFallbackCount: null,
    corruptFalseResultCount: 0,
    dataObjectBytesDecodedByKind: null,
    dataObjectBytesReadByKind: null,
    dependencyEdgesVisited: null,
    factsRecomputed: null,
    factsReused: null,
    factsValidated: null,
    gcPendingBytes: null,
    gcReclaimedBytes: null,
    liveReachableBytes: null,
    logicalReachableBytes: v1Reachable,
    managedPhysicalBytes: null,
    objectsCreated: null,
    objectsOpened: null,
    objectsReused: null,
    observedCacheRegularFileCount: observed.files,
    observedCacheRootBytes: observed.bytes,
    pointerBytesRead: null,
    protectedV1Bytes: protectedV1.bytes,
    quarantineBytes: null,
    queryDataObjectBytesDecoded: null,
    queryRecordsExamined: null,
    rootMetadataBytesRead: null,
    ruleFilesRead: null,
    sourceBytesHashed: null,
    sourceFilesStableRead: null,
    staleResultCount: 0,
    tmpBytes: null,
    unitsParsed: null,
    unitsRebound: null,
    unitsReparsed: null,
    unmanagedV2Bytes: null,
    unreachableKnownBytes: null,
    ...v2State,
    ...runtimeCounterProjection(runtime),
    ...overrides,
  });
}

async function sample(
  workspace: string,
  storageVersion: RepositoryCacheStorageVersion,
  input: Omit<TraceSample, "counters">,
  runtime: RepositoryCacheRuntimeCountersV2 | null = null,
  overrides: Partial<RepositoryCacheWorkCountersV1> = {},
  includeGcState = false,
): Promise<TraceSample> {
  return Object.freeze({ ...input, counters: await counters(
    workspace,
    storageVersion,
    runtime,
    overrides,
    includeGcState,
  ) });
}

async function cloneCurrentSources(workspace: string, target: string): Promise<void> {
  await cp(workspace, target, {
    filter: (source) => {
      const relative = source.slice(workspace.length).replaceAll("\\", "/").replace(/^\//u, "");
      return relative !== ".bornagent" && !relative.startsWith(".bornagent/");
    },
    recursive: true,
  });
}

async function assertCleanOracle(workspace: string, expectedGenerationSha256: string): Promise<void> {
  const oracleParent = await mkdtemp(join(tmpdir(), "bornagent-repository-cache-oracle-"));
  const oracle = join(oracleParent, "workspace");
  try {
    await cloneCurrentSources(workspace, oracle);
    const { DefaultRepositoryNavigationService } = await import("../navigation-service.js");
    const current = await (await DefaultRepositoryNavigationService.create(oracle, { cacheStorageVersion: "v1" })).rebuild(new AbortController().signal);
    if (current.stored.generation.generationSha256 !== expectedGenerationSha256) {
      throw new Error(`repository cache clean oracle mismatch: ${expectedGenerationSha256} != ${current.stored.generation.generationSha256}`);
    }
  } finally {
    await rm(oracleParent, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

async function allOutline(service: RepositoryNavigationService) {
  const page = await service.outline({ limit: 32, max_depth: 2, path: "src/fanout" }, new AbortController().signal);
  return Object.freeze({ envelope: withoutCursors({ ...page, result: [] }), results: page.result });
}

async function allSymbols(service: RepositoryNavigationService) {
  const page = await service.findSymbols({ limit: 32, query: "Hot" }, new AbortController().signal);
  return Object.freeze({ envelope: withoutCursors({ ...page, result: [] }), results: page.result });
}

async function allReferences(
  service: RepositoryNavigationService,
  target: string,
) {
  const page = await service.findReferences({
    limit: 64,
    relations: ["call", "import", "read"],
    symbol_id: target,
  }, new AbortController().signal);
  return Object.freeze({ envelope: withoutCursors({ ...page, result: [] }), results: page.result });
}

async function querySet(workspace: string, target: string, existing?: {
  readonly outline: DefaultRepositoryNavigationService;
  readonly references: DefaultRepositoryNavigationService;
  readonly symbols: DefaultRepositoryNavigationService;
}, storageVersion: RepositoryCacheStorageVersion = "v1", persistentFactsEnabled = false) {
  const { DefaultRepositoryNavigationService } = await import("../navigation-service.js");
  const services = existing ?? {
    outline: await DefaultRepositoryNavigationService.create(workspace, { cacheStorageVersion: storageVersion, persistentFactsEnabled }),
    references: await DefaultRepositoryNavigationService.create(workspace, { cacheStorageVersion: storageVersion, persistentFactsEnabled }),
    symbols: await DefaultRepositoryNavigationService.create(workspace, { cacheStorageVersion: storageVersion, persistentFactsEnabled }),
  };
  for (const service of Object.values(services)) service.resetRepositoryCacheRuntimeCounters();
  const [outline, symbols, references] = await Promise.all([
    allOutline(services.outline),
    allSymbols(services.symbols),
    allReferences(services.references, target),
  ]);
  const measured = [
    ["Q-OUTLINE-SUBTREE", services.outline.repositoryCacheRuntimeCounters()],
    ["Q-REFERENCES-HOT", services.references.repositoryCacheRuntimeCounters()],
    ["Q-SYMBOL-FUZZY", services.symbols.repositoryCacheRuntimeCounters()],
  ] as const;
  const runtime = measured.map(([, value]) => value).filter(
    (value): value is RepositoryCacheRuntimeCountersV2 => value !== null,
  ).reduce<RepositoryCacheRuntimeCountersV2 | null>((total, value) => total === null ? value : Object.freeze({
    cacheBytesDecoded: total.cacheBytesDecoded + value.cacheBytesDecoded,
    cacheBytesRead: total.cacheBytesRead + value.cacheBytesRead,
    cacheBytesWritten: total.cacheBytesWritten + value.cacheBytesWritten,
    dataObjectBytesReadByKind: Object.fromEntries(Object.keys(value.dataObjectBytesReadByKind).map((kind) => [
      kind,
      total.dataObjectBytesReadByKind[kind as keyof typeof value.dataObjectBytesReadByKind] + value.dataObjectBytesReadByKind[kind as keyof typeof value.dataObjectBytesReadByKind],
    ])) as unknown as RepositoryCacheRuntimeCountersV2["dataObjectBytesReadByKind"],
    objectsCreated: total.objectsCreated + value.objectsCreated,
    objectsOpened: total.objectsOpened + value.objectsOpened,
    objectsReused: total.objectsReused + value.objectsReused,
    pointerBytesRead: total.pointerBytesRead + value.pointerBytesRead,
    rootMetadataBytesRead: total.rootMetadataBytesRead + value.rootMetadataBytesRead,
  }), null);
  const queryDataObjectBytesDecoded = Object.fromEntries(measured.flatMap(([queryId, value]) =>
    value === null ? [] : [[queryId, value.cacheBytesDecoded]]));
  return Object.freeze({
    outcomeSha256: sha256Canonical({ outline, references, symbols }),
    queryDataObjectBytesDecoded,
    runtime,
    services,
  });
}

async function engineIdentityRejection(
  workspace: string,
  packageRoot: string,
  storageVersion: RepositoryCacheStorageVersion,
  persistentFactsEnabled: boolean,
): Promise<string> {
  const policyRoot = join(packageRoot, "policies", "repository-intelligence");
  await mkdir(policyRoot, { recursive: true });
  const sourceRoot = resolve(import.meta.dirname, "../../..");
  await cp(join(sourceRoot, "policies", "repository-intelligence", "assets-lock-v1.json"), join(policyRoot, "assets-lock-v1.json"));
  const raw = parseStrictJson(await readFile(join(sourceRoot, "policies", "repository-intelligence", "engine-v1.json"), "utf8")) as Record<string, unknown>;
  const oldIdentity = raw.engineIdentity as Record<string, unknown>;
  const identityUnsigned: Record<string, unknown> = {
    ...oldIdentity,
    adapterVersion: "bornagent-typescript-adapter-v2-evidence-change",
  };
  delete identityUnsigned.identitySha256;
  const decision = createRepositoryEngineDecision({
    baselineReportSha256: raw.baselineReportSha256 as string,
    candidateReportSha256: raw.candidateReportSha256 as string,
    contextReductionGatePassed: raw.contextReductionGatePassed as boolean,
    correctnessGatePassed: raw.correctnessGatePassed as boolean,
    engineIdentity: { ...identityUnsigned, identitySha256: sha256Canonical(identityUnsigned) } as never,
    freshnessGatePassed: raw.freshnessGatePassed as boolean,
    securityGatePassed: raw.securityGatePassed as boolean,
    suiteSha256: raw.suiteSha256 as string,
  });
  await writeFile(join(policyRoot, "engine-v1.json"), `${canonicalJson(decision)}\n`, "utf8");
  const { DefaultRepositoryNavigationService } = await import("../navigation-service.js");
  try {
    await DefaultRepositoryNavigationService.create(workspace, { cacheStorageVersion: storageVersion, packageRoot, persistentFactsEnabled });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "repository_engine_asset_invalid") {
      return String(error.code);
    }
    throw error;
  }
  throw new Error("changed engine identity was unexpectedly accepted");
}

async function twoProcessWriters(
  workspace: string,
  storageVersion: RepositoryCacheStorageVersion,
  persistentFactsEnabled: boolean,
): Promise<{ readonly buildModes: readonly string[]; readonly generationSha256: string }> {
  const currentModule = fileURLToPath(import.meta.url);
  const workerExtension = currentModule.endsWith(".ts") ? ".ts" : ".js";
  const worker = fileURLToPath(new URL(`./repository-cache-writer-worker${workerExtension}`, import.meta.url));
  const workerArguments = workerExtension === ".ts"
    ? ["--import", "tsx", worker, workspace, storageVersion, String(persistentFactsEnabled)]
    : [worker, workspace, storageVersion, String(persistentFactsEnabled)];
  const run = () => {
    const child = spawn(process.execPath, workerArguments, {
      cwd: resolve(import.meta.dirname, "../../.."),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    const result = new Promise<{ readonly buildMode: string; readonly generationSha256: string }>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0 || signal !== null) {
          reject(new Error(`repository cache writer worker failed (${String(code)}, ${String(signal)}): ${stderr}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout.trim()) as { readonly buildMode: string; readonly generationSha256: string });
        } catch (error) {
          reject(new Error("repository cache writer worker returned invalid JSON", { cause: error }));
        }
      });
    });
    return Object.freeze({ child, result });
  };
  const first = run();
  let firstComplete = false;
  void first.result.finally(() => { firstComplete = true; }).catch(() => undefined);
  const lockPath = join(workspace, ".bornagent", "cache", "repository-intelligence", storageVersion, "locks", "index.lock");
  for (let attempt = 0; attempt < 1_000 && !firstComplete; attempt += 1) {
    try {
      const source = await readFile(lockPath, "utf8");
      const record = parseStrictJson(source);
      if (typeof record === "object" && record !== null && !Array.isArray(record) &&
          "schemaVersion" in record && record.schemaVersion === 1 && "nonce" in record) break;
    } catch {
      // The contender is intentionally withheld until the writer's lock record has
      // reached its existing strict-reader linearization point.
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  const second = run();
  const results = await Promise.all([first.result, second.result]);
  const generations = new Set(results.map((value) => value.generationSha256));
  if (generations.size !== 1) throw new Error("two repository cache writers selected different generations");
  return Object.freeze({
    buildModes: Object.freeze(results.map((value) => value.buildMode).sort()),
    generationSha256: results[0]!.generationSha256,
  });
}

async function runSequence(
  moduleCount: number,
  storageVersion: RepositoryCacheStorageVersion,
  capabilities: readonly RepositoryCacheCapability[],
): Promise<ReadonlyMap<RepositoryCacheTraceCaseId, TraceSample>> {
  const parent = await mkdtemp(join(tmpdir(), "bornagent-repository-cache-baseline-"));
  const workspace = join(parent, "workspace");
  await mkdir(workspace);
  await materializeRepositoryCacheCorpus(workspace, moduleCount);
  const samples = new Map<RepositoryCacheTraceCaseId, TraceSample>();
  try {
    const { DefaultRepositoryNavigationService } = await import("../navigation-service.js");
    const { symbolId } = await import("../navigation-cursor.js");
    const persistentFactsEnabled = capabilities.includes("persistent_facts_v1");
    const serviceForOperation = async () => {
      const service = await DefaultRepositoryNavigationService.create(workspace, { cacheStorageVersion: storageVersion, persistentFactsEnabled });
      service.resetRepositoryCacheRuntimeCounters();
      return service;
    };

    let started = process.hrtime.bigint();
    let operationService = await serviceForOperation();
    let current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    samples.set("C0", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    const status = await operationService.status();
    samples.set("C1A", await sample(workspace, storageVersion, {
      buildMode: "reused",
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(status),
    }, operationService.repositoryCacheRuntimeCounters()));

    const hot = current.stored.records.symbols.find((value) => value.name === "hot");
    if (hot === undefined) throw new Error("deterministic corpus has no hot symbol");
    const hotId = symbolId(current.stored.generation.generationSha256, hot.recordId);
    started = process.hrtime.bigint();
    const coldQueries = await querySet(workspace, hotId, undefined, storageVersion, persistentFactsEnabled);
    samples.set("C1B", await sample(workspace, storageVersion, {
      buildMode: "reused",
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: coldQueries.outcomeSha256,
    }, coldQueries.runtime, { queryDataObjectBytesDecoded: coldQueries.queryDataObjectBytesDecoded }));
    started = process.hrtime.bigint();
    const warmQueries = await querySet(workspace, hotId, coldQueries.services, storageVersion, persistentFactsEnabled);
    samples.set("C1C", await sample(workspace, storageVersion, {
      buildMode: "reused",
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: warmQueries.outcomeSha256,
    }, warmQueries.runtime, { queryDataObjectBytesDecoded: warmQueries.queryDataObjectBytesDecoded }));
    if (coldQueries.outcomeSha256 !== warmQueries.outcomeSha256) throw new Error("warm query result differs from isolated first query");

    if (capabilities.includes("sharded_storage_v2")) {
      const store = await RepositoryIndexV2Store.openExisting(workspace);
      if (store === null) throw new Error("sharded cache candidate did not create a v2 store");
      store.resetCounters();
      const stored = await store.readCurrent();
      if (stored === null || stored.generation.generationSha256 !== current.stored.generation.generationSha256) {
        throw new Error("sharded cache semantic generation differs from the service generation");
      }
      samples.set("C8B", await sample(workspace, storageVersion, {
        buildMode: "reused",
        diagnosticDurationMs: null,
        errorCode: null,
        generationSha256: stored.generation.generationSha256,
        outcomeSha256: sha256Canonical({
          generation: stored.generation,
          records: stored.records,
          storageManifestSha256: stored.storageRoot.storageManifestSha256,
        }),
      }, store.snapshotCounters()));
    }

    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    samples.set("C2", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    const leaf = join(workspace, ...repositoryCacheModulePath(moduleCount - 1).split("/"));
    await writeFile(leaf, `${await readFile(leaf, "utf8")}\n// implementation-only evidence edit\n`, "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C3", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters(), current.incrementalPlan === null ? {} : {
      dependencyEdgesVisited: current.incrementalPlan.dependencyInvalidated.length,
      factsRecomputed: current.incrementalPlan.reparsedUnits.length,
      factsReused: current.incrementalPlan.reusedUnits.length,
      factsValidated: current.stored.records.units.length,
    }));

    if (capabilities.includes("persistent_facts_v1")) {
      const store = await RepositoryIndexV2Store.openExisting(workspace);
      if (store === null) throw new Error("persistent fact candidate did not create a v2 store");
      store.resetCounters();
      const lease = await store.acquireCurrentLease();
      if (lease === null) throw new Error("persistent fact candidate has no current root");
      try {
        const receipts = await lease.readFactReceipts();
        if (receipts.length === 0) throw new Error("persistent fact candidate root has no receipts");
        samples.set("C8C", await sample(workspace, storageVersion, {
          buildMode: current.buildMode,
          diagnosticDurationMs: null,
          errorCode: null,
          generationSha256: current.stored.generation.generationSha256,
          outcomeSha256: sha256Canonical(receipts),
        }, store.snapshotCounters(), current.incrementalPlan === null ? {} : {
          factsRecomputed: current.incrementalPlan.reparsedUnits.length,
          factsReused: current.incrementalPlan.reusedUnits.length,
          factsValidated: receipts.length,
        }));
      } finally {
        await lease.release();
      }
    }

    const core = join(workspace, "src", "modules", "module-0000.ts");
    await writeFile(core, [
      "export interface HotInput { readonly label?: string; readonly value: number; }",
      "export function hot(input: HotInput): number { return input.value + 1; }",
      "export const coreVersion = 1;",
      "",
    ].join("\n"), "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C4", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    await writeFile(core, [
      "export interface HotInput { readonly label?: string; readonly value: number; }",
      "export function hot(input: HotInput, adjustment = 1): number { return input.value + adjustment; }",
      "export const coreVersion = 2;",
      "",
    ].join("\n"), "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C5", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    const renameIndex = Math.max(2, moduleCount - 2);
    const deleteIndex = Math.max(3, moduleCount - 1);
    const renamedSource = join(workspace, ...repositoryCacheModulePath(renameIndex).split("/"));
    const renamedTarget = join(dirname(renamedSource), `renamed-${String(renameIndex).padStart(4, "0")}.ts`);
    await rename(renamedSource, renamedTarget);
    await rm(join(workspace, ...repositoryCacheModulePath(deleteIndex).split("/")));
    await writeFile(join(workspace, "src", "modules", "added-evidence.ts"), "export const addedEvidence = 1;\n", "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C6", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    await writeFile(join(workspace, "src", "fanout", "AGENTS.md"), "# Fanout rule changed for the deterministic trace.\n", "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C7", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    const changedPackageRoot = join(parent, "changed-package");
    started = process.hrtime.bigint();
    const engineError = await engineIdentityRejection(workspace, changedPackageRoot, storageVersion, persistentFactsEnabled);
    samples.set("C8A", await sample(workspace, storageVersion, {
      buildMode: "rejected",
      diagnosticDurationMs: elapsed(started),
      errorCode: engineError,
      generationSha256: null,
      outcomeSha256: sha256Canonical({ errorCode: engineError }),
    }));

    await writeFile(join(workspace, "src", "global-evidence.ts"), [
      "declare global { interface Window { bornagentEvidence?: string; } }",
      "export async function dynamicEvidence(name: string) { return import(name); }",
      "",
    ].join("\n"), "utf8");
    started = process.hrtime.bigint();
    operationService = await serviceForOperation();
    current = await operationService.ensureCurrent({ allowBuild: true, signal: new AbortController().signal });
    await assertCleanOracle(workspace, current.stored.generation.generationSha256);
    samples.set("C9", await sample(workspace, storageVersion, {
      buildMode: current.buildMode,
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: current.stored.generation.generationSha256,
      outcomeSha256: sha256Canonical(current.stored.generation),
    }, operationService.repositoryCacheRuntimeCounters()));

    await writeFile(join(workspace, "src", "modules", "two-writer-edit.ts"), "export const twoWriterEdit = true;\n", "utf8");
    started = process.hrtime.bigint();
    const writers = await twoProcessWriters(workspace, storageVersion, persistentFactsEnabled);
    await assertCleanOracle(workspace, writers.generationSha256);
    samples.set("C10", await sample(workspace, storageVersion, {
      buildMode: "reused",
      diagnosticDurationMs: elapsed(started),
      errorCode: null,
      generationSha256: writers.generationSha256,
      outcomeSha256: sha256Canonical(writers),
    }));

    if (capabilities.includes("lease_protocol_v2") && capabilities.includes("rooted_gc_v2")) {
      const store = await RepositoryIndexV2Store.openExisting(workspace);
      if (store === null) throw new Error("rooted GC candidate did not create a v2 store");
      const lease = await store.acquireCurrentLease();
      if (lease === null) throw new Error("rooted GC candidate has no current root to lease");
      try {
        store.resetCounters();
        const protectedPlan = await store.collectGarbage({ dryRun: true });
        if (protectedPlan.activeLeaseCount < 1) throw new Error("rooted GC did not observe the active reader lease");
        samples.set("C11", await sample(workspace, storageVersion, {
          buildMode: "reused",
          diagnosticDurationMs: null,
          errorCode: null,
          generationSha256: lease.root.generation.generationSha256,
          outcomeSha256: sha256Canonical({
            activeLeaseCount: protectedPlan.activeLeaseCount,
            currentRootPreserved: true,
            storageManifestSha256: lease.root.storageManifestSha256,
          }),
        }, store.snapshotCounters(), {
          gcReclaimedBytes: protectedPlan.gcReclaimedBytes,
        }, true));
      } finally {
        await lease.release();
      }

      let lastGc;
      let passes = 0;
      do {
        lastGc = await store.collectGarbage({ dryRun: false });
        passes += 1;
      } while ((lastGc.unreachableKnownBytes > 0 || lastGc.gcReclaimedBytes > 0) && passes < 67);
      if (lastGc.unreachableKnownBytes !== 0 || lastGc.gcReclaimedBytes !== 0) {
        throw new Error("rooted GC failed to reach a strict zero-work stable pass");
      }
      const selected = await store.readCurrent();
      if (selected === null || selected.generation.generationSha256 !== writers.generationSha256) {
        throw new Error("rooted GC changed or deleted the current generation");
      }
      samples.set("C12", await sample(workspace, storageVersion, {
        buildMode: "reused",
        diagnosticDurationMs: null,
        errorCode: null,
        generationSha256: selected.generation.generationSha256,
        outcomeSha256: sha256Canonical({ passes, stable: true }),
      }, store.snapshotCounters(), {
        gcReclaimedBytes: lastGc.gcReclaimedBytes,
      }, true));
    }
    return samples;
  } finally {
    await rm(parent, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

export async function runRepositoryCacheCandidate(
  options: RepositoryCacheCandidateRunnerOptions,
): Promise<RepositoryCacheBenchmarkReportV1> {
  const moduleCount = options.moduleCount ?? repositoryCacheMediumModuleCount;
  const sampleCount = options.sampleCount ?? 7;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 32) throw new TypeError("invalid repository cache sample count");
  const definition = repositoryCacheCandidateDefinitions[options.candidateId];
  const evidenceId = options.evidenceId ?? definition.evidenceId;
  const evidence = options.manifest.evidence.find((value) => value.evidenceId === evidenceId);
  if (evidence === undefined || evidence.candidateId !== options.candidateId) {
    throw new Error(`repository cache manifest has no ${evidenceId} evidence for ${options.candidateId}`);
  }
  const profile = options.manifest.candidateProfiles.find((value) => value.candidateId === evidence.candidateId)!;
  const byCase = new Map<RepositoryCacheTraceCaseId, TraceSample[]>();
  for (let index = 0; index < sampleCount; index += 1) {
    const sequence = await runSequence(moduleCount, definition.storageVersion, profile.capabilities);
    for (const [caseId, value] of sequence) {
      const values = byCase.get(caseId) ?? [];
      values.push(value);
      byCase.set(caseId, values);
    }
  }
  options.guard.assertClean();
  const manifestCorpus = options.manifest.corpora.find((value) => value.corpusId === evidence.corpusId)!;
  if (moduleCount === repositoryCacheMediumModuleCount && canonicalJson(manifestCorpus) !== canonicalJson(repositoryCacheMediumCorpusV1)) {
    throw new Error("repository cache manifest medium corpus does not match the deterministic generator");
  }
  const manifestQueries = Object.fromEntries(options.manifest.queries.map((value) => [value.queryId, value.inputSha256]));
  if (canonicalJson(manifestQueries) !== canonicalJson(repositoryCacheQueryInputHashesV1)) {
    throw new Error("repository cache manifest query hashes do not match the fixed query inputs");
  }
  const corpus = moduleCount === repositoryCacheMediumModuleCount ? manifestCorpus : Object.freeze({
    corpusId: `tiny-deterministic-${String(moduleCount)}`,
    definitionSha256: repositoryCacheCorpusDefinitionSha256,
    fileCount: moduleCount,
    generatorVersion: repositoryCacheCorpusGeneratorVersion,
    seed: repositoryCacheCorpusSeed,
    workspaceSha256: repositoryCacheCorpusWorkspaceSha256(moduleCount),
  });
  const checkout = await captureRepositoryCacheCheckoutFingerprint(options.workspaceRoot);
  const reportCases = options.manifest.traceCases.map((definition) => {
    const missing = definition.requiredCapabilities.filter((value) => !profile.capabilities.includes(value));
    if (missing.length > 0) {
      return {
        caseId: definition.caseId,
        reason: `missing_capability:${missing.join(",")}`,
        samples: [],
        status: "not_applicable" as const,
      };
    }
    const values = byCase.get(definition.caseId) ?? [];
    return {
      caseId: definition.caseId,
      reason: values.length === sampleCount ? null : "runner_case_missing",
      samples: values,
      status: values.length === sampleCount ? "pass" as const : "fail" as const,
    };
  });
  return createRepositoryCacheBenchmarkReport({
    arch: process.arch,
    candidateCapabilitySha256: profile.candidateCapabilitySha256,
    candidateCompositionSha256: profile.candidateCompositionSha256,
    candidateId: profile.candidateId,
    capabilities: profile.capabilities,
    cases: reportCases,
    checkout,
    command: [...options.command],
    corpus,
    evidenceId: evidence.evidenceId,
    guard: {
      credentialReadAttemptCount: options.guard.credentialReadAttemptCount,
      identitySha256: options.manifest.guard.identitySha256,
      networkAttemptCount: options.guard.networkAttemptCount,
    },
    manifestSha256: sha256Bytes(options.manifestSource),
    nodeVersion: process.version,
    platform: process.platform as "linux" | "win32",
    reportId: "repository-cache-benchmark-report-v1",
    schemaVersion: 1,
    storagePolicySha256: options.manifest.storagePolicySha256,
  });
}

export async function runRepositoryCacheBaseline(
  options: RepositoryCacheBaselineRunnerOptions,
): Promise<RepositoryCacheBenchmarkReportV1> {
  return runRepositoryCacheCandidate({
    ...options,
    candidateId: "monolith_v1",
    evidenceId: "RIC-E001-V1-BASELINE",
  });
}
