import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  ProductionDevelopmentPilotExecutor,
  type DevelopmentPilotAgentObservation,
  type DevelopmentPilotAttemptExecutor,
  type DevelopmentPilotToolCallObservation,
  type DevelopmentPilotUsageObservation,
} from "./development-pilot-production-executor.js";
import type { DevelopmentPilotCapExceeded } from "./development-pilot-provider-meter.js";
import type {
  DevelopmentPilotArm,
  DevelopmentPilotCase,
  DevelopmentPilotFixture,
} from "./development-pilot-fixture.js";
import {
  loadDevelopmentPilotFixture,
  loadDevelopmentPilotQualificationFromDs0Observation,
  VP0_DEVELOPMENT_PILOT_ID,
} from "./development-pilot-fixture.js";
import {
  createDevelopmentPilotAttemptWorkspace,
  verifyDevelopmentPilotAttemptWorkspace,
} from "./development-pilot-workspace.js";

export interface DevelopmentPilotOfflinePlan {
  readonly actorAttemptCount: 6;
  readonly apiKeyPresenceIsAuthorization: false;
  readonly caseCount: 3;
  readonly caseHashes: readonly Readonly<{
    readonly caseId: DevelopmentPilotCase["caseId"];
    readonly manifestRawSha256: string;
    readonly publicTreeSha256: string;
  }>[];
  readonly conservativePeakUpperBoundUsdMicros: 179_592;
  readonly evidenceClass: "development_directional_actual_model_effect_only";
  readonly executionOrder: readonly string[];
  readonly mode: "offline_plan_only";
  readonly pilotId: typeof VP0_DEVELOPMENT_PILOT_ID;
  readonly pricingSha256: string;
  readonly procedureRawSha256: string;
  readonly protocolRawSha256: string;
  readonly providerRequestsStarted: 0;
  readonly remoteCallsAuthorized: false;
  readonly vp0GateEligible: false;
}

export async function planDevelopmentPilot(
  repositoryRoot: string,
): Promise<DevelopmentPilotOfflinePlan> {
  const fixture = await loadDevelopmentPilotFixture(repositoryRoot);
  return Object.freeze({
    actorAttemptCount: 6,
    apiKeyPresenceIsAuthorization: false,
    caseCount: 3,
    caseHashes: Object.freeze(fixture.cases.map((caseInput) => Object.freeze({
      caseId: caseInput.caseId,
      manifestRawSha256: caseInput.manifestRawSha256,
      publicTreeSha256: caseInput.publicTreeSha256,
    }))),
    conservativePeakUpperBoundUsdMicros: 179_592,
    evidenceClass: "development_directional_actual_model_effect_only",
    executionOrder: Object.freeze([...fixture.protocol.fixedExecutionOrder]),
    mode: "offline_plan_only",
    pilotId: VP0_DEVELOPMENT_PILOT_ID,
    pricingSha256: fixture.pricing.pricingSha256,
    procedureRawSha256: fixture.procedureRawSha256,
    protocolRawSha256: fixture.protocolRawSha256,
    providerRequestsStarted: 0,
    remoteCallsAuthorized: false,
    vp0GateEligible: false,
  });
}

export interface DevelopmentPilotRunAuthorization {
  readonly acceptedPricingSha256: string;
  readonly authorizeRemote: true;
  readonly maximumEstimatedCostUsdMicros: number;
}

interface AttemptCost {
  readonly cacheDetail: "provider_reported" | "conservative_no_cache_detail";
  readonly estimatedOffPeakUsdMicros: number;
  readonly estimatedPeakUsdMicros: number;
  readonly isProviderInvoice: false;
}

interface AttemptRecord {
  readonly approvalDecisions: DevelopmentPilotAgentObservation["approvalDecisions"];
  readonly arm: DevelopmentPilotArm;
  readonly attemptIndex: number;
  readonly baselineCommit: string;
  readonly baselineSourceStateSha256: string;
  readonly capability: Readonly<{
    readonly procedureContentSha256: string | null;
    readonly pluginSha256: string | null;
    readonly selected: boolean;
  }>;
  readonly capExceeded: DevelopmentPilotCapExceeded | null;
  readonly capsPassed: boolean;
  readonly caseId: DevelopmentPilotCase["caseId"];
  readonly changedPaths: readonly string[];
  readonly completionEvidenceSha256: string | null;
  readonly completionReportSha256: string | null;
  readonly cost: AttemptCost | null;
  readonly finalSourceStateSha256: string | null;
  readonly finalTargetSha256: string | null;
  readonly freshVerifier: "failed" | "passed";
  readonly hostToolCallCategories: Readonly<Record<string, number>>;
  readonly independentTaskSuccess: boolean;
  readonly initialTargetSha256: string;
  readonly initialVerifierFailureObserved: true;
  readonly orchestrationFailure: boolean;
  readonly providerRequestsCompleted: number;
  readonly providerRequestsStarted: number;
  readonly primaryQualityOutcome: "excluded" | "failure" | "success";
  readonly qualitySampleEligible: boolean;
  readonly qualitySampleExclusionReason:
    | "cost_authority_exceeded"
    | "no_provider_request"
    | "orchestration_failure"
    | "terminal_failure_or_ambiguity"
    | "unsafe_or_ambiguous_approval"
    | "usage_incomplete"
    | null;
  readonly sessionEventLogSha256: string | null;
  readonly terminal: DevelopmentPilotAgentObservation["terminal"];
  readonly terminalCode: string | null;
  readonly terminalFailureCategory: string | null;
  readonly toolCalls: readonly DevelopmentPilotToolCallObservation[];
  readonly usage: DevelopmentPilotUsageObservation;
  readonly usageSource: "backend_meter";
  readonly usageCrossCheckedAgainstSession: boolean;
  readonly verifierStdoutSha256: string | null;
  readonly verifiedFinishTaskCompletion: boolean;
  readonly workspaceRetained: false;
}

function toolCategory(toolName: string): string {
  if (["read_file", "list_files", "search_files", "repository_search"].includes(toolName)) {
    return "repository_read";
  }
  if (toolName === "apply_patch") return "workspace_edit";
  if (toolName === "run_command") return "verification_command";
  if (toolName === "finish_task") return "completion";
  return "other";
}

function toolCategories(calls: readonly DevelopmentPilotToolCallObservation[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const category = toolCategory(call.toolName);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right))));
}

function estimateCost(
  fixture: DevelopmentPilotFixture,
  usage: DevelopmentPilotUsageObservation,
): AttemptCost | null {
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.totalTokens === null
  ) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const estimate = (rates: Readonly<{
    readonly cachedInput: number;
    readonly output: number;
    readonly uncachedInput: number;
  }>): number => Math.round(
    cacheRead * rates.cachedInput +
    (usage.inputTokens! + cacheWrite) * rates.uncachedInput +
    usage.outputTokens! * rates.output,
  );
  return Object.freeze({
    cacheDetail: usage.cacheReadTokens === null || usage.cacheWriteTokens === null
      ? "conservative_no_cache_detail"
      : "provider_reported",
    estimatedOffPeakUsdMicros: estimate(fixture.pricing.offPeak),
    estimatedPeakUsdMicros: estimate(fixture.pricing.peak),
    isProviderInvoice: false,
  });
}

function assertAuthorization(input: Readonly<{
  readonly authorization: DevelopmentPilotRunAuthorization;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fixture: DevelopmentPilotFixture;
}>): void {
  if (input.authorization.authorizeRemote !== true) {
    throw new Error("development pilot requires explicit run-local remote authorization");
  }
  if (
    !Number.isSafeInteger(input.authorization.maximumEstimatedCostUsdMicros) ||
    input.authorization.maximumEstimatedCostUsdMicros <
      input.fixture.protocol.batchCaps.conservativePeakUpperBoundUsdMicros ||
    input.authorization.maximumEstimatedCostUsdMicros >
      input.fixture.protocol.batchCaps.maximumEstimatedPeakCostUsdMicros
  ) {
    throw new Error("development pilot maximum cost must cover the frozen batch bound without exceeding USD 0.18");
  }
  if (input.authorization.acceptedPricingSha256 !== input.fixture.pricing.pricingSha256) {
    throw new Error("development pilot pricing confirmation does not match the frozen snapshot");
  }
  if ((input.environment.DEEPSEEK_API_KEY ?? "").trim().length === 0) {
    throw new Error("development pilot DeepSeek credential is not configured");
  }
}

function safeAttemptRoot(batchRoot: string, index: number): string {
  const child = resolve(batchRoot, `attempt-${String(index).padStart(2, "0")}`);
  if (dirname(child) !== resolve(batchRoot)) {
    throw new Error("development pilot attempt root escaped its temporary batch");
  }
  return child;
}

function emptyObservation(): DevelopmentPilotAgentObservation {
  return Object.freeze({
    approvalDecisions: Object.freeze({ approved: 0, cancelled: 0, denied: 0 }),
    completionEvidenceSha256: null,
    completionReportSha256: null,
    capExceeded: null,
    exitCode: 1,
    orchestrationFailure: true,
    providerRequestsCompleted: 0,
    providerRequestsStarted: 0,
    sessionEventLogSha256: null,
    terminal: "not_started",
    terminalCode: "orchestration_not_started",
    terminalFailureCategory: "orchestration",
    toolCalls: Object.freeze([]),
    usage: Object.freeze({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      completeness: "none",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }),
    usageCrossCheckedAgainstSession: false,
  });
}

function pairedSummary(attempts: readonly AttemptRecord[]): readonly Readonly<Record<string, unknown>>[] {
  const caseIds = ["inclusive-boundary", "end-exclusive-page-window", "one-based-retry-cap"] as const;
  return Object.freeze(caseIds.map((caseId) => {
    const baseline = attempts.find((attempt) => attempt.caseId === caseId && attempt.arm === "baseline");
    const candidate = attempts.find((attempt) => attempt.caseId === caseId && attempt.arm === "candidate");
    const primaryQuality = baseline === undefined || candidate === undefined
      ? "incomplete_pair"
      : !candidate.qualitySampleEligible || !baseline.qualitySampleEligible
        ? "excluded_pair"
        : candidate.independentTaskSuccess && baseline.independentTaskSuccess
          ? "both_success"
          : candidate.independentTaskSuccess
            ? "candidate_only_success"
            : baseline.independentTaskSuccess
              ? "baseline_only_success"
              : "neither_success";
    return Object.freeze({
      caseId,
      primaryQuality,
      baselineVerifiedFinishTaskCompletion:
        baseline?.verifiedFinishTaskCompletion ?? null,
      candidateVerifiedFinishTaskCompletion:
        candidate?.verifiedFinishTaskCompletion ?? null,
      baselineProviderRequests: baseline?.providerRequestsStarted ?? null,
      candidateProviderRequests: candidate?.providerRequestsStarted ?? null,
      baselineHostToolCalls: baseline?.toolCalls.length ?? null,
      candidateHostToolCalls: candidate?.toolCalls.length ?? null,
      baselineReportedTokens: baseline?.usage.totalTokens ?? null,
      candidateReportedTokens: candidate?.usage.totalTokens ?? null,
      baselinePeakCostUsdMicros: baseline?.cost?.estimatedPeakUsdMicros ?? null,
      candidatePeakCostUsdMicros: candidate?.cost?.estimatedPeakUsdMicros ?? null,
    });
  }));
}

export interface DevelopmentPilotReceipt extends Readonly<Record<string, unknown>> {
  readonly receiptSha256: string;
}

export async function runAuthorizedDevelopmentPilot(input: Readonly<{
  readonly authorization: DevelopmentPilotRunAuthorization;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executor: DevelopmentPilotAttemptExecutor;
  readonly ds0ObservationPath: string;
  readonly repositoryRoot: string;
}>): Promise<DevelopmentPilotReceipt> {
  const fixture = await loadDevelopmentPilotFixture(input.repositoryRoot);
  const productionExecution =
    input.executor instanceof ProductionDevelopmentPilotExecutor;
  assertAuthorization({
    authorization: input.authorization,
    environment: input.environment,
    fixture,
  });
  const qualification = await loadDevelopmentPilotQualificationFromDs0Observation(
    input.ds0ObservationPath,
    fixture,
  );
  const batchRoot = await mkdtemp(join(tmpdir(), "bornagent-vp0-development-"));
  const attempts: AttemptRecord[] = [];
  let status:
    | "completed"
    | "stopped_cap_exceeded"
    | "stopped_cost_or_usage_incomplete"
    | "stopped_quality_sample_ineligible"
    | "stopped_orchestration_error" = "completed";
  let peakCostSoFar = 0;
  try {
    for (const [index, order] of fixture.protocol.fixedExecutionOrder.entries()) {
      const [caseId, arm] = order.split(":") as [DevelopmentPilotCase["caseId"], DevelopmentPilotArm];
      const caseInput = fixture.cases.find((candidate) => candidate.caseId === caseId);
      if (caseInput === undefined) throw new Error("development pilot execution order names an unknown case");
      const remainingAttempts = fixture.protocol.actorAttemptCount - index;
      const perAttemptBound =
        fixture.protocol.batchCaps.conservativePeakUpperBoundUsdMicros /
        fixture.protocol.actorAttemptCount;
      if (
        peakCostSoFar + remainingAttempts * perAttemptBound >
        input.authorization.maximumEstimatedCostUsdMicros
      ) {
        status = "stopped_cost_or_usage_incomplete";
        break;
      }
      const attemptRoot = safeAttemptRoot(batchRoot, index + 1);
      await mkdir(attemptRoot, { recursive: false });
      let observation = emptyObservation();
      let orchestrationFailed = false;
      try {
        const attempt = await createDevelopmentPilotAttemptWorkspace({
          arm,
          attemptRoot,
          case: caseInput,
          fixture,
        });
        try {
          observation = await input.executor.execute({
            attempt,
            case: caseInput,
            environment: input.environment,
            fixture,
            qualification: qualification.descriptor,
          });
          orchestrationFailed = observation.orchestrationFailure;
        } catch {
          orchestrationFailed = true;
        }
        let freshVerification: Awaited<ReturnType<typeof verifyDevelopmentPilotAttemptWorkspace>> | null = null;
        if (!orchestrationFailed) {
          try {
            freshVerification = await verifyDevelopmentPilotAttemptWorkspace(
              caseInput,
              attempt,
            );
          } catch {
            freshVerification = null;
          }
        }
        const cost = estimateCost(fixture, observation.usage);
        const reportedUncachedInputTokens =
          observation.usage.inputTokens === null ||
          observation.usage.cacheWriteTokens === null
            ? null
            : observation.usage.inputTokens + observation.usage.cacheWriteTokens;
        const capsPassed =
          observation.capExceeded === null &&
          observation.providerRequestsStarted <= fixture.protocol.perAttemptCaps.maximumProviderRequests &&
          observation.providerRequestsCompleted <= observation.providerRequestsStarted &&
          reportedUncachedInputTokens !== null &&
          reportedUncachedInputTokens <=
            fixture.protocol.perAttemptCaps.maximumReportedUncachedInputTokens &&
          observation.usage.cacheReadTokens !== null &&
          observation.usage.cacheReadTokens <=
            fixture.protocol.perAttemptCaps.maximumReportedCacheReadTokens &&
          observation.usage.outputTokens !== null &&
          observation.usage.outputTokens <=
            fixture.protocol.perAttemptCaps.maximumReportedOutputTokens &&
          observation.usage.totalTokens !== null &&
          observation.usage.totalTokens <= fixture.protocol.perAttemptCaps.maximumReportedTotalTokens &&
          observation.usage.completeness === "complete" &&
          observation.usageCrossCheckedAgainstSession &&
          cost !== null &&
          peakCostSoFar + cost.estimatedPeakUsdMicros <= input.authorization.maximumEstimatedCostUsdMicros;
        const independentTaskSuccess = freshVerification !== null;
        const costAuthorityPassed = cost !== null &&
          peakCostSoFar + cost.estimatedPeakUsdMicros <=
            input.authorization.maximumEstimatedCostUsdMicros;
        const usageAuditable =
          observation.providerRequestsCompleted <= observation.providerRequestsStarted &&
          observation.usage.completeness === "complete" &&
          observation.usageCrossCheckedAgainstSession &&
          cost !== null;
        const safeApprovalTrace =
          observation.approvalDecisions.cancelled === 0 &&
          observation.approvalDecisions.denied === 0;
        const eligibleTerminal = [
          "budget_exceeded",
          "cap_exceeded",
          "completed",
        ].includes(observation.terminal);
        const qualitySampleExclusionReason: AttemptRecord["qualitySampleExclusionReason"] =
          orchestrationFailed
            ? "orchestration_failure"
            : !safeApprovalTrace
              ? "unsafe_or_ambiguous_approval"
              : observation.providerRequestsStarted === 0
                ? "no_provider_request"
                : !usageAuditable
                  ? "usage_incomplete"
                  : !costAuthorityPassed
                    ? "cost_authority_exceeded"
                    : !eligibleTerminal || observation.terminalFailureCategory !== null
                      ? "terminal_failure_or_ambiguity"
                      : null;
        const qualitySampleEligible = qualitySampleExclusionReason === null;
        const verifiedFinishTaskCompletion =
          !orchestrationFailed &&
          observation.exitCode === 0 &&
          observation.terminal === "completed" &&
          observation.completionEvidenceSha256 !== null &&
          observation.completionReportSha256 !== null &&
          independentTaskSuccess;
        if (cost !== null) peakCostSoFar += cost.estimatedPeakUsdMicros;
        attempts.push(Object.freeze({
          approvalDecisions: observation.approvalDecisions,
          arm,
          attemptIndex: index + 1,
          baselineCommit: attempt.baselineCommit,
          baselineSourceStateSha256: attempt.baselineSourceStateSha256,
          capability: Object.freeze({
            procedureContentSha256: attempt.capability.carrierContentSha256,
            pluginSha256: attempt.capability.pluginSha256,
            selected: attempt.capability.selector !== null,
          }),
          capExceeded: observation.capExceeded,
          capsPassed,
          caseId,
          changedPaths: freshVerification?.changedPaths ?? Object.freeze([]),
          completionEvidenceSha256: observation.completionEvidenceSha256,
          completionReportSha256: observation.completionReportSha256,
          cost,
          finalSourceStateSha256: freshVerification?.finalSourceStateSha256 ?? null,
          finalTargetSha256: freshVerification?.finalTargetSha256 ?? null,
          freshVerifier: freshVerification === null ? "failed" : "passed",
          hostToolCallCategories: toolCategories(observation.toolCalls),
          independentTaskSuccess,
          initialTargetSha256: attempt.initialTargetSha256,
          initialVerifierFailureObserved: true,
          orchestrationFailure: orchestrationFailed,
          providerRequestsCompleted: observation.providerRequestsCompleted,
          providerRequestsStarted: observation.providerRequestsStarted,
          primaryQualityOutcome: !qualitySampleEligible
            ? "excluded"
            : independentTaskSuccess
              ? "success"
              : "failure",
          qualitySampleEligible,
          qualitySampleExclusionReason,
          sessionEventLogSha256: observation.sessionEventLogSha256,
          terminal: observation.terminal,
          terminalCode: observation.terminalCode,
          terminalFailureCategory: observation.terminalFailureCategory,
          toolCalls: observation.toolCalls,
          usage: observation.usage,
          usageSource: "backend_meter",
          usageCrossCheckedAgainstSession: observation.usageCrossCheckedAgainstSession,
          verifierStdoutSha256: freshVerification?.verifierStdoutSha256 ?? null,
          verifiedFinishTaskCompletion,
          workspaceRetained: false,
        }));
        if (orchestrationFailed) {
          status = "stopped_orchestration_error";
          break;
        }
        if (
          qualitySampleExclusionReason === "no_provider_request" ||
          qualitySampleExclusionReason === "terminal_failure_or_ambiguity" ||
          qualitySampleExclusionReason === "unsafe_or_ambiguous_approval"
        ) {
          status = "stopped_quality_sample_ineligible";
          break;
        }
        if (!capsPassed) {
          status = observation.capExceeded === null
            ? "stopped_cost_or_usage_incomplete"
            : "stopped_cap_exceeded";
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
  const independentTaskSuccessCount = qualitySamples.filter(
    (attempt) => attempt.independentTaskSuccess,
  ).length;
  const verifiedFinishTaskCompletionCount = attempts.filter(
    (attempt) => attempt.verifiedFinishTaskCompletion,
  ).length;
  const ceilingObserved =
    qualitySamples.length === 6 && independentTaskSuccessCount === 6;
  const content = {
    schemaVersion: 1,
    pilotId: VP0_DEVELOPMENT_PILOT_ID,
    experimentId: fixture.protocol.experimentId,
    evidenceClass: productionExecution
      ? fixture.protocol.evidenceClass
      : "offline_mechanics_test_only",
    executionBackend: productionExecution
      ? "production_execute_agent"
      : "injected_test_executor",
    actualModelExecutionClaimed: productionExecution,
    vp0GateEligible: false,
    comparison: "procedure-present_vs_no-memory",
    primaryOutcome: "independent_fresh_verifier_task_success",
    secondaryOutcome: "bornagent_verified_finish_task_completion",
    strictEqualInformationRepresentationGate: false,
    status,
    authorization: {
      source: "run_local_explicit_flags",
      maximumEstimatedCostUsdMicros: input.authorization.maximumEstimatedCostUsdMicros,
      acceptedPricingSha256: input.authorization.acceptedPricingSha256,
      apiKeyPersisted: false,
    },
    fixture: {
      protocolRawSha256: fixture.protocolRawSha256,
      pricingSha256: fixture.pricing.pricingSha256,
      procedureRawSha256: fixture.procedureRawSha256,
      policyRawSha256: fixture.policyRawSha256,
      cases: fixture.cases.map((caseInput) => ({
        caseId: caseInput.caseId,
        family: caseInput.family,
        manifestRawSha256: caseInput.manifestRawSha256,
        publicTreeSha256: caseInput.publicTreeSha256,
      })),
    },
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
    executionOrder: [...fixture.protocol.fixedExecutionOrder],
    attempts,
    aggregate: {
      attemptsPlanned: 6,
      attemptsCompleted: attempts.length,
      qualitySampleCount: qualitySamples.length,
      independentTaskSuccessCount,
      baselineIndependentTaskSuccessCount: baseline.filter((attempt) =>
        attempt.qualitySampleEligible && attempt.independentTaskSuccess).length,
      candidateIndependentTaskSuccessCount: candidate.filter((attempt) =>
        attempt.qualitySampleEligible && attempt.independentTaskSuccess).length,
      verifiedFinishTaskCompletionCount,
      baselineVerifiedFinishTaskCompletionCount: baseline.filter((attempt) =>
        attempt.verifiedFinishTaskCompletion).length,
      candidateVerifiedFinishTaskCompletionCount: candidate.filter((attempt) =>
        attempt.verifiedFinishTaskCompletion).length,
      ceilingObserved,
      qualityInterpretation: ceilingObserved
        ? "quality_ceiling_secondary_metrics_only"
        : "directional_quality_observation_only",
      hardBenefitClaim: false,
      pairedCases: pairedSummary(attempts),
      secondaryTotals: {
        baselineProviderRequests: baseline.reduce((sum, attempt) => sum + attempt.providerRequestsStarted, 0),
        candidateProviderRequests: candidate.reduce((sum, attempt) => sum + attempt.providerRequestsStarted, 0),
        baselineHostToolCalls: baseline.reduce((sum, attempt) => sum + attempt.toolCalls.length, 0),
        candidateHostToolCalls: candidate.reduce((sum, attempt) => sum + attempt.toolCalls.length, 0),
        baselineReportedTokens: baseline.every((attempt) => attempt.usage.totalTokens !== null)
          ? baseline.reduce((sum, attempt) => sum + (attempt.usage.totalTokens ?? 0), 0)
          : null,
        candidateReportedTokens: candidate.every((attempt) => attempt.usage.totalTokens !== null)
          ? candidate.reduce((sum, attempt) => sum + (attempt.usage.totalTokens ?? 0), 0)
          : null,
        baselinePeakCostUsdMicros: baseline.every((attempt) => attempt.cost !== null)
          ? baseline.reduce((sum, attempt) => sum + (attempt.cost?.estimatedPeakUsdMicros ?? 0), 0)
          : null,
        candidatePeakCostUsdMicros: candidate.every((attempt) => attempt.cost !== null)
          ? candidate.reduce((sum, attempt) => sum + (attempt.cost?.estimatedPeakUsdMicros ?? 0), 0)
          : null,
        combinedPeakCostUsdMicros: peakCostSoFar,
        isProviderInvoice: false,
      },
    },
    privacy: {
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
      attemptWorkspacesRetained: false,
    },
    nonClaims: fixture.protocol.nonClaims,
  } as const;
  return Object.freeze({
    ...content,
    receiptSha256: sha256Canonical(content),
  });
}
