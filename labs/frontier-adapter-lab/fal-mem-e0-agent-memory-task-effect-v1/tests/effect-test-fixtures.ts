import { createMemE0ActorQualificationFreeze, MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS, MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256 } from "../src/actor-qualification.js";
const sha = (value: string) => value.repeat(64);
const commit = (value: string) => value.repeat(40);
const TARGET_RELATIVE_PATH = "src/qualification-target.txt";

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

export function qualificationCompletedInput(identity = qualificationIdentity()) {
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
      changedPaths: [identity.task.targetRelativePath],
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
