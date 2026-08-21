import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  createRepositoryCacheBenchmarkReport,
  evaluateRepositoryCacheEvidence,
  parseRepositoryCacheBenchmarkReport,
  parseRepositoryCacheEvidenceManifest,
  RepositoryCacheEvidenceError,
  sha256Bytes,
  verifyRepositoryCacheEvidenceReceipt,
  writeRepositoryCacheEvidenceReceiptNoReplace,
  type RepositoryCacheBenchmarkReportInputV1,
  type RepositoryCacheEvidenceManifestV1,
  type RepositoryCacheWorkCountersV1,
} from "../../src/repository-intelligence/benchmark/repository-cache-evidence.js";
import {
  installRepositoryCacheBenchmarkGuard,
  RepositoryCacheBenchmarkGuardError,
} from "../../src/repository-intelligence/benchmark/repository-cache-benchmark-guard.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const manifestPath = resolve(workspaceRoot, "tests/evidence/repository-intelligence-cache-optimization-v1.json");
const manifestSource = await import("node:fs/promises").then(async ({ readFile }) => readFile(manifestPath, "utf8"));
const manifest = parseRepositoryCacheEvidenceManifest(manifestSource);
const temporaryRoots: string[] = [];
const fingerprintSha256 = "b".repeat(64);

function unavailableCounters(): RepositoryCacheWorkCountersV1 {
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
    logicalReachableBytes: null,
    managedPhysicalBytes: null,
    objectsCreated: null,
    objectsOpened: null,
    objectsReused: null,
    observedCacheRegularFileCount: 5,
    observedCacheRootBytes: 1_024,
    pointerBytesRead: null,
    protectedV1Bytes: null,
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
  });
}

function validReportInput(
  selectedManifest: RepositoryCacheEvidenceManifestV1 = manifest,
): RepositoryCacheBenchmarkReportInputV1 {
  const profile = selectedManifest.candidateProfiles[0]!;
  const corpus = selectedManifest.corpora[0]!;
  return {
    arch: "x64",
    candidateCapabilitySha256: profile.candidateCapabilitySha256,
    candidateCompositionSha256: profile.candidateCompositionSha256,
    candidateId: profile.candidateId,
    capabilities: profile.capabilities,
    cases: selectedManifest.traceCases.map((definition) => {
      const missing = definition.requiredCapabilities.filter((value) => !profile.capabilities.includes(value));
      if (missing.length > 0) {
        return {
          caseId: definition.caseId,
          reason: `missing_capability:${missing.join(",")}`,
          samples: [],
          status: "not_applicable" as const,
        };
      }
      const sample = Object.freeze({
        buildMode: definition.caseId === "C8A" ? "rejected" as const : "cold" as const,
        counters: unavailableCounters(),
        diagnosticDurationMs: null,
        errorCode: definition.caseId === "C8A" ? "repository_engine_asset_invalid" : null,
        generationSha256: definition.caseId === "C8A" ? null : sha256Canonical({ caseId: definition.caseId, generation: 1 }),
        outcomeSha256: sha256Canonical({ caseId: definition.caseId, outcome: "canonical" }),
      });
      return {
        caseId: definition.caseId,
        reason: null,
        samples: Array.from({ length: definition.minimumSamples }, () => sample),
        status: "pass" as const,
      };
    }),
    checkout: { fingerprintSha256, headSha256: "a".repeat(40) },
    command: ["corepack", "pnpm", "repository:cache:benchmark"],
    corpus,
    evidenceId: "RIC-E001-V1-BASELINE",
    guard: {
      credentialReadAttemptCount: 0,
      identitySha256: selectedManifest.guard.identitySha256,
      networkAttemptCount: 0,
    },
    manifestSha256: sha256Bytes(manifestSource),
    nodeVersion: process.version,
    platform: process.platform as "linux" | "win32",
    reportId: "repository-cache-benchmark-report-v1",
    schemaVersion: 1,
    storagePolicySha256: selectedManifest.storagePolicySha256,
  };
}

function evaluate(input: RepositoryCacheBenchmarkReportInputV1 = validReportInput(), source = manifestSource) {
  return evaluateRepositoryCacheEvidence({
    context: { checkoutFingerprintSha256: fingerprintSha256, nodeVersion: process.version, platform: process.platform as "linux" | "win32" },
    evidenceId: "RIC-E001-V1-BASELINE",
    manifest,
    manifestSource: source,
    now: new Date("2026-08-21T00:00:00.000Z"),
    report: createRepositoryCacheBenchmarkReport(input),
  });
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryCacheEvidenceError);
    expect((error as RepositoryCacheEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectCodeAsync(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryCacheEvidenceError);
    expect((error as RepositoryCacheEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-repository-cache-evidence-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("RIC0 repository cache evidence contract", () => {
  test("accepts the exact manifest and report set", () => {
    const receipt = evaluate();
    expect(receipt.status).toBe("pass");
    expect(receipt.cases.filter((value) => value.status === "pass")).toHaveLength(13);
    expect(receipt.cases.filter((value) => value.status === "not_applicable")).toHaveLength(4);
  });

  test("denies a missing required case", () => {
    const input = validReportInput();
    const receipt = evaluate({ ...input, cases: input.cases.filter((value) => value.caseId !== "C0") });
    expect(receipt.status).toBe("fail");
    expect(receipt.cases).toContainEqual({ caseId: "C0", status: "missing" });
  });

  test("denies a duplicate evidence id", () => {
    const raw = JSON.parse(manifestSource) as { evidence: unknown[] };
    raw.evidence.push(raw.evidence[0]);
    expectCode(() => parseRepositoryCacheEvidenceManifest(JSON.stringify(raw)), "repository_cache_manifest_duplicate_id");
  });

  test("denies a renamed required case", () => {
    const raw = JSON.parse(canonicalJson(createRepositoryCacheBenchmarkReport(validReportInput()))) as {
      cases: Array<{ caseId: string }>;
    };
    raw.cases[0]!.caseId = "C0-renamed";
    expectCode(() => parseRepositoryCacheBenchmarkReport(JSON.stringify(raw)), "repository_cache_report_invalid");
  });

  test("denies an unexpected skip", () => {
    const input = validReportInput();
    const cases = input.cases.map((value) => value.caseId === "C0" ? { ...value, samples: [], status: "skipped" as const } : value);
    const receipt = evaluate({ ...input, cases });
    expect(receipt.status).toBe("fail");
    expect(receipt.cases).toContainEqual({ caseId: "C0", status: "unexpected_skip" });
  });

  test("denies a mismatched not-applicable reason", () => {
    const input = validReportInput();
    const cases = input.cases.map((value) => value.caseId === "C8B" ? { ...value, reason: "missing_capability:semantic_index_v1" } : value);
    const receipt = evaluate({ ...input, cases });
    expect(receipt.status).toBe("fail");
    expect(receipt.cases).toContainEqual({ caseId: "C8B", status: "fail" });
  });

  test("denies the wrong candidate", () => {
    expectCode(() => evaluate({ ...validReportInput(), candidateId: "sharded_cas_v2" }), "repository_cache_report_candidate_mismatch");
  });

  test("denies the wrong capability identity", () => {
    expectCode(() => evaluate({ ...validReportInput(), candidateCapabilitySha256: "c".repeat(64) }), "repository_cache_report_capability_mismatch");
  });

  test("denies the wrong corpus", () => {
    const input = validReportInput();
    expectCode(() => evaluate({ ...input, corpus: { ...input.corpus, workspaceSha256: "d".repeat(64) } }), "repository_cache_report_corpus_mismatch");
  });

  test("denies the wrong storage policy", () => {
    expectCode(() => evaluate({ ...validReportInput(), storagePolicySha256: "e".repeat(64) }), "repository_cache_report_policy_mismatch");
  });

  test("denies the wrong checkout platform or Node runtime", () => {
    const input = validReportInput();
    expectCode(() => evaluate({ ...input, nodeVersion: "v0.0.0" }), "repository_cache_report_execution_context_mismatch");
    expectCode(() => evaluate({ ...input, checkout: { ...input.checkout, fingerprintSha256: "f".repeat(64) } }), "repository_cache_report_execution_context_mismatch");
    expectCode(() => evaluate({ ...input, platform: process.platform === "win32" ? "linux" : "win32" }), "repository_cache_report_execution_context_mismatch");
  });

  test("denies a report hash mismatch", async () => {
    const root = await temporaryRoot();
    const report = createRepositoryCacheBenchmarkReport(validReportInput());
    const receipt = evaluateRepositoryCacheEvidence({
      evidenceId: "RIC-E001-V1-BASELINE",
      manifest,
      manifestSource,
      now: new Date("2026-08-21T00:00:00.000Z"),
      report,
    });
    const reportPath = join(root, "report.json");
    await writeFile(reportPath, `${canonicalJson({ ...report, arch: "changed" })}\n`, "utf8");
    await expectCodeAsync(
      async () => verifyRepositoryCacheEvidenceReceipt({ manifest, manifestSource, receipt, reportPath }),
      "repository_cache_report_hash_mismatch",
    );
  });

  test("denies a manifest hash mismatch", () => {
    expectCode(() => evaluate(validReportInput(), `${manifestSource}\n`), "repository_cache_manifest_hash_mismatch");
  });

  test("denies a network attempt", () => {
    const guard = installRepositoryCacheBenchmarkGuard();
    try {
      expect(() => fetch("https://example.invalid")).toThrow(RepositoryCacheBenchmarkGuardError);
      expect(guard.networkAttemptCount).toBe(1);
    } finally {
      guard.restore();
    }
  });

  test("denies an ambient credential read", () => {
    const guard = installRepositoryCacheBenchmarkGuard();
    try {
      expect(() => process.env.OPENAI_API_KEY).toThrow(RepositoryCacheBenchmarkGuardError);
      expect(guard.credentialReadAttemptCount).toBe(1);
    } finally {
      guard.restore();
    }
  });

  test("represents unavailable counters as null", () => {
    const counters = unavailableCounters();
    expect(counters.cacheBytesRead).toBeNull();
    expect(counters.dataObjectBytesDecodedByKind).toBeNull();
    expect(counters.observedCacheRootBytes).toBeGreaterThan(0);
  });

  test("reuses an equivalent no-replace receipt without changing its creation time", async () => {
    const root = await temporaryRoot();
    const report = createRepositoryCacheBenchmarkReport(validReportInput());
    const first = evaluateRepositoryCacheEvidence({
      evidenceId: "RIC-E001-V1-BASELINE",
      manifest,
      manifestSource,
      now: new Date("2026-08-21T00:00:00.000Z"),
      report,
    });
    const second = evaluateRepositoryCacheEvidence({
      evidenceId: "RIC-E001-V1-BASELINE",
      manifest,
      manifestSource,
      now: new Date("2026-08-21T01:00:00.000Z"),
      report,
    });
    const installed = await writeRepositoryCacheEvidenceReceiptNoReplace(root, first);
    const reused = await writeRepositoryCacheEvidenceReceiptNoReplace(root, second);
    expect(reused).toEqual(installed);
    expect(reused.receipt.createdAt).toBe("2026-08-21T00:00:00.000Z");
    expect(await readFile(reused.path, "utf8")).toBe(`${canonicalJson(first)}\n`);
  });
});
