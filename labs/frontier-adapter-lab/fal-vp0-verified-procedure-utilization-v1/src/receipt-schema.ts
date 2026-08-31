import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { falVp0CarrierPairPreflightSchema } from "./carrier-package-preflight.js";
import { falVp0CanaryResultSchema } from "./mechanics-canaries.js";
import { falVp0MechanicsSummarySchema } from "./mechanics-runner.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  commitSchema,
  identifierSchema,
  isStrictlySortedUnique,
  nonnegativeIntegerSchema,
  sha256Schema,
} from "./protocol.js";

export const falVp0ClaimResultSchema = z.object({
  claimId: identifierSchema,
  result: z.enum(["supported", "refuted", "inconclusive", "not_run"]),
  reasonCode: identifierSchema.nullable(),
  boundary: z.string().min(1).max(512),
  metricIds: z.array(identifierSchema).max(32),
  caseRoles: z.array(identifierSchema).max(32),
  evidenceSha256s: z.array(sha256Schema).max(64),
  nonClaims: z.array(z.string().min(1).max(512)).max(32),
}).strict().superRefine((value, context) => {
  if (!isStrictlySortedUnique(value.metricIds) ||
      !isStrictlySortedUnique(value.caseRoles) ||
      !isStrictlySortedUnique(value.evidenceSha256s)) {
    context.addIssue({ code: "custom", message: "claim arrays must be sorted and unique" });
  }
});

const carrierCostAggregateSchema = z.object({
  observedArmCount: nonnegativeIntegerSchema,
  totalCarrierBytes: nonnegativeIntegerSchema,
  medianCarrierBytes: nonnegativeIntegerSchema.nullable(),
  totalCarrierEstimatedTokens: nonnegativeIntegerSchema,
  medianCarrierEstimatedTokens: nonnegativeIntegerSchema.nullable(),
}).strict();

const costSummaryContentSchema = z.object({
  authoring: z.object({
    reviewModelCalls: nonnegativeIntegerSchema,
    inputTokens: nonnegativeIntegerSchema.nullable(),
    outputTokens: nonnegativeIntegerSchema.nullable(),
    estimatedCostUsdMicros: nonnegativeIntegerSchema.nullable(),
  }).strict(),
  adapterReadPath: z.object({
    modelCalls: z.literal(0),
    toolCalls: z.literal(0),
    networkCalls: z.literal(0),
    baselineCarrier: carrierCostAggregateSchema,
    candidateCarrier: carrierCostAggregateSchema,
  }).strict(),
  actor: z.object({
    attempts: nonnegativeIntegerSchema,
    modelCalls: nonnegativeIntegerSchema,
    toolCalls: nonnegativeIntegerSchema,
    inputTokens: nonnegativeIntegerSchema.nullable(),
    outputTokens: nonnegativeIntegerSchema.nullable(),
    estimatedCostUsdMicros: nonnegativeIntegerSchema.nullable(),
  }).strict(),
  storageBytes: nonnegativeIntegerSchema,
  packedArtifactDeltaBytes: nonnegativeIntegerSchema,
  priceScheduleSha256: sha256Schema.nullable(),
}).strict();

export const falVp0CostSummarySchema = costSummaryContentSchema.extend({
  summarySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { summarySha256: _summarySha256, ...content } = value;
  if (_summarySha256 !== sha256Canonical(content)) {
    context.addIssue({ code: "custom", message: "cost summary logical hash mismatch" });
  }
});

export const falVp0MechanicsFreezeEvidenceSchema = z.object({
  mechanicsFreezeCommit: commitSchema,
  mechanicsParentCommit: commitSchema,
  actorPreflightCommit: commitSchema,
  mechanicsTreeSha256: sha256Schema,
  actorPreflightSha256: sha256Schema,
  ancestryEvidenceSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.actorPreflightCommit !== value.mechanicsFreezeCommit) {
    context.addIssue({ code: "custom", message: "actor preflight commit must equal mechanics freeze commit" });
  }
  if (value.mechanicsParentCommit === value.mechanicsFreezeCommit) {
    context.addIssue({ code: "custom", message: "mechanics parent must differ from freeze commit" });
  }
});

const mechanicsReceiptContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  milestone: z.literal("vp0a_mechanics"),
  sourceCommit: commitSchema,
  freezeEvidence: falVp0MechanicsFreezeEvidenceSchema,
  protocolSha256: sha256Schema,
  actorPreflightSha256: sha256Schema,
  actorPreflightStatus: z.enum(["passed", "failed"]),
  implementationHashesSha256: sha256Schema,
  canaryResults: z.array(falVp0CanaryResultSchema).length(6),
  claimResults: z.array(falVp0ClaimResultSchema).length(8),
  lifecycle: z.literal("draft"),
  evidenceValidity: z.enum(["valid", "limited", "invalid"]),
  implementationFidelity: z.enum(["verified", "failed", "inconclusive"]),
  productFit: z.literal("not_assessed"),
  promotion: z.literal("blocked"),
  direction: z.enum(["retain", "revise", "pause", "drop"]),
  reproducibility: z.enum(["full", "corpus_only", "receipt_only"]),
  candidateLifecycle: z.enum(["retained_disabled", "quarantined"]),
  cost: falVp0CostSummarySchema,
  actualFocusedMinutes: nonnegativeIntegerSchema,
}).strict();

export const falVp0MechanicsReceiptSchema = mechanicsReceiptContentSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const claimIds = value.claimResults.map((entry) => entry.claimId);
  if (!isStrictlySortedUnique(claimIds)) {
    context.addIssue({ code: "custom", message: "mechanics receipt claims must be sorted and unique" });
  }
  if (value.sourceCommit !== value.freezeEvidence.mechanicsFreezeCommit ||
      value.actorPreflightSha256 !== value.freezeEvidence.actorPreflightSha256) {
    context.addIssue({ code: "custom", message: "mechanics receipt freeze bindings mismatch" });
  }
  const logical = Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "receiptSha256" && key !== "actualFocusedMinutes"));
  if (value.receiptSha256 !== sha256Canonical(logical)) {
    context.addIssue({ code: "custom", message: "mechanics receipt logical hash mismatch" });
  }
});

export type FalVp0MechanicsFreezeEvidence = Readonly<
  z.infer<typeof falVp0MechanicsFreezeEvidenceSchema>
>;
export type FalVp0MechanicsReceipt = Readonly<
  z.infer<typeof falVp0MechanicsReceiptSchema>
>;

function oneArmCost(carrier: {
  readonly carrierBytes: number;
  readonly estimatedTokens: number;
}) {
  return {
    observedArmCount: 1,
    totalCarrierBytes: carrier.carrierBytes,
    medianCarrierBytes: carrier.carrierBytes,
    totalCarrierEstimatedTokens: carrier.estimatedTokens,
    medianCarrierEstimatedTokens: carrier.estimatedTokens,
  };
}

function claim(input: {
  readonly boundary: string;
  readonly claimId: string;
  readonly evidenceSha256s?: readonly string[];
  readonly metricIds: readonly string[];
  readonly nonClaims: readonly string[];
  readonly reasonCode: string;
  readonly result: "supported" | "refuted" | "inconclusive" | "not_run";
}) {
  return falVp0ClaimResultSchema.parse({
    ...input,
    caseRoles: [],
    evidenceSha256s: [...new Set(input.evidenceSha256s ?? [])].sort(),
    metricIds: [...input.metricIds].sort(),
    nonClaims: input.nonClaims,
  });
}

export function buildFalVp0MechanicsReceipt(input: {
  readonly actualFocusedMinutes: number;
  readonly carrierPreflight: z.input<typeof falVp0CarrierPairPreflightSchema>;
  readonly freezeEvidence: FalVp0MechanicsFreezeEvidence;
  readonly mechanicsSummary: z.input<typeof falVp0MechanicsSummarySchema>;
  readonly packIsolation: Readonly<{
    readonly evidenceSha256: string | null;
    readonly packedArtifactDeltaBytes: number;
    readonly status: "passed" | "failed" | "not_run";
  }>;
  readonly storageBytes: number;
}): FalVp0MechanicsReceipt {
  const summary = falVp0MechanicsSummarySchema.parse(input.mechanicsSummary);
  const carrier = falVp0CarrierPairPreflightSchema.parse(input.carrierPreflight);
  const freeze = falVp0MechanicsFreezeEvidenceSchema.parse(input.freezeEvidence);
  if (input.packIsolation.status === "passed" && input.packIsolation.packedArtifactDeltaBytes !== 0) {
    throw new Error("FAL-VP0 pack isolation cannot pass with a non-zero packed artifact delta");
  }
  const canariesPassed = summary.canaryResults.every((entry) => entry.passed);
  const mechanicsPassed = summary.status === "passed" && carrier.status === "passed" && canariesPassed;
  const packResult = input.packIsolation.status === "passed" ? "supported"
    : input.packIsolation.status === "failed" ? "refuted"
      : "not_run";
  const claims = [
    claim({ claimId: "advisory_authority_isolation", result: carrier.status === "passed" ? "supported" : "refuted", reasonCode: carrier.status === "passed" ? "equal_untrusted_envelope" : "carrier_preflight_failed", boundary: "Equal Skill authority and metadata only; no production authority is granted.", metricIds: ["carrier_preflight"], evidenceSha256s: [carrier.preflightSha256], nonClaims: ["Does not prove task quality."] }),
    claim({ claimId: "equal_quality_efficiency", result: "not_run", reasonCode: "actor_blocked", boundary: "VP0c paired actor evidence only.", metricIds: [], nonClaims: ["No token or tool efficiency claim."] }),
    claim({ claimId: "external_validity_boundary", result: "not_run", reasonCode: "public_fixture_mechanics_only", boundary: "In-process fake lane supports mechanics only.", metricIds: [], nonClaims: ["No product-fit or model-generalization claim."] }),
    claim({ claimId: "fallback_equivalence", result: canariesPassed ? "supported" : "refuted", reasonCode: canariesPassed ? "twelve_canaries_zero_effect" : "canary_failed", boundary: "Pre-provider rejection semantics across six classes and twelve variants.", metricIds: ["canary_classes", "canary_variants"], evidenceSha256s: summary.canaryResults.flatMap((entry) => entry.variantObservationSha256s), nonClaims: ["Does not prove live actor fallback quality."] }),
    claim({ claimId: "held_out_full_pass_utility", result: "not_run", reasonCode: "actor_blocked", boundary: "VP0c held-out paired quality run only.", metricIds: [], nonClaims: ["No held-out quality uplift claim."] }),
    claim({ claimId: "non_regression", result: "not_run", reasonCode: "actor_blocked", boundary: "Requires nine applicable live pairs.", metricIds: [], nonClaims: ["Mechanics pass is not task non-regression."] }),
    claim({ claimId: "pack_isolation", result: packResult, reasonCode: input.packIsolation.status === "passed" ? "packed_delta_zero" : input.packIsolation.status === "failed" ? "packed_delta_nonzero" : "pack_not_run", boundary: "Lab and fixture paths must be absent from the production package.", metricIds: ["packed_artifact_delta_bytes"], evidenceSha256s: input.packIsolation.evidenceSha256 === null ? [] : [input.packIsolation.evidenceSha256], nonClaims: ["Does not validate external installation platforms."] }),
    claim({ claimId: "source_eligibility", result: "not_run", reasonCode: "vp0b_not_run", boundary: "VP0b exact source corpus only.", metricIds: [], nonClaims: ["No source eligibility claim."] }),
  ].sort((left, right) => left.claimId.localeCompare(right.claimId));
  const costContent = {
    authoring: { reviewModelCalls: 0, inputTokens: null, outputTokens: null, estimatedCostUsdMicros: null },
    adapterReadPath: {
      modelCalls: 0 as const,
      toolCalls: 0 as const,
      networkCalls: 0 as const,
      baselineCarrier: oneArmCost(carrier.baseline),
      candidateCarrier: oneArmCost(carrier.candidate),
    },
    actor: { attempts: 0, modelCalls: 0, toolCalls: 0, inputTokens: null, outputTokens: null, estimatedCostUsdMicros: null },
    storageBytes: input.storageBytes,
    packedArtifactDeltaBytes: input.packIsolation.packedArtifactDeltaBytes,
    priceScheduleSha256: null,
  };
  const cost = falVp0CostSummarySchema.parse({
    ...costContent,
    summarySha256: sha256Canonical(costContent),
  });
  const content = {
    schemaVersion: 1 as const,
    experimentId: FAL_VP0_EXPERIMENT_ID,
    milestone: "vp0a_mechanics" as const,
    sourceCommit: freeze.mechanicsFreezeCommit,
    freezeEvidence: freeze,
    protocolSha256: summary.protocolSha256,
    actorPreflightSha256: summary.actorPreflightSha256,
    actorPreflightStatus: summary.actorPreflightStatus,
    implementationHashesSha256: summary.implementationHashesSha256,
    canaryResults: summary.canaryResults,
    claimResults: claims,
    lifecycle: "draft" as const,
    evidenceValidity: mechanicsPassed && input.packIsolation.status === "passed" ? "valid" as const : mechanicsPassed ? "limited" as const : "invalid" as const,
    implementationFidelity: mechanicsPassed ? "verified" as const : canariesPassed ? "inconclusive" as const : "failed" as const,
    productFit: "not_assessed" as const,
    promotion: "blocked" as const,
    direction: !canariesPassed ? "drop" as const : mechanicsPassed ? "revise" as const : "revise" as const,
    reproducibility: mechanicsPassed ? "full" as const : "receipt_only" as const,
    candidateLifecycle: canariesPassed ? "retained_disabled" as const : "quarantined" as const,
    cost,
    actualFocusedMinutes: input.actualFocusedMinutes,
  };
  const logical = Object.fromEntries(Object.entries(content).filter(([key]) =>
    key !== "actualFocusedMinutes"));
  return falVp0MechanicsReceiptSchema.parse({
    ...content,
    receiptSha256: sha256Canonical(logical),
  });
}
