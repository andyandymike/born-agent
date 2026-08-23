import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ArchitectureEvidenceError,
  createEvidenceReceipt,
  evaluateEvidence,
  parseArchitectureArguments,
  parseEvidenceManifest,
  parseEvidenceReceipt,
  verifyEvidenceReceipt,
} from "../../scripts/validate-architecture-simplification.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const testFile = "tests/unit/architecture-simplification-evidence.test.ts";
const temporaryRoots: string[] = [];

interface InlineCase {
  readonly fullName: string;
  readonly id?: string;
  readonly invariant?: string;
  readonly platforms?: readonly ("linux" | "win32")[];
  readonly profiles?: readonly ("default" | "built_paths")[];
}

function manifestSource(cases: readonly InlineCase[]): string {
  return `${JSON.stringify({
    cases: cases.map((item, index) => ({
      blocking: true,
      file: testFile,
      fullName: item.fullName,
      id: item.id ?? `as0.1.inline.${String(index + 1)}`,
      invariant: item.invariant ?? "the exact evidence selector remains mandatory",
      platforms: item.platforms ?? ["linux", "win32"],
      profiles: item.profiles ?? ["default"],
      runner: "vitest",
      workPackage: "AS0.1",
    })),
    manifestId: "architecture-simplification-v1",
    schemaVersion: 1,
  }, null, 2)}\n`;
}

function vitestReport(assertions: readonly { readonly fullName: string; readonly status?: string }[]): string {
  return `${JSON.stringify({
    success: assertions.every((item) => item.status !== "failed"),
    testResults: [{
      assertionResults: assertions.map((item) => ({ fullName: item.fullName, status: item.status ?? "passed" })),
      name: resolve(workspaceRoot, testFile),
    }],
  })}\n`;
}

function document(source: string, path = resolve(workspaceRoot, ".architecture-inline-report.json")) {
  return Object.freeze({ argv: Object.freeze(["pnpm", "exec", "vitest", "run", testFile]), path, source });
}

function receiptContext() {
  return Object.freeze({
    arch: "x64",
    argv: Object.freeze(["node", "scripts/validate-architecture-simplification.mjs"]),
    commitSha: "a".repeat(40),
    dirty: null,
    metrics: Object.freeze({}),
    nodeVersion: "v22.19.0",
    pnpmVersion: "11.13.1",
  });
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchitectureEvidenceError);
    expect((error as ArchitectureEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectCodeAsync(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchitectureEvidenceError);
    expect((error as ArchitectureEvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-architecture-evidence-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("AS0.1 architecture evidence contract", () => {
  test("accepts exactly one package-manager argument separator", () => {
    expect(parseArchitectureArguments([
      "--",
      "--receipt",
      "receipt.json",
    ])).toMatchObject({ receipts: ["receipt.json"] });
    expectCode(
      () => parseArchitectureArguments([
        "--",
        "--",
        "--receipt",
        "receipt.json",
      ]),
      "evidence_cli_invalid",
    );
  });

  test("accepts the exact manifest and report set", async () => {
    const fullName = "AS0.1 architecture evidence contract accepts the exact manifest and report set";
    const source = manifestSource([{ fullName }]);
    const manifest = parseEvidenceManifest(source);
    const reportSource = vitestReport([{ fullName }]);
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    await writeFile(reportPath, reportSource, "utf8");
    const reportDocuments = [document(reportSource, reportPath)];

    const receiptSource = JSON.stringify(createEvidenceReceipt({
      context: receiptContext(),
      manifest,
      manifestSource: source,
      platform: "linux",
      profile: "default",
      reportDocuments,
      workspaceRoot,
    }));
    const receipt = parseEvidenceReceipt(receiptSource);

    await expect(verifyEvidenceReceipt({ manifest, manifestSource: source, receipt, workspaceRoot })).resolves.toBe(receipt);
  });

  test("denies a missing required case", () => {
    const source = manifestSource([{ fullName: "required exact test" }]);
    expectCode(() => evaluateEvidence({
      manifest: parseEvidenceManifest(source),
      platform: "linux",
      profile: "default",
      reportDocuments: [document(vitestReport([{ fullName: "another test" }]))],
      workspaceRoot,
    }), "evidence_required_case_failed");
  });

  test("denies a duplicate evidence id", () => {
    const source = manifestSource([
      { fullName: "first exact test", id: "as0.1.duplicate" },
      { fullName: "second exact test", id: "as0.1.duplicate" },
    ]);
    expectCode(() => parseEvidenceManifest(source), "evidence_duplicate_id");
  });

  test("denies a renamed required test", () => {
    const source = manifestSource([{ fullName: "original exact test" }]);
    expectCode(() => evaluateEvidence({
      manifest: parseEvidenceManifest(source),
      platform: "linux",
      profile: "default",
      reportDocuments: [document(vitestReport([{ fullName: "renamed exact test" }]))],
      workspaceRoot,
    }), "evidence_required_case_failed");
  });

  test("denies an unexpected skip", () => {
    const fullName = "required exact test";
    const source = manifestSource([{ fullName }]);
    expectCode(() => evaluateEvidence({
      manifest: parseEvidenceManifest(source),
      platform: "linux",
      profile: "default",
      reportDocuments: [document(vitestReport([{ fullName, status: "pending" }]))],
      workspaceRoot,
    }), "evidence_required_case_failed");
  });

  test("denies the wrong profile or platform", () => {
    const fullName = "linux default only";
    const manifest = parseEvidenceManifest(manifestSource([{
      fullName,
      platforms: ["linux"],
      profiles: ["default"],
    }]));
    const reportDocuments = [document(vitestReport([{ fullName }]))];
    expectCode(() => evaluateEvidence({ manifest, platform: "win32", profile: "default", reportDocuments, workspaceRoot }), "evidence_selection_empty");
    expectCode(() => evaluateEvidence({ manifest, platform: "linux", profile: "built_paths", reportDocuments, workspaceRoot }), "evidence_selection_empty");
  });

  test("denies a report hash mismatch", async () => {
    const fullName = "exact report test";
    const source = manifestSource([{ fullName }]);
    const manifest = parseEvidenceManifest(source);
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    const reportSource = vitestReport([{ fullName }]);
    await writeFile(reportPath, reportSource, "utf8");
    const receipt = parseEvidenceReceipt(JSON.stringify(createEvidenceReceipt({
      context: receiptContext(),
      manifest,
      manifestSource: source,
      platform: "linux",
      profile: "default",
      reportDocuments: [document(reportSource, reportPath)],
      workspaceRoot,
    })));
    await writeFile(reportPath, vitestReport([{ fullName: "changed report" }]), "utf8");

    await expectCodeAsync(
      async () => verifyEvidenceReceipt({ manifest, manifestSource: source, receipt, workspaceRoot }),
      "evidence_report_hash_mismatch",
    );
  });

  test("denies a manifest hash mismatch", async () => {
    const fullName = "exact manifest test";
    const source = manifestSource([{ fullName }]);
    const manifest = parseEvidenceManifest(source);
    const root = await temporaryRoot();
    const reportPath = join(root, "report.json");
    const reportSource = vitestReport([{ fullName }]);
    await writeFile(reportPath, reportSource, "utf8");
    const receipt = parseEvidenceReceipt(JSON.stringify(createEvidenceReceipt({
      context: receiptContext(),
      manifest,
      manifestSource: source,
      platform: "linux",
      profile: "default",
      reportDocuments: [document(reportSource, reportPath)],
      workspaceRoot,
    })));
    const changedSource = manifestSource([{ fullName, invariant: "a changed invariant changes the manifest identity" }]);

    await expectCodeAsync(
      async () => verifyEvidenceReceipt({
        manifest: parseEvidenceManifest(changedSource),
        manifestSource: changedSource,
        receipt,
        workspaceRoot,
      }),
      "evidence_manifest_hash_mismatch",
    );
  });
});
