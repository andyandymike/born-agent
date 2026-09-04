import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { explicitMemoryRecordV1Schema } from "../../../../src/memory/core/memory-record-v1.js";
import {
  MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  memE0ActorQualificationProviderUsageSchema,
  memE0ActorQualificationReceiptSchema,
  memE0ActorQualificationRunSchema,
} from "./actor-qualification.js";
import { MEM_E0_CASE_IDS, MEM_E0_EXPERIMENT_ID } from "./fixture.js";
import { memE0LivePlanSchema } from "./live-preflight.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const arm = z.enum(["off", "on"]);
const file = z.object({ path: z.string().min(1).max(512), rawSha256: hash }).strict();
export const memE0EffectDisclosureSchema = z.object({
  disclosureClass: z.literal("public_synthetic"),
  excerptContentSha256: hash,
  recordId: z.string().regex(/^memory_[a-f0-9]{64}$/u),
  recordSha256: hash,
  sourceReferenceSha256: hash,
}).strict();

export const memE0PreparedEffectArmSchema = z.object({
  arm, caseId: z.enum(MEM_E0_CASE_IDS),
  beforeStateRawSha256: hash,
  disclosure: memE0EffectDisclosureSchema,
  initialFiles: z.array(file).min(3).max(256),
  initialPublicManifestSha256: hash,
  initialTargetSha256: hash,
  targetPath: z.string().min(1).max(256),
  taskSha256: hash,
  hiddenVerifierSha256: hash,
  hiddenVerifierStdoutSha256: hash,
  hiddenVerifierArgvSha256: hash,
  publicVerifierSha256: hash,
  pairInvariantSha256: hash,
  recordLogicalSha256: hash,
  seedObservationSha256: hash,
  seedEnvelopeRawSha256: hash,
  seedProcessId: z.number().int().positive(),
  stagedModelRecordRawSha256: hash,
}).strict();
export type MemE0PreparedEffectArm = z.infer<typeof memE0PreparedEffectArmSchema>;

const batchPlanContent = z.object({
  arms: z.array(memE0PreparedEffectArmSchema).length(8),
  batchId: z.string().uuid(),
  effectClaimAllowed: z.literal(false),
  planType: z.literal("mem-e0-prepared-live-effect-plan-v1"),
  preflight: memE0LivePlanSchema,
  providerCalls: z.literal(0),
  qualification: memE0ActorQualificationReceiptSchema,
  schemaVersion: z.literal(1),
}).strict();
export const memE0PreparedEffectPlanSchema = batchPlanContent.extend({ planSha256: hash }).strict()
  .superRefine((value, context) => {
    const { planSha256, ...content } = value;
    const ordered = MEM_E0_CASE_IDS.flatMap((caseId) => ["off", "on"].map((mode) => `${caseId}/${mode}`));
    if (planSha256 !== sha256Canonical(content) ||
      sha256Canonical(value.arms.map((item) => `${item.caseId}/${item.arm}`)) !== sha256Canonical(ordered) ||
      value.preflight.bindings.actorQualificationReceiptSha256 !== value.qualification.receiptSha256) {
      context.addIssue({ code: "custom", message: "effect plan hash, order or qualification binding drifted" });
    }
    for (let index = 0; index < 8; index += 2) {
      const off = value.arms[index]!;
      const on = value.arms[index + 1]!;
      if (off.pairInvariantSha256 !== on.pairInvariantSha256 || off.recordLogicalSha256 !== on.recordLogicalSha256 ||
        off.initialPublicManifestSha256 !== on.initialPublicManifestSha256 || off.initialTargetSha256 !== on.initialTargetSha256) {
        context.addIssue({ code: "custom", message: "effect pair has a difference other than memory treatment" });
      }
    }
  });
export type MemE0PreparedEffectPlan = z.infer<typeof memE0PreparedEffectPlanSchema>;
export function sealMemE0PreparedEffectPlan(input: z.infer<typeof batchPlanContent>): MemE0PreparedEffectPlan {
  const content = batchPlanContent.parse(input);
  return memE0PreparedEffectPlanSchema.parse({ ...content, planSha256: sha256Canonical(content) });
}

export const memE0EffectAuthorizationSchema = z.object({
  authorizeRemote: z.literal(true),
  maximumEstimatedCostUsdMicros: z.literal(268_872),
  planSha256Confirmation: hash,
  scope: z.literal("eight_attempt_effect_batch_only"),
}).strict();
export type MemE0EffectAuthorization = z.infer<typeof memE0EffectAuthorizationSchema>;

export const memE0EffectRecallSchema = z.object({
  canonicalContextSha256: hash,
  contextPlanSha256: hash,
  historicalItemCount: z.number().int().min(0).max(8),
  recallSelectionSha256: hash.nullable(),
}).strict();
export const memE0EffectActorObservationSchema = z.object({
  actorClass: z.enum(["production_live", "offline_test"]),
  actorProcessId: z.number().int().positive(),
  grantSha256: hash.nullable(),
  providerUsage: memE0ActorQualificationProviderUsageSchema,
  recall: z.array(memE0EffectRecallSchema).max(4),
  run: memE0ActorQualificationRunSchema,
  schemaVersion: z.literal(1),
}).strict();
export type MemE0EffectActorObservation = z.infer<typeof memE0EffectActorObservationSchema>;
export const memE0EffectSeedSchema = z.object({
  observationSha256: hash,
  processId: z.number().int().positive(),
  record: explicitMemoryRecordV1Schema,
  schemaVersion: z.literal(1),
}).strict();

const verifier = z.object({
  argvIdentitySha256: hash,
  exitCode: z.number().int().nullable(),
  implementationRawSha256: hash,
  stderrSha256: hash,
  stdoutSha256: hash,
}).strict();
const effectEvidence = z.object({
  actor: memE0EffectActorObservationSchema.nullable(),
  arm, caseId: z.enum(MEM_E0_CASE_IDS),
  changedPaths: z.array(z.string()).max(16),
  failureSha256: hash.nullable(),
  finalManifestSha256: hash,
  finalTargetSha256: hash,
  hiddenVerifier: verifier.nullable(),
  hostStateValid: z.boolean(),
  pairInvariantSha256: hash,
  publicVerifier: verifier.nullable(),
  seedProcessId: z.number().int().positive(),
  sourceStable: z.boolean(),
  targetPath: z.string(),
  expectedHiddenStdoutSha256: hash,
  expectedHiddenImplementationSha256: hash,
  expectedPublicImplementationSha256: hash,
  verifierAfterActorExit: z.boolean(),
}).strict();
export type MemE0EffectArmEvidence = z.infer<typeof effectEvidence>;

function scoreArm(evidence: MemE0EffectArmEvidence, plan: MemE0PreparedEffectPlan) {
  const prepared = plan.arms.find((item) => item.caseId === evidence.caseId && item.arm === evidence.arm);
  const observation = evidence.actor;
  const run = observation?.run;
  const usage = observation?.providerUsage;
  const freeze = plan.qualification.freeze;
  const expectedCount = evidence.arm === "on" ? 1 : 0;
  const valid = prepared !== undefined && observation !== null && run !== undefined && usage !== undefined &&
    observation.actorClass === "production_live" && evidence.failureSha256 === null && evidence.sourceStable &&
    evidence.hostStateValid && evidence.verifierAfterActorExit && observation.actorProcessId !== evidence.seedProcessId &&
    evidence.seedProcessId === prepared.seedProcessId && evidence.pairInvariantSha256 === prepared.pairInvariantSha256 &&
    run.applicationServiceObserved && run.agentLoopObserved && !run.domainHarnessUsed && !run.orchestrationFailure &&
    run.productEntrySha256 === MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256 && run.toolRegistryCreatedCount === 1 &&
    run.observedQualificationFixtureSha256 === freeze.qualificationFixtureSha256 &&
    run.observedQualificationProtocolSha256 === freeze.qualificationProtocolSha256 &&
    run.endpointScope === "provider_network" && run.modelEvidenceKind === "remote_live_qualified" &&
    run.observedSourceCommit === plan.qualification.source.commit &&
    run.observedProtectedTreeSha256 === plan.qualification.source.protectedTreeSha256 &&
    run.observedActorFreezeSha256 === freeze.actorFreezeSha256 && run.observedToolCatalogSha256 === freeze.toolCatalogSha256 &&
    run.observedSystemInstructionSha256 === freeze.systemInstructionSha256 && run.observedPolicySha256 === freeze.policySha256 &&
    run.observedAdapterConfigSha256 === prepared.pairInvariantSha256 && run.observedTaskSha256 === prepared.taskSha256 &&
    run.observedInitialWorkspaceManifestSha256 === prepared.initialPublicManifestSha256 &&
    run.observedPublicVerifierSha256 === prepared.publicVerifierSha256 &&
    run.observedProductionPiRuntimeImplementationSha256 === freeze.productionPiRuntimeImplementationSha256 &&
    run.modelQualificationRecordSha256 === freeze.modelQualificationRecordSha256 &&
    run.modelQualificationEvidenceSha256 === freeze.modelQualificationEvidenceSha256 &&
    run.modelQualificationIdentitySha256 === freeze.modelQualificationIdentitySha256 &&
    run.modelQualificationObservationSha256 === freeze.modelQualificationObservationSha256 &&
    run.modelQualificationPricingSha256 === freeze.modelQualificationPricingSha256 &&
    run.modelQualificationProtocolSha256 === freeze.modelQualificationProtocolSha256 &&
    evidence.targetPath === prepared.targetPath && evidence.expectedHiddenStdoutSha256 === prepared.hiddenVerifierStdoutSha256 &&
    evidence.expectedHiddenImplementationSha256 === prepared.hiddenVerifierSha256 &&
    evidence.expectedPublicImplementationSha256 === prepared.publicVerifierSha256 &&
    run.memoryMode === (evidence.arm === "on" ? "local" : "off") &&
    run.remoteMemoryGrantRequested === (expectedCount === 1) &&
    evidence.changedPaths.every((path) => path === prepared.targetPath) &&
    sha256Canonical(run.changedPaths) === sha256Canonical(evidence.changedPaths) &&
    run.approvalDecisions.denied === 0 && run.approvalDecisions.cancelled === 0 &&
    run.pendingEffectCount === 0 && run.unknownEffectCount === 0 &&
    usage.requestsStarted > 0 && usage.requestsStarted <= 4 && usage.requestsCompleted === usage.requestsStarted &&
    usage.completeUsageEvents === usage.requestsStarted && usage.partialUsageEvents === 0 && usage.totalTokens <= 60_000 &&
    usage.outputTokens <= 8_192 && usage.maximumObservedOutputTokensPerRequest <= 2_048 && usage.retries === 0 &&
    usage.accountedPeakCostUsdMicros <= 33_609 && usage.pricingSha256 === plan.preflight.pricing.pricingSha256 &&
    usage.maximumAuthorizedCostUsdMicros === 33_609 &&
    usage.retryPolicyEvidence.configuredMaximumRetries === 0 &&
    usage.retryPolicyEvidence.frozenProductionImplementationIdentitySha256 === freeze.productionPiRuntimeImplementationSha256 &&
    usage.totalTokens === usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens &&
    usage.accountedPeakCostUsdMicros === Math.ceil(((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * 440_000 + usage.outputTokens * 1_320_000) / 1_000_000) &&
    usage.requestObservationSha256s.length === usage.requestsStarted && usage.usageObservationSha256s.length === usage.requestsStarted &&
    run.logicalProviderTurnRequestCount === usage.requestsStarted &&
    sha256Canonical(run.modelRequestObservationSha256s) === sha256Canonical(usage.requestObservationSha256s) &&
    run.historicalMemoryItemCount === expectedCount * usage.requestsStarted &&
    observation.recall.length === usage.requestsStarted &&
    observation.recall.every((item) => item.historicalItemCount === expectedCount &&
      (expectedCount === 0 ? item.recallSelectionSha256 === null : item.recallSelectionSha256 !== null)) &&
    (expectedCount === 0 ? observation.grantSha256 === null : observation.grantSha256 !== null) &&
    evidence.hiddenVerifier?.implementationRawSha256 === evidence.expectedHiddenImplementationSha256 &&
    evidence.hiddenVerifier.argvIdentitySha256 === prepared.hiddenVerifierArgvSha256 &&
    evidence.publicVerifier?.implementationRawSha256 === evidence.expectedPublicImplementationSha256 &&
    evidence.publicVerifier.argvIdentitySha256 === sha256Canonical(["node", "verify.mjs"]);
  const solutionPass = evidence.hiddenVerifier?.exitCode === 0 &&
    evidence.hiddenVerifier.stdoutSha256 === evidence.expectedHiddenStdoutSha256 &&
    evidence.publicVerifier?.exitCode === 0 &&
    sha256Canonical(evidence.changedPaths) === sha256Canonical([evidence.targetPath]);
  const fullPass = valid && solutionPass && run?.agentExitCode === 0 && run.terminal === "verified_finish_task" &&
    run.publicVerifierPassed && run.toolNames.includes("finish_task");
  return { arm: evidence.arm, caseId: evidence.caseId, fullPass, solutionPassCompletionFail: valid && solutionPass && !fullPass, valid };
}

export function scoreMemE0LiveEffect(plan: MemE0PreparedEffectPlan, evidence: readonly MemE0EffectArmEvidence[]) {
  const expectedOrder = plan.arms.slice(0, evidence.length).map((item) => `${item.caseId}/${item.arm}`);
  if (evidence.length > 8 || sha256Canonical(expectedOrder) !== sha256Canonical(evidence.map((item) => `${item.caseId}/${item.arm}`))) {
    throw new Error("effect evidence must be the original ordered prefix, never a filtered denominator");
  }
  const arms = evidence.map((item) => scoreArm(item, plan));
  const pairs = MEM_E0_CASE_IDS.map((caseId) => {
    const off = arms.find((item) => item.caseId === caseId && item.arm === "off");
    const on = arms.find((item) => item.caseId === caseId && item.arm === "on");
    const outcome = !off?.valid || !on?.valid ? "inconclusive_invalid_pair" : off.fullPass
      ? on.fullPass ? "both_pass" : "baseline_only_regression"
      : on.fullPass ? "candidate_only_win" : "both_fail";
    return { caseId, outcome };
  });
  const complete = arms.length === 8 && arms.every((item) => item.valid);
  const dependent = pairs.slice(0, 3);
  const direction = dependent.filter((item) => item.outcome === "candidate_only_win").length >= 2 &&
    dependent.every((item) => item.outcome !== "baseline_only_regression") && pairs[3]!.outcome === "both_pass";
  const qualified = plan.qualification.result.status === "passed" && plan.qualification.source.protectedPathsClean;
  return { arms, decision: !complete || !qualified ? "inconclusive" : direction ? "supported_direction_signal" : "refuted_on_frozen_pack",
    effectClaimAllowed: complete && qualified, pairs };
}

const receiptContent = z.object({
  authorization: memE0EffectAuthorizationSchema,
  evidence: z.array(effectEvidence).max(8),
  evidenceClass: z.literal("agent_memory_task_effect_e2e"),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  plan: memE0PreparedEffectPlanSchema,
  receiptType: z.literal("mem-e0-live-effect-receipt-v1"),
  schemaVersion: z.literal(1),
  stopReason: z.enum(["completed", "invalid_arm", "baseline_only_regression", "execution_failed"]),
}).strict();
export function createMemE0LiveEffectReceipt(input: z.infer<typeof receiptContent>) {
  const content = receiptContent.parse(input);
  if (content.authorization.planSha256Confirmation !== content.plan.planSha256) throw new Error("effect authorization mismatched plan");
  const score = scoreMemE0LiveEffect(content.plan, content.evidence);
  const usage = content.evidence.reduce((sum, item) => sum + (item.actor?.providerUsage.accountedPeakCostUsdMicros ?? 33_609), 0);
  const providerCalls = content.evidence.reduce((sum, item) => sum + (item.actor?.providerUsage.requestsStarted ?? 0), 0);
  const derived = { ...content, ...score, accountedPeakCostUsdMicros: usage, providerCalls,
    providerCallsComplete: content.evidence.every((item) => item.actor !== null), isProviderInvoice: false };
  if (usage > content.authorization.maximumEstimatedCostUsdMicros) throw new Error("effect batch cost ceiling exceeded");
  return { ...derived, receiptSha256: sha256Canonical(derived) };
}
export function parseMemE0LiveEffectReceipt(value: unknown): ReturnType<typeof createMemE0LiveEffectReceipt> {
  const input = z.object({ ...receiptContent.shape,
    arms: z.unknown(), pairs: z.unknown(), decision: z.string(), effectClaimAllowed: z.boolean(),
    accountedPeakCostUsdMicros: z.number(), providerCalls: z.number(), providerCallsComplete: z.boolean(),
    isProviderInvoice: z.literal(false), receiptSha256: hash,
  }).strict().parse(value);
  const expected = createMemE0LiveEffectReceipt(receiptContent.parse(Object.fromEntries(
    Object.keys(receiptContent.shape).map((key) => [key, input[key as keyof typeof input]]),
  )));
  if (sha256Canonical(input) !== sha256Canonical(expected)) throw new Error("effect receipt derived score or self-hash mismatch");
  return expected;
}
