import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import { DeterministicTokenEstimator } from "../../../../src/context/token-estimator.js";
import { describe, expect, it } from "vitest";

import {
  renderFalVp0Procedure,
  renderFalVp0SourceDossier,
} from "../src/carrier-renderer.js";
import { falVp0ProcedureSchema } from "../src/procedure-schema.js";
import { buildTestProcedure, testSupportArtifacts } from "./fixture-builder.js";

const estimator = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "fal-vp0-structural",
  provider: "host",
  tokenizer: "deterministic-byte-estimator",
  version: "1",
});

describe("FAL-VP0 strict procedure contract", () => {
  it("round-trips a heterogeneous dual-source procedure with stable identity", () => {
    const procedure = buildTestProcedure();
    const encoded = canonicalJson(procedure);
    const decoded = falVp0ProcedureSchema.parse(JSON.parse(encoded));

    expect(decoded).toEqual(procedure);
    expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(8 * 1024);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(procedure.sourceBindings[0].sourceIdentity.runId)
      .not.toBe(procedure.sourceBindings[1].sourceIdentity.runId);
  });

  it("rejects unknown fields and recomputed tampering", () => {
    const procedure = buildTestProcedure();
    expect(falVp0ProcedureSchema.safeParse({ ...procedure, unexpected: true }).success).toBe(false);
    expect(falVp0ProcedureSchema.safeParse({
      ...procedure,
      procedureFamilyId: "family-tampered",
    }).success).toBe(false);
  });

  it("renders equal support sets into distinct bounded payloads", () => {
    const procedure = buildTestProcedure();
    const artifacts = testSupportArtifacts();
    const baseline = renderFalVp0SourceDossier({ artifacts, procedure });
    const candidate = renderFalVp0Procedure({ artifacts, procedure });

    expect(candidate.supportSetSha256).toBe(baseline.supportSetSha256);
    expect(candidate.contentSha256).not.toBe(baseline.contentSha256);
    expect(estimator.estimateText(baseline.content).estimatedTokens).toBeLessThanOrEqual(800);
    expect(estimator.estimateText(candidate.content).estimatedTokens).toBeLessThanOrEqual(800);
    expect(candidate.content).not.toContain("supportRefs");
  });

  it("replays exact support bytes and rejects a tampered span", () => {
    const procedure = buildTestProcedure();
    const artifacts = testSupportArtifacts();
    const tampered = artifacts.map((entry, index) => index === 0
      ? { ...entry, bytes: new TextEncoder().encode("tampered") }
      : entry);
    expect(() => renderFalVp0Procedure({ artifacts: tampered, procedure }))
      .toThrow(/outside UTF-8 boundaries|raw span hash mismatch/u);
  });
});
