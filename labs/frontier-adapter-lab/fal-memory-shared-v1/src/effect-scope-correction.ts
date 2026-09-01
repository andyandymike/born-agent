import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const historicalArtifactSchema = z.object({
  artifactId: z.enum([
    "fal-cf0-cf1-v1-receipt",
    "fal-cf2-v2-receipt",
    "fal-em0-em1-v1-receipt",
    "fal-em-r1-v2-receipt",
    "fal-memory-shared-v1-local-reader-receipt",
    "fal-memory-shared-v1-deepseek-receipt",
    "fal-memory-shared-v2-deepseek-receipt",
  ]),
  path: z.string().min(1),
  rawSha256: sha256Schema,
}).strict();

const componentCoverageSchema = z.object({
  productMemoryWriteAdmission: z.literal(false),
  crossProcessRestart: z.literal(false),
  automaticRecallInjection: z.literal(false),
  bornAgentAgentLoop: z.literal(false),
  agentToolExecution: z.literal(false),
  independentTaskOutcomeVerifier: z.literal(false),
  standaloneFixedPacketReader: z.literal(false),
}).strict();

const fixedReaderCoverageSchema = componentCoverageSchema.extend({
  standaloneFixedPacketReader: z.literal(true),
}).strict();

const contextFoldingAuditSchema = z.object({
  experimentGroup: z.literal("context_folding_v1_cf2_and_shared_public"),
  executionClass: z.literal("component_mechanics"),
  observedBoundary: z.literal("verified_receipt_projection_fixtures"),
  coverage: componentCoverageSchema,
  retainedClaims: z.tuple([
    z.literal("lossless_expansion_on_frozen_fixtures"),
    z.literal("fallback_equivalence_on_frozen_fixtures"),
    z.literal("projection_security_checks_on_frozen_fixtures"),
    z.literal("shared_public_selector_selected_0_of_12"),
  ]),
  withdrawnClaims: z.tuple([
    z.literal("context_folding_has_no_real_agent_benefit"),
    z.literal("context_folding_has_no_real_workload_token_benefit"),
    z.literal("context_folding_is_long_term_memory_effect_evidence"),
  ]),
  effectStatus: z.literal("not_tested"),
}).strict();

const localEmbeddingAuditSchema = z.object({
  experimentGroup: z.literal("local_embedding_em0_emr1_and_shared_public"),
  executionClass: z.literal("component_mechanics"),
  observedBoundary: z.literal("preloaded_canonical_retrieval"),
  coverage: componentCoverageSchema,
  retainedClaims: z.tuple([
    z.literal("retrieval_metrics_on_frozen_fixture_corpora"),
    z.literal("scope_source_lifecycle_filtering_on_frozen_fixtures"),
    z.literal("cost_and_fallback_mechanics"),
    z.literal("v2_retrieval_refuted_under_frozen_public_threshold"),
  ]),
  withdrawnClaims: z.tuple([
    z.literal("local_embedding_improves_bornagent_agent_task_success"),
    z.literal("local_embedding_refutes_long_term_memory_direction"),
    z.literal("embedding_model_or_algorithm_root_cause_established"),
  ]),
  effectStatus: z.literal("not_tested"),
}).strict();

const sharedReaderAuditSchema = z.object({
  experimentGroup: z.literal("shared_fixed_packet_reader_v1_v2"),
  executionClass: z.literal("fixed_packet_reader_diagnostic"),
  observedBoundary: z.literal("preloaded_retrieval_to_standalone_reader"),
  coverage: fixedReaderCoverageSchema,
  retainedClaims: z.tuple([
    z.literal("deepseek_model_calls_on_public_synthetic_packets"),
    z.literal("v1_fixed_packet_reader_effect_on_public_splits"),
    z.literal("v2_reader_diagnostic_on_public_splits"),
    z.literal("production_memory_sent_false"),
  ]),
  withdrawnClaims: z.tuple([
    z.literal("local_embedding_end_to_end_benefit_observed"),
    z.literal("bornagent_agent_memory_effect_observed"),
    z.literal("deepseek_reader_result_is_agent_task_effect"),
  ]),
  effectStatus: z.literal("not_tested"),
}).strict();

export const agentMemoryEffectScopeCorrectionSchema = z.object({
  schemaVersion: z.literal(1),
  correctionId: z.literal("fal-agent-memory-effect-scope-correction-v1"),
  issuedAt: z.string().datetime(),
  appliesTo: z.array(historicalArtifactSchema).length(7),
  historicalBytesModified: z.literal(false),
  auditedExperiments: z.tuple([
    contextFoldingAuditSchema,
    localEmbeddingAuditSchema,
    sharedReaderAuditSchema,
  ]),
  historicalClaimCorrections: z.tuple([
    z.object({
      artifactId: z.literal("fal-memory-shared-v1-deepseek-receipt"),
      fieldPath: z.literal("decision.localEmbeddingEndToEndBenefitObserved"),
      historicalValue: z.literal(true),
      action: z.literal("withdraw_and_relabel"),
      replacementClaim: z.literal("retrieval_to_fixed_packet_reader_effect_observed"),
      replacementScope: z.literal("public_synthetic_r0_retrieval_to_fixed_deepseek_reader"),
      bornAgentAgentMemoryEffect: z.literal("not_tested"),
    }).strict(),
    z.object({
      artifactId: z.literal("fal-memory-shared-v1-deepseek-receipt"),
      fieldPath: z.literal("decision.contextFoldingBenefitObserved"),
      historicalValue: z.literal(false),
      action: z.literal("withdraw_and_relabel"),
      replacementClaim: z.literal("shared_public_context_folding_selector_selected_0_of_12"),
      replacementScope: z.literal("public_synthetic_receipt_projection_and_fixed_reader"),
      bornAgentAgentMemoryEffect: z.literal("not_tested"),
    }).strict(),
    z.object({
      artifactId: z.literal("fal-memory-shared-v2-deepseek-receipt"),
      fieldPath: z.literal("decision.contextFoldingBenefitObserved"),
      historicalValue: z.literal(false),
      action: z.literal("withdraw_and_relabel"),
      replacementClaim: z.literal("shared_public_context_folding_selector_selected_0_of_12"),
      replacementScope: z.literal("public_synthetic_receipt_projection_and_fixed_reader"),
      bornAgentAgentMemoryEffect: z.literal("not_tested"),
    }).strict(),
    z.object({
      artifactId: z.literal("fal-memory-shared-v1-deepseek-receipt"),
      fieldPath: z.literal("comparisonToFixedQwenReader.readerCapacityBottleneckSupported"),
      historicalValue: z.literal(true),
      action: z.literal("withdraw_and_relabel"),
      replacementClaim: z.literal("fixed_packet_qwen2b_reader_capacity_bottleneck_supported"),
      replacementScope: z.literal("public_synthetic_fixed_packet_reader_comparison"),
      bornAgentAgentMemoryEffect: z.literal("not_tested"),
    }).strict(),
    z.object({
      artifactId: z.literal("fal-memory-shared-v1-local-reader-receipt"),
      fieldPath: z.literal("product.productFit"),
      historicalValue: z.literal("not_demonstrated"),
      action: z.literal("withdraw_and_relabel"),
      replacementClaim: z.literal("product_fit_not_assessed_by_shared_benchmark"),
      replacementScope: z.literal("preloaded_retrieval_and_fixed_packet_reader_only"),
      bornAgentAgentMemoryEffect: z.literal("not_tested"),
    }).strict(),
  ]),
  existingProductPathEvidence: z.object({
    status: z.literal("structural_pipeline_tested_with_fake_model"),
    covered: z.tuple([
      z.literal("session_a_product_ingest"),
      z.literal("full_process_restart"),
      z.literal("session_b_automatic_recall_context_injection"),
    ]),
    notCovered: z.tuple([
      z.literal("live_model_behavior_delta"),
      z.literal("agent_tool_outcome_delta"),
      z.literal("paired_memory_off_on_task_success"),
    ]),
    effectStatus: z.literal("not_tested"),
  }).strict(),
  effectClaimGate: z.tuple([
    z.literal("same_model_task_budget_and_permissions"),
    z.literal("session_a_uses_product_memory_write_and_admission"),
    z.literal("full_process_restart_before_session_b"),
    z.literal("session_b_uses_product_automatic_recall_and_context_injection"),
    z.literal("bornagent_agent_loop_and_tools_execute"),
    z.literal("task_outcome_scored_by_independent_verifier"),
    z.literal("paired_memory_off_and_memory_on_comparison"),
  ]),
  finalInterpretation: z.object({
    bornAgentAgentMemoryTaskEffect: z.literal("not_tested"),
    contextFoldingRealWorkloadEffect: z.literal("not_tested"),
    localEmbeddingAgentTaskEffect: z.literal("not_tested"),
    componentEvidenceRetained: z.literal(true),
    fixedReaderEvidenceClass: z.literal("diagnostic_only"),
    effectClaimAllowed: z.literal(false),
  }).strict(),
  correctionSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const artifactIds = value.appliesTo.map((entry) => entry.artifactId);
  const paths = value.appliesTo.map((entry) => entry.path);
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({ code: "custom", message: "effect-scope correction artifact IDs must be unique" });
  }
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "effect-scope correction artifact paths must be unique" });
  }
});

export type AgentMemoryEffectScopeCorrection = Readonly<
  z.infer<typeof agentMemoryEffectScopeCorrectionSchema>
>;

export function parseAgentMemoryEffectScopeCorrection(
  input: unknown,
): AgentMemoryEffectScopeCorrection {
  const parsed = agentMemoryEffectScopeCorrectionSchema.parse(input);
  const { correctionSha256, ...content } = parsed;
  if (sha256Canonical(content) !== correctionSha256) {
    throw new Error("agent-memory effect-scope correction logical hash mismatch");
  }
  return Object.freeze(parsed);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFieldPath(input: unknown, fieldPath: string): unknown {
  let current = input;
  for (const segment of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      throw new Error(`effect-scope correction field is missing: ${fieldPath}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function verifyAgentMemoryEffectScopeCorrection(
  repositoryRoot: string,
  input: unknown,
): Promise<AgentMemoryEffectScopeCorrection> {
  const correction = parseAgentMemoryEffectScopeCorrection(input);
  const artifacts = new Map<string, unknown>();
  for (const artifact of correction.appliesTo) {
    const bytes = await readFile(join(repositoryRoot, artifact.path));
    if (sha256(bytes) !== artifact.rawSha256) {
      throw new Error(`effect-scope correction artifact hash mismatch: ${artifact.artifactId}`);
    }
    artifacts.set(artifact.artifactId, parseStrictJson(bytes.toString("utf8")));
  }

  for (const claim of correction.historicalClaimCorrections) {
    const artifact = artifacts.get(claim.artifactId);
    if (artifact === undefined) {
      throw new Error(`effect-scope correction artifact is not bound: ${claim.artifactId}`);
    }
    if (readFieldPath(artifact, claim.fieldPath) !== claim.historicalValue) {
      throw new Error(
        `effect-scope correction historical value mismatch: ${claim.artifactId}.${claim.fieldPath}`,
      );
    }
  }
  return correction;
}
