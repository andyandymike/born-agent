import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256 } from "../src/actor-qualification.js";
import type { MemE0ActorQualificationModelEvidence } from "../src/actor-qualification-model-evidence.js";
import { parseMemE0LiveActorQualificationOutput } from "../src/live-actor-qualification-executor.js";
import {
  createMemE0ActorQualificationRunnerForTesting,
  createMemE0LiveActorQualificationAuthorization,
  parseMemE0LiveActorQualificationAuthorization,
  parseMemE0LiveActorQualificationPlan,
  type MemE0LiveActorQualificationPlan,
} from "../src/live-actor-qualification-runner.js";

const repositoryRoot = resolve(".");
const ds0ObservationPath = resolve(
  ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs",
  "ds0-00000000-0000-4000-8000-000000000000",
  "observation.json",
);
const localRecordRef =
  ".bornagent/mem-e0/model-qualification-record.json";
const finalTarget = [
  "export function harmControlMarker() {",
  "  return \"HARM_PUBLIC_214\";",
  "}",
  "",
].join("\n");
const temporaryRoots: string[] = [];

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const rawSha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
});

function modelEvidence(): MemE0ActorQualificationModelEvidence {
  return Object.freeze({
    descriptor: Object.freeze({
      backend: "deepseek",
      baseUrl: "https://api.deepseek.com",
      endpointScope: "remote_https",
      kind: "remote_live_qualified",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      qualificationCompletedRequestCount: 6,
      qualificationEvidenceKind: "model_capability_probe_suite",
      qualificationEvidenceRef:
        ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/ds0-00000000-0000-4000-8000-000000000000/qualification-record.json",
      qualificationEvidenceSha256: sha("1"),
      qualificationRequestCount: 6,
      qualificationStatus: "passed",
      qualificationUsageCapability: "complete",
      remoteBillableRequests: 6,
      remoteQualificationRequests: 6,
      requestCountScope: "qualification_only",
    }),
    modelQualificationEvidenceSha256: sha("1"),
    modelQualificationIdentitySha256: sha("2"),
    modelQualificationObservationSha256: sha("3"),
    modelQualificationPricingSha256: sha("4"),
    modelQualificationProtocolSha256: sha("5"),
    modelQualificationRecordSha256: sha("6"),
  });
}

function cleanSource(character = "a") {
  return Object.freeze({
    commit: commit(character),
    implementationSha256s: [sha("7"), sha("8")],
    protectedPathsClean: true,
    protectedTreeSha256: sha(character),
  });
}

function authorization(plan: MemE0LiveActorQualificationPlan) {
  return createMemE0LiveActorQualificationAuthorization({
    actorFreezeSha256Confirmation: plan.freeze.actorFreezeSha256,
    authorizeRemote: true,
    ds0ObservationReferenceSha256Confirmation:
      plan.ds0.observationReferenceSha256,
    ds0ObservationSha256Confirmation: plan.ds0.observationSha256,
    maximumAuthorizedCostUsdMicros:
      plan.cost.maximumAuthorizedCostUsdMicros,
    modelQualificationRecordSha256Confirmation: plan.ds0.recordSha256,
    planSha256Confirmation: plan.planSha256,
    protectedTreeSha256Confirmation: plan.source.protectedTreeSha256,
    schemaVersion: 1,
    sourceCommitConfirmation: plan.source.commit,
  });
}

interface Counters {
  cleanup: number;
  credentialReads: number;
  sourceObservations: number;
  spawns: number;
  temporaryRoots: number;
  verifiers: number;
}

function counters(): Counters {
  return {
    cleanup: 0,
    credentialReads: 0,
    sourceObservations: 0,
    spawns: 0,
    temporaryRoots: 0,
    verifiers: 0,
  };
}

function validActorOutput(
  plan: MemE0LiveActorQualificationPlan,
  actorInput: Readonly<{
    readonly source: Readonly<{
      readonly commit: string;
      readonly protectedTreeSha256: string;
    }>;
  }>,
) {
  return {
    actorProcessId: 9_001,
    providerUsage: {
      accountedPeakCostUsdMicros: 1_100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completeUsageEvents: 4,
      inputTokens: 1_000,
      isProviderInvoice: false,
      maximumAuthorizedCostUsdMicros: 33_609,
      maximumObservedOutputTokensPerRequest: 200,
      outputTokens: 500,
      partialUsageEvents: 0,
      pricingSha256: plan.freeze.pricingSha256,
      requestObservationSha256s: [sha("0"), sha("1"), sha("2"), sha("3")],
      requestsCompleted: 4,
      requestsStarted: 4,
      retries: 0,
      retryPolicyEvidence: {
        configuredMaximumRetries: 0,
        evidenceKind: "frozen_production_implementation_identity",
        frozenProductionImplementationIdentitySha256:
          plan.freeze.productionPiRuntimeImplementationSha256,
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
      approvalDecisions: { approved: 2, cancelled: 0, denied: 0 },
      approvalObservationSha256s: [sha("a"), sha("b")],
      changedPaths: [plan.task.targetRelativePath],
      completionEvidenceSha256: sha("c"),
      domainHarnessUsed: false,
      endpointScope: "provider_network",
      historicalMemoryItemCount: 0,
      memoryMode: "off",
      modelEvidenceKind: "remote_live_qualified",
      modelQualificationEvidenceSha256:
        plan.freeze.modelQualificationEvidenceSha256,
      modelQualificationIdentitySha256:
        plan.freeze.modelQualificationIdentitySha256,
      modelQualificationObservationSha256:
        plan.freeze.modelQualificationObservationSha256,
      modelQualificationPricingSha256:
        plan.freeze.modelQualificationPricingSha256,
      modelQualificationProtocolSha256:
        plan.freeze.modelQualificationProtocolSha256,
      modelQualificationRecordSha256:
        plan.freeze.modelQualificationRecordSha256,
      modelRequestObservationSha256s: [sha("d"), sha("e"), sha("f"), sha("0")],
      observedActorFreezeSha256: plan.freeze.actorFreezeSha256,
      observedAdapterConfigSha256: plan.freeze.adapterConfigSha256,
      observedInitialWorkspaceManifestSha256:
        plan.task.initialWorkspaceManifestSha256,
      observedPolicySha256: plan.freeze.policySha256,
      observedProductionPiRuntimeImplementationSha256:
        plan.freeze.productionPiRuntimeImplementationSha256,
      observedProtectedTreeSha256: actorInput.source.protectedTreeSha256,
      observedPublicVerifierSha256: plan.task.publicVerifierSha256,
      observedQualificationFixtureSha256:
        plan.freeze.qualificationFixtureSha256,
      observedQualificationProtocolSha256:
        plan.freeze.qualificationProtocolSha256,
      observedSourceCommit: actorInput.source.commit,
      observedSystemInstructionSha256: plan.freeze.systemInstructionSha256,
      observedTaskSha256: plan.task.taskSha256,
      observedToolCatalogSha256: plan.freeze.toolCatalogSha256,
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
    schemaVersion: 1,
  } as const;
}

function testRunner(input: Readonly<{
  readonly counts: Counters;
  readonly driftAfterActor?: boolean;
  readonly emptyCredential?: boolean;
  readonly invalidHostState?: boolean;
  readonly supportRecordTamperedByActor?: boolean;
}>) {
  const evidence = modelEvidence();
  let planned: MemE0LiveActorQualificationPlan | null = null;
  const runner = createMemE0ActorQualificationRunnerForTesting({
    // This parent-unit-test actor emits no real Host files. The production
    // inspector is exercised by the full, real-tool offline flow regression.
    inspectWorkspaceHostState: async () => ({ filePaths: [], valid: input.invalidHostState !== true }),
    authorizedChildEnvironment: () => {
      input.counts.credentialReads += 1;
      return Object.freeze({
        DEEPSEEK_API_KEY: input.emptyCredential === true
          ? "  "
          : "test-only-placeholder",
      });
    },
    cleanupTemporaryRoot: async (path) => {
      input.counts.cleanup += 1;
      await rm(path, { force: true, recursive: true });
    },
    createTemporaryRoot: async () => {
      input.counts.temporaryRoots += 1;
      const path = await mkdtemp(join(tmpdir(), "mem-e0-runner-test-"));
      temporaryRoots.push(path);
      return path;
    },
    loadModelEvidence: async () => evidence,
    observeSource: async () => {
      input.counts.sourceObservations += 1;
      return input.driftAfterActor === true &&
          input.counts.sourceObservations >= 3
        ? cleanSource("b")
        : cleanSource("a");
    },
    productionPiRuntimeImplementationSha256: async () => sha("9"),
    runVerifierProcess: async (request) => {
      input.counts.verifiers += 1;
      const hidden = request.args.length === 2;
      return Object.freeze({
        exitCode: 0,
        processId: hidden ? 9_003 : 9_002,
        stderrSha256: rawSha256(""),
        stdoutSha256: hidden
          ? "ba766a1c26897a3f3f1911a18b977034ac0ad4aacb1a6c20f85928e29f4a0d92"
          : sha("d"),
      });
    },
    spawnActor: async ({ actorInput }) => {
      input.counts.spawns += 1;
      expect(actorInput.modelEvidence.qualificationEvidenceRef).toBe(
        localRecordRef,
      );
      await writeFile(
        join(actorInput.workspace, ...planned!.task.targetRelativePath.split("/")),
        finalTarget,
        "utf8",
      );
      if (input.supportRecordTamperedByActor === true) {
        await writeFile(
          join(actorInput.workspace, ...localRecordRef.split("/")),
          "tampered\n",
          "utf8",
        );
      }
      return parseMemE0LiveActorQualificationOutput(
        validActorOutput(planned!, actorInput),
      );
    },
    stageQualificationRecord: async ({ modelEvidence: loaded, workspace }) => {
      const destination = join(workspace, ...localRecordRef.split("/"));
      const raw = "{\"safeSyntheticQualificationRecord\":true}\n";
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, raw, { encoding: "utf8", flag: "wx" });
      return Object.freeze({
        localModelEvidence: Object.freeze({
          ...loaded.descriptor,
          qualificationEvidenceRef: localRecordRef,
          qualificationUsageCapability: "complete" as const,
        }),
        recordRawSha256: rawSha256(raw),
      });
    },
  });
  return Object.freeze({
    plan: async () => {
      const result = await runner.plan({ ds0ObservationPath, repositoryRoot });
      planned = result.plan;
      return result;
    },
    run: runner.run,
  });
}

describe("MEM-E0 parent live actor qualification runner", () => {
  it("creates a strict self-hashed plan whose default receipt is non-authorizing", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("runner tests must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const observed = counters();
    const runner = testRunner({ counts: observed });
    const planned = await runner.plan();

    expect(parseMemE0LiveActorQualificationPlan(planned.plan)).toEqual(
      planned.plan,
    );
    expect(() => parseMemE0LiveActorQualificationPlan({
      ...planned.plan,
      planSha256: sha("f"),
    })).toThrow(/self-hash/u);
    const sealedAuthorization = authorization(planned.plan);
    expect(() => parseMemE0LiveActorQualificationAuthorization({
      ...sealedAuthorization,
      authorizationSha256: sha("e"),
    })).toThrow(/self-hash/u);
    expect(planned.plan).toMatchObject({
      authorizationSemantics: {
        apiKeyPresenceIsAuthorization: false,
        defaultOutcome: "not_run",
        remoteCallsAuthorizedByPlan: false,
      },
      cost: { maximumAuthorizedCostUsdMicros: 33_609 },
      ds0: {
        observationSha256: modelEvidence().modelQualificationObservationSha256,
      },
    });
    expect(planned.receipt).toMatchObject({
      providerCalls: 0,
      result: { reasonCode: "qualification_not_authorized", status: "not_run" },
      run: null,
      verifier: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(observed).toMatchObject({
      credentialReads: 0,
      spawns: 0,
      temporaryRoots: 0,
      verifiers: 0,
    });
  });

  it("returns not-run without re-observing source, reading a key, or spawning", async () => {
    const observed = counters();
    const runner = testRunner({ counts: observed });
    const planned = await runner.plan();
    const receipt = await runner.run({
      ds0ObservationPath,
      plan: planned.plan,
      repositoryRoot,
    });

    expect(receipt.result).toEqual({
      reasonCode: "qualification_not_authorized",
      status: "not_run",
    });
    expect(observed.sourceObservations).toBe(1);
    expect(observed.credentialReads).toBe(0);
    expect(observed.temporaryRoots).toBe(0);
    expect(observed.spawns).toBe(0);
    expect(observed.verifiers).toBe(0);
  });

  it("rejects a self-hashed but mismatched confirmation before any privileged effect", async () => {
    const observed = counters();
    const runner = testRunner({ counts: observed });
    const planned = await runner.plan();
    const {
      authorizationSha256: _authorizationSha256,
      ...authorizationContent
    } = authorization(planned.plan);
    expect(_authorizationSha256).toMatch(/^[a-f0-9]{64}$/u);
    const wrongAuthorization = createMemE0LiveActorQualificationAuthorization({
      ...authorizationContent,
      planSha256Confirmation: sha("f"),
    });
    expect(parseMemE0LiveActorQualificationAuthorization(
      wrongAuthorization,
    )).toEqual(wrongAuthorization);

    await expect(runner.run({
      authorization: wrongAuthorization,
      ds0ObservationPath,
      plan: planned.plan,
      repositoryRoot,
    })).rejects.toMatchObject({
      observation: { failureCode: "qualification_actor_failed" },
    });
    expect(observed.sourceObservations).toBe(1);
    expect(observed.credentialReads).toBe(0);
    expect(observed.temporaryRoots).toBe(0);
    expect(observed.spawns).toBe(0);
    expect(observed.verifiers).toBe(0);
  });

  it("rejects an empty authorized credential before creating a temporary root", async () => {
    const observed = counters();
    const runner = testRunner({ counts: observed, emptyCredential: true });
    const planned = await runner.plan();

    await expect(runner.run({
      authorization: authorization(planned.plan),
      ds0ObservationPath,
      plan: planned.plan,
      repositoryRoot,
    })).rejects.toMatchObject({
      observation: { failureCode: "qualification_actor_failed" },
    });
    expect(observed.credentialReads).toBe(1);
    expect(observed.sourceObservations).toBe(2);
    expect(observed.temporaryRoots).toBe(0);
    expect(observed.spawns).toBe(0);
    expect(observed.verifiers).toBe(0);
  });

  it("stages a local record, awaits the actor, then independently seals parent checks", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("runner tests must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const observed = counters();
    const runner = testRunner({ counts: observed });
    const planned = await runner.plan();
    const receipt = await runner.run({
      authorization: authorization(planned.plan),
      ds0ObservationPath,
      plan: planned.plan,
      repositoryRoot,
    });

    expect(receipt).toMatchObject({
      providerCalls: 4,
      result: {
        reasonCode: "exact_product_tool_actor_passed",
        status: "passed",
      },
      run: {
        changedPaths: ["src/harm-control.mjs"],
        toolNames: ["read_file", "apply_patch", "run_command", "finish_task"],
      },
      verifier: {
        agentExitedBeforeVerifier: true,
        distinctOsProcesses: true,
        hiddenVerifierOutsideWorkspace: true,
        passed: true,
      },
    });
    expect(observed).toMatchObject({
      cleanup: 1,
      credentialReads: 1,
      sourceObservations: 3,
      spawns: 1,
      temporaryRoots: 1,
      verifiers: 2,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const path of temporaryRoots) {
      await expect(access(path)).rejects.toThrow();
    }
  }, 30_000);

  it("cannot pass when source, Host state, or the staged record fails its gate", async () => {
    for (const options of [
      { driftAfterActor: true },
      { invalidHostState: true },
      { supportRecordTamperedByActor: true },
    ] as const) {
      const observed = counters();
      const runner = testRunner({ counts: observed, ...options });
      const planned = await runner.plan();
      const receipt = await runner.run({
        authorization: authorization(planned.plan),
        ds0ObservationPath,
        plan: planned.plan,
        repositoryRoot,
      });
      expect(receipt.result).toEqual({
        reasonCode: "verifier_failed",
        status: "failed",
      });
    }
  }, 30_000);
});
