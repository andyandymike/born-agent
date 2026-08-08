import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadRepositoryBenchmarkSuite, resolveBenchmarkRef } from "../../src/repository-intelligence/benchmark/benchmark-schema.js";
import { runRepositoryBenchmark } from "../../src/repository-intelligence/benchmark/benchmark-runner.js";
import { benchmarkWorkspaceSha256 } from "../../src/repository-intelligence/benchmark/benchmark-workspace.js";

const SUITE = resolve("evals/repository-intelligence/suite-v1.json");

describe("Phase 17A legacy scan baseline", () => {
  it("validates all twenty checked-in workspaces and keeps hidden gold outside them", async () => {
    const loaded = await loadRepositoryBenchmarkSuite(SUITE);
    expect(loaded.suite.cases).toHaveLength(20);
    expect(loaded.suite.smokeCaseIds).toHaveLength(8);
    for (const entry of loaded.suite.cases) {
      const workspace = resolveBenchmarkRef(loaded.root, entry.workspaceRef);
      expect(await benchmarkWorkspaceSha256(workspace)).toBe(entry.workspaceSha256);
      expect(workspace).not.toContain("grader");
      expect(await readFile(resolveBenchmarkRef(loaded.root, entry.hiddenExpectedRef), "utf8")).toContain(entry.id);
    }
  });

  it("runs the production read-tool observation contract without model or network calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must remain unused"));
    const report = await runRepositoryBenchmark({ mode: "full", runId: "phase17a-test", suitePath: SUITE });
    expect(report.attempts).toHaveLength(20);
    expect(report.metrics.scheduledAttempts).toBe(20);
    expect(report.metrics.harnessInvalidCount).toBe(0);
    expect(report.attempts.every((attempt) => attempt.evidenceLevel === "textual_fallback")).toBe(true);
    expect(report.attempts.reduce((total, attempt) => total + attempt.observationBytes, 0)).toBe(
      report.metrics.observationBytesTotal,
    );
    expect(report).toMatchObject({
      modelFreeRetrieval: true,
      modelQualityEvidence: "not_measured",
      remoteExecution: "not_run_by_policy",
    });
    expect(fetch).not.toHaveBeenCalled();
  }, 60_000);
});
