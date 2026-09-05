import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { createExplicitMemoryRecordV1, memoryRecordSourceReferenceSha256 } from "../../../../src/memory/core/memory-record-v1.js";
import { renderHistoricalMemoryExcerptV1 } from "../../../../src/memory/recall/automatic-memory-recall-service.js";
import { phase8NetworkActivityReport } from "../../../../tests/setup-network-tripwire.js";
import { createMemE0ActorQualificationReceipt, createNotRunMemE0ActorQualificationReceipt } from "../src/actor-qualification.js";
import { loadMemE0Fixture, memE0RawSha256 } from "../src/fixture.js";
import {
  createMemE0LiveEffectReceipt, memE0PreparedEffectPlanSchema, parseMemE0LiveEffectReceipt,
  scoreMemE0LiveEffect, sealMemE0PreparedEffectPlan, type MemE0EffectArmEvidence, type MemE0PreparedEffectPlan,
} from "../src/live-effect-contract.js";
import {
  createMemE0LivePlan,
  MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
} from "../src/live-preflight.js";
import { createMemE0LiveEffectRunnerForTesting } from "../src/live-effect-runner.js";
import { qualificationCompletedInput } from "./effect-test-fixtures.js";

const H = "a".repeat(64);
async function planFixture(notRun = false) {
  const input = qualificationCompletedInput();
  const qualification = notRun ? createNotRunMemE0ActorQualificationReceipt({ freeze: input.freeze, source: input.source, task: input.task }) :
    createMemE0ActorQualificationReceipt(input);
  const fixture = await loadMemE0Fixture(resolve("."));
  const preflight = createMemE0LivePlan({ actorQualificationReceipt: qualification, disclosurePolicySha256: H,
    fixtureSha256: sha256Canonical(fixture.cases.map((item) => item.definition.caseSha256)), protocolSha256: fixture.protocol.protocolSha256 });
  const arms = fixture.cases.flatMap((loaded, index) => ["off", "on"].map((arm, ordinal) => {
    const record = createExplicitMemoryRecordV1({ commandId: `synthetic-command-${index}-${ordinal}`, kind: loaded.definition.memory.kind,
      occurredAt: "2026-09-01T00:00:00.000Z", revision: 1, supersedesRevisionId: null, text: loaded.definition.memory.recordText,
      scope: { applicationRepositoryId: `synthetic-repository-${index}-${ordinal}`, canonicalRootIdentitySha256: H, ownerPrincipalId: "synthetic-owner" } });
    return { arm: arm as "off" | "on", beforeStateRawSha256: H, caseId: loaded.definition.caseId,
      disclosure: { disclosureClass: "public_synthetic" as const, excerptContentSha256: memE0RawSha256(renderHistoricalMemoryExcerptV1(record)),
        recordId: record.recordId, recordSha256: record.recordSha256, sourceReferenceSha256: memoryRecordSourceReferenceSha256(record) },
      initialFiles: loaded.publicFiles.map((file) => ({ path: file.path, rawSha256: file.rawSha256 })),
      initialPublicManifestSha256: loaded.definition.publicWorkspace.manifestSha256, initialTargetSha256: loaded.definition.publicWorkspace.initialTargetRawSha256,
      targetPath: loaded.definition.publicWorkspace.targetRelativePath, taskSha256: loaded.definition.task.taskSha256,
      hiddenVerifierSha256: loaded.definition.hiddenVerifier.implementationRawSha256, hiddenVerifierStdoutSha256: loaded.definition.hiddenVerifier.successStdoutSha256,
      hiddenVerifierArgvSha256: loaded.definition.hiddenVerifier.argvIdentitySha256, publicVerifierSha256: loaded.publicFiles.find((file) => file.path === "verify.mjs")!.rawSha256,
      pairInvariantSha256: loaded.definition.caseSha256, recordLogicalSha256: loaded.definition.memory.recordLogicalSha256,
      seedObservationSha256: H, seedEnvelopeRawSha256: H, seedProcessId: 100 + index * 2 + ordinal, stagedModelRecordRawSha256: H };
  }));
  return sealMemE0PreparedEffectPlan({ arms, batchId: "12345678-1234-4234-8234-123456789abc", effectClaimAllowed: false,
    planType: "mem-e0-prepared-live-effect-plan-v1", preflight, providerCalls: 0, qualification, schemaVersion: 1 });
}
function evidenceFixture(plan: MemE0PreparedEffectPlan): MemE0EffectArmEvidence[] {
  return plan.arms.map((prepared, index) => {
    const pass = prepared.arm === "on" || prepared.caseId === "mem-e0-harm-control";
    const historical = prepared.arm === "on" ? 1 : 0;
    const turns = pass ? 6 : 1;
    const usage = { ...structuredClone(plan.qualification.providerUsage!), completeUsageEvents: turns, requestsStarted: turns, requestsCompleted: turns,
      inputTokens: 250 * turns, outputTokens: 125 * turns, totalTokens: 375 * turns, accountedPeakCostUsdMicros: 275 * turns,
      maximumObservedOutputTokensPerRequest: 125, pricingSha256: plan.preflight.pricing.pricingSha256,
      requestObservationSha256s: Array.from({ length: turns }, () => H), usageObservationSha256s: Array.from({ length: turns }, () => H) };
    const run = { ...plan.qualification.run!, agentExitCode: pass ? 0 : 7,
      memoryMode: prepared.arm === "on" ? "local" as const : "off" as const, historicalMemoryItemCount: historical * turns,
      remoteMemoryGrantRequested: historical === 1, observedAdapterConfigSha256: prepared.pairInvariantSha256,
      observedTaskSha256: prepared.taskSha256, observedInitialWorkspaceManifestSha256: prepared.initialPublicManifestSha256,
      observedPublicVerifierSha256: prepared.publicVerifierSha256, logicalProviderTurnRequestCount: turns,
      modelRequestObservationSha256s: usage.requestObservationSha256s, publicVerifierPassed: pass,
      terminal: pass ? "verified_finish_task" as const : "bounded_stop" as const,
      changedPaths: pass ? [prepared.targetPath] : [],
      toolArgumentSha256s: Array.from({ length: turns }, () => H),
      toolNames: pass
        ? [
            "read_file" as const,
            "read_file" as const,
            "apply_patch" as const,
            "run_command" as const,
            "run_command" as const,
            "finish_task" as const,
          ]
        : ["read_file" as const],
      toolSuccessCount: pass ? 5 : 1,
      approvalDecisions: { approved: pass ? 2 : 0, denied: 0, cancelled: 0 } };
    const verifier = { exitCode: pass ? 0 : 1, stderrSha256: H, stdoutSha256: pass ? prepared.hiddenVerifierStdoutSha256 : H };
    return { actor: { actorClass: "production_live", actorProcessId: 500 + index, grantSha256: historical === 1 ? H : null,
      providerUsage: usage, recall: Array.from({ length: turns }, () => ({ canonicalContextSha256: H, contextPlanSha256: H,
        historicalItemCount: historical, recallSelectionSha256: historical === 1 ? H : null })), run, schemaVersion: 1 },
      arm: prepared.arm, caseId: prepared.caseId, changedPaths: pass ? [prepared.targetPath] : [], failureSha256: null,
      finalManifestSha256: H, finalTargetSha256: H, hostStateValid: true, pairInvariantSha256: prepared.pairInvariantSha256,
      seedProcessId: prepared.seedProcessId, sourceStable: true, targetPath: prepared.targetPath,
      expectedHiddenStdoutSha256: prepared.hiddenVerifierStdoutSha256, expectedHiddenImplementationSha256: prepared.hiddenVerifierSha256,
      expectedPublicImplementationSha256: prepared.publicVerifierSha256, verifierAfterActorExit: true,
      publicVerifier: { ...verifier, argvIdentitySha256: sha256Canonical(["node", "verify.mjs"]), implementationRawSha256: prepared.publicVerifierSha256 },
      hiddenVerifier: { ...verifier, argvIdentitySha256: prepared.hiddenVerifierArgvSha256, implementationRawSha256: prepared.hiddenVerifierSha256 } };
  });
}
function receiptFixture(plan: MemE0PreparedEffectPlan, evidence = evidenceFixture(plan)) {
  return createMemE0LiveEffectReceipt({ authorization: { authorizeRemote: true, maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
    planSha256Confirmation: plan.planSha256, scope: "eight_attempt_effect_batch_only" }, evidence,
    evidenceClass: "agent_memory_task_effect_e2e", experimentId: "fal-mem-e0-agent-memory-task-effect-v1", plan,
    receiptType: "mem-e0-live-effect-receipt-v1", schemaVersion: 1, stopReason: "completed" });
}

describe("MEM-E0 live effect contract (synthetic unit evidence only)", () => {
  it("scores eight valid arms with the frozen denominator and round-trips derived receipt fields", async () => {
    const plan = await planFixture();
    const receipt = receiptFixture(plan);
    expect(receipt.decision).toBe("supported_direction_signal");
    expect(receipt.effectClaimAllowed).toBe(true);
    expect(receipt.pairs.map((pair) => pair.outcome)).toEqual(["candidate_only_win", "candidate_only_win", "candidate_only_win", "both_pass"]);
    expect(parseMemE0LiveEffectReceipt(receipt)).toEqual(receipt);
  });
  it("rejects filtered/reordered evidence and rehashed derived-score forgery", async () => {
    const plan = await planFixture();
    const evidence = evidenceFixture(plan);
    expect(() => scoreMemE0LiveEffect(plan, evidence.slice(1))).toThrow();
    const receipt = receiptFixture(plan);
    const { receiptSha256: _old, ...content } = { ...receipt, decision: "refuted_on_frozen_pack" };
    void _old;
    expect(() => parseMemE0LiveEffectReceipt({ ...content, receiptSha256: sha256Canonical(content) })).toThrow();
  });
  it("cannot promote an offline actor, wrong recall, hidden gold drift, incomplete usage or changed source", async () => {
    const plan = await planFixture();
    for (const mutate of [
      (arm: MemE0EffectArmEvidence) => { arm.actor!.actorClass = "offline_test"; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.recall[0]!.historicalItemCount = 0; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.run.observedSourceCommit = "f".repeat(40); },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.providerUsage.completeUsageEvents = 0; },
      (arm: MemE0EffectArmEvidence) => { arm.expectedHiddenStdoutSha256 = H; arm.hiddenVerifier!.stdoutSha256 = H; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.providerUsage.accountedPeakCostUsdMicros = 0; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.run.remoteMemoryGrantRequested = false; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.run.productEntrySha256 = H; },
      (arm: MemE0EffectArmEvidence) => { arm.publicVerifier!.argvIdentitySha256 = H; },
      (arm: MemE0EffectArmEvidence) => { arm.actor!.providerUsage.retryPolicyEvidence.frozenProductionImplementationIdentitySha256 = H; },
    ]) {
      const evidence = evidenceFixture(plan); mutate(evidence[1]!);
      expect(receiptFixture(plan, evidence)).toMatchObject({ decision: "inconclusive", effectClaimAllowed: false });
    }
  });
  it("does not call a hidden-verifier-only success primary completion", async () => {
    const plan = await planFixture(); const evidence = evidenceFixture(plan);
    evidence[1]!.actor!.run.terminal = "bounded_stop";
    const score = scoreMemE0LiveEffect(plan, evidence);
    expect(score.arms[1]).toMatchObject({ valid: true, fullPass: false, solutionPassCompletionFail: true });
  });
  it("refutes only a complete valid negative batch; partial evidence remains inconclusive", async () => {
    const plan = await planFixture(); const evidence = evidenceFixture(plan);
    for (const index of [1, 3, 5]) evidence[index]!.hiddenVerifier!.exitCode = 1;
    expect(receiptFixture(plan, evidence)).toMatchObject({ decision: "refuted_on_frozen_pack", effectClaimAllowed: true });
    expect(scoreMemE0LiveEffect(plan, evidence.slice(0, 4))).toMatchObject({ decision: "inconclusive", effectClaimAllowed: false });
  });
  it("blocks an unqualified or mismatched plan before credentials and child execution", async () => {
    const plan = await planFixture(true); let credentialReads = 0; let childCalls = 0;
    const run = createMemE0LiveEffectRunnerForTesting({ credential: () => { credentialReads += 1; return "sentinel"; },
      child: async () => { childCalls += 1; throw new Error("must not run"); } });
    await expect(run({ repositoryRoot: resolve("."), envelope: { ds0ObservationPath: "unused", plan, preparedRoot: "unused", schemaVersion: 1 },
      authorization: { authorizeRemote: true, maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS, planSha256Confirmation: plan.planSha256,
        scope: "eight_attempt_effect_batch_only" } })).rejects.toThrow();
    expect({ credentialReads, childCalls }).toEqual({ credentialReads: 0, childCalls: 0 });
    const { planSha256: _hash, ...content } = plan; void _hash;
    const changed = { ...content, arms: [...content.arms].reverse() };
    expect(() => memE0PreparedEffectPlanSchema.parse({ ...changed, planSha256: sha256Canonical(changed) })).toThrow();
    expect(phase8NetworkActivityReport().remoteProviderRequestCount).toBe(0);
  });
});
