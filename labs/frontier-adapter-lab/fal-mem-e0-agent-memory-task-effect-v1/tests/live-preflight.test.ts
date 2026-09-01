import { afterEach, describe, expect, it } from "vitest";

import {
  createMemE0ActorQualificationFreeze,
  createMemE0ActorQualificationReceipt,
  createNotRunMemE0ActorQualificationReceipt,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  type MemE0ActorQualificationReceipt,
} from "../src/actor-qualification.js";
import {
  createMemE0LivePlan,
  createMemE0LivePricingSnapshot,
  evaluateMemE0LivePreflight,
  MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT,
  MEM_E0_LIVE_ENDPOINT,
  MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT,
  MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
  MEM_E0_LIVE_MODEL,
  MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT,
  MEM_E0_LIVE_PAIR_COUNT,
  MEM_E0_LIVE_PROVIDER,
  MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
  parseMemE0LivePlan,
  parseMemE0LivePreflightDecision,
  parseMemE0LivePricingSnapshot,
  type MemE0LivePlan,
  type MemE0LivePreflightAuthorization,
} from "../src/live-preflight.js";

const PROTOCOL_SHA256 = "1".repeat(64);
const FIXTURE_SHA256 = "2".repeat(64);
const DISCLOSURE_POLICY_SHA256 = "3".repeat(64);
const WRONG_SHA256 = "f".repeat(64);
const TARGET_RELATIVE_PATH = "src/qualification-target.txt";
const originalApiKey = process.env.DEEPSEEK_API_KEY;

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);

function qualificationFreeze(adapterCharacter = "1") {
  return createMemE0ActorQualificationFreeze({
    adapterConfigSha256: sha(adapterCharacter),
    modelQualificationEvidenceSha256: sha("8"),
    modelQualificationIdentitySha256: sha("9"),
    modelQualificationObservationSha256: sha("a"),
    modelQualificationPricingSha256: sha("b"),
    modelQualificationProtocolSha256: sha("c"),
    modelQualificationRecordSha256: sha("d"),
    policySha256: sha("2"),
    pricingSha256: sha("3"),
    productionPiRuntimeImplementationSha256: sha("e"),
    qualificationFixtureSha256: sha("4"),
    qualificationProtocolSha256: sha("5"),
    systemInstructionSha256: sha("6"),
    toolCatalogSha256: sha("7"),
  });
}

function qualificationIdentity() {
  return {
    freeze: qualificationFreeze(),
    source: {
      commit: commit("a"),
      implementationSha256s: [sha("8"), sha("9")],
      protectedPathsClean: true,
      protectedTreeSha256: sha("b"),
    },
    task: {
      allowedChangedPaths: [TARGET_RELATIVE_PATH],
      disclosureClass: "public_synthetic",
      hiddenVerifierSha256: sha("c"),
      initialTargetSha256: sha("0"),
      initialWorkspaceManifestSha256: sha("d"),
      memoryMode: "off",
      publicVerifierSha256: sha("e"),
      targetRelativePath: TARGET_RELATIVE_PATH,
      taskSha256: sha("f"),
    },
  };
}

function qualificationCompletedInput() {
  const identity = qualificationIdentity();
  return {
    ...identity,
    providerUsage: {
      accountedPeakCostUsdMicros: 1_100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completeUsageEvents: 4,
      inputTokens: 1_000,
      isProviderInvoice: false,
      maximumAuthorizedCostUsdMicros:
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
      maximumObservedOutputTokensPerRequest: 125,
      outputTokens: 500,
      partialUsageEvents: 0,
      pricingSha256: identity.freeze.pricingSha256,
      requestObservationSha256s: [sha("0"), sha("1"), sha("2"), sha("3")],
      requestsCompleted: 4,
      requestsStarted: 4,
      retries: 0,
      retryPolicyEvidence: {
        configuredMaximumRetries: 0,
        evidenceKind: "frozen_production_implementation_identity",
        frozenProductionImplementationIdentitySha256:
          identity.freeze.productionPiRuntimeImplementationSha256,
        transportRetriesObserved: null,
      },
      totalTokens: 1_500,
      usageObservationSha256s: [sha("4"), sha("5"), sha("6"), sha("7")],
    },
    run: {
      agentExitCode: 0,
      agentLoopObservationSha256: sha("8"),
      agentLoopObserved: true,
      applicationServiceObservationSha256: sha("9"),
      applicationServiceObserved: true,
      approvalDecisions: {
        approved: 2,
        cancelled: 0,
        denied: 0,
      },
      approvalObservationSha256s: [sha("a"), sha("b")],
      changedPaths: [TARGET_RELATIVE_PATH],
      completionEvidenceSha256: sha("c"),
      domainHarnessUsed: false,
      endpointScope: "provider_network",
      historicalMemoryItemCount: 0,
      memoryMode: "off",
      modelEvidenceKind: "remote_live_qualified",
      modelQualificationEvidenceSha256:
        identity.freeze.modelQualificationEvidenceSha256,
      modelQualificationIdentitySha256:
        identity.freeze.modelQualificationIdentitySha256,
      modelQualificationObservationSha256:
        identity.freeze.modelQualificationObservationSha256,
      modelQualificationPricingSha256:
        identity.freeze.modelQualificationPricingSha256,
      modelQualificationProtocolSha256:
        identity.freeze.modelQualificationProtocolSha256,
      modelQualificationRecordSha256:
        identity.freeze.modelQualificationRecordSha256,
      modelRequestObservationSha256s: [sha("d"), sha("e"), sha("f"), sha("0")],
      observedActorFreezeSha256: identity.freeze.actorFreezeSha256,
      observedAdapterConfigSha256: identity.freeze.adapterConfigSha256,
      observedInitialWorkspaceManifestSha256:
        identity.task.initialWorkspaceManifestSha256,
      observedPolicySha256: identity.freeze.policySha256,
      observedProductionPiRuntimeImplementationSha256:
        identity.freeze.productionPiRuntimeImplementationSha256,
      observedProtectedTreeSha256: identity.source.protectedTreeSha256,
      observedPublicVerifierSha256: identity.task.publicVerifierSha256,
      observedQualificationFixtureSha256:
        identity.freeze.qualificationFixtureSha256,
      observedQualificationProtocolSha256:
        identity.freeze.qualificationProtocolSha256,
      observedSourceCommit: identity.source.commit,
      observedSystemInstructionSha256:
        identity.freeze.systemInstructionSha256,
      observedTaskSha256: identity.task.taskSha256,
      observedToolCatalogSha256: identity.freeze.toolCatalogSha256,
      orchestrationFailure: false,
      pendingEffectCount: 0,
      productEntrySha256: MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
      logicalProviderTurnRequestCount: 4,
      publicVerifierPassed: true,
      remoteMemoryGrantRequested: false,
      sessionEventSpanSha256: sha("1"),
      stderrSha256: sha("2"),
      stdoutSha256: sha("3"),
      terminal: "verified_finish_task",
      toolArgumentSha256s: [sha("4"), sha("5"), sha("6"), sha("7")],
      toolNames: ["read_file", "apply_patch", "run_command", "finish_task"],
      toolRegistryCreatedCount: 1,
      toolSuccessCount: 4,
      unknownEffectCount: 0,
    },
    verifier: {
      agentExitedBeforeVerifier: true,
      argvSha256: sha("8"),
      distinctOsProcesses: true,
      exitCode: 0,
      finalTargetSha256: sha("9"),
      finalWorkspaceManifestSha256: sha("a"),
      hiddenVerifierOutsideWorkspace: true,
      implementationSha256: identity.task.hiddenVerifierSha256,
      passed: true,
      stderrSha256: sha("b"),
      stdoutSha256: sha("c"),
    },
  };
}

function passedQualificationReceipt(): MemE0ActorQualificationReceipt {
  return createMemE0ActorQualificationReceipt(qualificationCompletedInput());
}

function notRunQualificationReceipt(): MemE0ActorQualificationReceipt {
  return createNotRunMemE0ActorQualificationReceipt(qualificationIdentity());
}

function failedQualificationReceipt(): MemE0ActorQualificationReceipt {
  const input = qualificationCompletedInput();
  input.run.applicationServiceObserved = false;
  return createMemE0ActorQualificationReceipt(input);
}

function createPlan(
  qualification = passedQualificationReceipt(),
): MemE0LivePlan {
  return createMemE0LivePlan({
    actorQualificationReceipt: qualification,
    disclosurePolicySha256: DISCLOSURE_POLICY_SHA256,
    fixtureSha256: FIXTURE_SHA256,
    protocolSha256: PROTOCOL_SHA256,
  });
}

function readyAuthorization(
  plan: MemE0LivePlan,
  qualification: MemE0ActorQualificationReceipt,
): MemE0LivePreflightAuthorization {
  return {
    actorQualificationReceiptSha256Confirmation: qualification.receiptSha256,
    authorizeRemote: true,
    disclosurePolicySha256Confirmation: DISCLOSURE_POLICY_SHA256,
    fixtureSha256Confirmation: FIXTURE_SHA256,
    maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
    pricingSnapshotSha256Confirmation: plan.pricing.pricingSha256,
    protectedTreeSha256Confirmation: qualification.source.protectedTreeSha256,
    protocolSha256Confirmation: PROTOCOL_SHA256,
    sourceCommitConfirmation: qualification.source.commit,
  };
}

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalApiKey;
  }
});

describe("MEM-E0 live paid preflight", () => {
  it("freezes the exact qualified actor and effect-only paid plan", () => {
    const pricing = createMemE0LivePricingSnapshot();
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);

    expect(plan.provider).toBe(MEM_E0_LIVE_PROVIDER);
    expect(plan.model).toBe(MEM_E0_LIVE_MODEL);
    expect(plan.endpoint).toBe(MEM_E0_LIVE_ENDPOINT);
    expect(plan.bindings).toMatchObject({
      actorFreezeSha256: qualification.freeze.actorFreezeSha256,
      actorQualificationReceiptSha256: qualification.receiptSha256,
      protectedTreeSha256: qualification.source.protectedTreeSha256,
      qualificationFixtureSha256:
        qualification.freeze.qualificationFixtureSha256,
      qualificationProtocolSha256:
        qualification.freeze.qualificationProtocolSha256,
      sourceCommit: qualification.source.commit,
    });
    expect(plan.caps).toEqual({
      effectAttemptCount: MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT,
      inputReserveTokensPerAttempt:
        MEM_E0_LIVE_INPUT_RESERVE_TOKENS_PER_ATTEMPT,
      maximumProviderRequests:
        MEM_E0_LIVE_EFFECT_ATTEMPT_COUNT *
        MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
      maximumRequestsPerAttempt: MEM_E0_LIVE_MAXIMUM_REQUESTS_PER_ATTEMPT,
      outputReserveTokensPerAttempt:
        MEM_E0_LIVE_OUTPUT_RESERVE_TOKENS_PER_ATTEMPT,
      pairCount: MEM_E0_LIVE_PAIR_COUNT,
    });
    expect(plan.cost).toMatchObject({
      scope: "effect_batch_only_excludes_actor_qualification",
      upperBoundUsdMicros: 268_872,
    });
    expect(plan.cost.upperBoundUsdMicros).toBe(
      MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
    );
    expect(plan.authorizationSemantics).toMatchObject({
      actorQualificationCostIncluded: false,
      apiKeyPresenceIsAuthorization: false,
    });
    expect(plan.pricing.pricingSha256).toBe(pricing.pricingSha256);
    expect(qualification.freeze.productionPiRuntimeImplementationSha256).toBe(
      sha("e"),
    );
    expect(qualification.providerUsage?.retryPolicyEvidence).toEqual({
      configuredMaximumRetries: 0,
      evidenceKind: "frozen_production_implementation_identity",
      frozenProductionImplementationIdentitySha256: sha("e"),
      transportRetriesObserved: null,
    });
    expect(parseMemE0LivePricingSnapshot(pricing)).toEqual(pricing);
    expect(parseMemE0LivePlan(plan)).toEqual(plan);
  });

  it("is blocked by default even if an API key exists in the environment", () => {
    const qualification = notRunQualificationReceipt();
    const plan = createPlan(qualification);
    const authorization: MemE0LivePreflightAuthorization = {
      ...readyAuthorization(plan, qualification),
      authorizeRemote: false,
      maximumEstimatedCostUsdMicros: 0,
    };

    delete process.env.DEEPSEEK_API_KEY;
    const withoutKey = evaluateMemE0LivePreflight(
      plan,
      qualification,
      authorization,
    );
    process.env.DEEPSEEK_API_KEY = "key-presence-is-not-authorization";
    const withKey = evaluateMemE0LivePreflight(
      plan,
      qualification,
      authorization,
    );

    expect(withoutKey).toEqual(withKey);
    expect(withKey).toMatchObject({
      actorQualificationReceiptSha256: qualification.receiptSha256,
      providerCallsAuthorized: false,
      reasonCodes: [
        "remote_authorization_missing",
        "cost_ceiling_too_low",
        "actor_qualification_not_run",
      ],
      status: "blocked",
    });
  });

  it("rejects key-like and obsolete self-asserted gate fields", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const authorization = readyAuthorization(plan, qualification);
    for (const extra of [
      { apiKey: "must-never-enter-this-gate" },
      { actorQualification: "passed" },
      { cleanCommit: true },
    ]) {
      expect(() => evaluateMemE0LivePreflight(
        plan,
        qualification,
        { ...authorization, ...extra },
      )).toThrow();
    }
  });

  it.each([
    ["protocolSha256Confirmation", "protocol_confirmation_mismatch"],
    ["fixtureSha256Confirmation", "fixture_confirmation_mismatch"],
    [
      "disclosurePolicySha256Confirmation",
      "disclosure_policy_confirmation_mismatch",
    ],
    ["pricingSnapshotSha256Confirmation", "pricing_confirmation_mismatch"],
  ] as const)("blocks an incorrect effect %s", (field, expectedReason) => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const authorization = {
      ...readyAuthorization(plan, qualification),
      [field]: WRONG_SHA256,
    };
    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      authorization,
    );

    expect(decision).toMatchObject({
      providerCallsAuthorized: false,
      reasonCodes: [expectedReason],
      status: "blocked",
    });
  });

  it.each([
    "actorQualificationReceiptSha256Confirmation",
    "protectedTreeSha256Confirmation",
  ] as const)("blocks an incorrect qualification %s", (field) => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      {
        ...readyAuthorization(plan, qualification),
        [field]: WRONG_SHA256,
      },
    );

    expect(decision).toMatchObject({
      providerCallsAuthorized: false,
      reasonCodes: ["actor_qualification_confirmation_mismatch"],
      status: "blocked",
    });
  });

  it("blocks an incorrect qualification source-commit confirmation", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      {
        ...readyAuthorization(plan, qualification),
        sourceCommitConfirmation: commit("b"),
      },
    );

    expect(decision.reasonCodes).toEqual([
      "actor_qualification_confirmation_mismatch",
    ]);
  });

  it("keeps the effect batch cost authorization separate and exact", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      {
        ...readyAuthorization(plan, qualification),
        maximumEstimatedCostUsdMicros:
          MEM_E0_LIVE_UPPER_BOUND_USD_MICROS - 1,
      },
    );

    expect(decision).toMatchObject({
      providerCallsAuthorized: false,
      reasonCodes: ["cost_ceiling_too_low"],
      status: "blocked",
    });
  });

  it("distinguishes not-run, failed, and dirty qualification receipts", () => {
    const notRun = notRunQualificationReceipt();
    const notRunPlan = createPlan(notRun);
    expect(evaluateMemE0LivePreflight(
      notRunPlan,
      notRun,
      readyAuthorization(notRunPlan, notRun),
    ).reasonCodes).toEqual(["actor_qualification_not_run"]);

    const failed = failedQualificationReceipt();
    const failedPlan = createPlan(failed);
    expect(evaluateMemE0LivePreflight(
      failedPlan,
      failed,
      readyAuthorization(failedPlan, failed),
    ).reasonCodes).toEqual(["actor_qualification_failed"]);

    const dirtyInput = qualificationCompletedInput();
    dirtyInput.source.protectedPathsClean = false;
    const dirty = createMemE0ActorQualificationReceipt(dirtyInput);
    const dirtyPlan = createPlan(dirty);
    expect(evaluateMemE0LivePreflight(
      dirtyPlan,
      dirty,
      readyAuthorization(dirtyPlan, dirty),
    ).reasonCodes).toEqual([
      "actor_qualification_failed",
      "actor_qualification_source_not_clean",
    ]);
  });

  it("returns a stable invalid reason for a tampered qualification receipt", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const decision = evaluateMemE0LivePreflight(
      plan,
      { ...qualification, receiptSha256: WRONG_SHA256 },
      readyAuthorization(plan, qualification),
    );

    expect(decision).toMatchObject({
      actorQualificationReceiptSha256: null,
      providerCallsAuthorized: false,
      reasonCodes: ["actor_qualification_receipt_invalid"],
      status: "blocked",
    });
  });

  it("blocks a valid passed receipt from a different source or actor freeze", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);

    const differentSourceInput = qualificationCompletedInput();
    differentSourceInput.source.commit = commit("b");
    differentSourceInput.run.observedSourceCommit = commit("b");
    const differentSource = createMemE0ActorQualificationReceipt(
      differentSourceInput,
    );
    expect(evaluateMemE0LivePreflight(
      plan,
      differentSource,
      readyAuthorization(plan, qualification),
    ).reasonCodes).toEqual(["actor_qualification_plan_mismatch"]);

    const differentFreezeInput = qualificationCompletedInput();
    differentFreezeInput.freeze = qualificationFreeze("0");
    differentFreezeInput.run.observedActorFreezeSha256 =
      differentFreezeInput.freeze.actorFreezeSha256;
    differentFreezeInput.run.observedAdapterConfigSha256 =
      differentFreezeInput.freeze.adapterConfigSha256;
    const differentFreeze = createMemE0ActorQualificationReceipt(
      differentFreezeInput,
    );
    expect(evaluateMemE0LivePreflight(
      plan,
      differentFreeze,
      readyAuthorization(plan, qualification),
    ).reasonCodes).toEqual(["actor_qualification_plan_mismatch"]);
  });

  it("becomes ready only with the exact passed receipt and confirmations", () => {
    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      readyAuthorization(plan, qualification),
    );

    expect(decision).toMatchObject({
      actorQualificationReceiptSha256: qualification.receiptSha256,
      planSha256: plan.planSha256,
      providerCallsAuthorized: true,
      reasonCodes: [],
      status: "ready",
    });
    expect(parseMemE0LivePreflightDecision(decision)).toEqual(decision);
  });

  it("rejects pricing, plan, and decision tampering through canonical hashes", () => {
    const pricing = createMemE0LivePricingSnapshot();
    expect(() => parseMemE0LivePricingSnapshot({
      ...pricing,
      pricingSha256: WRONG_SHA256,
    })).toThrow();

    const qualification = passedQualificationReceipt();
    const plan = createPlan(qualification);
    expect(() => parseMemE0LivePlan({
      ...plan,
      bindings: {
        ...plan.bindings,
        actorFreezeSha256: WRONG_SHA256,
      },
    })).toThrow();

    const decision = evaluateMemE0LivePreflight(
      plan,
      qualification,
      readyAuthorization(plan, qualification),
    );
    expect(() => parseMemE0LivePreflightDecision({
      ...decision,
      decisionSha256: WRONG_SHA256,
    })).toThrow();
  });
});
