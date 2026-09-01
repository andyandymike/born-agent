import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { modelQualificationIdentitySha256 } from "../../../../src/model/model-qualification-identity.js";
import { createModelQualificationRecord } from "../../../../src/model/model-qualification-schema.js";
import {
  BackendContinuation,
  type ModelBackend,
  type ModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import {
  loadDevelopmentPilotQualificationFromDs0Observation,
  type DevelopmentPilotQualificationDescriptor,
} from "../src/development-pilot-fixture.js";
import {
  buildDevelopmentDirectPrompt,
  createInjectedDevelopmentDirectExecutor,
  type DevelopmentDirectAttemptExecutor,
  type DevelopmentDirectAttemptObservation,
} from "../src/development-direct-executor.js";
import { loadDevelopmentDirectFixture } from "../src/development-direct-fixture.js";
import {
  planDevelopmentDirectPilot,
  runAuthorizedDevelopmentDirectPilot,
} from "../src/development-direct-runner.js";
import {
  createDevelopmentPilotAttemptWorkspace,
  verifyDevelopmentPilotAttemptWorkspace,
} from "../src/development-pilot-workspace.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFunctionalDs0(): Promise<Readonly<{
  readonly descriptor: DevelopmentPilotQualificationDescriptor;
  readonly path: string;
}>> {
  const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
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
  await writeFile(
    join(root, "qualification-record.json"),
    `${JSON.stringify(qualificationRecord)}\n`,
    "utf8",
  );
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
    cacheReadTokens: 1_536,
    cacheWriteTokens: 0,
    completeUsageEvents: 6,
    inputTokens: 144_871,
    outputTokens: 843,
    partialUsageEvents: 0,
    totalTokens: 147_250,
  };
  const codingSystemInstructionSha256 = hash(AGENT_SYSTEM_INSTRUCTIONS);
  const content = {
    actor: {
      approvalDecisions: [{ actionKind: "apply_patch", decision: "approved" }],
      exitCode: 7,
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
      reportHash: null,
      reportStatus: null,
      requestCount: 6,
      backendMeterUsage: actorUsage,
      sessionUsage: actorUsage,
      terminalRunFailed: null,
      unreportedRequestCount: 0,
      unreportedRequestReserveUsdMicros: 0,
      usage: actorUsage,
      usageCrossCheckedAgainstBackendMeter: true,
    },
    combinedProviderRequests: 12,
    configuration: {
      actorConfigurationSha256: sha256Canonical({
        codingSystemInstructionSha256,
        model: "deepseek-v4-flash",
        policyProfile: "fal-ds0-deepseek-remote-v1",
        protocolSha256: fixture.base.ds0ProtocolSha256,
        provider: "deepseek",
      }),
      codingSystemInstructionSha256,
    },
    cost: {
      actorUnreportedRequestReserveUsdMicros: 0,
      applicableBand: "off_peak",
      boundaryKind: "estimated_replay_not_provider_bill_cap",
      combinedApplicableEstimatedUsdMicros: 43_612,
      combinedPeakEstimatedUsdMicros: 76_411,
      confirmedMaximumUsdMicros: 120_000,
      isProviderInvoice: false,
      preActorPeakBoundUsdMicros: 74_427,
      qualificationUnreportedRequestReserveUsdMicros: 0,
    },
    experimentId: "fal-ds0-deepseek-tool-actor-v1",
    privacy: {
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
    },
    protocolSha256: fixture.base.ds0ProtocolSha256,
    pricingSha256: fixture.base.pricing.pricingSha256,
    publicWorkspace: {
      baselineCommit: "3".repeat(40),
      target: "fixtures/phase-07-fix-and-verify/src/clamp.mjs",
    },
    qualification: {
      evidenceSha256: qualificationRecord.evidenceSha256,
      qualifiedModes: ["build", "plan"],
      requestCount: 6,
      unreportedRequestCount: 0,
      usage: qualificationUsage,
    },
    qualificationDescriptor: null,
    runId,
    schemaVersion: 1,
    status: "actor_failed",
  } as const;
  const observation = {
    ...content,
    observationSha256: sha256Canonical(content),
  };
  const path = join(root, "observation.json");
  await writeFile(path, `${JSON.stringify(observation)}\n`, "utf8");
  const qualification = await loadDevelopmentPilotQualificationFromDs0Observation(
    path,
    fixture.base,
  );
  return Object.freeze({ descriptor: qualification.descriptor, path });
}

function successfulObservation(input: Readonly<{
  readonly promptBytes: number;
  readonly promptSha256: string;
  readonly response: string;
  readonly appliedPath: string;
}>): DevelopmentDirectAttemptObservation {
  return Object.freeze({
    appliedPath: input.appliedPath,
    capExceeded: null,
    encodedPromptBytes: input.promptBytes,
    encodedPromptSha256: input.promptSha256,
    orchestrationFailure: false,
    providerFailure: null,
    providerFailureObserved: false,
    providerRequestsCompleted: 1,
    providerRequestsStarted: 1,
    responseBytes: Buffer.byteLength(input.response, "utf8"),
    responseDisposition: "applied",
    responseTextSha256: hash(input.response),
    terminalOutcome: "text",
    usage: Object.freeze({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completeness: "complete",
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
    }),
  });
}

describe("development-only direct-generation DeepSeek effect pilot", () => {
  it("builds a zero-call plan with exact hard-cost math and public-only prompts", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const plan = await planDevelopmentDirectPilot(repositoryRoot);
    const caseInput = fixture.base.cases[0]!;
    const baseline = await buildDevelopmentDirectPrompt({ arm: "baseline", case: caseInput, fixture });
    const candidate = await buildDevelopmentDirectPrompt({ arm: "candidate", case: caseInput, fixture });
    const baselinePayload = JSON.parse(baseline.userPrompt) as Readonly<Record<string, unknown>>;
    const candidatePayload = JSON.parse(candidate.userPrompt) as Readonly<Record<string, unknown>>;

    expect(plan).toMatchObject({
      attemptCount: 6,
      conservativePeakUpperBoundUsdMicros: 52_716,
      maximumAuthorizedCostUsdMicros: 60_000,
      maximumProviderRequests: 6,
      mode: "offline_plan_only",
      providerRequestsStarted: 0,
      remoteCallsAuthorized: false,
    });
    expect(plan.promptBindings).toHaveLength(6);
    expect(plan.promptBindings.every((entry) => entry.encodedPromptBytes <= 8_192)).toBe(true);
    expect(baselinePayload).not.toHaveProperty("advisoryProcedure");
    expect(candidatePayload.advisoryProcedure).toBe(fixture.base.procedure);
    expect(baselinePayload).toMatchObject({ task: caseInput.task });
    expect(baseline.userPrompt).not.toMatch(/targetRelativePath|exactFinalSource|"argv"/u);
    expect(candidate.userPrompt).not.toMatch(/targetRelativePath|exactFinalSource|"argv"/u);
  });

  it("uses a text-only backend turn, applies one safe edit, and sanitizes ModelEvent.failed", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const qualification = await writeFunctionalDs0();
    const caseInput = fixture.base.cases[0]!;
    const attemptRoot = join(repositoryRoot, ".cache", `direct-executor-${randomUUID()}`);
    temporaryRoots.push(attemptRoot);
    const attempt = await createDevelopmentPilotAttemptWorkspace({
      arm: "candidate",
      attemptRoot,
      case: caseInput,
      fixture: fixture.base,
    });
    let capturedRequest: ModelTurnRequest | undefined;
    class TestContinuation extends BackendContinuation {}
    const response = JSON.stringify({
      schemaVersion: 1,
      path: caseInput.targetRelativePath,
      replacement: caseInput.exactFinalSource,
    });
    const backend: ModelBackend = {
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "best_effort",
        usage: "complete",
      },
      identity: {
        adapter: "test",
        adapterVersion: "1",
        configFingerprint: "a".repeat(64),
        model: "deepseek-v4-flash",
        provider: "deepseek",
      },
      resume: { capability: "canonical_only", supportsCanonicalDegradedResume: true },
      async *runTurn(request) {
        capturedRequest = request;
        yield { text: response, type: "text_delta" } as const;
        yield {
          type: "usage",
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            completeness: "complete",
            inputTokens: 1_000,
            outputTokens: 100,
            totalTokens: 1_100,
          },
        } as const;
        yield {
          continuation: new TestContinuation(),
          outcome: "text",
          providerRequestId: "req_direct_test_1",
          type: "turn_completed",
        } as const;
      },
    };
    const executor = createInjectedDevelopmentDirectExecutor(async () => backend);
    const observation = await executor.execute({
      arm: "candidate",
      attempt,
      case: caseInput,
      environment: { DEEPSEEK_API_KEY: "offline-sentinel" },
      fixture,
      qualification: qualification.descriptor,
    });

    expect(capturedRequest?.tools).toEqual([]);
    expect(observation).toMatchObject({
      providerFailure: null,
      providerRequestIdSha256: hash("req_direct_test_1"),
      providerRequestsCompleted: 1,
      providerRequestsStarted: 1,
      responseDisposition: "applied",
      terminalOutcome: "text",
      usageEventsObserved: 1,
    });
    await expect(verifyDevelopmentPilotAttemptWorkspace(caseInput, attempt)).resolves.toMatchObject({
      verifierExitCode: 0,
    });

    const failureBackend: ModelBackend = {
      ...backend,
      async *runTurn() {
        yield {
          error: {
            category: "quota",
            code: "provider_quota",
            message: "raw provider billing secret",
            providerRequestId: "raw_failure_request_id",
            retryable: false,
          },
          type: "failed",
        } as const;
      },
    };
    const failureExecutor = createInjectedDevelopmentDirectExecutor(async () => failureBackend);
    const failureAttemptRoot = join(
      repositoryRoot,
      ".cache",
      `direct-executor-failure-${randomUUID()}`,
    );
    temporaryRoots.push(failureAttemptRoot);
    const failureAttempt = await createDevelopmentPilotAttemptWorkspace({
      arm: "baseline",
      attemptRoot: failureAttemptRoot,
      case: caseInput,
      fixture: fixture.base,
    });
    const failure = await failureExecutor.execute({
      arm: "baseline",
      attempt: failureAttempt,
      case: caseInput,
      environment: { DEEPSEEK_API_KEY: "offline-sentinel" },
      fixture,
      qualification: qualification.descriptor,
    });
    expect(failure.providerFailure).toEqual({
      category: "quota",
      code: "provider_quota",
      retryable: false,
    });
    expect(failure.providerRequestIdSha256).toBe(hash("raw_failure_request_id"));
    expect(JSON.stringify(failure)).not.toMatch(/raw provider billing secret|raw_failure_request_id/u);
  }, 30_000);

  it("runs six fake pairs, self-hashes a sanitized receipt, and cannot forge production evidence", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const qualification = await writeFunctionalDs0();
    const attemptRoots: string[] = [];
    const execute = vi.fn<DevelopmentDirectAttemptExecutor["execute"]>(async (input) => {
      attemptRoots.push(input.attempt.root);
      const prompt = await buildDevelopmentDirectPrompt(input);
      const response = JSON.stringify({
        schemaVersion: 1,
        path: input.case.targetRelativePath,
        replacement: input.case.exactFinalSource,
      });
      await writeFile(
        join(input.attempt.workspace, ...input.case.targetRelativePath.split("/")),
        input.case.exactFinalSource,
        "utf8",
      );
      return successfulObservation({
        appliedPath: input.case.targetRelativePath,
        promptBytes: prompt.encodedBytes,
        promptSha256: prompt.encodedSha256,
        response,
      });
    });
    const forgedExecutor: DevelopmentDirectAttemptExecutor = {
      execute,
      transportKind: "production_deepseek",
    };
    const checkpoints: Readonly<Record<string, unknown>>[] = [];
    const sentinel = "direct-receipt-secret-sentinel";
    const receipt = await runAuthorizedDevelopmentDirectPilot({
      authorization: {
        acceptedPricingSha256: fixture.base.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 60_000,
      },
      ds0ObservationPath: qualification.path,
      environment: { DEEPSEEK_API_KEY: sentinel },
      executor: forgedExecutor,
      checkpointSink: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      repositoryRoot,
    });

    expect(execute).toHaveBeenCalledTimes(6);
    expect(checkpoints).toHaveLength(12);
    expect(checkpoints.map((checkpoint) => checkpoint.stage)).toEqual([
      "before_provider_request",
      "after_provider_observation",
      "before_provider_request",
      "after_provider_observation",
      "before_provider_request",
      "after_provider_observation",
      "before_provider_request",
      "after_provider_observation",
      "before_provider_request",
      "after_provider_observation",
      "before_provider_request",
      "after_provider_observation",
    ]);
    expect(receipt).toMatchObject({
      actualModelExecutionClaimed: false,
      bornagentToolProtocolExercised: false,
      evidenceClass: "offline_mechanics_test_only",
      executionBackend: "injected_test_executor",
      productAgentCompletionClaimed: false,
      status: "completed",
      aggregate: {
        attemptsCompleted: 6,
        ceilingObserved: true,
        independentExactRepairSuccessCount: 6,
        qualitySampleCount: 6,
        totalProviderRequests: 6,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(sentinel);
    expect(receipt.receiptSha256).toBe(sha256Canonical(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")),
    ));
    for (const root of attemptRoots) {
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

  it("persists only stable provider failure fields in a stopped receipt", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const qualification = await writeFunctionalDs0();
    const executor: DevelopmentDirectAttemptExecutor = {
      transportKind: "injected_test",
      execute: async (input) => {
        const prompt = await buildDevelopmentDirectPrompt(input);
        return Object.freeze({
          appliedPath: null,
          capExceeded: null,
          encodedPromptBytes: prompt.encodedBytes,
          encodedPromptSha256: prompt.encodedSha256,
          orchestrationFailure: false,
          providerFailure: Object.freeze({
            category: "quota" as const,
            code: "provider_quota",
            retryable: false,
          }),
          providerFailureObserved: true,
          providerRequestsCompleted: 0,
          providerRequestsStarted: 1,
          responseBytes: 0,
          responseDisposition: "not_received" as const,
          responseTextSha256: hash(""),
          terminalOutcome: "provider_failed" as const,
          usage: Object.freeze({
            cacheReadTokens: null,
            cacheWriteTokens: null,
            completeness: "none" as const,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          }),
        });
      },
    };
    const receipt = await runAuthorizedDevelopmentDirectPilot({
      authorization: {
        acceptedPricingSha256: fixture.base.pricing.pricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros: 60_000,
      },
      ds0ObservationPath: qualification.path,
      environment: { DEEPSEEK_API_KEY: "offline-failure-sentinel" },
      executor,
      repositoryRoot,
    });

    expect(receipt).toMatchObject({
      actualModelExecutionClaimed: false,
      status: "stopped_provider_or_protocol_failure",
      attempts: [{
        cost: null,
        peakCostAccounting: {
          basis: "started_request_worst_case_reserve",
          peakUsdMicros: 8_786,
          reserveIsProviderInvoice: false,
        },
        providerFailure: {
          category: "quota",
          code: "provider_quota",
          retryable: false,
        },
        qualitySampleEligible: false,
        qualitySampleExclusionReason: "provider_or_protocol_failure",
      }],
      aggregate: {
        combinedPeakCostUsdMicros: 8_786,
        incompleteUsageStartedRequestReserveCount: 1,
        incompleteUsageStartedRequestReserveUsdMicros: 8_786,
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/billing secret|offline-failure-sentinel/u);
  }, 30_000);
});
