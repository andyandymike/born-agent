import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseStrictJson } from "../../../../src/system/strict-json.js";

import {
  parseAgentMemoryEffectScopeCorrection,
  verifyAgentMemoryEffectScopeCorrection,
} from "../src/effect-scope-correction.js";

const repositoryRoot = process.cwd();
const correctionPath = join(
  repositoryRoot,
  "fixtures/frontier-adapter-lab/fal-memory-shared-v2/agent-memory-effect-scope-correction-v1.json",
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FAL Agent-memory effect-scope correction", () => {
  it("keeps historical receipts immutable and binds every corrected evidence artifact", async () => {
    const correction = await verifyAgentMemoryEffectScopeCorrection(repositoryRoot, parseStrictJson(
      await readFile(correctionPath, "utf8"),
    ));

    expect(correction.historicalBytesModified).toBe(false);
    for (const artifact of correction.appliesTo) {
      expect(sha256(await readFile(join(repositoryRoot, artifact.path))))
        .toBe(artifact.rawSha256);
    }

    const v1DeepSeek = parseStrictJson(await readFile(join(
      repositoryRoot,
      "fixtures/frontier-adapter-lab/fal-memory-shared-v1/" +
        "deepseek-v4-flash-development-calibration-receipt.json",
    ), "utf8")) as {
      readonly decision?: {
        readonly contextFoldingBenefitObserved?: unknown;
        readonly localEmbeddingEndToEndBenefitObserved?: unknown;
      };
      readonly executionBoundary?: { readonly productionMemorySent?: unknown };
    };
    expect(v1DeepSeek.decision?.localEmbeddingEndToEndBenefitObserved).toBe(true);
    expect(v1DeepSeek.decision?.contextFoldingBenefitObserved).toBe(false);
    expect(v1DeepSeek.executionBoundary?.productionMemorySent).toBe(false);

    const v2DeepSeek = parseStrictJson(await readFile(join(
      repositoryRoot,
      "fixtures/frontier-adapter-lab/fal-memory-shared-v2/" +
        "deepseek-v4-flash-answer-policy-v2-development-calibration-receipt.json",
    ), "utf8")) as {
      readonly decision?: {
        readonly contextFoldingBenefitObserved?: unknown;
        readonly localEmbeddingRetrievalBenefitObserved?: unknown;
        readonly productionIntegrationAllowed?: unknown;
        readonly publicV2ReaderRun?: unknown;
      };
      readonly executionBoundary?: { readonly productionMemorySent?: unknown };
    };
    expect(v2DeepSeek.decision).toMatchObject({
      contextFoldingBenefitObserved: false,
      localEmbeddingRetrievalBenefitObserved: false,
      productionIntegrationAllowed: false,
      publicV2ReaderRun: "completed_diagnostic_only",
    });
    expect(v2DeepSeek.executionBoundary?.productionMemorySent).toBe(false);

    expect(correction.historicalClaimCorrections).toEqual([
      expect.objectContaining({
        fieldPath: "decision.localEmbeddingEndToEndBenefitObserved",
        action: "withdraw_and_relabel",
        replacementClaim: "retrieval_to_fixed_packet_reader_effect_observed",
        bornAgentAgentMemoryEffect: "not_tested",
      }),
      expect.objectContaining({
        artifactId: "fal-memory-shared-v1-deepseek-receipt",
        fieldPath: "decision.contextFoldingBenefitObserved",
        action: "withdraw_and_relabel",
      }),
      expect.objectContaining({
        artifactId: "fal-memory-shared-v2-deepseek-receipt",
        fieldPath: "decision.contextFoldingBenefitObserved",
        action: "withdraw_and_relabel",
      }),
      expect.objectContaining({
        fieldPath: "comparisonToFixedQwenReader.readerCapacityBottleneckSupported",
        replacementClaim: "fixed_packet_qwen2b_reader_capacity_bottleneck_supported",
      }),
      expect.objectContaining({
        fieldPath: "product.productFit",
        replacementClaim: "product_fit_not_assessed_by_shared_benchmark",
      }),
    ]);
  });

  it("separates component, fixed-reader, structural pipeline, and Agent effect evidence", async () => {
    const correction = parseAgentMemoryEffectScopeCorrection(parseStrictJson(
      await readFile(correctionPath, "utf8"),
    ));

    expect(correction.auditedExperiments.map((entry) => entry.executionClass)).toEqual([
      "component_mechanics",
      "component_mechanics",
      "fixed_packet_reader_diagnostic",
    ]);
    expect(correction.auditedExperiments.map((entry) => entry.effectStatus))
      .toEqual(["not_tested", "not_tested", "not_tested"]);
    expect(correction.existingProductPathEvidence).toMatchObject({
      status: "structural_pipeline_tested_with_fake_model",
      effectStatus: "not_tested",
    });
    expect(correction.effectClaimGate).toEqual([
      "same_model_task_budget_and_permissions",
      "session_a_uses_product_memory_write_and_admission",
      "full_process_restart_before_session_b",
      "session_b_uses_product_automatic_recall_and_context_injection",
      "bornagent_agent_loop_and_tools_execute",
      "task_outcome_scored_by_independent_verifier",
      "paired_memory_off_and_memory_on_comparison",
    ]);
    expect(correction.finalInterpretation).toEqual({
      bornAgentAgentMemoryTaskEffect: "not_tested",
      contextFoldingRealWorkloadEffect: "not_tested",
      localEmbeddingAgentTaskEffect: "not_tested",
      componentEvidenceRetained: true,
      fixedReaderEvidenceClass: "diagnostic_only",
      effectClaimAllowed: false,
    });
  });

  it("rejects self-hash tampering and any attempt to upgrade the correction into effect proof", async () => {
    const source = parseStrictJson(await readFile(correctionPath, "utf8"));

    const hashTampered = structuredClone(source) as { correctionSha256: string };
    hashTampered.correctionSha256 = "f".repeat(64);
    expect(() => parseAgentMemoryEffectScopeCorrection(hashTampered))
      .toThrow(/logical hash mismatch/u);

    const effectTampered = structuredClone(source) as {
      finalInterpretation: { effectClaimAllowed: boolean };
    };
    effectTampered.finalInterpretation.effectClaimAllowed = true;
    expect(() => parseAgentMemoryEffectScopeCorrection(effectTampered)).toThrow();

    const statusTampered = structuredClone(source) as {
      auditedExperiments: { effectStatus: string }[];
    };
    statusTampered.auditedExperiments[2]!.effectStatus = "observed";
    expect(() => parseAgentMemoryEffectScopeCorrection(statusTampered)).toThrow();
  });
});
