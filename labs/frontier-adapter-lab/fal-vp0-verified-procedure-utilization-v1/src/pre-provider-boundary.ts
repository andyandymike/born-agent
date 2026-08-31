import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

export const falVp0PreProviderBoundaryInputSchema = z.object({
  sourceState: z.enum(["settled", "failed", "incomplete"]),
  receiptIntegrity: z.enum(["valid", "missing", "tampered"]),
  principalScope: z.enum(["matches", "foreign"]),
  repositoryScope: z.enum(["matches", "foreign"]),
  runtimeVersion: z.enum(["applicable", "stale", "out_of_range"]),
  admissionState: z.enum(["clean", "instruction_poison", "credential_poison"]),
  authorityState: z.enum(["advisory_only", "historical_approval", "high_risk_effect"]),
}).strict();

export const falVp0PreProviderBoundaryDecisionSchema = z.object({
  accepted: z.boolean(),
  decisionStage: z.enum(["source", "scope", "version", "materialization", "selected"]),
  rejectionCode: z.enum([
    "source_unsettled",
    "receipt_integrity_failed",
    "scope_mismatch",
    "version_not_applicable",
    "admission_rejected",
    "authority_escalation_rejected",
  ]).nullable(),
  candidateInvoked: z.boolean(),
  carrierGenerated: z.boolean(),
  providerCalls: z.number().int().nonnegative(),
  canonicalMemoryMutations: z.number().int().nonnegative(),
  currentInstructionMutations: z.number().int().nonnegative(),
  approvalOrEffectMutations: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.accepted !== (value.rejectionCode === null && value.decisionStage === "selected")) {
    context.addIssue({ code: "custom", message: "boundary acceptance is not derived" });
  }
  if (!value.accepted && (
    value.candidateInvoked ||
    value.carrierGenerated ||
    value.providerCalls !== 0 ||
    value.canonicalMemoryMutations !== 0 ||
    value.currentInstructionMutations !== 0 ||
    value.approvalOrEffectMutations !== 0
  )) {
    context.addIssue({ code: "custom", message: "rejected boundary decision changed protected state" });
  }
});

export type FalVp0PreProviderBoundaryInput = Readonly<
  z.infer<typeof falVp0PreProviderBoundaryInputSchema>
>;
export type FalVp0PreProviderBoundaryDecision = Readonly<
  z.infer<typeof falVp0PreProviderBoundaryDecisionSchema>
>;

export const FAL_VP0_PRE_PROVIDER_BOUNDARY_SHA256 = sha256Canonical({
  algorithm: "fal-vp0-pre-provider-boundary-v1",
  order: ["source", "receipt_integrity", "scope", "version", "admission", "authority"],
  rejectionSemantics: "zero_candidate_zero_carrier_zero_provider_zero_protected_mutation",
});

function rejected(
  decisionStage: "source" | "scope" | "version" | "materialization",
  rejectionCode: NonNullable<FalVp0PreProviderBoundaryDecision["rejectionCode"]>,
): FalVp0PreProviderBoundaryDecision {
  return falVp0PreProviderBoundaryDecisionSchema.parse({
    accepted: false,
    decisionStage,
    rejectionCode,
    candidateInvoked: false,
    carrierGenerated: false,
    providerCalls: 0,
    canonicalMemoryMutations: 0,
    currentInstructionMutations: 0,
    approvalOrEffectMutations: 0,
  });
}

export function evaluateFalVp0PreProviderBoundary(
  rawInput: FalVp0PreProviderBoundaryInput,
): FalVp0PreProviderBoundaryDecision {
  const input = falVp0PreProviderBoundaryInputSchema.parse(rawInput);
  if (input.sourceState !== "settled") return rejected("source", "source_unsettled");
  if (input.receiptIntegrity !== "valid") return rejected("source", "receipt_integrity_failed");
  if (input.principalScope !== "matches" || input.repositoryScope !== "matches") {
    return rejected("scope", "scope_mismatch");
  }
  if (input.runtimeVersion !== "applicable") {
    return rejected("version", "version_not_applicable");
  }
  if (input.admissionState !== "clean") return rejected("materialization", "admission_rejected");
  if (input.authorityState !== "advisory_only") {
    return rejected("materialization", "authority_escalation_rejected");
  }
  return falVp0PreProviderBoundaryDecisionSchema.parse({
    accepted: true,
    decisionStage: "selected",
    rejectionCode: null,
    candidateInvoked: true,
    carrierGenerated: true,
    providerCalls: 0,
    canonicalMemoryMutations: 0,
    currentInstructionMutations: 0,
    approvalOrEffectMutations: 0,
  });
}
