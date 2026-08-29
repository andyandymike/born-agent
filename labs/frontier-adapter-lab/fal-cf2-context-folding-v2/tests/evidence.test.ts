import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  CF2_PRIOR_CANDIDATE_SHA256,
  CF2_PRIOR_RECEIPT_SHA256,
  cf2ManifestSchema,
  cf2TraceProvenanceSchema,
  loadCf2Corpus,
  verifyCf2TraceArtifacts,
} from "../src/experiment-schema.js";

function trace(index: number, multiChild = true) {
  return {
    caseId: `trace-${String(index)}`,
    evidenceKind: "trace_replay" as const,
    caseRole: "naturalistic_product_evaluation" as const,
    multiChild,
    scenarioFamilyId: `family-${String(index)}`,
    taskStatusShape: ["analysis-complete", "coding-complete", "blocked"][(index - 1) % 3] ??
      "analysis-complete",
    parentRunIdSha256: String(index).padStart(64, "0"),
    sourceCommit: "1".repeat(40),
    sourceDirtyStateSha256: null,
    capturePoint: "after_parent_receipt_projection_before_provider_request" as const,
    captureToolVersion: "cf2-capture-v1",
    acceptedChildReceiptItemsArtifactRef: `traces/evaluation/trace-${String(index)}-receipts.json`,
    acceptedChildReceiptItemsSha256: "2".repeat(64),
    baselineTaskContextArtifactRef: `traces/evaluation/trace-${String(index)}-context.json`,
    baselineTaskContextSha256: "3".repeat(64),
    redactionTransformId: "none",
    redactionTransformSha256: null,
    tokenDistributionChanged: false,
  };
}

describe("CF2 evidence protocol", () => {
  it("loads the new hash-bound corpus without changing v1 evidence", async () => {
    const corpus = await loadCf2Corpus(process.cwd());
    expect(corpus.casePack.cases).toHaveLength(20);
    expect(corpus.casePack.cases.filter((entry) =>
      entry.route === "verified_receipt")).toHaveLength(7);
    expect(corpus.casePack.cases.filter((entry) =>
      entry.caseRole === "security")).toHaveLength(5);
    expect(corpus.manifest.traces).toEqual([]);
    expect(corpus.manifest.candidateIdentityMode).toBe(
      "reimplementation_from_v1_contract",
    );
    expect(corpus.manifest.priorEvidenceReceiptSha256).toBe(CF2_PRIOR_RECEIPT_SHA256);
    expect(corpus.manifest.priorCandidateImplementationSha256).toBe(
      CF2_PRIOR_CANDIDATE_SHA256,
    );

    const prior = parseStrictJson(await readFile(join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal0-context-folding-v1/experiment-receipt.json",
    ), "utf8")) as Readonly<Record<string, unknown>>;
    expect(prior.receiptSha256).toBe(CF2_PRIOR_RECEIPT_SHA256);
    expect(prior.candidateImplementationSha256).toBe(CF2_PRIOR_CANDIDATE_SHA256);
  });

  it("keeps the historical 3-vs-4 route defect visible", async () => {
    const oldCases = parseStrictJson(await readFile(join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal0-context-folding-v1/cases.json",
    ), "utf8")) as {
      readonly cases: readonly {
        readonly class: string;
        readonly route: string;
      }[];
    };
    expect(oldCases.cases.filter((entry) =>
      entry.class === "representative" && entry.route === "verified_receipt")).toHaveLength(3);
    expect(oldCases.cases.filter((entry) => entry.route === "verified_receipt")).toHaveLength(7);
  });

  it("does not let verified security routes fill the trace multi-child predicate", async () => {
    const corpus = await loadCf2Corpus(process.cwd());
    const { manifestSha256: _manifestSha256, ...content } = corpus.manifest;
    void _manifestSha256;
    const invalid = {
      ...content,
      traces: Array.from({ length: 12 }, (_, index) =>
        trace(index + 1, index < 3)),
      samplingProtocol: {
        ...content.samplingProtocol,
        productFitEvaluationRequested: true,
      },
      manifestSha256: "0".repeat(64),
    };
    expect(corpus.casePack.cases.filter((entry) =>
      entry.caseRole === "security" && entry.route === "verified_receipt").length).toBeGreaterThanOrEqual(4);
    expect(() => cf2ManifestSchema.parse(invalid)).toThrow(
      "product-fit evaluation requires four multi-child traces",
    );
  });

  it("rejects absolute refs and invalid source/redaction provenance pairs", () => {
    expect(cf2TraceProvenanceSchema.parse(trace(1)).caseId).toBe("trace-1");
    expect(() => cf2TraceProvenanceSchema.parse({
      ...trace(1),
      baselineTaskContextArtifactRef: "D:\\private\\context.json",
    })).toThrow("artifact refs must be normalized relative paths");
    expect(() => cf2TraceProvenanceSchema.parse({
      ...trace(1),
      sourceCommit: null,
      sourceDirtyStateSha256: "4".repeat(64),
    })).toThrow("dirty runs must also bind their base source commit");
    expect(() => cf2TraceProvenanceSchema.parse({
      ...trace(1),
      redactionTransformId: "redact-v1",
      redactionTransformSha256: null,
    })).toThrow("redaction identity and hash must be paired");
  });

  it("does not accept trace metadata without retained hash-matching artifacts", async () => {
    await expect(verifyCf2TraceArtifacts(process.cwd(), [trace(1)]))
      .rejects.toThrow();
  });
});
