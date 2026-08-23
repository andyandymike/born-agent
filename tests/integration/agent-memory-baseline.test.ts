import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { runAgentMemoryBaseline } from "../../src/memory/benchmark/agent-memory-baseline-runner.js";
import { installAgentMemoryBenchmarkGuard } from "../../src/memory/benchmark/agent-memory-benchmark-guard.js";
import { parseAgentMemoryEvidenceManifest } from "../../src/memory/benchmark/agent-memory-evidence.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");

function deterministicCases(
  cases: Awaited<ReturnType<typeof runAgentMemoryBaseline>>["report"]["cases"],
) {
  return cases.map((value) => Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "durationMs"),
  ));
}

describe("AM0 agent memory characterization baseline", () => {
  test("replays every required case in a protected local memory-off harness", async () => {
    const manifestSource = await readFile(
      resolve(workspaceRoot, "tests/evidence/agent-memory-v1.json"),
      "utf8",
    );
    const manifest = parseAgentMemoryEvidenceManifest(manifestSource);
    const guard = installAgentMemoryBenchmarkGuard();
    try {
      const first = await runAgentMemoryBaseline({
        guard,
        manifest,
        manifestSource,
        workspaceRoot,
      });
      const second = await runAgentMemoryBaseline({
        guard,
        manifest,
        manifestSource,
        workspaceRoot,
      });

      expect(first.receipt).toMatchObject({
        status: "pass",
        testsFailed: 0,
        testsPassed: 36,
        testsSkipped: 0,
      });
      expect(first.report.summary).toMatchObject({
        caseCount: 36,
        contextProtectedOverflowCount: 3,
        contextUnsafeCompactionCount: 1,
        maxEventCount: 10_000,
        plannedCount: 32,
      });
      expect(first.report.guard).toEqual({
        credentialReadAttemptCount: 0,
        guardIdentitySha256: manifest.guard.identitySha256,
        networkAttemptCount: 0,
        providerCallCount: 0,
      });
      expect(first.report.cases.find(({ caseId }) => caseId === "N12")).toMatchObject({
        archivedItemCount: expect.any(Number),
        eventCount: 10_000,
        outcome: "planned",
        sourceEventsApplied: 10_000,
      });
      expect(first.report.cases.find(({ caseId }) => caseId === "U04")).toMatchObject({
        outcome: "planned",
        projectedItemCount: 2,
      });
      expect(first.report.cases.find(({ caseId }) => caseId === "E03")).toMatchObject({
        errorCode: "context_protected_overflow",
        outcome: "context_protected_overflow",
        plannedInputTokens: null,
      });
      expect(first.report.cases.find(({ caseId }) => caseId === "P01")).toMatchObject({
        errorCode: "context_unsafe_compaction",
        outcome: "context_unsafe_compaction",
        plannedInputTokens: null,
      });
      expect(second.report.deterministicResultSha256).toBe(
        first.report.deterministicResultSha256,
      );
      expect(deterministicCases(second.report.cases)).toEqual(
        deterministicCases(first.report.cases),
      );
      expect(guard.networkAttemptCount).toBe(0);
      expect(guard.credentialReadAttemptCount).toBe(0);
    } finally {
      guard.restore();
    }
  }, 120_000);
});
