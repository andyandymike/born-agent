import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { FalVp0Procedure } from "./procedure-schema.js";
import type {
  FalVp0HostFactRegistryEntry,
  FalVp0PredicateEvaluation,
} from "./host-fact-predicate.js";
import {
  evaluateFalVp0Predicate,
  falVp0PredicateEvaluationSchema,
} from "./host-fact-predicate.js";
import {
  identifierSchema,
  sha256Schema,
} from "./protocol.js";
import type { hostFactValueSchema } from "./protocol.js";

const fallbackReasonSchema = z.enum([
  "source_ineligible",
  "scope_mismatch",
  "version_not_applicable",
  "activation_not_applicable",
  "negative_condition_matched",
  "precondition_not_satisfied",
  "predicate_rejected",
  "adapter_disabled",
  "deadline_exhausted",
  "materialization_throw",
  "materialization_timeout",
  "materialization_invalid",
  "materialization_oversize",
]);

export const falVp0ApplicabilityDecisionSchema = z.object({
  procedureId: identifierSchema,
  applicability: z.enum(["applicable", "applicable_guarded", "not_applicable", "fallback_error"]),
  decisionStage: z.enum([
    "source",
    "scope",
    "version",
    "activation",
    "negative",
    "precondition",
    "materialization",
    "selected",
  ]),
  candidateInvoked: z.boolean(),
  fallbackReasonCode: fallbackReasonSchema.nullable(),
  predicateEvaluations: z.array(falVp0PredicateEvaluationSchema).max(64),
  changedGuardConditionIds: z.array(identifierSchema).max(8),
  decisionSha256: sha256Schema,
}).strict();

export type FalVp0ApplicabilityDecision = Readonly<
  z.infer<typeof falVp0ApplicabilityDecisionSchema>
>;

type HostFactValue = z.infer<typeof hostFactValueSchema>;

interface GateContext {
  readonly evidenceByFactKey: Readonly<Record<string, readonly string[]>>;
  readonly facts: Readonly<Record<string, HostFactValue>>;
  readonly registryByFactKey: Readonly<Record<string, FalVp0HostFactRegistryEntry>>;
  readonly workspaceBeforeSha256: string | null;
}

function decision(input: Omit<FalVp0ApplicabilityDecision, "decisionSha256">): FalVp0ApplicabilityDecision {
  return falVp0ApplicabilityDecisionSchema.parse({
    ...input,
    decisionSha256: sha256Canonical(input),
  });
}

function evaluateCondition(
  condition: FalVp0Procedure["activationConditions"][number],
  context: GateContext,
): FalVp0PredicateEvaluation {
  return evaluateFalVp0Predicate({
    conditionId: condition.conditionId,
    evidenceSha256s: context.evidenceByFactKey[condition.predicate.factKey] ?? [],
    facts: context.facts,
    predicate: condition.predicate,
    registryEntry: context.registryByFactKey[condition.predicate.factKey] ?? null,
    workspaceBeforeSha256: context.workspaceBeforeSha256,
  });
}

export function evaluateFalVp0Applicability(input: {
  readonly adapterEnabled: boolean;
  readonly context: GateContext;
  readonly deadlineExhausted: boolean;
  readonly expectedScope: FalVp0Procedure["scope"];
  readonly procedure: FalVp0Procedure;
  readonly sourceEligible: boolean;
}): FalVp0ApplicabilityDecision {
  const evaluations: FalVp0PredicateEvaluation[] = [];
  const blocked = (
    stage: FalVp0ApplicabilityDecision["decisionStage"],
    reason: z.infer<typeof fallbackReasonSchema>,
    error = false,
  ): FalVp0ApplicabilityDecision => decision({
    procedureId: input.procedure.procedureId,
    applicability: error ? "fallback_error" : "not_applicable",
    decisionStage: stage,
    candidateInvoked: false,
    fallbackReasonCode: reason,
    predicateEvaluations: evaluations,
    changedGuardConditionIds: [],
  });
  if (!input.adapterEnabled) return blocked("source", "adapter_disabled");
  if (!input.sourceEligible) return blocked("source", "source_ineligible");
  if (
    input.expectedScope.ownerPrincipalId !== input.procedure.scope.ownerPrincipalId ||
    input.expectedScope.applicationRepositoryId !== input.procedure.scope.applicationRepositoryId ||
    input.expectedScope.canonicalRootIdentitySha256 !== input.procedure.scope.canonicalRootIdentitySha256
  ) {
    return blocked("scope", "scope_mismatch");
  }
  if (input.deadlineExhausted) return blocked("materialization", "deadline_exhausted", true);

  const version = evaluateCondition(input.procedure.compatibility.versionCondition, input.context);
  evaluations.push(version);
  if (version.gateValue === "reject") return blocked("version", "predicate_rejected", true);
  if (!version.gateValue) return blocked("version", "version_not_applicable");

  for (const condition of input.procedure.activationConditions) {
    const evaluated = evaluateCondition(condition, input.context);
    evaluations.push(evaluated);
    if (evaluated.gateValue === "reject") return blocked("activation", "predicate_rejected", true);
    if (!evaluated.gateValue) return blocked("activation", "activation_not_applicable");
  }
  for (const condition of input.procedure.negativeConditions) {
    const evaluated = evaluateCondition(condition, input.context);
    evaluations.push(evaluated);
    if (evaluated.gateValue === "reject") return blocked("negative", "predicate_rejected", true);
    if (evaluated.gateValue) return blocked("negative", "negative_condition_matched");
  }
  for (const condition of input.procedure.preconditions) {
    const evaluated = evaluateCondition(condition, input.context);
    evaluations.push(evaluated);
    if (evaluated.gateValue === "reject") return blocked("precondition", "predicate_rejected", true);
    if (!evaluated.gateValue) return blocked("precondition", "precondition_not_satisfied");
  }
  const changedGuardConditionIds: string[] = [];
  for (const condition of input.procedure.guardChecks) {
    const evaluated = evaluateCondition(condition, input.context);
    evaluations.push(evaluated);
    if (evaluated.gateValue === "reject") return blocked("precondition", "predicate_rejected", true);
    if (!evaluated.gateValue) changedGuardConditionIds.push(condition.conditionId);
  }
  return decision({
    procedureId: input.procedure.procedureId,
    applicability: changedGuardConditionIds.length === 0 ? "applicable" : "applicable_guarded",
    decisionStage: "selected",
    candidateInvoked: true,
    fallbackReasonCode: null,
    predicateEvaluations: evaluations,
    changedGuardConditionIds,
  });
}
