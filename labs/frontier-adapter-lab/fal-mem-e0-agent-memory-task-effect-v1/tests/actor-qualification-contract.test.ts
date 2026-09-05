import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  createMemE0ActorQualificationFreeze,
  createMemE0ActorQualificationReceipt,
  createNotRunMemE0ActorQualificationReceipt,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256,
  parseMemE0ActorQualificationFreeze,
  parseMemE0ActorQualificationReceipt,
  scoreMemE0ActorQualificationObservation,
} from "../src/actor-qualification.js";

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const targetRelativePath = "src/qualification-target.txt";

function qualificationFreeze() {
  return createMemE0ActorQualificationFreeze({
    adapterConfigSha256: sha("1"),
    modelQualificationEvidenceSha256: sha("0"),
    modelQualificationIdentitySha256: sha("a"),
    modelQualificationObservationSha256: sha("b"),
    modelQualificationPricingSha256: sha("c"),
    modelQualificationProtocolSha256: sha("d"),
    modelQualificationRecordSha256: sha("e"),
    policySha256: sha("2"),
    pricingSha256: sha("3"),
    productionPiRuntimeImplementationSha256: sha("f"),
    qualificationFixtureSha256: sha("4"),
    qualificationProtocolSha256: sha("5"),
    systemInstructionSha256: sha("6"),
    toolCatalogSha256: sha("7"),
  });
}

function legacyV1QualificationFreeze() {
  const current = qualificationFreeze();
  const currentContent = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== "actorFreezeSha256"),
  );
  const caps = {
    maximumAuthorizedCostUsdMicros: 33_609,
    maximumOutputTokensPerRequest: 2_048,
    maximumOutputTokensTotal: 8_192,
    maximumProviderRequests: 4,
    maximumReportedTokens: 60_000,
    retries: 0,
  } as const;
  const content = {
    ...currentContent,
    budgetSha256: sha256Canonical(caps),
    caps,
  };
  return {
    ...content,
    actorFreezeSha256: sha256Canonical(content),
  };
}

function identityInput() {
  return {
    freeze: qualificationFreeze(),
    source: {
      commit: commit("a"),
      implementationSha256s: [sha("8"), sha("9")],
      protectedPathsClean: true,
      protectedTreeSha256: sha("b"),
    },
    task: {
      allowedChangedPaths: [targetRelativePath],
      disclosureClass: "public_synthetic",
      hiddenVerifierSha256: sha("c"),
      initialTargetSha256: sha("0"),
      initialWorkspaceManifestSha256: sha("d"),
      memoryMode: "off",
      publicVerifierSha256: sha("e"),
      targetRelativePath,
      taskSha256: sha("f"),
    },
  };
}

function validCompletedInput() {
  const identity = identityInput();
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
      maximumObservedOutputTokensPerRequest: 200,
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
      changedPaths: [targetRelativePath],
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
      observedProtectedTreeSha256: identity.source.protectedTreeSha256,
      observedPolicySha256: identity.freeze.policySha256,
      observedProductionPiRuntimeImplementationSha256:
        identity.freeze.productionPiRuntimeImplementationSha256,
      observedPublicVerifierSha256: identity.task.publicVerifierSha256,
      observedQualificationFixtureSha256:
        identity.freeze.qualificationFixtureSha256,
      observedQualificationProtocolSha256:
        identity.freeze.qualificationProtocolSha256,
      observedSourceCommit: identity.source.commit,
      observedSystemInstructionSha256: identity.freeze.systemInstructionSha256,
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

function resealReceipt(value: Readonly<Record<string, unknown>>) {
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "receiptSha256"),
  );
  return {
    ...content,
    receiptSha256: sha256Canonical(content),
  };
}

describe("MEM-E0 exact DeepSeek actor qualification contract", () => {
  it("creates a self-hashed default not-run receipt with zero provider calls", () => {
    const receipt = createNotRunMemE0ActorQualificationReceipt(identityInput());

    expect(receipt).toMatchObject({
      effectClaimAllowed: false,
      providerCalls: 0,
      providerUsage: null,
      result: {
        reasonCode: "qualification_not_authorized",
        status: "not_run",
      },
      run: null,
      verifier: null,
    });
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseMemE0ActorQualificationReceipt(receipt)).toEqual(receipt);
  });

  it("derives passed only from the complete production observation", () => {
    const input = validCompletedInput();
    const result = scoreMemE0ActorQualificationObservation(input);
    const receipt = createMemE0ActorQualificationReceipt(input);

    expect(result).toEqual({
      reasonCode: "exact_product_tool_actor_passed",
      status: "passed",
    });
    expect(receipt).toMatchObject({
      effectClaimAllowed: false,
      freeze: {
        productionPiRuntimeImplementationSha256: sha("f"),
      },
      providerCalls: 4,
      providerUsage: {
        accountedPeakCostUsdMicros: 1_100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completeUsageEvents: 4,
        inputTokens: 1_000,
        maximumObservedOutputTokensPerRequest: 200,
        outputTokens: 500,
        partialUsageEvents: 0,
        retryPolicyEvidence: {
          configuredMaximumRetries: 0,
          evidenceKind: "frozen_production_implementation_identity",
          frozenProductionImplementationIdentitySha256: sha("f"),
          transportRetriesObserved: null,
        },
        totalTokens: 1_500,
      },
      result,
      run: {
        domainHarnessUsed: false,
        observedProductionPiRuntimeImplementationSha256: sha("f"),
        toolNames: ["read_file", "apply_patch", "run_command", "finish_task"],
      },
      verifier: {
        agentExitedBeforeVerifier: true,
        distinctOsProcesses: true,
        passed: true,
      },
    });
    expect(parseMemE0ActorQualificationReceipt(receipt)).toEqual(receipt);
  });

  it("accepts a bounded extra read and one corrected command before verified completion", () => {
    const input = validCompletedInput();
    input.providerUsage.accountedPeakCostUsdMicros = 1_320;
    input.providerUsage.completeUsageEvents = 6;
    input.providerUsage.inputTokens = 1_200;
    input.providerUsage.outputTokens = 600;
    input.providerUsage.requestsCompleted = 6;
    input.providerUsage.requestsStarted = 6;
    input.providerUsage.totalTokens = 1_800;
    input.providerUsage.requestObservationSha256s = [
      sha("0"), sha("1"), sha("2"), sha("3"), sha("4"), sha("5"),
    ];
    input.providerUsage.usageObservationSha256s = [
      sha("6"), sha("7"), sha("8"), sha("9"), sha("a"), sha("b"),
    ];
    input.run.logicalProviderTurnRequestCount = 6;
    input.run.modelRequestObservationSha256s = [
      sha("0"), sha("1"), sha("2"), sha("3"), sha("4"), sha("5"),
    ];
    input.run.toolArgumentSha256s = [
      sha("1"), sha("2"), sha("3"), sha("4"), sha("5"), sha("6"),
    ];
    input.run.toolNames = [
      "read_file",
      "read_file",
      "apply_patch",
      "run_command",
      "run_command",
      "finish_task",
    ];
    input.run.toolSuccessCount = 5;

    expect(scoreMemE0ActorQualificationObservation(input)).toEqual({
      reasonCode: "exact_product_tool_actor_passed",
      status: "passed",
    });
  });

  it("keeps legacy four-turn receipts parseable under their frozen scorer", () => {
    const input = validCompletedInput();
    const freeze = legacyV1QualificationFreeze();
    const legacyInput = {
      ...input,
      freeze,
      providerUsage: {
        ...input.providerUsage,
        maximumAuthorizedCostUsdMicros: 33_609,
      },
      run: {
        ...input.run,
        observedActorFreezeSha256: freeze.actorFreezeSha256,
      },
    };
    const receipt = createMemE0ActorQualificationReceipt(legacyInput);

    expect(receipt.freeze.caps).toEqual(freeze.caps);
    expect(receipt.result).toEqual({
      reasonCode: "exact_product_tool_actor_passed",
      status: "passed",
    });
    expect(parseMemE0ActorQualificationReceipt(receipt)).toEqual(receipt);
  });

  it("does not accept a caller-supplied result", () => {
    expect(() => createMemE0ActorQualificationReceipt({
      ...validCompletedInput(),
      result: {
        reasonCode: "exact_product_tool_actor_passed",
        status: "passed",
      },
    })).toThrow();
    expect(() => createNotRunMemE0ActorQualificationReceipt({
      ...identityInput(),
      result: {
        reasonCode: "exact_product_tool_actor_passed",
        status: "passed",
      },
    })).toThrow();
  });

  it("hard-gates the clean source commit, tree, and actor freeze", () => {
    const dirty = validCompletedInput();
    dirty.source.protectedPathsClean = false;
    expect(scoreMemE0ActorQualificationObservation(dirty)).toMatchObject({
      reasonCode: "source_not_clean",
      status: "failed",
    });

    const wrongCommit = validCompletedInput();
    wrongCommit.run.observedSourceCommit = commit("b");
    expect(scoreMemE0ActorQualificationObservation(wrongCommit)).toMatchObject({
      reasonCode: "identity_drift",
      status: "failed",
    });

    const wrongTree = validCompletedInput();
    wrongTree.run.observedProtectedTreeSha256 = sha("c");
    expect(scoreMemE0ActorQualificationObservation(wrongTree)).toMatchObject({
      reasonCode: "identity_drift",
      status: "failed",
    });

    const wrongFreeze = validCompletedInput();
    wrongFreeze.run.observedActorFreezeSha256 = sha("d");
    expect(scoreMemE0ActorQualificationObservation(wrongFreeze)).toMatchObject({
      reasonCode: "identity_drift",
      status: "failed",
    });

    const wrongProductionRuntime = validCompletedInput();
    wrongProductionRuntime.run.observedProductionPiRuntimeImplementationSha256 =
      sha("0");
    expect(scoreMemE0ActorQualificationObservation(
      wrongProductionRuntime,
    )).toMatchObject({
      reasonCode: "identity_drift",
      status: "failed",
    });
  });

  it("hard-gates Application Service, non-DomainHarness, and AgentLoop", () => {
    const noApplication = validCompletedInput();
    noApplication.run.applicationServiceObserved = false;
    expect(scoreMemE0ActorQualificationObservation(noApplication)).toMatchObject({
      reasonCode: "product_path_failed",
      status: "failed",
    });

    const harness = validCompletedInput();
    harness.run.domainHarnessUsed = true;
    expect(scoreMemE0ActorQualificationObservation(harness)).toMatchObject({
      reasonCode: "product_path_failed",
      status: "failed",
    });

    const noLoop = validCompletedInput();
    noLoop.run.agentLoopObserved = false;
    expect(scoreMemE0ActorQualificationObservation(noLoop)).toMatchObject({
      reasonCode: "product_path_failed",
      status: "failed",
    });
  });

  it("hard-gates bounded read/apply/run/finish topology and effect reconciliation", () => {
    const wrongOrder = validCompletedInput();
    wrongOrder.run.toolNames = [
      "read_file",
      "run_command",
      "apply_patch",
      "finish_task",
    ];
    expect(scoreMemE0ActorQualificationObservation(wrongOrder)).toMatchObject({
      reasonCode: "tool_sequence_failed",
      status: "failed",
    });

    const pending = validCompletedInput();
    pending.run.pendingEffectCount = 1;
    expect(scoreMemE0ActorQualificationObservation(pending)).toMatchObject({
      reasonCode: "tool_sequence_failed",
      status: "failed",
    });
  });

  it("hard-gates complete recorded usage and scorer-derived peak cost", () => {
    const partial = validCompletedInput();
    partial.providerUsage.partialUsageEvents = 1;
    expect(scoreMemE0ActorQualificationObservation(partial)).toMatchObject({
      reasonCode: "usage_incomplete",
      status: "failed",
    });

    const wrongCost = validCompletedInput();
    wrongCost.providerUsage.accountedPeakCostUsdMicros = 1_099;
    expect(scoreMemE0ActorQualificationObservation(wrongCost)).toMatchObject({
      reasonCode: "cost_cap_exceeded",
      status: "failed",
    });

    const retryCount = validCompletedInput();
    retryCount.providerUsage.retries = 1;
    expect(scoreMemE0ActorQualificationObservation(retryCount)).toMatchObject({
      reasonCode: "cost_cap_exceeded",
      status: "failed",
    });

    const wrongRetryImplementation = validCompletedInput();
    wrongRetryImplementation.providerUsage.retryPolicyEvidence
      .frozenProductionImplementationIdentitySha256 = sha("0");
    expect(scoreMemE0ActorQualificationObservation(
      wrongRetryImplementation,
    )).toMatchObject({
      reasonCode: "cost_cap_exceeded",
      status: "failed",
    });

    const observedTransportRetry = validCompletedInput();
    expect(() => scoreMemE0ActorQualificationObservation({
      ...observedTransportRetry,
      providerUsage: {
        ...observedTransportRetry.providerUsage,
        retryPolicyEvidence: {
          ...observedTransportRetry.providerUsage.retryPolicyEvidence,
          transportRetriesObserved: 1,
        },
      },
    })).toThrow();
  });

  it("hard-gates a fresh independent hidden verifier", () => {
    const sameProcess = validCompletedInput();
    sameProcess.verifier.distinctOsProcesses = false;
    expect(scoreMemE0ActorQualificationObservation(sameProcess)).toMatchObject({
      reasonCode: "verifier_failed",
      status: "failed",
    });

    const wrongVerifier = validCompletedInput();
    wrongVerifier.verifier.implementationSha256 = sha("d");
    expect(scoreMemE0ActorQualificationObservation(wrongVerifier)).toMatchObject({
      reasonCode: "verifier_failed",
      status: "failed",
    });
  });

  it("rejects actor-freeze, receipt self-hash, and scorer-result tampering", () => {
    const freeze = qualificationFreeze();
    expect(() => parseMemE0ActorQualificationFreeze({
      ...freeze,
      policySha256: sha("f"),
    })).toThrow();
    expect(() => parseMemE0ActorQualificationFreeze({
      ...freeze,
      productionPiRuntimeImplementationSha256: sha("0"),
    })).toThrow();

    const receipt = createMemE0ActorQualificationReceipt(validCompletedInput());
    expect(() => parseMemE0ActorQualificationReceipt({
      ...receipt,
      receiptSha256: sha("0"),
    })).toThrow();

    const forgedResult = resealReceipt({
      ...receipt,
      result: {
        reasonCode: "product_path_failed",
        status: "failed",
      },
    });
    expect(() => parseMemE0ActorQualificationReceipt(forgedResult)).toThrow();
  });

  it("accepts typed hashes only and rejects raw or absolute-path evidence", () => {
    const sentinel = "MEM_E0_RAW_PROVIDER_SENTINEL";
    const absolutePath = "D:\\private\\qualification-output.txt";
    expect(() => createMemE0ActorQualificationReceipt({
      ...validCompletedInput(),
      rawProviderResponse: `${sentinel}:${absolutePath}`,
    })).toThrow();

    const input = validCompletedInput();
    expect(() => createMemE0ActorQualificationReceipt({
      ...input,
      run: {
        ...input.run,
        rawStdout: `${sentinel}:${absolutePath}`,
      },
    })).toThrow();

    const serialized = JSON.stringify(
      createMemE0ActorQualificationReceipt(validCompletedInput()),
    );
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(absolutePath);
  });
});
