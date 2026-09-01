import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { DevelopmentPilotArm, DevelopmentPilotCase } from "./development-pilot-fixture.js";
import { loadDevelopmentPilotQualificationFromDs0Observation } from "./development-pilot-fixture.js";
import {
  buildDevelopmentDirectPrompt,
  type DevelopmentDirectAttemptExecutor,
  type DevelopmentDirectAttemptObservation,
  type DevelopmentDirectUsage,
  isExactProductionDevelopmentDirectExecutor,
} from "./development-direct-executor.js";
import {
  loadDevelopmentDirectFixture,
  VP0_DEVELOPMENT_DIRECT_PILOT_ID,
} from "./development-direct-fixture.js";
import {
  createDevelopmentPilotAttemptWorkspace,
  developmentPilotGitEnvironment,
  verifyDevelopmentPilotAttemptWorkspace,
} from "./development-pilot-workspace.js";

export interface DevelopmentDirectOfflinePlan {
  readonly apiKeyPresenceIsAuthorization: false;
  readonly attemptCount: 6;
  readonly caseCount: 3;
  readonly conservativePeakUpperBoundUsdMicros: 52_716;
  readonly directPolicyRawSha256: string;
  readonly directProtocolRawSha256: string;
  readonly evidenceClass: "development_directional_direct_generation_actual_model_effect_only";
  readonly executionOrder: readonly string[];
  readonly maximumAuthorizedCostUsdMicros: 60_000;
  readonly maximumProviderRequests: 6;
  readonly mode: "offline_plan_only";
  readonly pilotId: typeof VP0_DEVELOPMENT_DIRECT_PILOT_ID;
  readonly pricingSha256: string;
  readonly promptBindings: readonly Readonly<{
    readonly arm: DevelopmentPilotArm;
    readonly caseId: DevelopmentPilotCase["caseId"];
    readonly encodedPromptBytes: number;
    readonly encodedPromptSha256: string;
  }>[];
  readonly providerRequestsStarted: 0;
  readonly remoteCallsAuthorized: false;
  readonly vp0GateEligible: false;
}

export async function planDevelopmentDirectPilot(
  repositoryRoot: string,
): Promise<DevelopmentDirectOfflinePlan> {
  const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
  const promptBindings = [];
  for (const order of fixture.directProtocol.fixedExecutionOrder) {
    const [caseId, arm] = order.split(":") as [DevelopmentPilotCase["caseId"], DevelopmentPilotArm];
    const caseInput = fixture.base.cases.find((candidate) => candidate.caseId === caseId);
    if (caseInput === undefined) throw new Error("development direct order names an unknown case");
    const prompt = await buildDevelopmentDirectPrompt({ arm, case: caseInput, fixture });
    if (prompt.encodedBytes > fixture.directProtocol.perAttemptCaps.maximumEncodedPromptBytes) {
      throw new Error("development direct prompt exceeds its frozen pre-provider byte cap");
    }
    promptBindings.push(Object.freeze({
      arm,
      caseId,
      encodedPromptBytes: prompt.encodedBytes,
      encodedPromptSha256: prompt.encodedSha256,
    }));
  }
  return Object.freeze({
    apiKeyPresenceIsAuthorization: false,
    attemptCount: 6,
    caseCount: 3,
    conservativePeakUpperBoundUsdMicros: 52_716,
    directPolicyRawSha256: fixture.directPolicyRawSha256,
    directProtocolRawSha256: fixture.directProtocolRawSha256,
    evidenceClass: fixture.directProtocol.evidenceClass,
    executionOrder: Object.freeze([...fixture.directProtocol.fixedExecutionOrder]),
    maximumAuthorizedCostUsdMicros: 60_000,
    maximumProviderRequests: 6,
    mode: "offline_plan_only",
    pilotId: VP0_DEVELOPMENT_DIRECT_PILOT_ID,
    pricingSha256: fixture.base.pricing.pricingSha256,
    promptBindings: Object.freeze(promptBindings),
    providerRequestsStarted: 0,
    remoteCallsAuthorized: false,
    vp0GateEligible: false,
  });
}

export interface DevelopmentDirectRunAuthorization {
  readonly acceptedPricingSha256: string;
  readonly authorizeRemote: true;
  readonly maximumEstimatedCostUsdMicros: number;
}

export interface DevelopmentDirectRepositoryProvenance {
  readonly gitDirty: boolean;
  readonly gitHead: string;
  readonly gitStatusPorcelainSha256: string;
  readonly implementationRawSha256: Readonly<{
    readonly developmentDirectExecutor: string;
    readonly developmentDirectFixture: string;
    readonly developmentDirectRunner: string;
    readonly developmentPilotFixture: string;
    readonly developmentPilotWorkspace: string;
    readonly piModelBackend: string;
    readonly productionPiRuntimePort: string;
    readonly runDevelopmentDirectPilotCli: string;
  }>;
}

export interface DevelopmentDirectJournalCheckpoint extends Readonly<Record<string, unknown>> {
  readonly pilotId: typeof VP0_DEVELOPMENT_DIRECT_PILOT_ID;
  readonly schemaVersion: 1;
  readonly stage: "after_provider_observation" | "before_provider_request";
}

interface AttemptCost {
  readonly estimatedOffPeakUsdMicros: number;
  readonly estimatedPeakUsdMicros: number;
  readonly isProviderInvoice: false;
}

interface AttemptPeakCostAccounting {
  readonly basis:
    | "complete_usage_estimate"
    | "no_provider_request"
    | "started_request_worst_case_reserve";
  readonly peakUsdMicros: number;
  readonly reserveIsProviderInvoice: false;
}

type QualityExclusion =
  | "cap_exceeded"
  | "cost_or_usage_incomplete"
  | "no_provider_request"
  | "orchestration_failure"
  | "provider_or_protocol_failure"
  | null;

interface AttemptRecord {
  readonly appliedPath: string | null;
  readonly arm: DevelopmentPilotArm;
  readonly attemptIndex: number;
  readonly baselineCommit: string;
  readonly baselineSourceStateSha256: string;
  readonly capExceeded: DevelopmentDirectAttemptObservation["capExceeded"];
  readonly caseId: DevelopmentPilotCase["caseId"];
  readonly changedPaths: readonly string[];
  readonly cost: AttemptCost | null;
  readonly peakCostAccounting: AttemptPeakCostAccounting;
  readonly encodedPromptBytes: number;
  readonly encodedPromptSha256: string;
  readonly finalSourceStateSha256: string | null;
  readonly finalTargetSha256: string | null;
  readonly freshVerifier: "failed" | "passed";
  readonly initialTargetSha256: string;
  readonly initialVerifierFailureObserved: true;
  readonly independentExactRepairSuccess: boolean;
  readonly primaryQualityOutcome: "excluded" | "failure" | "success";
  readonly procedureContentSha256: string | null;
  readonly providerFailure: DevelopmentDirectAttemptObservation["providerFailure"];
  readonly providerFailureObserved: boolean;
  readonly providerRequestIdSha256: string | null;
  readonly providerRequestsCompleted: 0 | 1;
  readonly providerRequestsStarted: 0 | 1;
  readonly qualitySampleEligible: boolean;
  readonly qualitySampleExclusionReason: QualityExclusion;
  readonly responseBytes: number;
  readonly responseDisposition: DevelopmentDirectAttemptObservation["responseDisposition"];
  readonly responseTextSha256: string;
  readonly terminalOutcome: DevelopmentDirectAttemptObservation["terminalOutcome"];
  readonly usage: DevelopmentDirectUsage;
  readonly usageEventsObserved: number;
  readonly verifierStdoutSha256: string | null;
  readonly workspaceRetained: false;
}

const execFileAsync = promisify(execFile);
const IMPLEMENTATION_REFS = Object.freeze({
  developmentDirectExecutor:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-executor.ts",
  developmentDirectFixture:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-fixture.ts",
  developmentDirectRunner:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-runner.ts",
  developmentPilotFixture:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-pilot-fixture.ts",
  developmentPilotWorkspace:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-pilot-workspace.ts",
  piModelBackend: "src/providers/pi/pi-model-backend.ts",
  productionPiRuntimePort: "src/providers/pi/production-pi-runtime-port.ts",
  runDevelopmentDirectPilotCli:
    "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/tools/run-development-direct-pilot.ts",
} as const);

function rawSha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function captureDevelopmentDirectRepositoryProvenance(
  repositoryRoot: string,
): Promise<DevelopmentDirectRepositoryProvenance> {
  const normalizedRoot = resolve(repositoryRoot);
  const [headResult, statusResult, implementationEntries] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: normalizedRoot,
      encoding: "utf8",
      env: developmentPilotGitEnvironment(process.env),
      windowsHide: true,
    }),
    execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: normalizedRoot,
      encoding: "utf8",
      env: developmentPilotGitEnvironment(process.env),
      maxBuffer: 4 * 1_024 * 1_024,
      windowsHide: true,
    }),
    Promise.all(Object.entries(IMPLEMENTATION_REFS).map(async ([key, ref]) => Object.freeze({
      hash: rawSha256(await readFile(resolve(normalizedRoot, ...ref.split("/")))),
      key,
    }))),
  ]);
  const gitHead = String(headResult.stdout).trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(gitHead)) {
    throw new Error("development direct provenance could not bind a git HEAD");
  }
  const gitStatus = String(statusResult.stdout);
  const implementationRawSha256 = Object.fromEntries(
    implementationEntries.map((entry) => [entry.key, entry.hash]),
  ) as unknown as DevelopmentDirectRepositoryProvenance["implementationRawSha256"];
  return Object.freeze({
    gitDirty: gitStatus.length > 0,
    gitHead,
    gitStatusPorcelainSha256: rawSha256(gitStatus),
    implementationRawSha256: Object.freeze(implementationRawSha256),
  });
}

function assertAuthorization(input: Readonly<{
  readonly authorization: DevelopmentDirectRunAuthorization;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fixture: Awaited<ReturnType<typeof loadDevelopmentDirectFixture>>;
}>): void {
  if (
    input.authorization.authorizeRemote !== true ||
    input.authorization.acceptedPricingSha256 !== input.fixture.base.pricing.pricingSha256 ||
    !Number.isSafeInteger(input.authorization.maximumEstimatedCostUsdMicros) ||
    input.authorization.maximumEstimatedCostUsdMicros <
      input.fixture.directProtocol.batchCaps.conservativePeakUpperBoundUsdMicros ||
    input.authorization.maximumEstimatedCostUsdMicros >
      input.fixture.directProtocol.batchCaps.maximumAuthorizedCostUsdMicros ||
    (input.environment.DEEPSEEK_API_KEY ?? "").trim().length === 0
  ) {
    throw new Error("development direct authorization, pricing, cost, or credential preflight failed");
  }
}

function safeAttemptRoot(batchRoot: string, index: number): string {
  const child = resolve(batchRoot, `attempt-${String(index).padStart(2, "0")}`);
  if (dirname(child) !== resolve(batchRoot)) {
    throw new Error("development direct attempt root escaped its temporary batch");
  }
  return child;
}

function usageIsComplete(usage: DevelopmentDirectUsage): boolean {
  if (
    usage.completeness !== "complete" ||
    usage.cacheReadTokens === null ||
    usage.cacheWriteTokens === null ||
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.totalTokens === null
  ) return false;
  return usage.totalTokens ===
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

function estimateCost(
  fixture: Awaited<ReturnType<typeof loadDevelopmentDirectFixture>>,
  usage: DevelopmentDirectUsage,
): AttemptCost | null {
  if (!usageIsComplete(usage)) return null;
  const estimate = (rates: Readonly<{
    readonly cachedInput: number;
    readonly output: number;
    readonly uncachedInput: number;
  }>): number => Math.round(
    usage.cacheReadTokens! * rates.cachedInput +
    (usage.inputTokens! + usage.cacheWriteTokens!) * rates.uncachedInput +
    usage.outputTokens! * rates.output,
  );
  return Object.freeze({
    estimatedOffPeakUsdMicros: estimate(fixture.base.pricing.offPeak),
    estimatedPeakUsdMicros: estimate(fixture.base.pricing.peak),
    isProviderInvoice: false,
  });
}

function worstCaseStartedRequestPeakReserve(
  fixture: Awaited<ReturnType<typeof loadDevelopmentDirectFixture>>,
): number {
  return Math.ceil(
    fixture.directProtocol.perAttemptCaps.inputAuthorizationTokens *
      fixture.base.pricing.peak.uncachedInput +
    fixture.directProtocol.perAttemptCaps.maximumReportedOutputTokens *
      fixture.base.pricing.peak.output,
  );
}

function peakCostAccounting(input: Readonly<{
  readonly completeUsageCost: AttemptCost | null;
  readonly providerRequestsStarted: 0 | 1;
  readonly worstCaseStartedRequestPeakReserveUsdMicros: number;
}>): AttemptPeakCostAccounting {
  if (input.completeUsageCost !== null) {
    return Object.freeze({
      basis: "complete_usage_estimate",
      peakUsdMicros: input.completeUsageCost.estimatedPeakUsdMicros,
      reserveIsProviderInvoice: false,
    });
  }
  if (input.providerRequestsStarted === 1) {
    return Object.freeze({
      basis: "started_request_worst_case_reserve",
      peakUsdMicros: input.worstCaseStartedRequestPeakReserveUsdMicros,
      reserveIsProviderInvoice: false,
    });
  }
  return Object.freeze({
    basis: "no_provider_request",
    peakUsdMicros: 0,
    reserveIsProviderInvoice: false,
  });
}

function hasCompletedProviderUsageEvidence(
  attempt: Readonly<Pick<AttemptRecord,
    "providerRequestsCompleted" | "providerRequestsStarted" | "usage" | "usageEventsObserved">>,
): boolean {
  return attempt.providerRequestsStarted === 1 &&
    attempt.providerRequestsCompleted === 1 &&
    attempt.usageEventsObserved === 1 &&
    usageIsComplete(attempt.usage);
}

function pairedSummary(attempts: readonly AttemptRecord[]): readonly Readonly<Record<string, unknown>>[] {
  const caseIds = ["inclusive-boundary", "end-exclusive-page-window", "one-based-retry-cap"] as const;
  return Object.freeze(caseIds.map((caseId) => {
    const baseline = attempts.find((attempt) => attempt.caseId === caseId && attempt.arm === "baseline");
    const candidate = attempts.find((attempt) => attempt.caseId === caseId && attempt.arm === "candidate");
    const outcome = baseline === undefined || candidate === undefined
      ? "incomplete_pair"
      : !baseline.qualitySampleEligible || !candidate.qualitySampleEligible
        ? "excluded_pair"
        : baseline.independentExactRepairSuccess && candidate.independentExactRepairSuccess
          ? "both_success"
          : candidate.independentExactRepairSuccess
            ? "candidate_only_success"
            : baseline.independentExactRepairSuccess
              ? "baseline_only_success"
              : "neither_success";
    return Object.freeze({
      baselinePeakCostUsdMicros: baseline?.cost?.estimatedPeakUsdMicros ?? null,
      baselineReportedTokens: baseline?.usage.totalTokens ?? null,
      candidatePeakCostUsdMicros: candidate?.cost?.estimatedPeakUsdMicros ?? null,
      candidateReportedTokens: candidate?.usage.totalTokens ?? null,
      caseId,
      outcome,
    });
  }));
}

export interface DevelopmentDirectReceipt extends Readonly<Record<string, unknown>> {
  readonly receiptSha256: string;
  readonly status: string;
}

export async function runAuthorizedDevelopmentDirectPilot(input: Readonly<{
  readonly authorization: DevelopmentDirectRunAuthorization;
  readonly checkpointSink?: (checkpoint: DevelopmentDirectJournalCheckpoint) => Promise<void>;
  readonly ds0ObservationPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executor: DevelopmentDirectAttemptExecutor;
  readonly repositoryRoot: string;
}>): Promise<DevelopmentDirectReceipt> {
  const fixture = await loadDevelopmentDirectFixture(input.repositoryRoot);
  assertAuthorization({
    authorization: input.authorization,
    environment: input.environment,
    fixture,
  });
  const qualification = await loadDevelopmentPilotQualificationFromDs0Observation(
    input.ds0ObservationPath,
    fixture.base,
  );
  const repositoryProvenance = await captureDevelopmentDirectRepositoryProvenance(
    input.repositoryRoot,
  );
  const batchRoot = await mkdtemp(join(tmpdir(), "bornagent-vp0-direct-"));
  const exactProductionExecutor = isExactProductionDevelopmentDirectExecutor(input.executor);
  const attempts: AttemptRecord[] = [];
  let status:
    | "completed"
    | "stopped_cap_exceeded"
    | "stopped_cost_or_usage_incomplete"
    | "stopped_orchestration_error"
    | "stopped_provider_or_protocol_failure" = "completed";
  let accountedPeakCostSoFar = 0;
  let unobservedAttemptWorstCaseReserveCount = 0;
  const worstCaseStartedRequestPeakReserveUsdMicros =
    worstCaseStartedRequestPeakReserve(fixture);
  try {
    for (const [index, order] of fixture.directProtocol.fixedExecutionOrder.entries()) {
      const [caseId, arm] = order.split(":") as [DevelopmentPilotCase["caseId"], DevelopmentPilotArm];
      const caseInput = fixture.base.cases.find((candidate) => candidate.caseId === caseId);
      if (caseInput === undefined) throw new Error("development direct order names an unknown case");
      const attemptRoot = safeAttemptRoot(batchRoot, index + 1);
      await mkdir(attemptRoot, { recursive: false });
      try {
        const attempt = await createDevelopmentPilotAttemptWorkspace({
          arm,
          attemptRoot,
          case: caseInput,
          fixture: fixture.base,
        });
        await input.checkpointSink?.(Object.freeze({
          schemaVersion: 1,
          pilotId: VP0_DEVELOPMENT_DIRECT_PILOT_ID,
          stage: "before_provider_request",
          receiptPending: true,
          providerRequestMayBeInFlightOnCrashAfterThisCheckpoint: true,
          repositoryProvenance,
          inFlightAttempt: Object.freeze({
            arm,
            attemptIndex: index + 1,
            caseId,
            encodedPromptOrResponsePersisted: false,
            worstCasePeakReserveUsdMicros:
              worstCaseStartedRequestPeakReserveUsdMicros,
          }),
          aggregateBeforeAttempt: Object.freeze({
            accountedPeakCostUsdMicros: accountedPeakCostSoFar,
            attemptsRecorded: attempts.length,
            providerRequestsCompleted: attempts.reduce(
              (sum, record) => sum + record.providerRequestsCompleted,
              0,
            ),
            providerRequestsStarted: attempts.reduce(
              (sum, record) => sum + record.providerRequestsStarted,
              0,
            ),
          }),
          privacy: Object.freeze({
            absolutePathsPersisted: false,
            apiKeyPersisted: false,
            rawProviderReasoningPersisted: false,
            rawProviderResponsePersisted: false,
          }),
        }));
        let observation: DevelopmentDirectAttemptObservation;
        try {
          observation = await input.executor.execute({
            arm,
            attempt,
            case: caseInput,
            environment: input.environment,
            fixture,
            qualification: qualification.descriptor,
          });
        } catch {
          accountedPeakCostSoFar += worstCaseStartedRequestPeakReserveUsdMicros;
          unobservedAttemptWorstCaseReserveCount += 1;
          status = "stopped_orchestration_error";
          break;
        }
        let freshVerification: Awaited<ReturnType<typeof verifyDevelopmentPilotAttemptWorkspace>> | null = null;
        if (!observation.orchestrationFailure && observation.responseDisposition === "applied") {
          try {
            freshVerification = await verifyDevelopmentPilotAttemptWorkspace(caseInput, attempt);
          } catch {
            freshVerification = null;
          }
        }
        const cost = estimateCost(fixture, observation.usage);
        const attemptPeakCostAccounting = peakCostAccounting({
          completeUsageCost: cost,
          providerRequestsStarted: observation.providerRequestsStarted,
          worstCaseStartedRequestPeakReserveUsdMicros,
        });
        const providerOrProtocolFailure =
          observation.providerFailureObserved ||
          !["text", "local_refused"].includes(observation.terminalOutcome);
        const qualitySampleExclusionReason: QualityExclusion = observation.orchestrationFailure
          ? "orchestration_failure"
          : observation.capExceeded !== null
            ? "cap_exceeded"
            : observation.providerRequestsStarted === 0
              ? "no_provider_request"
              : providerOrProtocolFailure || observation.providerRequestsCompleted !== 1
                ? "provider_or_protocol_failure"
                : !usageIsComplete(observation.usage) || cost === null ||
                    accountedPeakCostSoFar + attemptPeakCostAccounting.peakUsdMicros >
                      input.authorization.maximumEstimatedCostUsdMicros
                  ? "cost_or_usage_incomplete"
                  : null;
        const qualitySampleEligible = qualitySampleExclusionReason === null;
        const independentExactRepairSuccess = freshVerification !== null;
        accountedPeakCostSoFar += attemptPeakCostAccounting.peakUsdMicros;
        const attemptRecord: AttemptRecord = Object.freeze({
          appliedPath: observation.appliedPath,
          arm,
          attemptIndex: index + 1,
          baselineCommit: attempt.baselineCommit,
          baselineSourceStateSha256: attempt.baselineSourceStateSha256,
          capExceeded: observation.capExceeded,
          caseId,
          changedPaths: freshVerification?.changedPaths ?? Object.freeze([]),
          cost,
          peakCostAccounting: attemptPeakCostAccounting,
          encodedPromptBytes: observation.encodedPromptBytes,
          encodedPromptSha256: observation.encodedPromptSha256,
          finalSourceStateSha256: freshVerification?.finalSourceStateSha256 ?? null,
          finalTargetSha256: freshVerification?.finalTargetSha256 ?? null,
          freshVerifier: independentExactRepairSuccess ? "passed" : "failed",
          initialTargetSha256: attempt.initialTargetSha256,
          initialVerifierFailureObserved: true,
          independentExactRepairSuccess,
          primaryQualityOutcome: !qualitySampleEligible
            ? "excluded"
            : independentExactRepairSuccess
              ? "success"
              : "failure",
          procedureContentSha256: arm === "candidate"
            ? fixture.base.procedureRawSha256
            : null,
          providerFailure: observation.providerFailure,
          providerFailureObserved: observation.providerFailureObserved,
          providerRequestIdSha256: observation.providerRequestIdSha256 ?? null,
          providerRequestsCompleted: observation.providerRequestsCompleted,
          providerRequestsStarted: observation.providerRequestsStarted,
          qualitySampleEligible,
          qualitySampleExclusionReason,
          responseBytes: observation.responseBytes,
          responseDisposition: observation.responseDisposition,
          responseTextSha256: observation.responseTextSha256,
          terminalOutcome: observation.terminalOutcome,
          usage: observation.usage,
          usageEventsObserved: observation.usageEventsObserved ?? 0,
          verifierStdoutSha256: freshVerification?.verifierStdoutSha256 ?? null,
          workspaceRetained: false,
        });
        attempts.push(attemptRecord);
        await input.checkpointSink?.(Object.freeze({
          schemaVersion: 1,
          pilotId: VP0_DEVELOPMENT_DIRECT_PILOT_ID,
          stage: "after_provider_observation",
          receiptPending: true,
          providerRequestMayBeInFlightOnCrashAfterThisCheckpoint: false,
          repositoryProvenance,
          lastAttemptObservation: Object.freeze({
            arm,
            attemptIndex: index + 1,
            caseId,
            peakCostAccounting: attemptPeakCostAccounting,
            providerFailure: observation.providerFailure,
            providerRequestIdSha256: observation.providerRequestIdSha256 ?? null,
            providerRequestsCompleted: observation.providerRequestsCompleted,
            providerRequestsStarted: observation.providerRequestsStarted,
            responseTextSha256: observation.responseTextSha256,
            terminalOutcome: observation.terminalOutcome,
            usage: observation.usage,
            usageEventsObserved: observation.usageEventsObserved ?? 0,
          }),
          aggregateAfterAttempt: Object.freeze({
            accountedPeakCostUsdMicros: accountedPeakCostSoFar,
            attemptsRecorded: attempts.length,
            providerRequestsCompleted: attempts.reduce(
              (sum, record) => sum + record.providerRequestsCompleted,
              0,
            ),
            providerRequestsStarted: attempts.reduce(
              (sum, record) => sum + record.providerRequestsStarted,
              0,
            ),
          }),
          privacy: Object.freeze({
            absolutePathsPersisted: false,
            apiKeyPersisted: false,
            rawProviderReasoningPersisted: false,
            rawProviderResponsePersisted: false,
          }),
        }));
        if (observation.orchestrationFailure) {
          status = "stopped_orchestration_error";
          break;
        }
        if (observation.capExceeded !== null) {
          status = "stopped_cap_exceeded";
          break;
        }
        if (providerOrProtocolFailure || observation.providerRequestsCompleted !== 1) {
          status = "stopped_provider_or_protocol_failure";
          break;
        }
        if (!usageIsComplete(observation.usage) || cost === null ||
          accountedPeakCostSoFar > input.authorization.maximumEstimatedCostUsdMicros) {
          status = "stopped_cost_or_usage_incomplete";
          break;
        }
      } finally {
        await rm(attemptRoot, { force: true, recursive: true });
      }
    }
  } finally {
    await rm(batchRoot, { force: true, recursive: true });
  }
  const baseline = attempts.filter((attempt) => attempt.arm === "baseline");
  const candidate = attempts.filter((attempt) => attempt.arm === "candidate");
  const qualitySamples = attempts.filter((attempt) => attempt.qualitySampleEligible);
  const successful = qualitySamples.filter((attempt) => attempt.independentExactRepairSuccess);
  const completedProviderUsageEvidence = attempts.filter(hasCompletedProviderUsageEvidence);
  const actualModelExecutionClaimed =
    exactProductionExecutor && completedProviderUsageEvidence.length > 0;
  const reservedIncompleteUsageAttempts = attempts.filter((attempt) =>
    attempt.peakCostAccounting.basis === "started_request_worst_case_reserve"
  );
  const content = {
    schemaVersion: 1,
    pilotId: VP0_DEVELOPMENT_DIRECT_PILOT_ID,
    experimentId: fixture.directProtocol.experimentId,
    evidenceClass: actualModelExecutionClaimed
      ? fixture.directProtocol.evidenceClass
      : "offline_mechanics_test_only",
    executionBackend: actualModelExecutionClaimed
      ? "production_model_backend_single_turn_no_tools"
      : exactProductionExecutor
        ? "production_executor_without_completed_usage_evidence"
        : "injected_test_executor",
    actualModelExecutionClaimed,
    actualModelEvidence: {
      derivation:
        "exact_module_branded_production_executor_and_at_least_one_turn_completed_with_exactly_one_complete_usage_event",
      exactProductionExecutor,
      completedRequestWithCompleteUsageCount: completedProviderUsageEvidence.length,
      providerRequestIdSha256Count: completedProviderUsageEvidence.filter(
        (attempt) => attempt.providerRequestIdSha256 !== null,
      ).length,
      zeroProviderRequestsCannotClaimActualModelExecution: true,
    },
    bornagentToolProtocolExercised: false,
    productAgentCompletionClaimed: false,
    vp0GateEligible: false,
    comparison: "procedure-present_vs_no-memory",
    primaryOutcome: fixture.directProtocol.outcome.primary,
    status,
    authorization: {
      source: "run_local_explicit_flags",
      maximumEstimatedCostUsdMicros: input.authorization.maximumEstimatedCostUsdMicros,
      acceptedPricingSha256: input.authorization.acceptedPricingSha256,
      apiKeyPersisted: false,
    },
    hardLocalCaps: {
      maximumEncodedPromptBytesPerAttempt:
        fixture.directProtocol.perAttemptCaps.maximumEncodedPromptBytes,
      inputAuthorizationTokensPerAttempt:
        fixture.directProtocol.perAttemptCaps.inputAuthorizationTokens,
      maximumOutputTokensPerAttempt:
        fixture.directProtocol.perAttemptCaps.maximumReportedOutputTokens,
      maximumProviderRequests: fixture.directProtocol.batchCaps.maximumProviderRequests,
      conservativePeakUpperBoundUsdMicros:
        fixture.directProtocol.batchCaps.conservativePeakUpperBoundUsdMicros,
      conservativePeakUpperBoundFormula:
        fixture.directProtocol.batchCaps.conservativePeakUpperBoundFormula,
      absoluteProviderBillingGuaranteeClaimed: false,
    },
    fixture: {
      basePolicyRawSha256: fixture.base.policyRawSha256,
      basePricingRawSha256: fixture.base.pricingRawSha256,
      baseProtocolRawSha256: fixture.base.protocolRawSha256,
      ds0ProtocolSha256: fixture.base.ds0ProtocolSha256,
      directPolicyRawSha256: fixture.directPolicyRawSha256,
      directProtocolRawSha256: fixture.directProtocolRawSha256,
      pricingSha256: fixture.base.pricing.pricingSha256,
      procedureRawSha256: fixture.base.procedureRawSha256,
      cases: fixture.base.cases.map((caseInput) => ({
        caseId: caseInput.caseId,
        manifestRawSha256: caseInput.manifestRawSha256,
        publicTreeSha256: caseInput.publicTreeSha256,
      })),
    },
    repositoryProvenance,
    ds0QualificationBinding: {
      actorReportSha256: qualification.ds0ActorReportSha256,
      entryEvidenceClass: qualification.ds0EntryEvidenceClass,
      entryIsProductCompletionEvidence:
        qualification.ds0EntryEvidenceClass === "ds0_product_completion_passed",
      entryIsQualityEvidence: false,
      evidenceSha256: qualification.descriptor.qualificationEvidenceSha256,
      observationSha256: qualification.ds0ObservationSha256,
      pricingSha256: qualification.ds0PricingSha256,
      protocolSha256: qualification.ds0ProtocolSha256,
      qualificationRecordSha256: qualification.ds0QualificationRecordSha256,
    },
    executionOrder: [...fixture.directProtocol.fixedExecutionOrder],
    attempts,
    aggregate: {
      attemptsPlanned: 6,
      attemptsCompleted: attempts.length,
      qualitySampleCount: qualitySamples.length,
      independentExactRepairSuccessCount: successful.length,
      baselineIndependentExactRepairSuccessCount: baseline.filter((attempt) =>
        attempt.qualitySampleEligible && attempt.independentExactRepairSuccess).length,
      candidateIndependentExactRepairSuccessCount: candidate.filter((attempt) =>
        attempt.qualitySampleEligible && attempt.independentExactRepairSuccess).length,
      ceilingObserved: qualitySamples.length === 6 && successful.length === 6,
      hardBenefitClaim: false,
      pairedCases: pairedSummary(attempts),
      totalProviderRequests: attempts.reduce(
        (sum, attempt) => sum + attempt.providerRequestsStarted,
        0,
      ),
      combinedPeakCostUsdMicros: accountedPeakCostSoFar,
      combinedPeakCostAccounting:
        "complete_usage_estimate_or_started_request_worst_case_reserve",
      completeUsageEstimatedPeakCostUsdMicros: attempts.reduce(
        (sum, attempt) => sum + (attempt.cost?.estimatedPeakUsdMicros ?? 0),
        0,
      ),
      incompleteUsageStartedRequestReserveCount: reservedIncompleteUsageAttempts.length,
      incompleteUsageStartedRequestReserveUsdMicros: reservedIncompleteUsageAttempts.reduce(
        (sum, attempt) => sum + attempt.peakCostAccounting.peakUsdMicros,
        0,
      ),
      unobservedAttemptWorstCaseReserveCount,
      unobservedAttemptWorstCaseReserveUsdMicros:
        unobservedAttemptWorstCaseReserveCount * worstCaseStartedRequestPeakReserveUsdMicros,
      worstCaseStartedRequestPeakReserveUsdMicros,
      isProviderInvoice: false,
    },
    privacy: {
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
      attemptWorkspacesRetained: false,
    },
    nonClaims: fixture.directProtocol.nonClaims,
  } as const;
  return Object.freeze({
    ...content,
    receiptSha256: sha256Canonical(content),
  });
}
