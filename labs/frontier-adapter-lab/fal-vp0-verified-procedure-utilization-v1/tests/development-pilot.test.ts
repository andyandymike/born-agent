import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { modelQualificationIdentitySha256 } from "../../../../src/model/model-qualification-identity.js";
import { createModelQualificationRecord } from "../../../../src/model/model-qualification-schema.js";
import type { ModelBackend, ModelTurnRequest } from "../../../../src/model/model-backend.js";
import {
  loadDevelopmentPilotFixture,
  loadDevelopmentPilotQualificationFromDs0Observation,
} from "../src/development-pilot-fixture.js";
import type {
  DevelopmentPilotAgentObservation,
  DevelopmentPilotAttemptExecutor,
} from "../src/development-pilot-production-executor.js";
import { developmentPilotCommandOptions } from "../src/development-pilot-production-executor.js";
import {
  DevelopmentPilotProviderCapError,
  DevelopmentPilotProviderMeter,
} from "../src/development-pilot-provider-meter.js";
import {
  planDevelopmentPilot,
  runAuthorizedDevelopmentPilot,
} from "../src/development-pilot-runner.js";
import {
  createDevelopmentPilotAttemptWorkspace,
  developmentPilotGitEnvironment,
  verifyDevelopmentPilotAttemptWorkspace,
} from "../src/development-pilot-workspace.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeObservation(
  arm: "baseline" | "candidate",
): DevelopmentPilotAgentObservation {
  const requests = arm === "candidate" ? 3 : 4;
  const total = arm === "candidate" ? 900 : 1_000;
  return Object.freeze({
    approvalDecisions: Object.freeze({ approved: 3, cancelled: 0, denied: 0 }),
    capExceeded: null,
    completionEvidenceSha256: "d".repeat(64),
    completionReportSha256: "e".repeat(64),
    exitCode: 0,
    orchestrationFailure: false,
    providerRequestsCompleted: requests,
    providerRequestsStarted: requests,
    sessionEventLogSha256: "f".repeat(64),
    terminal: "completed",
    terminalCode: null,
    terminalFailureCategory: null,
    toolCalls: Object.freeze([
      Object.freeze({ status: "success" as const, step: 1, toolName: "read_file" }),
      Object.freeze({ status: "success" as const, step: 2, toolName: "apply_patch" }),
      Object.freeze({ status: "success" as const, step: 3, toolName: "run_command" }),
      Object.freeze({ status: "success" as const, step: requests, toolName: "finish_task" }),
    ]),
    usage: Object.freeze({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completeness: "complete",
      inputTokens: total - 100,
      outputTokens: 100,
      totalTokens: total,
    }),
    usageCrossCheckedAgainstSession: true,
  });
}

function passedDs0Observation(
  fixture: Awaited<ReturnType<typeof loadDevelopmentPilotFixture>>,
  runId: string,
  qualificationRecord: ReturnType<typeof createModelQualificationRecord>,
  qualificationRef: string,
): Readonly<Record<string, unknown>> {
  const qualificationUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completeUsageEvents: 6,
    inputTokens: 600,
    outputTokens: 60,
    partialUsageEvents: 0,
    totalTokens: 660,
  };
  const actorUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completeUsageEvents: 4,
    inputTokens: 400,
    outputTokens: 40,
    partialUsageEvents: 0,
    totalTokens: 440,
  };
  const codingSystemInstructionSha256 = hash(AGENT_SYSTEM_INSTRUCTIONS);
  const content = {
    actor: {
      approvalDecisions: [
        { actionKind: "apply_patch", decision: "approved" },
        { actionKind: "run_command", decision: "approved" },
      ],
      exitCode: 0,
      freshVerification: {
        changedPaths: ["fixtures/phase-07-fix-and-verify/src/clamp.mjs"],
        finalTargetSha256: hash([
          "export function clamp(value, minimum, maximum) {",
          "  return Math.min(maximum, Math.max(minimum, value));",
          "}",
          "",
        ].join("\n")),
        verifierExitCode: 0,
      },
      reportHash: "1".repeat(64),
      reportStatus: "completed",
      requestCount: 4,
      backendMeterUsage: actorUsage,
      sessionUsage: actorUsage,
      terminalRunFailed: null,
      unreportedRequestCount: 0,
      unreportedRequestReserveUsdMicros: 0,
      usage: actorUsage,
      usageCrossCheckedAgainstBackendMeter: true,
    },
    combinedProviderRequests: 10,
    configuration: {
      actorConfigurationSha256: sha256Canonical({
        codingSystemInstructionSha256,
        model: "deepseek-v4-flash",
        policyProfile: "fal-ds0-deepseek-remote-v1",
        protocolSha256: fixture.ds0ProtocolSha256,
        provider: "deepseek",
      }),
      codingSystemInstructionSha256,
    },
    cost: {
      actorUnreportedRequestReserveUsdMicros: 0,
      applicableBand: "off_peak",
      boundaryKind: "estimated_replay_not_provider_bill_cap",
      combinedApplicableEstimatedUsdMicros: 100,
      combinedPeakEstimatedUsdMicros: 200,
      confirmedMaximumUsdMicros: 120_000,
      isProviderInvoice: false,
      preActorPeakBoundUsdMicros: 80_000,
      qualificationUnreportedRequestReserveUsdMicros: 0,
    },
    privacy: {
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
    },
    protocolSha256: fixture.ds0ProtocolSha256,
    pricingSha256: fixture.pricing.pricingSha256,
    qualification: {
      evidenceSha256: qualificationRecord.evidenceSha256,
      qualifiedModes: ["build", "plan"],
      requestCount: 6,
      unreportedRequestCount: 0,
      usage: qualificationUsage,
    },
    qualificationDescriptor: {
      baseUrl: "https://api.deepseek.com",
      completedCount: 6,
      evidenceSha256: qualificationRecord.evidenceSha256,
      kind: "model_capability_probe_suite",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      recordSha256: sha256Canonical(qualificationRecord),
      ref: qualificationRef,
      requestCount: 6,
      schemaVersion: 1,
      status: "passed",
      usageCapability: "complete",
    },
    publicWorkspace: {
      baselineCommit: "3".repeat(40),
      target: "fixtures/phase-07-fix-and-verify/src/clamp.mjs",
    },
    status: "passed",
    experimentId: "fal-ds0-deepseek-tool-actor-v1",
    runId,
    schemaVersion: 1,
  };
  return Object.freeze({ ...content, observationSha256: sha256Canonical(content) });
}

async function writePassedDs0Observation(
  fixture: Awaited<ReturnType<typeof loadDevelopmentPilotFixture>>,
): Promise<Readonly<{ readonly observation: Readonly<Record<string, unknown>>; readonly path: string }>> {
  const runId = `ds0-${randomUUID()}`;
  const root = join(
    repositoryRoot,
    ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs",
    runId,
  );
  await mkdir(root, { recursive: true });
  temporaryRoots.push(root);
  const identity = {
    adapterId: "pi-ai",
    adapterVersion: "0.80.7",
    continuationCodecVersion: null,
    endpointScope: { kind: "remote_explicit" as const, originSha256: "a".repeat(64) },
    model: "deepseek-v4-flash",
    modelRuntimeIdentity: {
      kind: "provider_model_id" as const,
      value: "deepseek-v4-flash",
    },
    policyProfileId: "fal-ds0-deepseek-remote-v1",
    policyProfileSha256: "b".repeat(64),
    probeSuiteVersion: "phase18a-capability-registry-v1",
    probeToolSchemaSha256: "c".repeat(64),
    provider: "deepseek",
  };
  const common = { code: "passed", durationMs: 1, status: "passed" as const };
  const qualificationRecord = createModelQualificationRecord({
    createdAt: "2026-08-31T00:00:00.000Z",
    identity,
    identitySha256: modelQualificationIdentitySha256(identity),
    probeResults: [
      { ...common, observed: { deltaCount: 1, terminalText: true }, probeId: "streaming_text_v1", requestCount: 0 },
      { ...common, observed: { argumentsStrict: true, callIdPresent: true, toolCallCount: 1 }, probeId: "strict_tool_args_v1", requestCount: 1 },
      { ...common, observed: { acknowledgementMatched: true, terminalText: true }, probeId: "tool_continuation_v1", requestCount: 1 },
      { ...common, observed: { ordered: true, toolCallCount: 2 }, probeId: "sequential_tools_v1", requestCount: 3 },
      { ...common, observed: { abortObserved: true, cancelLatencyMs: 1, lateEventCount: 0 }, probeId: "cancellation_v1", requestCount: 1 },
      { ...common, observed: { availability: "complete" }, probeId: "usage_semantics_v1", requestCount: 0 },
    ],
    qualifiedModes: ["plan", "build"],
    schemaVersion: 1,
    totalDurationMs: 6,
    totalRequestCount: 6,
  });
  const qualificationRef = [
    ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs",
    runId,
    "qualification-record.json",
  ].join("/");
  await writeFile(
    join(root, "qualification-record.json"),
    `${JSON.stringify(qualificationRecord)}\n`,
    "utf8",
  );
  const path = join(root, "observation.json");
  const observation = passedDs0Observation(
    fixture,
    runId,
    qualificationRecord,
    qualificationRef,
  );
  await writeFile(path, `${JSON.stringify(observation)}\n`, "utf8");
  return Object.freeze({ observation, path });
}

describe("development-only DeepSeek verified-procedure pilot", () => {
  it("plans offline by default and freezes three heterogeneous AB/BA/AB cases", async () => {
    const plan = await planDevelopmentPilot(repositoryRoot);

    expect(plan).toMatchObject({
      actorAttemptCount: 6,
      caseCount: 3,
      conservativePeakUpperBoundUsdMicros: 179_592,
      mode: "offline_plan_only",
      providerRequestsStarted: 0,
      remoteCallsAuthorized: false,
      vp0GateEligible: false,
    });
    expect(plan.executionOrder).toEqual([
      "inclusive-boundary:baseline",
      "inclusive-boundary:candidate",
      "end-exclusive-page-window:candidate",
      "end-exclusive-page-window:baseline",
      "one-based-retry-cap:baseline",
      "one-based-retry-cap:candidate",
    ]);
    expect(new Set(plan.caseHashes.map((entry) => entry.publicTreeSha256))).toHaveLength(3);
  });

  it("never propagates provider credentials into Git child processes", () => {
    const environment = developmentPilotGitEnvironment({
      ANTHROPIC_API_KEY: "anthropic-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
      PATH: "test-path",
      SystemRoot: "test-system-root",
      UNRELATED_SECRET: "other-secret",
    });

    expect(environment).toMatchObject({ PATH: "test-path", SystemRoot: "test-system-root" });
    expect(Object.keys(environment)).not.toContain("DEEPSEEK_API_KEY");
    expect(JSON.stringify(environment)).not.toMatch(/deepseek-secret|anthropic-secret|openai-secret|other-secret/u);
  });

  it("preserves the triggering provider usage and exposes a typed cap before any next request", async () => {
    let backendRequests = 0;
    const backend: ModelBackend = {
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      identity: {
        adapter: "pi-ai",
        adapterVersion: "test",
        configFingerprint: "a".repeat(64),
        model: "deepseek-v4-flash",
        provider: "deepseek",
      },
      prepareTurnRequest: (request) => ({ adapterEncodingVersion: "test", request }),
      resume: {
        capability: "canonical_only",
        supportsCanonicalDegradedResume: true,
      },
      async *runTurn() {
        backendRequests += 1;
        yield {
          type: "usage",
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            completeness: "complete",
            inputTokens: 600,
            outputTokens: 10,
            totalTokens: 610,
          },
        } as const;
      },
    };
    const meter = new DevelopmentPilotProviderMeter({
      maximumCacheReadTokens: 100,
      maximumOutputTokens: 100,
      maximumRequests: 6,
      maximumTotalTokens: 700,
      maximumUncachedInputTokens: 500,
    });
    const request: ModelTurnRequest = {
      input: { kind: "user_prompt", text: "offline meter fixture" },
      instructions: "test",
      timeoutMs: 1_000,
      tools: [],
    };
    const wrapped = meter.wrap(backend);
    const firstEvents = [];
    for await (const event of wrapped.runTurn(request, new AbortController().signal)) {
      firstEvents.push(event);
    }

    expect(firstEvents).toHaveLength(1);
    expect(meter.usage()).toMatchObject({ inputTokens: 600, totalTokens: 610 });
    expect(meter.capExceeded).toEqual({
      kind: "reported_uncached_input_tokens",
      limit: 500,
      observed: 600,
      stage: "after_provider_usage",
    });
    await expect(async () => {
      for await (const event of wrapped.runTurn(request, new AbortController().signal)) {
        // A locally refused next request yields no provider event.
        void event;
      }
    }).rejects.toBeInstanceOf(DevelopmentPilotProviderCapError);
    expect(backendRequests).toBe(1);
    expect(meter.requestCount).toBe(1);
  });

  it("proves every public case starts failing and accepts only its exact final bytes", async () => {
    const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
    const root = await temporary("vp0-development-cases-");

    for (const [index, caseInput] of fixture.cases.entries()) {
      const attemptRoot = join(root, `case-${String(index)}`);
      const attempt = await createDevelopmentPilotAttemptWorkspace({
        arm: index % 2 === 0 ? "baseline" : "candidate",
        attemptRoot,
        case: caseInput,
        fixture,
      });
      expect(attempt.initialVerifierFailureObserved).toBe(true);
      expect(attempt.initialTargetSha256).not.toBe(caseInput.exactFinalSourceSha256);
      await writeFile(
        join(attempt.workspace, ...caseInput.targetRelativePath.split("/")),
        caseInput.exactFinalSource,
        "utf8",
      );
      const verification = await verifyDevelopmentPilotAttemptWorkspace(caseInput, attempt);
      expect(verification).toMatchObject({
        changedPaths: [caseInput.targetRelativePath],
        finalTargetSha256: caseInput.exactFinalSourceSha256,
        verifierExitCode: 0,
      });
      expect(attempt.capability.selector === null).toBe(index % 2 === 0);
      const options = developmentPilotCommandOptions(fixture, attempt, caseInput);
      expect(options).not.toHaveProperty("mode");
      expect(options).toMatchObject({ taskProfile: "coding" });
    }
  });

  it("runs the six-attempt fake lane, reports a quality ceiling, and persists no raw host facts", async () => {
    const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
    const ds0 = await writePassedDs0Observation(fixture);
    const attemptRoots: string[] = [];
    const executor: DevelopmentPilotAttemptExecutor = {
      execute: vi.fn(async ({ attempt, case: caseInput }) => {
        attemptRoots.push(attempt.root);
        await writeFile(
          join(attempt.workspace, ...caseInput.targetRelativePath.split("/")),
          caseInput.exactFinalSource,
          "utf8",
        );
        return fakeObservation(attempt.arm);
      }),
    };
    const sentinel = "deepseek-test-sentinel-never-persist";
    const receipt = await runAuthorizedDevelopmentPilot({
      authorization: {
        acceptedPricingSha256: fixture.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 180_000,
      },
      environment: {
        ...process.env,
        DEEPSEEK_API_KEY: sentinel,
      },
      executor,
      ds0ObservationPath: ds0.path,
      repositoryRoot,
    });

    expect(executor.execute).toHaveBeenCalledTimes(6);
    expect(receipt).toMatchObject({
      actualModelExecutionClaimed: false,
      comparison: "procedure-present_vs_no-memory",
      evidenceClass: "offline_mechanics_test_only",
      executionBackend: "injected_test_executor",
      status: "completed",
      strictEqualInformationRepresentationGate: false,
      vp0GateEligible: false,
      aggregate: {
        attemptsCompleted: 6,
        ceilingObserved: true,
        independentTaskSuccessCount: 6,
        qualitySampleCount: 6,
        verifiedFinishTaskCompletionCount: 6,
        hardBenefitClaim: false,
        qualityInterpretation: "quality_ceiling_secondary_metrics_only",
      },
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain(sentinel);
    expect(encoded).not.toContain(repositoryRoot);
    expect(encoded).not.toMatch(/rawProviderReasoning\s*:\s*true/u);
    expect(receipt.receiptSha256).toBe(sha256Canonical(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")),
    ));
    for (const path of attemptRoots) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

  it("stops the batch with a typed cap-exceeded receipt instead of an internal error", async () => {
    const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
    const ds0 = await writePassedDs0Observation(fixture);
    const execute = vi.fn<DevelopmentPilotAttemptExecutor["execute"]>(
      async ({ attempt, case: caseInput }) => {
        await writeFile(
          join(attempt.workspace, ...caseInput.targetRelativePath.split("/")),
          caseInput.exactFinalSource,
          "utf8",
        );
        return Object.freeze({
          ...fakeObservation(attempt.arm),
          capExceeded: Object.freeze({
            kind: "reported_uncached_input_tokens" as const,
            limit: 64_000,
            observed: 64_001,
            stage: "after_provider_usage" as const,
          }),
          terminal: "cap_exceeded" as const,
          terminalCode: "pilot_cap_reported_uncached_input_tokens",
        });
      },
    );
    const receipt = await runAuthorizedDevelopmentPilot({
      authorization: {
        acceptedPricingSha256: fixture.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 180_000,
      },
      environment: { DEEPSEEK_API_KEY: "offline-typed-cap-test" },
      executor: { execute },
      ds0ObservationPath: ds0.path,
      repositoryRoot,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      status: "stopped_cap_exceeded",
      aggregate: {
        attemptsCompleted: 1,
        independentTaskSuccessCount: 1,
        qualitySampleCount: 1,
        verifiedFinishTaskCompletionCount: 0,
      },
      attempts: [{
        capExceeded: {
          kind: "reported_uncached_input_tokens",
          limit: 64_000,
          observed: 64_001,
        },
        terminal: "cap_exceeded",
        terminalCode: "pilot_cap_reported_uncached_input_tokens",
        independentTaskSuccess: true,
        primaryQualityOutcome: "success",
        qualitySampleEligible: true,
        verifiedFinishTaskCompletion: false,
      }],
    });
  });

  it("refuses invalid run-local authority before invoking an executor", async () => {
    const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
    const execute = vi.fn<DevelopmentPilotAttemptExecutor["execute"]>();

    await expect(runAuthorizedDevelopmentPilot({
      authorization: {
        acceptedPricingSha256: fixture.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 100_000,
      },
      environment: { DEEPSEEK_API_KEY: "present-is-not-authority" },
      executor: { execute },
      ds0ObservationPath: join(repositoryRoot, "does-not-need-to-exist-before-authority-refusal.json"),
      repositoryRoot,
    })).rejects.toThrow(/maximum cost/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts passed or strict functional-entry DS0 evidence but rejects internal failure", async () => {
    const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
    const ds0 = await writePassedDs0Observation(fixture);

    await expect(loadDevelopmentPilotQualificationFromDs0Observation(
      ds0.path,
      fixture,
    )).resolves.toMatchObject({
      descriptor: {
        qualificationEvidenceSha256:
          (ds0.observation.qualificationDescriptor as { evidenceSha256: string }).evidenceSha256,
      },
      ds0ActorReportSha256: "1".repeat(64),
      ds0EntryEvidenceClass: "ds0_product_completion_passed",
      ds0ObservationSha256: ds0.observation.observationSha256,
    });

    const passedActor = ds0.observation.actor as Readonly<Record<string, unknown>>;
    const functionalEntryContent = {
      ...Object.fromEntries(
        Object.entries(ds0.observation).filter(([key]) => key !== "observationSha256"),
      ),
      actor: {
        ...passedActor,
        approvalDecisions: [{ actionKind: "apply_patch", decision: "approved" }],
        exitCode: 7,
        reportHash: null,
        reportStatus: null,
        terminalRunFailed: null,
      },
      qualificationDescriptor: null,
      status: "actor_failed",
    };
    const functionalEntry = {
      ...functionalEntryContent,
      observationSha256: sha256Canonical(functionalEntryContent),
    };
    await writeFile(ds0.path, `${JSON.stringify(functionalEntry)}\n`, "utf8");
    await expect(loadDevelopmentPilotQualificationFromDs0Observation(
      ds0.path,
      fixture,
    )).resolves.toMatchObject({
      ds0ActorReportSha256: null,
      ds0EntryEvidenceClass: "functional_entry_only",
    });

    const internalFailureContent = {
      ...functionalEntryContent,
      actor: {
        ...(functionalEntryContent.actor as Readonly<Record<string, unknown>>),
        exitCode: 1,
        terminalRunFailed: {
          category: "internal",
          code: "internal_error",
          steps: 5,
          tool_calls: 4,
        },
      },
    };
    const internalFailure = {
      ...internalFailureContent,
      observationSha256: sha256Canonical(internalFailureContent),
    };
    await writeFile(ds0.path, `${JSON.stringify(internalFailure)}\n`, "utf8");
    await expect(loadDevelopmentPilotQualificationFromDs0Observation(
      ds0.path,
      fixture,
    )).rejects.toThrow();

    const execute = vi.fn<DevelopmentPilotAttemptExecutor["execute"]>();
    await expect(runAuthorizedDevelopmentPilot({
      authorization: {
        acceptedPricingSha256: fixture.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 180_000,
      },
      environment: { DEEPSEEK_API_KEY: "present-only-for-offline-refusal" },
      executor: { execute },
      ds0ObservationPath: ds0.path,
      repositoryRoot,
    })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
