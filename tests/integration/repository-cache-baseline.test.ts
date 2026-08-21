import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  runRepositoryCacheBaseline,
  runRepositoryCacheCandidate,
} from "../../src/repository-intelligence/benchmark/repository-cache-baseline-runner.js";
import {
  parseRepositoryCacheEvidenceManifest,
  repositoryCacheTraceCaseIds,
} from "../../src/repository-intelligence/benchmark/repository-cache-evidence.js";
import { installRepositoryCacheBenchmarkGuard } from "../../src/repository-intelligence/benchmark/repository-cache-benchmark-guard.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("RIC0 repository cache monolith baseline", () => {
  test("runs the complete tiny trace in a protected local harness", async () => {
    const manifestSource = await readFile(
      resolve(workspaceRoot, "tests/evidence/repository-intelligence-cache-optimization-v1.json"),
      "utf8",
    );
    const manifest = parseRepositoryCacheEvidenceManifest(manifestSource);
    const guard = installRepositoryCacheBenchmarkGuard();
    try {
      const report = await runRepositoryCacheBaseline({
        command: ["integration", "repository-cache-baseline"],
        guard,
        manifest,
        manifestSource,
        moduleCount: 12,
        sampleCount: 1,
        workspaceRoot,
      });
      expect(report.cases.map((value) => value.caseId)).toEqual(repositoryCacheTraceCaseIds);
      expect(report.cases.filter((value) => value.status === "pass")).toHaveLength(13);
      expect(report.cases.filter((value) => value.status === "not_applicable")).toEqual([
        expect.objectContaining({ caseId: "C8B", reason: "missing_capability:sharded_storage_v2" }),
        expect.objectContaining({ caseId: "C8C", reason: "missing_capability:persistent_facts_v1" }),
        expect.objectContaining({ caseId: "C11", reason: "missing_capability:lease_protocol_v2,rooted_gc_v2" }),
        expect.objectContaining({ caseId: "C12", reason: "missing_capability:lease_protocol_v2,rooted_gc_v2" }),
      ]);
      expect(report.guard).toMatchObject({ credentialReadAttemptCount: 0, networkAttemptCount: 0 });
      expect(report.cases.find((value) => value.caseId === "C10")?.samples[0]).toMatchObject({
        errorCode: null,
        generationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(report.cases.filter((value) => value.status === "pass").every((value) =>
        value.samples[0]?.counters.observedCacheRootBytes !== undefined &&
        value.samples[0].counters.observedCacheRootBytes > 0)).toBe(true);
    } finally {
      guard.restore();
    }
  }, 120_000);

  test("runs every sharding, persistent-fact, lease, and rooted-GC trace for the v2 candidate", async () => {
    const manifestSource = await readFile(
      resolve(workspaceRoot, "tests/evidence/repository-intelligence-cache-optimization-v1.json"),
      "utf8",
    );
    const manifest = parseRepositoryCacheEvidenceManifest(manifestSource);
    const guard = installRepositoryCacheBenchmarkGuard();
    try {
      const report = await runRepositoryCacheCandidate({
        candidateId: "persistent_dag_v2",
        command: ["integration", "repository-cache-persistent-dag"],
        guard,
        manifest,
        manifestSource,
        moduleCount: 12,
        sampleCount: 1,
        workspaceRoot,
      });
      expect(report.cases.map((value) => value.caseId)).toEqual(repositoryCacheTraceCaseIds);
      expect(report.cases.every((value) => value.status === "pass")).toBe(true);
      expect(report.cases.find((value) => value.caseId === "C8C")?.samples[0]).toMatchObject({
        counters: {
          factsRecomputed: expect.any(Number),
          factsReused: expect.any(Number),
          factsValidated: expect.any(Number),
        },
      });
      expect(report.cases.find((value) => value.caseId === "C11")?.samples[0]?.counters.activeLeaseCount).toBe(1);
      expect(report.cases.find((value) => value.caseId === "C12")?.samples[0]).toMatchObject({
        counters: {
          activeLeaseCount: 0,
          gcPendingBytes: 0,
          tmpBytes: 0,
          unreachableKnownBytes: 0,
        },
      });
    } finally {
      guard.restore();
    }
  }, 180_000);
});
