import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

import { emR1LogicalReceiptIdentity } from "../src/receipt-identity.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("FAL-EM-R1 retained calibration evidence", () => {
  it("binds the complete breakpoint sweep and stops before sealed evaluation", async () => {
    const directory = join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2",
    );
    const receipt = JSON.parse(await readFile(
      join(directory, "experiment-receipt.json"),
      "utf8",
    )) as Record<string, unknown> & {
      readonly receiptSha256: string;
      readonly anchors: { readonly status: string; readonly failedAnchors: readonly string[] };
      readonly fidelityReplay: { readonly matchedCases: number; readonly totalCases: number };
      readonly reimplementationConfounded: boolean;
      readonly implementationFidelity: string;
      readonly calibration: {
        readonly diagnosticOperatingPoint: Record<string, number | boolean>;
        readonly maximumSemanticOperatingPoint: Record<string, number | boolean>;
        readonly selectedOperatingPoint: null;
        readonly status: string;
        readonly thresholdBehaviorPointCount: number;
        readonly thresholdBehaviorPointColumns: readonly string[];
        readonly thresholdBehaviorPointShards: readonly Readonly<{
          readonly bytes: number;
          readonly path: string;
          readonly pointCount: number;
          readonly sha256: string;
        }>[];
      };
      readonly evaluation: { readonly evaluationGoldensLoadedByRunner: boolean; readonly status: string };
      readonly promotion: string;
    };
    const { receiptSha256, ...content } = receipt;
    expect(emR1LogicalReceiptIdentity(content)).toBe(receiptSha256);
    expect(receipt.anchors).toMatchObject({ status: "passed", failedAnchors: [] });
    expect(receipt.reimplementationConfounded).toBe(true);
    expect(receipt.implementationFidelity).toBe("inconclusive");
    expect(receipt.fidelityReplay).toMatchObject({ matchedCases: 26, totalCases: 36 });
    expect(receipt.calibration.status).toBe("refuted");
    expect(receipt.calibration.selectedOperatingPoint).toBeNull();
    expect(receipt.calibration.diagnosticOperatingPoint).toMatchObject({
      baselineCollisionParityFailures: 0,
      candidateAddedNegativeHitCases: 0,
      controlsPassed: 8,
      effectiveVectorNegativeFalseAccepts: 0,
      filteredTargetSubstitutes: 0,
      securityInvariantFailures: 0,
      semanticHitsAt5: 0,
    });
    expect(receipt.calibration.maximumSemanticOperatingPoint).toMatchObject({
      semanticHitsAt5: 8,
      controlsPassed: 8,
    });
    expect(receipt.evaluation).toEqual({
      status: "not_run_calibration_refuted",
      evaluationGoldensLoadedByRunner: false,
      reason: "no_non_reject_all_eligible_operating_point",
    });
    expect(receipt.promotion).toBe("blocked");

    let pointCount = 0;
    for (const shard of receipt.calibration.thresholdBehaviorPointShards) {
      const bytes = await readFile(join(directory, shard.path));
      expect(bytes.byteLength).toBe(shard.bytes);
      expect(sha256(bytes)).toBe(shard.sha256);
      const parsed = JSON.parse(bytes.toString("utf8")) as {
        readonly pointColumns: readonly string[];
        readonly points: readonly (readonly unknown[])[];
      };
      expect(parsed.pointColumns).toEqual(receipt.calibration.thresholdBehaviorPointColumns);
      expect(parsed.points).toHaveLength(shard.pointCount);
      pointCount += parsed.points.length;
    }
    expect(pointCount).toBe(receipt.calibration.thresholdBehaviorPointCount);
    expect(pointCount).toBe(9_538);
  });

  it("keeps the historical receipt immutable and binds the append-only audit correction", async () => {
    const directory = join(
      process.cwd(),
      "fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2",
    );
    const receiptBytes = await readFile(join(directory, "experiment-receipt.json"));
    const correction = JSON.parse(await readFile(
      join(directory, "evidence-correction-v2.json"),
      "utf8",
    )) as Record<string, unknown> & {
      readonly appliesTo: {
        readonly receiptLogicalSha256: string;
        readonly receiptRawSha256: string;
      };
      readonly correctionSha256: string;
      readonly corrections: Record<string, unknown>;
      readonly historicalBytesModified: boolean;
      readonly retainedClaims: readonly string[];
    };
    const { correctionSha256, ...content } = correction;

    expect(sha256(receiptBytes)).toBe(correction.appliesTo.receiptRawSha256);
    expect(correction.appliesTo.receiptLogicalSha256)
      .toBe("4e20762f11447a136423699bda44ac09268374f62f8907fa603a59ecc084220f");
    expect(sha256Canonical(content)).toBe(correctionSha256);
    expect(correction.historicalBytesModified).toBe(false);
    expect(correction.retainedClaims).toEqual([
      "calibration_has_no_eligible_global_threshold",
      "evaluation_scoring_not_run",
      "promotion_blocked",
    ]);
    expect(correction.corrections).toMatchObject({
      evaluationFilesReadForManifestVerification: true,
      evaluationCasesParsedOrScored: false,
      semanticFamilyDisjoint: "refuted_by_audit",
      evaluationLifecycle: "known_exposed_holdout_development_only",
    });
  });
});
