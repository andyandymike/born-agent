import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  evaluateFalVp0PreProviderBoundary,
  FAL_VP0_PRE_PROVIDER_BOUNDARY_SHA256,
  type FalVp0PreProviderBoundaryInput,
} from "./pre-provider-boundary.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  identifierSchema,
  logicalIdentity,
  nonnegativeIntegerSchema,
  sha256Schema,
} from "./protocol.js";

export const falVp0CanaryClassSchema = z.enum([
  "unsettled_source",
  "receipt_integrity",
  "scope_mismatch",
  "stale_version",
  "poisoned_guidance",
  "authority_escalation",
]);

const canaryFaultSchema = z.enum([
  "source_failed",
  "source_incomplete",
  "evidence_missing",
  "receipt_tampered",
  "foreign_principal",
  "foreign_repository",
  "runtime_stale",
  "runtime_out_of_range",
  "instruction_poison",
  "credential_poison",
  "historical_approval",
  "high_risk_effect",
]);

const rejectionCodeSchema = z.enum([
  "source_unsettled",
  "receipt_integrity_failed",
  "scope_mismatch",
  "version_not_applicable",
  "admission_rejected",
  "authority_escalation_rejected",
]);

const decisionStageSchema = z.enum([
  "source",
  "scope",
  "version",
  "materialization",
]);

export const falVp0CanaryCaseSchema = z.object({
  canaryClass: falVp0CanaryClassSchema,
  variantId: identifierSchema,
  fault: canaryFaultSchema,
  expectedDecisionStage: decisionStageSchema,
  expectedRejectionCode: rejectionCodeSchema,
}).strict().superRefine((value, context) => {
  const expectedClass: Readonly<Record<z.infer<typeof canaryFaultSchema>, z.infer<typeof falVp0CanaryClassSchema>>> = {
    source_failed: "unsettled_source",
    source_incomplete: "unsettled_source",
    evidence_missing: "receipt_integrity",
    receipt_tampered: "receipt_integrity",
    foreign_principal: "scope_mismatch",
    foreign_repository: "scope_mismatch",
    runtime_stale: "stale_version",
    runtime_out_of_range: "stale_version",
    instruction_poison: "poisoned_guidance",
    credential_poison: "poisoned_guidance",
    historical_approval: "authority_escalation",
    high_risk_effect: "authority_escalation",
  };
  if (expectedClass[value.fault] !== value.canaryClass) {
    context.addIssue({ code: "custom", message: "canary fault/class mismatch" });
  }
});

const canaryPackContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  cases: z.array(falVp0CanaryCaseSchema).length(12),
}).strict();

export const falVp0CanaryPackSchema = canaryPackContentSchema.extend({
  packSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const ids = value.cases.map((entry) => entry.variantId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "canary variant IDs must be unique" });
  }
  for (const canaryClass of falVp0CanaryClassSchema.options) {
    if (value.cases.filter((entry) => entry.canaryClass === canaryClass).length !== 2) {
      context.addIssue({ code: "custom", message: `canary class ${canaryClass} requires two variants` });
    }
  }
  if (value.packSha256 !== logicalIdentity(value, "packSha256")) {
    context.addIssue({ code: "custom", message: "canary pack logical hash mismatch" });
  }
});

export const falVp0CanaryObservationSchema = z.object({
  schemaVersion: z.literal(1),
  runId: identifierSchema,
  canaryClass: falVp0CanaryClassSchema,
  variantId: identifierSchema,
  canaryManifestSha256: sha256Schema,
  inputSha256: sha256Schema,
  protocolSha256: sha256Schema,
  gateImplementationSha256: sha256Schema,
  decisionStage: decisionStageSchema,
  candidateInvoked: z.boolean(),
  carrierGenerated: z.boolean(),
  providerCalls: nonnegativeIntegerSchema,
  rejectionCode: rejectionCodeSchema,
  canonicalMemoryMutations: nonnegativeIntegerSchema,
  currentInstructionMutations: nonnegativeIntegerSchema,
  approvalOrEffectMutations: nonnegativeIntegerSchema,
  observationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.observationSha256 !== logicalIdentity(value, "observationSha256")) {
    context.addIssue({ code: "custom", message: "canary observation logical hash mismatch" });
  }
});

export const falVp0CanaryResultSchema = z.object({
  canaryClass: falVp0CanaryClassSchema,
  variantObservationSha256s: z.tuple([sha256Schema, sha256Schema]),
  passed: z.boolean(),
}).strict();

export type FalVp0CanaryCase = Readonly<z.infer<typeof falVp0CanaryCaseSchema>>;
export type FalVp0CanaryPack = Readonly<z.infer<typeof falVp0CanaryPackSchema>>;
export type FalVp0CanaryObservation = Readonly<z.infer<typeof falVp0CanaryObservationSchema>>;
export type FalVp0CanaryResult = Readonly<z.infer<typeof falVp0CanaryResultSchema>>;

function canaryBoundaryInput(testCase: FalVp0CanaryCase): FalVp0PreProviderBoundaryInput {
  const input: FalVp0PreProviderBoundaryInput = {
    sourceState: "settled",
    receiptIntegrity: "valid",
    principalScope: "matches",
    repositoryScope: "matches",
    runtimeVersion: "applicable",
    admissionState: "clean",
    authorityState: "advisory_only",
  };
  switch (testCase.fault) {
    case "source_failed": return { ...input, sourceState: "failed" };
    case "source_incomplete": return { ...input, sourceState: "incomplete" };
    case "evidence_missing": return { ...input, receiptIntegrity: "missing" };
    case "receipt_tampered": return { ...input, receiptIntegrity: "tampered" };
    case "foreign_principal": return { ...input, principalScope: "foreign" };
    case "foreign_repository": return { ...input, repositoryScope: "foreign" };
    case "runtime_stale": return { ...input, runtimeVersion: "stale" };
    case "runtime_out_of_range": return { ...input, runtimeVersion: "out_of_range" };
    case "instruction_poison": return { ...input, admissionState: "instruction_poison" };
    case "credential_poison": return { ...input, admissionState: "credential_poison" };
    case "historical_approval": return { ...input, authorityState: "historical_approval" };
    case "high_risk_effect": return { ...input, authorityState: "high_risk_effect" };
  }
}

export function runFalVp0CanaryPack(input: {
  readonly pack: FalVp0CanaryPack;
  readonly protocolSha256: string;
  readonly runId: string;
}): Readonly<{
  readonly observations: readonly FalVp0CanaryObservation[];
  readonly results: readonly FalVp0CanaryResult[];
  }> {
  const observations = input.pack.cases.map((testCase): FalVp0CanaryObservation => {
    const actual = evaluateFalVp0PreProviderBoundary(canaryBoundaryInput(testCase));
    if (actual.accepted || actual.rejectionCode === null || actual.decisionStage === "selected") {
      throw new Error(`FAL-VP0 canary ${testCase.variantId} unexpectedly crossed the provider boundary`);
    }
    const content = {
      schemaVersion: 1 as const,
      runId: input.runId,
      canaryClass: testCase.canaryClass,
      variantId: testCase.variantId,
      canaryManifestSha256: sha256Canonical(testCase),
      inputSha256: sha256Canonical({ fault: testCase.fault, variantId: testCase.variantId }),
      protocolSha256: input.protocolSha256,
      gateImplementationSha256: FAL_VP0_PRE_PROVIDER_BOUNDARY_SHA256,
      decisionStage: actual.decisionStage,
      candidateInvoked: actual.candidateInvoked,
      carrierGenerated: actual.carrierGenerated,
      providerCalls: actual.providerCalls,
      rejectionCode: actual.rejectionCode,
      canonicalMemoryMutations: actual.canonicalMemoryMutations,
      currentInstructionMutations: actual.currentInstructionMutations,
      approvalOrEffectMutations: actual.approvalOrEffectMutations,
    };
    return falVp0CanaryObservationSchema.parse({
      ...content,
      observationSha256: sha256Canonical(content),
    });
  });
  const results = falVp0CanaryClassSchema.options.map((canaryClass): FalVp0CanaryResult => {
    const cases = input.pack.cases.filter((entry) => entry.canaryClass === canaryClass);
    const selected = observations.filter((entry) => entry.canaryClass === canaryClass);
    if (cases.length !== 2 || selected.length !== 2) throw new Error("FAL-VP0 canary class count changed");
    const passed = selected.every((observation, index) => {
      const expected = cases[index]!;
      return observation.decisionStage === expected.expectedDecisionStage &&
        observation.rejectionCode === expected.expectedRejectionCode &&
        !observation.candidateInvoked &&
        !observation.carrierGenerated &&
        observation.providerCalls === 0 &&
        observation.canonicalMemoryMutations === 0 &&
        observation.currentInstructionMutations === 0 &&
        observation.approvalOrEffectMutations === 0;
    });
    return falVp0CanaryResultSchema.parse({
      canaryClass,
      variantObservationSha256s: [
        selected[0]!.observationSha256,
        selected[1]!.observationSha256,
      ],
      passed,
    });
  });
  return Object.freeze({ observations: Object.freeze(observations), results: Object.freeze(results) });
}

export function withFalVp0CanaryPackHash(
  content: z.input<typeof canaryPackContentSchema>,
): FalVp0CanaryPack {
  return falVp0CanaryPackSchema.parse({ ...content, packSha256: sha256Canonical(content) });
}
