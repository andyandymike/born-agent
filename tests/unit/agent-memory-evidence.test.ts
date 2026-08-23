import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  agentMemoryOffConfigSha256,
  AgentMemoryEvidenceError,
  createAgentMemoryBaselineReport,
  evaluateAgentMemoryEvidence,
  parseAgentMemoryBaselineReport,
  parseAgentMemoryEvidenceManifest,
  parseAgentMemoryEvidenceReceipt,
  sha256Bytes,
  writeAgentMemoryBaselineReport,
  writeAgentMemoryEvidenceReceipt,
  type AgentMemoryBaselineCaseReportV1,
  type AgentMemoryEvidenceManifestV1,
} from "../../src/memory/benchmark/agent-memory-evidence.js";
import {
  AgentMemoryBenchmarkGuardError,
  installAgentMemoryBenchmarkGuard,
  sanitizedAgentMemoryBenchmarkEnvironment,
} from "../../src/memory/benchmark/agent-memory-benchmark-guard.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const manifestSource = await readFile(
  resolve(workspaceRoot, "tests/evidence/agent-memory-v1.json"),
  "utf8",
);
const manifest = parseAgentMemoryEvidenceManifest(manifestSource);
const temporaryRoots: string[] = [];
const checkoutFingerprintSha256 = "c".repeat(64);
const inputFiles = Object.freeze(
  manifest.characterizationInputs.map((path, index) => Object.freeze({
    bytes: index + 1,
    path,
    sha256: sha256Canonical({ path }),
  })),
);
const inputFingerprintSha256 = sha256Canonical(inputFiles);

function caseReport(
  definition: AgentMemoryEvidenceManifestV1["cases"][number],
): AgentMemoryBaselineCaseReportV1 {
  const planned = definition.expectedOutcome === "planned";
  return Object.freeze({
    archivedItemCount: planned ? 0 : null,
    canonicalContextSha256: planned
      ? sha256Canonical({ caseId: definition.caseId, context: "synthetic" })
      : null,
    caseDefinitionSha256: sha256Canonical(definition),
    caseId: definition.caseId,
    durationMs: 1,
    errorCode:
      definition.expectedOutcome === "context_protected_overflow" ||
      definition.expectedOutcome === "context_unsafe_compaction"
        ? definition.expectedOutcome
        : null,
    eventCount: definition.expectedEventCount,
    fullEstimatedInputTokens: 100,
    includedItemCount: planned ? 2 : null,
    outcome: definition.expectedOutcome,
    plannedInputTokens: planned ? 80 : null,
    projectedItemCount: 3,
    protectedEstimatedTokens: 50,
    sourceEventBytesRead: definition.expectedEventCount * 100,
    sourceEventsApplied: definition.expectedEventCount,
  });
}

function validReportInput() {
  return {
    cases: manifest.cases.map(caseReport),
    checkout: {
      fileCount: 100,
      fingerprintSha256: checkoutFingerprintSha256,
      headSha256: "a".repeat(40),
      totalBytes: 10_000,
    },
    credentialReadAttemptCount: 0,
    exactCommand: "pnpm memory:baseline",
    inputFiles,
    inputFingerprintSha256,
    manifest,
    manifestSource,
    networkAttemptCount: 0,
    nodeVersion: process.version,
    now: new Date("2026-08-23T00:00:00.000Z"),
    platform: process.platform as "linux" | "win32",
    providerCallCount: 0,
  } as const;
}

function validReport() {
  return createAgentMemoryBaselineReport(validReportInput());
}

function evaluate(
  report = validReport(),
  currentCheckout = checkoutFingerprintSha256,
) {
  return evaluateAgentMemoryEvidence({
    currentCheckoutFingerprintSha256: currentCheckout,
    currentInputFingerprintSha256: inputFingerprintSha256,
    manifest,
    manifestSource,
    report,
  });
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMemoryEvidenceError);
    expect((error as AgentMemoryEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectCodeAsync(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMemoryEvidenceError);
    expect((error as AgentMemoryEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      rm(root, { force: true, recursive: true })
    ),
  );
});

describe("AM0 agent memory evidence contract", () => {
  test("freezes the complete synthetic corpus, query, scope, and fault inventory", () => {
    expect(manifest.defaultMode).toBe("off");
    expect(manifest.cases).toHaveLength(36);
    expect(Math.max(...manifest.cases.map(({ expectedEventCount }) => expectedEventCount))).toBe(10_000);
    expect(new Set(manifest.cases.map(({ scenario }) => scenario)).size).toBe(7);
    expect(new Set(manifest.cases.map(({ expectedOutcome }) => expectedOutcome))).toEqual(
      new Set([
        "context_protected_overflow",
        "context_unsafe_compaction",
        "planned",
      ]),
    );
    expect(manifest.queries).toHaveLength(12);
    expect(manifest.scopes).toHaveLength(6);
    expect(manifest.faults).toHaveLength(10);
    expect(manifest.faults.every(({ providerCallCount }) => providerCallCount === 0)).toBe(true);
  });

  test("rejects duplicate case identities and stale collection roots", () => {
    const duplicate = JSON.parse(manifestSource) as Record<string, unknown> & {
      cases: unknown[];
    };
    duplicate.cases.push(duplicate.cases[0]);
    expectCode(
      () => parseAgentMemoryEvidenceManifest(JSON.stringify(duplicate)),
      "agent_memory_manifest_duplicate_id",
    );

    const stale = JSON.parse(manifestSource) as {
      cases: Array<{ payloadBytes: number }>;
    };
    stale.cases[0]!.payloadBytes += 1;
    expectCode(
      () => parseAgentMemoryEvidenceManifest(JSON.stringify(stale)),
      "agent_memory_manifest_root_mismatch",
    );
  });

  test("rejects contradictory scope and query oracles", () => {
    const scope = JSON.parse(manifestSource) as {
      scopeOracleSha256: string;
      scopes: Array<{ decision: string }>;
    };
    scope.scopes[1]!.decision = "allow";
    scope.scopeOracleSha256 = sha256Canonical(scope.scopes);
    expectCode(
      () => parseAgentMemoryEvidenceManifest(JSON.stringify(scope)),
      "agent_memory_manifest_scope_oracle_invalid",
    );

    const query = JSON.parse(manifestSource) as {
      queries: Array<{ scopeCaseId: string }>;
      queryOracleSha256: string;
    };
    query.queries[0]!.scopeCaseId = "missing-scope";
    query.queryOracleSha256 = sha256Canonical(query.queries);
    expectCode(
      () => parseAgentMemoryEvidenceManifest(JSON.stringify(query)),
      "agent_memory_manifest_query_scope_missing",
    );
  });

  test("strictly rejects duplicate JSON keys", () => {
    const finalBrace = manifestSource.lastIndexOf("}");
    const source = `${manifestSource.slice(0, finalBrace)},\n  "workPackage": "AM0"\n}\n`;
    expectCode(
      () => parseAgentMemoryEvidenceManifest(source),
      "agent_memory_manifest_invalid",
    );
  });

  test("binds a passing report and receipt to memory-off, checkout, and exact inputs", () => {
    const report = validReport();
    const receipt = evaluate(report);
    expect(receipt).toMatchObject({
      checkoutFingerprintSha256,
      corpusSha256: manifest.corpusDefinitionSha256,
      exactCommand: "pnpm memory:baseline",
      manifestSha256: sha256Bytes(manifestSource),
      memoryConfigSha256: agentMemoryOffConfigSha256,
      status: "pass",
      testsFailed: 0,
      testsPassed: 36,
      testsSkipped: 0,
    });
    expect(parseAgentMemoryBaselineReport(canonicalJson(report))).toEqual(report);
    expect(parseAgentMemoryEvidenceReceipt(canonicalJson(receipt))).toEqual(receipt);
    expect(evaluate(report)).toEqual(receipt);
  });

  test("rejects tampered reports, stale checkouts, and forbidden attempts", () => {
    const report = validReport();
    const tampered = JSON.parse(canonicalJson(report)) as { exactCommand: string };
    tampered.exactCommand = "pnpm memory:baseline --changed";
    expectCode(
      () => parseAgentMemoryBaselineReport(JSON.stringify(tampered)),
      "agent_memory_report_hash_mismatch",
    );
    expectCode(
      () => evaluate(report, "d".repeat(64)),
      "agent_memory_report_binding_mismatch",
    );
    expectCode(
      () => evaluate(createAgentMemoryBaselineReport({
        ...validReportInput(),
        networkAttemptCount: 1,
      })),
      "agent_memory_report_guard_failed",
    );
  });

  test("represents plan-only metrics as null on fail-closed outcomes", () => {
    const failed = validReport().cases.find(
      ({ outcome }) => outcome === "context_protected_overflow",
    );
    expect(failed).toMatchObject({
      archivedItemCount: null,
      canonicalContextSha256: null,
      includedItemCount: null,
      plannedInputTokens: null,
    });

    const cases = manifest.cases.map(caseReport);
    const plannedIndex = cases.findIndex(({ outcome }) => outcome === "planned");
    cases[plannedIndex] = Object.freeze({
      ...cases[plannedIndex]!,
      archivedItemCount: null,
    });
    expectCode(
      () => evaluate(createAgentMemoryBaselineReport({
        ...validReportInput(),
        cases,
      })),
      "agent_memory_report_nullability_mismatch",
    );
  });

  test("denies network and ambient provider credential access", () => {
    const guard = installAgentMemoryBenchmarkGuard();
    try {
      expect(() => fetch("https://example.invalid")).toThrow(
        AgentMemoryBenchmarkGuardError,
      );
      expect(() => process.env.OPENAI_API_KEY).toThrow(
        AgentMemoryBenchmarkGuardError,
      );
      expect(() => guard.denyProviderUse()).toThrow(
        AgentMemoryBenchmarkGuardError,
      );
      expect(guard.networkAttemptCount).toBe(1);
      expect(guard.credentialReadAttemptCount).toBe(1);
      expect(guard.providerCallCount).toBe(1);
    } finally {
      guard.restore();
    }
    const sanitized = sanitizedAgentMemoryBenchmarkEnvironment({
      AM0_VISIBLE: "yes",
      OPENAI_API_KEY: "not-a-real-key",
      PRIVATE_TOKEN: "not-a-real-token",
    });
    expect(sanitized).toEqual({ AM0_VISIBLE: "yes" });
  });

  test("writes content-addressed evidence without replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-agent-memory-evidence-"));
    temporaryRoots.push(root);
    const report = validReport();
    const receipt = evaluate(report);
    const reportPath = await writeAgentMemoryBaselineReport(root, report);
    expect(await writeAgentMemoryBaselineReport(root, report)).toBe(reportPath);
    expect(
      parseAgentMemoryBaselineReport(await readFile(reportPath, "utf8")),
    ).toEqual(report);
    const receiptPath = await writeAgentMemoryEvidenceReceipt(root, receipt);
    expect(await writeAgentMemoryEvidenceReceipt(root, receipt)).toBe(receiptPath);
    await writeFile(reportPath, "conflict\n", "utf8");
    await expectCodeAsync(
      async () => writeAgentMemoryBaselineReport(root, report),
      "agent_memory_evidence_path_conflict",
    );
  });
});
