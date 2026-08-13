import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createEvidenceReceipt,
  parseEvidenceManifest,
  parseEvidenceReceipt,
  verifyEvidenceReceipt,
} from "../../scripts/validate-architecture-simplification.mjs";
import {
  ARCHITECTURE_CHARACTERIZATION_BASELINE_PATH,
  architectureCharacterizationMetrics,
  architectureCharacterizationSha256,
  generateArchitectureCharacterization,
  parseArchitectureCharacterization,
  readTrackedArchitectureCharacterization,
  type ArchitectureCharacterizationV1,
} from "../helpers/architecture-characterization.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
let actual: ArchitectureCharacterizationV1;
let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "bornagent-as0.2-tests-"));
  actual = await generateArchitectureCharacterization(workspaceRoot);
}, 30_000);

afterAll(async () => {
  await rm(temporaryRoot, { force: true, recursive: true });
});

describe("AS0.2 architecture characterization", () => {
  test("matches the tracked baseline across dependency, handoff, workspace, session, terminal, and route observations", async () => {
    const expected = await readTrackedArchitectureCharacterization(workspaceRoot);
    expect(architectureCharacterizationSha256(actual)).toBe(architectureCharacterizationSha256(expected));
    expect(actual.backgroundHandoff.twoProcessCas).toEqual({
      conflictCount: 1,
      contenderCount: 2,
      finalOwner: "parent",
      finalState: "terminal",
      winnerCount: 1,
    });
    expect(actual.workspaceSnapshot).toMatchObject({
      materializeLimitCheckAfterPayloadReadCount: 1,
      payloadReadCount: 4,
      retainedPayloadBytes: 64,
      returnedPayloadBytes: 40,
    });
    expect(actual.previousBaselineSha256).toBe("aae8e113f8ca161a60a67052517978b28c65000d72b42a7601cecc0cad5ee27e");
    expect(actual.dependencyBoundaries.violations).toEqual([]);
    expect(new Set(actual.surfaceRoutes.map((route) => route.legacyAuthority))).toEqual(
      new Set(["explicit_domain_harness"]),
    );
    expect(actual.sessionReads).toMatchObject({
      catalogFullScanCount: 1,
      exclusiveSnapshotCount: 1,
      fullProjectionCount: 2,
      polling: {
        activeChild: { readAttemptsPerIdleSecond: 11 },
        preStart: { readAttemptsPerIdleSecond: 21 },
      },
    });
  });

  test("rejects duplicate keys and unknown baseline fields", async () => {
    expect(() => parseArchitectureCharacterization('{"schemaVersion":1,"schemaVersion":1}')).toThrow();
    const source = JSON.parse(await readFile(resolve(workspaceRoot, ARCHITECTURE_CHARACTERIZATION_BASELINE_PATH), "utf8")) as Record<string, unknown>;
    expect(() => parseArchitectureCharacterization(JSON.stringify({ ...source, unexpected: true }))).toThrow();
  });

  test("binds deterministic command metrics into a patch-verifiable receipt", async () => {
    const manifestSource = `${JSON.stringify({
      cases: [{
        blocking: true,
        id: "as0.2.characterization.baseline",
        invariant: "the exact architecture characterization remains reproducible",
        platforms: ["linux", "win32"],
        profiles: ["metric"],
        runner: "metric",
        workPackage: "AS0.2",
      }],
      manifestId: "architecture-simplification-v1",
      schemaVersion: 1,
    })}\n`;
    const reportPath = join(temporaryRoot, "metric-report.json");
    const reportSource = `${JSON.stringify({
      metrics: architectureCharacterizationMetrics(actual),
      reportId: "architecture-command-report-v1",
      results: [{ id: "as0.2.characterization.baseline", status: "passed" }],
      schemaVersion: 1,
    })}\n`;
    await writeFile(reportPath, reportSource, "utf8");
    const manifest = parseEvidenceManifest(manifestSource);
    const receiptSource = JSON.stringify(createEvidenceReceipt({
      context: {
        arch: "x64",
        argv: ["pnpm", "architecture:gate"],
        commitSha: "a".repeat(40),
        dirty: null,
        nodeVersion: "v22.19.0",
        pnpmVersion: "11.13.1",
      },
      manifest,
      manifestSource,
      platform: "linux",
      profile: "metric",
      reportDocuments: [{ argv: ["pnpm", "architecture:characterize", "--", "--check"], path: reportPath, source: reportSource }],
      workspaceRoot,
    }));
    const receipt = parseEvidenceReceipt(receiptSource) as { readonly metrics: Readonly<Record<string, number>> };
    expect(receipt.metrics["as0.2.workspace-payload-read-count"]).toBe(4);

    const tampered = parseEvidenceReceipt(JSON.stringify({
      ...JSON.parse(receiptSource) as Record<string, unknown>,
      metrics: { ...receipt.metrics, "as0.2.workspace-payload-read-count": 3 },
    }));
    await expect(verifyEvidenceReceipt({ manifest, manifestSource, receipt: tampered, workspaceRoot }))
      .rejects.toMatchObject({ code: "evidence_receipt_metric_mismatch" });
  });
});
