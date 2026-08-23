import { performance } from "node:perf_hooks";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import {
  AgentContextRuntime,
  type AgentContextProjectionResult,
} from "../../context/agent-context-runtime.js";
import { ContextCompactionError } from "../../context/deterministic-compactor.js";
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../context/token-estimator.js";
import type { AgentMemoryBenchmarkGuard } from "./agent-memory-benchmark-guard.js";
import { captureAgentMemoryCheckoutFingerprint } from "./agent-memory-checkout-fingerprint.js";
import { generateAgentMemoryCorpusCase } from "./agent-memory-corpus.js";
import {
  captureAgentMemoryInputFingerprint,
  sha256Bytes,
  type AgentMemoryEvidenceManifestV1,
} from "./agent-memory-evidence.js";
import {
  AgentMemoryWorkingStateEvidenceError,
  createAgentMemoryWorkingStateReport,
  evaluateAgentMemoryWorkingStateEvidence,
  type AgentMemoryWorkingEquivalenceCaseV1,
  type AgentMemoryWorkingPerformanceCaseV1,
  type AgentMemoryWorkingStateManifestV1,
  type AgentMemoryWorkingStateReceiptV1,
  type AgentMemoryWorkingStateReportV1,
} from "./agent-memory-working-state-evidence.js";

export interface AgentMemoryWorkingStateRunResultV1 {
  readonly receipt: AgentMemoryWorkingStateReceiptV1;
  readonly report: AgentMemoryWorkingStateReportV1;
}

interface ProjectionObservation {
  readonly mode: "cold" | "incremental";
  readonly sourceEventCount: number;
  readonly sourceEventsApplied: number;
}

function selectedPlatform(): "linux" | "win32" {
  if (process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  throw new AgentMemoryWorkingStateEvidenceError(
    "agent_memory_working_platform_unsupported",
    `AM1 supports linux and win32, not ${process.platform}`,
  );
}

function runtime(
  manifest: AgentMemoryEvidenceManifestV1,
  mode: "off" | "working",
  observations: ProjectionObservation[] = [],
): AgentContextRuntime {
  const estimator = new DeterministicTokenEstimator({
    bytesPerToken: manifest.budget.bytesPerToken,
    itemOverheadTokens: manifest.budget.itemOverheadTokens,
    model: "agent-memory-am1-synthetic",
    provider: "offline-fixture",
    tokenizer: "utf8-deterministic-upper-bound",
    version: "agent-memory-am1-v1",
  });
  return new AgentContextRuntime({
    budget: resolveContextBudget(
      {
        contextWindowTokens: manifest.budget.contextWindowTokens,
        maximumOutputTokens: manifest.budget.reservedOutputTokens,
        source: "user_conservative_limit",
      },
      {
        compactionThreshold: manifest.budget.compactionThreshold,
        fixedSafetyMarginTokens: manifest.budget.fixedSafetyMarginTokens,
        reservedOutputTokens: manifest.budget.reservedOutputTokens,
      },
    ),
    estimator,
    systemInstructions:
      "AM1 synthetic equivalence. Do not call providers, tools, credentials, or networks.",
    ...(mode === "working"
      ? {
          workingState: {
            mode,
            observation: {
              onProjection: (value: ProjectionObservation) => {
                observations.push(value);
              },
            },
          },
        }
      : {}),
  });
}

function planningOutcome(
  selectedRuntime: AgentContextRuntime,
  projection: AgentContextProjectionResult,
): Readonly<{
  readonly errorCode: string | null;
  readonly planSha256: string | null;
  readonly providerBytesSha256: string | null;
}> {
  try {
    const result = selectedRuntime.planProjected(projection);
    return Object.freeze({
      errorCode: null,
      planSha256: sha256Canonical(result.plan),
      providerBytesSha256: sha256Bytes(result.materialized.bytes),
    });
  } catch (error) {
    if (error instanceof ContextCompactionError) {
      return Object.freeze({
        errorCode: error.code,
        planSha256: null,
        providerBytesSha256: null,
      });
    }
    throw error;
  }
}

function equivalenceCase(
  baselineManifest: AgentMemoryEvidenceManifestV1,
  caseId: string,
): AgentMemoryWorkingEquivalenceCaseV1 {
  const definition = baselineManifest.cases.find(
    (candidate) => candidate.caseId === caseId,
  );
  if (definition === undefined) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_case_missing",
      `AM0 corpus has no case ${caseId}`,
    );
  }
  const generated = generateAgentMemoryCorpusCase(definition);
  const prefixEventCount = Math.max(1, Math.floor(generated.events.length / 2));
  const observations: ProjectionObservation[] = [];
  const cold = runtime(baselineManifest, "off");
  const incremental = runtime(baselineManifest, "working", observations);
  const common = {
    artifactRefsByEventId: generated.artifactRefsByEventId,
    epoch: 0,
  } as const;
  incremental.project({
    ...common,
    events: generated.events.slice(0, prefixEventCount),
  });
  const coldProjection = cold.project({ ...common, events: generated.events });
  const incrementalProjection = incremental.project({
    ...common,
    events: generated.events,
  });
  const noOpProjection = incremental.project({
    ...common,
    events: generated.events,
  });
  if (
    canonicalJson(coldProjection.state) !== canonicalJson(incrementalProjection.state) ||
    canonicalJson(incrementalProjection.state) !== canonicalJson(noOpProjection.state)
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_projection_mismatch",
      `working state diverged from the cold oracle for ${caseId}`,
    );
  }
  const coldPlanning = planningOutcome(cold, coldProjection);
  const incrementalPlanning = planningOutcome(incremental, incrementalProjection);
  const appendObservation = observations[1];
  const noOpObservation = observations[2];
  if (
    observations.length !== 3 ||
    observations[0]?.mode !== "cold" ||
    appendObservation?.mode !== "incremental" ||
    noOpObservation?.mode !== "incremental"
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_observation_invalid",
      `working projection did not expose its exact work for ${caseId}`,
    );
  }
  return Object.freeze({
    appendSourceEventsApplied: appendObservation.sourceEventsApplied,
    caseId,
    coldErrorCode: coldPlanning.errorCode,
    coldPlanSha256: coldPlanning.planSha256,
    coldProviderBytesSha256: coldPlanning.providerBytesSha256,
    coldStateSha256: sha256Canonical(coldProjection.state),
    eventCount: generated.events.length,
    incrementalErrorCode: incrementalPlanning.errorCode,
    incrementalPlanSha256: incrementalPlanning.planSha256,
    incrementalProviderBytesSha256: incrementalPlanning.providerBytesSha256,
    incrementalStateSha256: sha256Canonical(incrementalProjection.state),
    noOpSourceEventsApplied: noOpObservation.sourceEventsApplied,
    prefixEventCount,
    suffixEventCount: generated.events.length - prefixEventCount,
  });
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function measure(operation: () => unknown): number {
  const startedAt = performance.now();
  operation();
  return rounded(performance.now() - startedAt);
}

function median(values: readonly number[]): number {
  const selected = [...values].sort((left, right) => left - right);
  return rounded(selected[Math.floor(selected.length / 2)]!);
}

function performanceCase(
  baselineManifest: AgentMemoryEvidenceManifestV1,
  definition: AgentMemoryWorkingStateManifestV1["performance"][number],
): AgentMemoryWorkingPerformanceCaseV1 {
  const corpusCase = baselineManifest.cases.find(
    (candidate) => candidate.caseId === definition.caseId,
  );
  if (corpusCase === undefined || corpusCase.expectedOutcome !== "planned") {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_performance_case_invalid",
      `performance case ${definition.caseId} must be a planned AM0 case`,
    );
  }
  const generated = generateAgentMemoryCorpusCase(corpusCase);
  const input = {
    artifactRefsByEventId: generated.artifactRefsByEventId,
    epoch: 0,
    events: generated.events,
  } as const;
  const baseline = runtime(baselineManifest, "off");
  const observations: ProjectionObservation[] = [];
  const working = runtime(baselineManifest, "working", observations);
  const baselineWarm = baseline.plan(input);
  const workingWarm = working.plan(input);
  if (
    canonicalJson(baselineWarm.plan) !== canonicalJson(workingWarm.plan) ||
    !Buffer.from(baselineWarm.materialized.bytes).equals(
      Buffer.from(workingWarm.materialized.bytes),
    )
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_performance_oracle_mismatch",
      `performance case ${definition.caseId} is not byte-equivalent`,
    );
  }
  for (let index = 1; index < definition.warmupIterations; index += 1) {
    baseline.plan(input);
    working.plan(input);
  }
  const baselineDurationsMs: number[] = [];
  const workingDurationsMs: number[] = [];
  for (let index = 0; index < definition.repetitions; index += 1) {
    if (index % 2 === 0) {
      baselineDurationsMs.push(measure(() => baseline.plan(input)));
      workingDurationsMs.push(measure(() => working.plan(input)));
    } else {
      workingDurationsMs.push(measure(() => working.plan(input)));
      baselineDurationsMs.push(measure(() => baseline.plan(input)));
    }
  }
  if (
    observations.length < definition.warmupIterations + definition.repetitions ||
    observations.slice(1).some(
      ({ mode, sourceEventsApplied }) =>
        mode !== "incremental" || sourceEventsApplied !== 0,
    )
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_performance_work_invalid",
      `performance case ${definition.caseId} replayed a no-op prefix`,
    );
  }
  const baselineMedianMs = median(baselineDurationsMs);
  const workingMedianMs = median(workingDurationsMs);
  const workingToBaselineRatio = rounded(workingMedianMs / baselineMedianMs);
  return Object.freeze({
    baselineDurationsMs: [...baselineDurationsMs],
    baselineMedianMs,
    caseId: definition.caseId,
    eventCount: generated.events.length,
    historyClass: definition.historyClass,
    improvementRatio: rounded(1 - workingToBaselineRatio),
    repetitions: definition.repetitions,
    workingDurationsMs: [...workingDurationsMs],
    workingMedianMs,
    workingToBaselineRatio,
  });
}

function verifyManifestPair(
  manifest: AgentMemoryWorkingStateManifestV1,
  baseline: AgentMemoryEvidenceManifestV1,
): void {
  const baselineIds = baseline.cases.map(({ caseId }) => caseId);
  if (
    manifest.corpusId !== baseline.corpusId ||
    canonicalJson(manifest.equivalenceCaseIds) !== canonicalJson(baselineIds)
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_baseline_mismatch",
      "AM1 does not bind the exact AM0 corpus case order",
    );
  }
}

export async function runAgentMemoryWorkingStateBenchmark(input: Readonly<{
  readonly baselineManifest: AgentMemoryEvidenceManifestV1;
  readonly baselineManifestSource: string;
  readonly guard: AgentMemoryBenchmarkGuard;
  readonly manifest: AgentMemoryWorkingStateManifestV1;
  readonly manifestSource: string;
  readonly workspaceRoot: string;
}>): Promise<AgentMemoryWorkingStateRunResultV1> {
  verifyManifestPair(input.manifest, input.baselineManifest);
  const [inputsBefore, checkoutBefore] = await Promise.all([
    captureAgentMemoryInputFingerprint(input.workspaceRoot, input.manifest),
    captureAgentMemoryCheckoutFingerprint(input.workspaceRoot),
  ]);
  const equivalenceCases = Object.freeze(
    input.manifest.equivalenceCaseIds.map((caseId) =>
      equivalenceCase(input.baselineManifest, caseId),
    ),
  );
  const performanceCases = Object.freeze(
    input.manifest.performance.map((definition) =>
      performanceCase(input.baselineManifest, definition),
    ),
  );
  input.guard.assertClean();
  const [inputsAfter, checkoutAfter] = await Promise.all([
    captureAgentMemoryInputFingerprint(input.workspaceRoot, input.manifest),
    captureAgentMemoryCheckoutFingerprint(input.workspaceRoot),
  ]);
  if (
    inputsBefore.fingerprintSha256 !== inputsAfter.fingerprintSha256 ||
    checkoutBefore.fingerprintSha256 !== checkoutAfter.fingerprintSha256
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_inputs_changed",
      "AM1 inputs changed while the benchmark was running",
    );
  }
  const report = createAgentMemoryWorkingStateReport({
    baselineManifest: input.baselineManifest,
    baselineManifestSource: input.baselineManifestSource,
    checkout: checkoutAfter,
    credentialReadAttemptCount: input.guard.credentialReadAttemptCount,
    equivalenceCases,
    exactCommand: input.manifest.commands.find(
      ({ commandId }) => commandId === "am1-benchmark",
    )!.command,
    inputFiles: inputsAfter.files,
    inputFingerprintSha256: inputsAfter.fingerprintSha256,
    manifest: input.manifest,
    manifestSource: input.manifestSource,
    networkAttemptCount: input.guard.networkAttemptCount,
    nodeVersion: process.version,
    now: new Date(),
    performanceCases,
    platform: selectedPlatform(),
    providerCallCount: input.guard.providerCallCount,
  });
  const receipt = evaluateAgentMemoryWorkingStateEvidence({
    baselineManifest: input.baselineManifest,
    baselineManifestSource: input.baselineManifestSource,
    currentCheckoutFingerprintSha256: checkoutAfter.fingerprintSha256,
    currentInputFingerprintSha256: inputsAfter.fingerprintSha256,
    manifest: input.manifest,
    manifestSource: input.manifestSource,
    report,
  });
  return Object.freeze({ receipt, report });
}
