import { performance } from "node:perf_hooks";

import { AgentContextRuntime } from "../../context/agent-context-runtime.js";
import { ContextCompactionError } from "../../context/deterministic-compactor.js";
import {
  DeterministicTokenEstimator,
  resolveContextBudget,
} from "../../context/token-estimator.js";
import type { AgentMemoryBenchmarkGuard } from "./agent-memory-benchmark-guard.js";
import { captureAgentMemoryCheckoutFingerprint } from "./agent-memory-checkout-fingerprint.js";
import { generateAgentMemoryCorpusCase } from "./agent-memory-corpus.js";
import {
  AgentMemoryEvidenceError,
  captureAgentMemoryInputFingerprint,
  createAgentMemoryBaselineReport,
  evaluateAgentMemoryEvidence,
  type AgentMemoryBaselineCaseReportV1,
  type AgentMemoryBaselineReportV1,
  type AgentMemoryEvidenceManifestV1,
  type AgentMemoryEvidenceReceiptV1,
} from "./agent-memory-evidence.js";

export interface AgentMemoryBaselineRunResultV1 {
  readonly receipt: AgentMemoryEvidenceReceiptV1;
  readonly report: AgentMemoryBaselineReportV1;
}

function platform(): "linux" | "win32" {
  if (process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  throw new AgentMemoryEvidenceError(
    "agent_memory_platform_unsupported",
    `AM0 supports linux and win32, not ${process.platform}`,
  );
}

function duration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function runtime(manifest: AgentMemoryEvidenceManifestV1): AgentContextRuntime {
  const estimator = new DeterministicTokenEstimator({
    bytesPerToken: manifest.budget.bytesPerToken,
    itemOverheadTokens: manifest.budget.itemOverheadTokens,
    model: "agent-memory-am0-synthetic",
    provider: "offline-fixture",
    tokenizer: "utf8-deterministic-upper-bound",
    version: "agent-memory-am0-v1",
  });
  const budget = resolveContextBudget(
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
  );
  return new AgentContextRuntime({
    budget,
    estimator,
    systemInstructions:
      "AM0 synthetic characterization. Do not call providers, tools, credentials, or networks.",
  });
}

function successfulCase(
  definition: AgentMemoryEvidenceManifestV1["cases"][number],
  generated: ReturnType<typeof generateAgentMemoryCorpusCase>,
  planning: ReturnType<AgentContextRuntime["plan"]>,
  elapsed: number,
): AgentMemoryBaselineCaseReportV1 {
  return Object.freeze({
    archivedItemCount: planning.plan.archivedItemIds.length,
    canonicalContextSha256: planning.plan.canonicalContextSha256,
    caseDefinitionSha256: generated.caseDefinitionSha256,
    caseId: definition.caseId,
    durationMs: elapsed,
    errorCode: null,
    eventCount: generated.events.length,
    fullEstimatedInputTokens: planning.fullEstimatedInputTokens,
    includedItemCount: planning.plan.includedItemIds.length,
    outcome: "planned",
    plannedInputTokens: planning.plan.estimatedInputTokens,
    projectedItemCount: planning.state.items.length,
    protectedEstimatedTokens: planning.plan.protectedEstimatedTokens,
    sourceEventBytesRead: generated.eventBytes,
    sourceEventsApplied: generated.events.length,
  });
}

function failedCase(
  definition: AgentMemoryEvidenceManifestV1["cases"][number],
  generated: ReturnType<typeof generateAgentMemoryCorpusCase>,
  projection: ReturnType<AgentContextRuntime["project"]>,
  error: ContextCompactionError,
  elapsed: number,
): AgentMemoryBaselineCaseReportV1 {
  if (
    error.code !== "context_protected_overflow" &&
    error.code !== "context_unsafe_compaction"
  ) {
    throw error;
  }
  return Object.freeze({
    archivedItemCount: null,
    canonicalContextSha256: null,
    caseDefinitionSha256: generated.caseDefinitionSha256,
    caseId: definition.caseId,
    durationMs: elapsed,
    errorCode: error.code,
    eventCount: generated.events.length,
    fullEstimatedInputTokens: projection.fullEstimatedInputTokens,
    includedItemCount: null,
    outcome: error.code,
    plannedInputTokens: null,
    projectedItemCount: projection.state.items.length,
    protectedEstimatedTokens: error.details.estimatedTokens,
    sourceEventBytesRead: generated.eventBytes,
    sourceEventsApplied: generated.events.length,
  });
}

function runCase(
  selectedRuntime: AgentContextRuntime,
  definition: AgentMemoryEvidenceManifestV1["cases"][number],
): AgentMemoryBaselineCaseReportV1 {
  const generated = generateAgentMemoryCorpusCase(definition);
  const startedAt = performance.now();
  const projection = selectedRuntime.project({
    artifactRefsByEventId: generated.artifactRefsByEventId,
    epoch: 0,
    events: generated.events,
  });
  try {
    const planning = selectedRuntime.planProjected(projection);
    return successfulCase(
      definition,
      generated,
      planning,
      duration(startedAt),
    );
  } catch (error) {
    if (error instanceof ContextCompactionError) {
      return failedCase(
        definition,
        generated,
        projection,
        error,
        duration(startedAt),
      );
    }
    throw error;
  }
}

export async function runAgentMemoryBaseline(input: Readonly<{
  readonly guard: AgentMemoryBenchmarkGuard;
  readonly manifest: AgentMemoryEvidenceManifestV1;
  readonly manifestSource: string;
  readonly workspaceRoot: string;
}>): Promise<AgentMemoryBaselineRunResultV1> {
  const [before, checkoutBefore] = await Promise.all([
    captureAgentMemoryInputFingerprint(input.workspaceRoot, input.manifest),
    captureAgentMemoryCheckoutFingerprint(input.workspaceRoot),
  ]);
  const selectedRuntime = runtime(input.manifest);
  const cases = Object.freeze(
    input.manifest.cases.map((definition) =>
      runCase(selectedRuntime, definition),
    ),
  );
  input.guard.assertClean();
  const [after, checkoutAfter] = await Promise.all([
    captureAgentMemoryInputFingerprint(input.workspaceRoot, input.manifest),
    captureAgentMemoryCheckoutFingerprint(input.workspaceRoot),
  ]);
  if (
    before.fingerprintSha256 !== after.fingerprintSha256 ||
    checkoutBefore.fingerprintSha256 !== checkoutAfter.fingerprintSha256
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_inputs_changed",
      "characterization inputs changed while the baseline was running",
    );
  }
  const report = createAgentMemoryBaselineReport({
    cases,
    checkout: checkoutAfter,
    credentialReadAttemptCount: input.guard.credentialReadAttemptCount,
    exactCommand: input.manifest.commands.find(
      ({ commandId }) => commandId === "am0-baseline",
    )!.command,
    inputFiles: after.files,
    inputFingerprintSha256: after.fingerprintSha256,
    manifest: input.manifest,
    manifestSource: input.manifestSource,
    networkAttemptCount: input.guard.networkAttemptCount,
    nodeVersion: process.version,
    now: new Date(),
    platform: platform(),
    providerCallCount: input.guard.providerCallCount,
  });
  const receipt = evaluateAgentMemoryEvidence({
    currentCheckoutFingerprintSha256: checkoutAfter.fingerprintSha256,
    currentInputFingerprintSha256: after.fingerprintSha256,
    manifest: input.manifest,
    manifestSource: input.manifestSource,
    report,
  });
  return Object.freeze({ receipt, report });
}
