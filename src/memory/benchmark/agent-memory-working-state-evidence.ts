import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import {
  agentMemoryBenchmarkGuardDescriptorV1,
  agentMemoryBenchmarkGuardIdentitySha256,
} from "./agent-memory-benchmark-guard.js";
import type { AgentMemoryCheckoutFingerprintV1 } from "./agent-memory-checkout-fingerprint.js";
import {
  sha256Bytes,
  type AgentMemoryEvidenceManifestV1,
  type AgentMemoryInputFileV1,
} from "./agent-memory-evidence.js";

export const agentMemoryWorkingConfigSha256 = sha256Canonical({
  defaultMode: "off",
  domain: "bornagent.agent-memory-config.v1",
  evaluatedMode: "working",
  projectionVersion: "agent-memory-working-context-v1",
  schemaVersion: 1,
  snapshotVersion: "agent-memory-working-state-v1",
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const safeRelativePathSchema = z.string().min(1).max(512).refine((value) => (
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
), "must be a safe repository-relative POSIX path");

const commandSchema = z.object({
  command: z.string().min(1).max(2_048),
  commandId: identifierSchema,
}).strict();

const guardSchema = z.object({
  descriptor: z.object({
    credentialPolicy: z.literal("deny-known-provider-env-read-v1"),
    guardedCredentialNames: z.array(z.string().min(1)).nonempty(),
    networkPolicy: z.literal("deny-fetch-dns-tcp-udp-v1"),
    providerPolicy: z.literal("no-provider-construction-or-dispatch-v1"),
    schemaVersion: z.literal(1),
  }).strict(),
  identitySha256: sha256Schema,
}).strict();

const workingFaultSchema = z.object({
  expectedResult: z.enum([
    "corrupt",
    "future_head",
    "missing",
    "working_state_busy",
    "working_state_publish_failed",
    "working_state_stale",
  ]),
  faultId: identifierSchema,
  injection: z.enum([
    "append_race",
    "corrupt_pointer",
    "future_head",
    "missing_pointer",
    "pointer_install_crash",
    "same_prefix_divergence",
  ]),
}).strict();

const performanceDefinitionSchema = z.discriminatedUnion("historyClass", [
  z.object({
    caseId: identifierSchema,
    historyClass: z.literal("short"),
    maximumWorkingToBaselineRatio: z.literal(1.1),
    minimumImprovementRatio: z.null(),
    repetitions: z.number().int().min(7).max(31),
    warmupIterations: z.number().int().min(1).max(10),
  }).strict(),
  z.object({
    caseId: identifierSchema,
    historyClass: z.literal("long"),
    maximumWorkingToBaselineRatio: z.null(),
    minimumImprovementRatio: z.literal(0.3),
    repetitions: z.number().int().min(7).max(31),
    warmupIterations: z.number().int().min(1).max(10),
  }).strict(),
]);

const workingManifestSchema = z.object({
  baselineManifest: safeRelativePathSchema,
  characterizationInputs: z.array(safeRelativePathSchema).min(12).max(64),
  commands: z.array(commandSchema).min(3).max(8),
  corpusId: z.literal("agent-memory-synthetic-v1"),
  defaultMode: z.literal("off"),
  equivalenceCaseIds: z.array(identifierSchema).min(36).max(128),
  evaluatedMode: z.literal("working"),
  evidenceId: z.literal("AM-E002-WORKING-STATE"),
  faultMatrixSha256: sha256Schema,
  faults: z.array(workingFaultSchema).length(6),
  guard: guardSchema,
  manifestId: z.literal("agent-memory-working-state-v1"),
  performance: z.array(performanceDefinitionSchema).length(2),
  performanceOracleSha256: sha256Schema,
  privacyPolicy: z.literal("synthetic-fixtures-only-v1"),
  schemaVersion: z.literal(1),
  workPackage: z.literal("AM1"),
}).strict();

export type AgentMemoryWorkingStateManifestV1 = Readonly<
  z.infer<typeof workingManifestSchema>
>;

const inputFileSchema = z.object({
  bytes: z.number().int().nonnegative(),
  path: safeRelativePathSchema,
  sha256: sha256Schema,
}).strict();

const checkoutSchema = z.object({
  fileCount: z.number().int().positive().max(50_000),
  fingerprintSha256: sha256Schema,
  headSha256: z.string().regex(/^[a-f0-9]{40,64}$/u),
  totalBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
}).strict();

const equivalenceCaseSchema = z.object({
  appendSourceEventsApplied: z.number().int().nonnegative(),
  caseId: identifierSchema,
  coldErrorCode: identifierSchema.nullable(),
  coldPlanSha256: sha256Schema.nullable(),
  coldProviderBytesSha256: sha256Schema.nullable(),
  coldStateSha256: sha256Schema,
  eventCount: z.number().int().min(2).max(20_000),
  incrementalErrorCode: identifierSchema.nullable(),
  incrementalPlanSha256: sha256Schema.nullable(),
  incrementalProviderBytesSha256: sha256Schema.nullable(),
  incrementalStateSha256: sha256Schema,
  noOpSourceEventsApplied: z.number().int().nonnegative(),
  prefixEventCount: z.number().int().positive(),
  suffixEventCount: z.number().int().nonnegative(),
}).strict();

export type AgentMemoryWorkingEquivalenceCaseV1 = Readonly<
  z.infer<typeof equivalenceCaseSchema>
>;

const durationSchema = z.number().finite().nonnegative();
const performanceCaseSchema = z.object({
  baselineDurationsMs: z.array(durationSchema).min(7).max(31),
  baselineMedianMs: durationSchema,
  caseId: identifierSchema,
  eventCount: z.number().int().min(2).max(20_000),
  historyClass: z.enum(["long", "short"]),
  improvementRatio: z.number().finite(),
  repetitions: z.number().int().min(7).max(31),
  workingDurationsMs: z.array(durationSchema).min(7).max(31),
  workingMedianMs: durationSchema,
  workingToBaselineRatio: z.number().finite().nonnegative(),
}).strict();

export type AgentMemoryWorkingPerformanceCaseV1 = Readonly<
  z.infer<typeof performanceCaseSchema>
>;

const reportSummarySchema = z.object({
  equivalenceCaseCount: z.number().int().min(36).max(128),
  longHistoryImprovementRatio: z.number().finite(),
  maximumAppendEventsApplied: z.number().int().nonnegative(),
  maximumNoOpEventsApplied: z.number().int().nonnegative(),
  performanceCaseCount: z.literal(2),
  shortHistoryWorkingToBaselineRatio: z.number().finite().nonnegative(),
}).strict();

const workingReportContentSchema = z.object({
  baselineManifestSourceSha256: sha256Schema,
  checkout: checkoutSchema,
  corpusSha256: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  deterministicResultSha256: sha256Schema,
  equivalenceCases: z.array(equivalenceCaseSchema).min(36).max(128),
  evidenceId: z.literal("AM-E002-WORKING-STATE"),
  exactCommand: z.string().min(1).max(2_048),
  faultMatrixSha256: sha256Schema,
  guard: z.object({
    credentialReadAttemptCount: z.number().int().nonnegative(),
    guardIdentitySha256: sha256Schema,
    networkAttemptCount: z.number().int().nonnegative(),
    providerCallCount: z.number().int().nonnegative(),
  }).strict(),
  inputFiles: z.array(inputFileSchema).min(12).max(64),
  inputFingerprintSha256: sha256Schema,
  manifestId: z.literal("agent-memory-working-state-v1"),
  manifestSourceSha256: sha256Schema,
  memoryConfigSha256: sha256Schema,
  nodeVersion: z.string().min(1).max(64),
  performanceCases: z.array(performanceCaseSchema).length(2),
  performanceOracleSha256: sha256Schema,
  platform: z.enum(["linux", "win32"]),
  schemaVersion: z.literal(1),
  summary: reportSummarySchema,
}).strict();

const workingReportSchema = workingReportContentSchema.extend({
  reportSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { reportSha256, ...content } = value;
  if (sha256Canonical(content) !== reportSha256) {
    context.addIssue({ code: "custom", message: "working report hash mismatch" });
  }
});

export type AgentMemoryWorkingStateReportV1 = Readonly<
  z.infer<typeof workingReportSchema>
>;

const workingReceiptContentSchema = z.object({
  checkoutFingerprintSha256: sha256Schema,
  corpusSha256: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  credentialReadAttemptCount: z.literal(0),
  deterministicResultSha256: sha256Schema,
  evidenceId: z.literal("AM-E002-WORKING-STATE"),
  exactCommand: z.string().min(1).max(2_048),
  inputFingerprintSha256: sha256Schema,
  manifestSha256: sha256Schema,
  memoryConfigSha256: sha256Schema,
  networkAttemptCount: z.literal(0),
  nodeVersion: z.string().min(1).max(64),
  platform: z.enum(["linux", "win32"]),
  providerCallCount: z.literal(0),
  reportSha256: sha256Schema,
  schemaVersion: z.literal(1),
  status: z.literal("pass"),
  testCountSemantics: z.literal("required_projection_and_performance_cases"),
  testsFailed: z.literal(0),
  testsPassed: z.number().int().min(38).max(130),
  testsSkipped: z.literal(0),
}).strict();

const workingReceiptSchema = workingReceiptContentSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...content } = value;
  if (sha256Canonical(content) !== receiptSha256) {
    context.addIssue({ code: "custom", message: "working receipt hash mismatch" });
  }
});

export type AgentMemoryWorkingStateReceiptV1 = Readonly<
  z.infer<typeof workingReceiptSchema>
>;

export class AgentMemoryWorkingStateEvidenceError extends Error {
  override readonly name = "AgentMemoryWorkingStateEvidenceError";

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_manifest_duplicate_id",
      `${label} contains duplicate identifiers`,
    );
  }
}

function parseStrict<T>(
  source: string,
  schema: z.ZodType<T>,
  code: string,
  label: string,
): T {
  try {
    return schema.parse(parseStrictJson(source));
  } catch (error) {
    if (error instanceof AgentMemoryWorkingStateEvidenceError) throw error;
    throw new AgentMemoryWorkingStateEvidenceError(
      code,
      `${label} is invalid`,
      { cause: error },
    );
  }
}

export function parseAgentMemoryWorkingStateManifest(
  source: string,
): AgentMemoryWorkingStateManifestV1 {
  const manifest = parseStrict(
    source,
    workingManifestSchema,
    "agent_memory_working_manifest_invalid",
    "working-state evidence manifest",
  );
  unique(manifest.characterizationInputs, "characterizationInputs");
  unique(manifest.commands.map(({ commandId }) => commandId), "commands");
  unique(manifest.equivalenceCaseIds, "equivalenceCaseIds");
  unique(manifest.faults.map(({ faultId }) => faultId), "faults");
  unique(manifest.performance.map(({ caseId }) => caseId), "performance");
  if (
    manifest.faultMatrixSha256 !== sha256Canonical(manifest.faults) ||
    manifest.performanceOracleSha256 !== sha256Canonical(manifest.performance)
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_manifest_root_mismatch",
      "working-state manifest collection root is stale",
    );
  }
  if (
    canonicalJson(manifest.guard.descriptor) !==
      canonicalJson(agentMemoryBenchmarkGuardDescriptorV1) ||
    manifest.guard.identitySha256 !== agentMemoryBenchmarkGuardIdentitySha256
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_manifest_guard_mismatch",
      "working-state manifest does not bind the installed offline guard",
    );
  }
  const commandIds = new Set(manifest.commands.map(({ commandId }) => commandId));
  if (
    !commandIds.has("am1-benchmark") ||
    !commandIds.has("am1-validate") ||
    !commandIds.has("am1-focused-gate")
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_manifest_command_missing",
      "working-state manifest is missing a required exact command",
    );
  }
  return manifest;
}

export function parseAgentMemoryWorkingStateReport(
  source: string,
): AgentMemoryWorkingStateReportV1 {
  try {
    const value = workingReportSchema.parse(parseStrictJson(source));
    return value;
  } catch (error) {
    const hashMismatch = error instanceof z.ZodError && error.issues.some(
      ({ message }) => message === "working report hash mismatch",
    );
    throw new AgentMemoryWorkingStateEvidenceError(
      hashMismatch
        ? "agent_memory_working_report_hash_mismatch"
        : "agent_memory_working_report_invalid",
      "working-state report is invalid",
      { cause: error },
    );
  }
}

export function parseAgentMemoryWorkingStateReceipt(
  source: string,
): AgentMemoryWorkingStateReceiptV1 {
  try {
    const value = workingReceiptSchema.parse(parseStrictJson(source));
    return value;
  } catch (error) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_receipt_invalid",
      "working-state receipt is invalid",
      { cause: error },
    );
  }
}

export async function readAgentMemoryWorkingStateManifest(
  path: string,
): Promise<Readonly<{
  readonly manifest: AgentMemoryWorkingStateManifestV1;
  readonly source: string;
}>> {
  const source = await readFile(path, "utf8");
  return Object.freeze({
    manifest: parseAgentMemoryWorkingStateManifest(source),
    source,
  });
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function median(values: readonly number[]): number {
  const selected = [...values].sort((left, right) => left - right);
  return selected[Math.floor(selected.length / 2)]!;
}

function deterministicResult(
  cases: readonly AgentMemoryWorkingEquivalenceCaseV1[],
  manifest: AgentMemoryWorkingStateManifestV1,
): string {
  return sha256Canonical({
    equivalenceCases: cases,
    faultMatrixSha256: manifest.faultMatrixSha256,
    performanceOracleSha256: manifest.performanceOracleSha256,
    projectionVersion: "agent-memory-working-context-v1",
    snapshotVersion: "agent-memory-working-state-v1",
  });
}

function summary(
  equivalenceCases: readonly AgentMemoryWorkingEquivalenceCaseV1[],
  performanceCases: readonly AgentMemoryWorkingPerformanceCaseV1[],
): z.infer<typeof reportSummarySchema> {
  const long = performanceCases.find(({ historyClass }) => historyClass === "long")!;
  const short = performanceCases.find(({ historyClass }) => historyClass === "short")!;
  return Object.freeze({
    equivalenceCaseCount: equivalenceCases.length,
    longHistoryImprovementRatio: long.improvementRatio,
    maximumAppendEventsApplied: Math.max(
      ...equivalenceCases.map(({ appendSourceEventsApplied }) => appendSourceEventsApplied),
    ),
    maximumNoOpEventsApplied: Math.max(
      ...equivalenceCases.map(({ noOpSourceEventsApplied }) => noOpSourceEventsApplied),
    ),
    performanceCaseCount: 2 as const,
    shortHistoryWorkingToBaselineRatio: short.workingToBaselineRatio,
  });
}

export function createAgentMemoryWorkingStateReport(input: Readonly<{
  readonly baselineManifest: AgentMemoryEvidenceManifestV1;
  readonly baselineManifestSource: string;
  readonly checkout: AgentMemoryCheckoutFingerprintV1;
  readonly credentialReadAttemptCount: number;
  readonly equivalenceCases: readonly AgentMemoryWorkingEquivalenceCaseV1[];
  readonly exactCommand: string;
  readonly inputFiles: readonly AgentMemoryInputFileV1[];
  readonly inputFingerprintSha256: string;
  readonly manifest: AgentMemoryWorkingStateManifestV1;
  readonly manifestSource: string;
  readonly networkAttemptCount: number;
  readonly nodeVersion: string;
  readonly now: Date;
  readonly performanceCases: readonly AgentMemoryWorkingPerformanceCaseV1[];
  readonly platform: "linux" | "win32";
  readonly providerCallCount: number;
}>): AgentMemoryWorkingStateReportV1 {
  if (Number.isNaN(input.now.getTime())) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_report_time_invalid",
      "working-state report time must be valid",
    );
  }
  const body = {
    baselineManifestSourceSha256: sha256Bytes(input.baselineManifestSource),
    checkout: input.checkout,
    corpusSha256: input.baselineManifest.corpusDefinitionSha256,
    createdAt: input.now.toISOString(),
    deterministicResultSha256: deterministicResult(
      input.equivalenceCases,
      input.manifest,
    ),
    equivalenceCases: input.equivalenceCases,
    evidenceId: input.manifest.evidenceId,
    exactCommand: input.exactCommand,
    faultMatrixSha256: input.manifest.faultMatrixSha256,
    guard: {
      credentialReadAttemptCount: input.credentialReadAttemptCount,
      guardIdentitySha256: agentMemoryBenchmarkGuardIdentitySha256,
      networkAttemptCount: input.networkAttemptCount,
      providerCallCount: input.providerCallCount,
    },
    inputFiles: input.inputFiles,
    inputFingerprintSha256: input.inputFingerprintSha256,
    manifestId: input.manifest.manifestId,
    manifestSourceSha256: sha256Bytes(input.manifestSource),
    memoryConfigSha256: agentMemoryWorkingConfigSha256,
    nodeVersion: input.nodeVersion,
    performanceCases: input.performanceCases,
    performanceOracleSha256: input.manifest.performanceOracleSha256,
    platform: input.platform,
    schemaVersion: 1 as const,
    summary: summary(input.equivalenceCases, input.performanceCases),
  };
  return workingReportSchema.parse({
    ...body,
    reportSha256: sha256Canonical(body),
  });
}

function validateEquivalence(
  manifest: AgentMemoryWorkingStateManifestV1,
  baseline: AgentMemoryEvidenceManifestV1,
  report: AgentMemoryWorkingStateReportV1,
): void {
  const baselineById = new Map(baseline.cases.map((value) => [value.caseId, value]));
  if (
    canonicalJson(report.equivalenceCases.map(({ caseId }) => caseId)) !==
      canonicalJson(manifest.equivalenceCaseIds)
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_report_case_set_mismatch",
      "working report does not contain the exact equivalence case set",
    );
  }
  for (const result of report.equivalenceCases) {
    const definition = baselineById.get(result.caseId);
    if (
      definition === undefined ||
      result.eventCount !== definition.expectedEventCount ||
      result.prefixEventCount + result.suffixEventCount !== result.eventCount ||
      result.appendSourceEventsApplied > result.suffixEventCount ||
      result.noOpSourceEventsApplied !== 0 ||
      result.coldStateSha256 !== result.incrementalStateSha256 ||
      result.coldErrorCode !== result.incrementalErrorCode ||
      result.coldPlanSha256 !== result.incrementalPlanSha256 ||
      result.coldProviderBytesSha256 !== result.incrementalProviderBytesSha256
    ) {
      throw new AgentMemoryWorkingStateEvidenceError(
        "agent_memory_working_report_equivalence_failed",
        `working projection diverged for ${result.caseId}`,
      );
    }
    const planned = result.coldErrorCode === null;
    if (
      planned !== (result.coldPlanSha256 !== null) ||
      planned !== (result.coldProviderBytesSha256 !== null)
    ) {
      throw new AgentMemoryWorkingStateEvidenceError(
        "agent_memory_working_report_nullability_mismatch",
        `working projection outcome is incomplete for ${result.caseId}`,
      );
    }
  }
}

function validatePerformance(
  manifest: AgentMemoryWorkingStateManifestV1,
  baseline: AgentMemoryEvidenceManifestV1,
  report: AgentMemoryWorkingStateReportV1,
): void {
  const baselineById = new Map(baseline.cases.map((value) => [value.caseId, value]));
  for (let index = 0; index < manifest.performance.length; index += 1) {
    const definition = manifest.performance[index]!;
    const result = report.performanceCases[index];
    const corpusCase = baselineById.get(definition.caseId);
    if (
      result === undefined ||
      corpusCase === undefined ||
      result.caseId !== definition.caseId ||
      result.eventCount !== corpusCase.expectedEventCount ||
      result.historyClass !== definition.historyClass ||
      result.repetitions !== definition.repetitions ||
      result.baselineDurationsMs.length !== definition.repetitions ||
      result.workingDurationsMs.length !== definition.repetitions ||
      result.baselineMedianMs !== rounded(median(result.baselineDurationsMs)) ||
      result.workingMedianMs !== rounded(median(result.workingDurationsMs)) ||
      result.workingToBaselineRatio !== rounded(
        result.workingMedianMs / result.baselineMedianMs,
      ) ||
      result.improvementRatio !== rounded(1 - result.workingToBaselineRatio)
    ) {
      throw new AgentMemoryWorkingStateEvidenceError(
        "agent_memory_working_report_performance_invalid",
        `working performance evidence is malformed for ${definition.caseId}`,
      );
    }
    if (
      (definition.maximumWorkingToBaselineRatio !== null &&
        result.workingToBaselineRatio > definition.maximumWorkingToBaselineRatio) ||
      (definition.minimumImprovementRatio !== null &&
        result.improvementRatio < definition.minimumImprovementRatio)
    ) {
      throw new AgentMemoryWorkingStateEvidenceError(
        "agent_memory_working_report_performance_failed",
        `working performance threshold failed for ${definition.caseId}`,
      );
    }
  }
}

export function evaluateAgentMemoryWorkingStateEvidence(input: Readonly<{
  readonly baselineManifest: AgentMemoryEvidenceManifestV1;
  readonly baselineManifestSource: string;
  readonly currentCheckoutFingerprintSha256: string;
  readonly currentInputFingerprintSha256: string;
  readonly manifest: AgentMemoryWorkingStateManifestV1;
  readonly manifestSource: string;
  readonly report: AgentMemoryWorkingStateReportV1;
}>): AgentMemoryWorkingStateReceiptV1 {
  const { report } = input;
  if (
    report.checkout.fingerprintSha256 !== input.currentCheckoutFingerprintSha256 ||
    report.inputFingerprintSha256 !== input.currentInputFingerprintSha256 ||
    report.manifestSourceSha256 !== sha256Bytes(input.manifestSource) ||
    report.baselineManifestSourceSha256 !== sha256Bytes(input.baselineManifestSource) ||
    report.corpusSha256 !== input.baselineManifest.corpusDefinitionSha256 ||
    report.memoryConfigSha256 !== agentMemoryWorkingConfigSha256 ||
    report.faultMatrixSha256 !== input.manifest.faultMatrixSha256 ||
    report.performanceOracleSha256 !== input.manifest.performanceOracleSha256 ||
    report.exactCommand !== input.manifest.commands.find(
      ({ commandId }) => commandId === "am1-benchmark",
    )?.command
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_report_binding_mismatch",
      "working report does not bind the current checkout, inputs, and manifests",
    );
  }
  if (
    report.guard.guardIdentitySha256 !== agentMemoryBenchmarkGuardIdentitySha256 ||
    report.guard.networkAttemptCount !== 0 ||
    report.guard.credentialReadAttemptCount !== 0 ||
    report.guard.providerCallCount !== 0
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_report_guard_failed",
      "working benchmark observed a forbidden network, credential, or provider attempt",
    );
  }
  validateEquivalence(input.manifest, input.baselineManifest, report);
  validatePerformance(input.manifest, input.baselineManifest, report);
  if (
    report.deterministicResultSha256 !== deterministicResult(
      report.equivalenceCases,
      input.manifest,
    ) ||
    canonicalJson(report.summary) !== canonicalJson(
      summary(report.equivalenceCases, report.performanceCases),
    )
  ) {
    throw new AgentMemoryWorkingStateEvidenceError(
      "agent_memory_working_report_summary_mismatch",
      "working report deterministic result or summary is stale",
    );
  }
  const body = {
    checkoutFingerprintSha256: report.checkout.fingerprintSha256,
    corpusSha256: report.corpusSha256,
    createdAt: report.createdAt,
    credentialReadAttemptCount: 0 as const,
    deterministicResultSha256: report.deterministicResultSha256,
    evidenceId: report.evidenceId,
    exactCommand: report.exactCommand,
    inputFingerprintSha256: report.inputFingerprintSha256,
    manifestSha256: sha256Bytes(input.manifestSource),
    memoryConfigSha256: report.memoryConfigSha256,
    networkAttemptCount: 0 as const,
    nodeVersion: report.nodeVersion,
    platform: report.platform,
    providerCallCount: 0 as const,
    reportSha256: report.reportSha256,
    schemaVersion: 1 as const,
    status: "pass" as const,
    testCountSemantics: "required_projection_and_performance_cases" as const,
    testsFailed: 0 as const,
    testsPassed: report.equivalenceCases.length + report.performanceCases.length,
    testsSkipped: 0 as const,
  };
  return workingReceiptSchema.parse({
    ...body,
    receiptSha256: sha256Canonical(body),
  });
}

async function writeCanonicalNoReplace(
  directory: string,
  filename: string,
  value: unknown,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  const source = `${canonicalJson(value)}\n`;
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== source) {
      throw new AgentMemoryWorkingStateEvidenceError(
        "agent_memory_working_evidence_path_conflict",
        `${filename} already exists with different bytes`,
      );
    }
  }
  return path;
}

export async function writeAgentMemoryWorkingStateReport(
  directory: string,
  report: AgentMemoryWorkingStateReportV1,
): Promise<string> {
  return writeCanonicalNoReplace(
    directory,
    `agent-memory-working-state-${report.reportSha256}.json`,
    report,
  );
}

export async function writeAgentMemoryWorkingStateReceipt(
  directory: string,
  receipt: AgentMemoryWorkingStateReceiptV1,
): Promise<string> {
  return writeCanonicalNoReplace(
    directory,
    `agent-memory-working-state-receipt-${receipt.receiptSha256}.json`,
    receipt,
  );
}
