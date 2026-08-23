import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import {
  agentMemoryBenchmarkGuardDescriptorV1,
  agentMemoryBenchmarkGuardIdentitySha256,
} from "./agent-memory-benchmark-guard.js";
import {
  agentMemoryCorpusScenarios,
  agentMemoryExpectedOutcomes,
  expectedAgentMemoryEventCount,
} from "./agent-memory-corpus.js";

export const agentMemoryOffConfigSha256 = sha256Canonical({
  domain: "bornagent.agent-memory-config.v1",
  mode: "off",
  schemaVersion: 1,
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const safeRelativePathSchema = z.string().min(1).max(512).refine((value) => (
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
), "must be a safe repository-relative POSIX path");

const caseSchema = z.object({
  caseId: identifierSchema,
  expectedEventCount: z.number().int().min(2).max(20_000),
  expectedOutcome: z.enum(agentMemoryExpectedOutcomes),
  groups: z.number().int().min(1).max(10_000),
  payloadBytes: z.number().int().min(16).max(16_384),
  scenario: z.enum(agentMemoryCorpusScenarios),
}).strict().superRefine((value, context) => {
  if (value.expectedEventCount !== expectedAgentMemoryEventCount(value)) {
    context.addIssue({
      code: "custom",
      message: "expectedEventCount does not match the generator contract",
    });
  }
});

const querySchema = z.object({
  expectedEvidenceCaseIds: z.array(identifierSchema).max(16),
  memoryKind: z.enum(["episodic", "procedural", "semantic"]),
  mustAbstain: z.boolean(),
  queryId: identifierSchema,
  scopeCaseId: identifierSchema,
  text: z.string().min(1).max(512),
}).strict();

const scopeSchema = z.object({
  branch: z.string().min(1).max(128).nullable(),
  candidateBranch: z.string().min(1).max(128).nullable(),
  candidateRepositorySha256: sha256Schema,
  candidateUserId: identifierSchema,
  candidateWorkspaceId: identifierSchema,
  decision: z.enum(["allow", "deny"]),
  reason: z.enum([
    "branch_mismatch",
    "exact_scope_match",
    "repository_mismatch",
    "user_mismatch",
    "workspace_mismatch",
  ]),
  repositorySha256: sha256Schema,
  scopeCaseId: identifierSchema,
  userId: identifierSchema,
  workspaceId: identifierSchema,
}).strict();

const faultSchema = z.object({
  expectedCode: identifierSchema,
  faultId: identifierSchema,
  injection: z.enum([
    "concurrent_append",
    "credential_read",
    "duplicate_json_key",
    "invalid_utf8",
    "large_artifact",
    "network_attempt",
    "protected_overflow",
    "sequence_gap",
    "unknown_event",
    "windows_path_alias",
  ]),
  providerCallCount: z.literal(0),
}).strict();

const budgetSchema = z.object({
  bytesPerToken: z.number().int().min(1).max(16),
  compactionThreshold: z.number().min(0.5).max(0.95),
  contextWindowTokens: z.number().int().min(8_192).max(1_048_576),
  fixedSafetyMarginTokens: z.number().int().min(0).max(32_768),
  itemOverheadTokens: z.number().int().min(0).max(1_024),
  reservedOutputTokens: z.number().int().min(512).max(32_768),
}).strict();

const metricNames = Object.freeze([
  "archived_item_count",
  "canonical_context_sha256",
  "duration_ms",
  "full_estimated_input_tokens",
  "included_item_count",
  "projected_item_count",
  "protected_estimated_tokens",
  "source_event_bytes_read",
  "source_events_applied",
] as const);

const metricsSchema = z.object({
  required: z.array(z.enum(metricNames)).length(metricNames.length),
  unavailableValue: z.literal("null"),
  wallClockIsDiagnosticOnly: z.literal(true),
}).strict();

const commandSchema = z.object({
  command: z.string().min(1).max(1_024),
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

const agentMemoryEvidenceManifestSchema = z.object({
  budget: budgetSchema,
  cases: z.array(caseSchema).min(36).max(128),
  characterizationInputs: z.array(safeRelativePathSchema).min(6).max(64),
  commands: z.array(commandSchema).min(2).max(8),
  corpusDefinitionSha256: sha256Schema,
  corpusId: z.literal("agent-memory-synthetic-v1"),
  defaultMode: z.literal("off"),
  evidenceId: z.literal("AM-E001-CONTRACT-BASELINE"),
  faults: z.array(faultSchema).min(10).max(32),
  faultMatrixSha256: sha256Schema,
  generatorVersion: z.literal(1),
  guard: guardSchema,
  manifestId: z.literal("agent-memory-v1"),
  metrics: metricsSchema,
  privacyPolicy: z.literal("synthetic-fixtures-only-v1"),
  queries: z.array(querySchema).min(10).max(64),
  queryOracleSha256: sha256Schema,
  schemaVersion: z.literal(1),
  scopes: z.array(scopeSchema).min(6).max(32),
  scopeOracleSha256: sha256Schema,
  workPackage: z.literal("AM0"),
}).strict();

export type AgentMemoryEvidenceManifestV1 = z.infer<
  typeof agentMemoryEvidenceManifestSchema
>;

const nullableNonnegativeInteger = z.number().int().nonnegative().nullable();
const nullableSha256 = sha256Schema.nullable();

const caseReportSchema = z.object({
  archivedItemCount: nullableNonnegativeInteger,
  canonicalContextSha256: nullableSha256,
  caseDefinitionSha256: sha256Schema,
  caseId: identifierSchema,
  durationMs: z.number().nonnegative().nullable(),
  errorCode: z.enum([
    "context_protected_overflow",
    "context_unsafe_compaction",
  ]).nullable(),
  eventCount: z.number().int().min(1).max(20_000),
  fullEstimatedInputTokens: nullableNonnegativeInteger,
  includedItemCount: nullableNonnegativeInteger,
  outcome: z.enum(agentMemoryExpectedOutcomes),
  plannedInputTokens: nullableNonnegativeInteger,
  projectedItemCount: nullableNonnegativeInteger,
  protectedEstimatedTokens: nullableNonnegativeInteger,
  sourceEventBytesRead: z.number().int().nonnegative(),
  sourceEventsApplied: z.number().int().nonnegative(),
}).strict();

const inputFileSchema = z.object({
  bytes: z.number().int().nonnegative(),
  path: safeRelativePathSchema,
  sha256: sha256Schema,
}).strict();

export type AgentMemoryInputFileV1 = Readonly<
  z.infer<typeof inputFileSchema>
>;

const checkoutSchema = z.object({
  fileCount: z.number().int().positive().max(50_000),
  fingerprintSha256: sha256Schema,
  headSha256: z.string().regex(/^[a-f0-9]{40,64}$/u),
  totalBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
}).strict();

const reportSummarySchema = z.object({
  caseCount: z.number().int().min(36),
  contextProtectedOverflowCount: z.number().int().nonnegative(),
  contextUnsafeCompactionCount: z.number().int().nonnegative(),
  maxEventCount: z.number().int().min(10_000),
  plannedCount: z.number().int().nonnegative(),
  totalEventCount: z.number().int().positive(),
}).strict();

const agentMemoryBaselineReportSchema = z.object({
  cases: z.array(caseReportSchema).min(36).max(128),
  checkout: checkoutSchema,
  corpusDefinitionSha256: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  deterministicResultSha256: sha256Schema,
  evidenceId: z.literal("AM-E001-CONTRACT-BASELINE"),
  exactCommand: z.string().min(1).max(2_048),
  faultMatrixSha256: sha256Schema,
  guard: z.object({
    credentialReadAttemptCount: z.number().int().nonnegative(),
    guardIdentitySha256: sha256Schema,
    networkAttemptCount: z.number().int().nonnegative(),
    providerCallCount: z.number().int().nonnegative(),
  }).strict(),
  inputFiles: z.array(inputFileSchema).min(6).max(64),
  inputFingerprintSha256: sha256Schema,
  manifestId: z.literal("agent-memory-v1"),
  manifestSourceSha256: sha256Schema,
  memoryConfigSha256: sha256Schema,
  nodeVersion: z.string().min(1).max(64),
  platform: z.enum(["linux", "win32"]),
  queryOracleSha256: sha256Schema,
  reportSha256: sha256Schema,
  schemaVersion: z.literal(1),
  scopeOracleSha256: sha256Schema,
  summary: reportSummarySchema,
}).strict();

export type AgentMemoryBaselineReportV1 = z.infer<
  typeof agentMemoryBaselineReportSchema
>;
export type AgentMemoryBaselineCaseReportV1 = z.infer<typeof caseReportSchema>;

const agentMemoryEvidenceReceiptSchema = z.object({
  checkoutFingerprintSha256: sha256Schema,
  corpusSha256: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  deterministicResultSha256: sha256Schema,
  evidenceId: z.literal("AM-E001-CONTRACT-BASELINE"),
  exactCommand: z.string().min(1).max(2_048),
  inputFingerprintSha256: sha256Schema,
  manifestSha256: sha256Schema,
  memoryConfigSha256: sha256Schema,
  nodeVersion: z.string().min(1).max(64),
  platform: z.enum(["linux", "win32"]),
  receiptSha256: sha256Schema,
  reportSha256: sha256Schema,
  schemaVersion: z.literal(1),
  status: z.literal("pass"),
  testCountSemantics: z.literal("required_characterization_cases"),
  testsFailed: z.literal(0),
  testsPassed: z.number().int().min(36).max(128),
  testsSkipped: z.literal(0),
}).strict();

export type AgentMemoryEvidenceReceiptV1 = z.infer<
  typeof agentMemoryEvidenceReceiptSchema
>;

export class AgentMemoryEvidenceError extends Error {
  override readonly name = "AgentMemoryEvidenceError";

  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_duplicate_id",
      `${label} contains duplicate identifiers`,
    );
  }
}

function verifyScopeOracle(manifest: AgentMemoryEvidenceManifestV1): void {
  for (const scope of manifest.scopes) {
    const exact =
      scope.branch === scope.candidateBranch &&
      scope.repositorySha256 === scope.candidateRepositorySha256 &&
      scope.userId === scope.candidateUserId &&
      scope.workspaceId === scope.candidateWorkspaceId;
    const reasonMatches =
      (scope.reason === "exact_scope_match" && exact) ||
      (scope.reason === "branch_mismatch" &&
        scope.branch !== scope.candidateBranch) ||
      (scope.reason === "repository_mismatch" &&
        scope.repositorySha256 !== scope.candidateRepositorySha256) ||
      (scope.reason === "user_mismatch" &&
        scope.userId !== scope.candidateUserId) ||
      (scope.reason === "workspace_mismatch" &&
        scope.workspaceId !== scope.candidateWorkspaceId);
    if (!reasonMatches || scope.decision !== (exact ? "allow" : "deny")) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_scope_oracle_invalid",
        `scope oracle ${scope.scopeCaseId} contradicts its typed identities`,
      );
    }
  }
}

function verifyFaultMatrix(manifest: AgentMemoryEvidenceManifestV1): void {
  const required = [
    "concurrent_append",
    "credential_read",
    "duplicate_json_key",
    "invalid_utf8",
    "large_artifact",
    "network_attempt",
    "protected_overflow",
    "sequence_gap",
    "unknown_event",
    "windows_path_alias",
  ];
  const actual = manifest.faults
    .map(({ injection }) => injection)
    .sort((left, right) => left.localeCompare(right));
  if (canonicalJson(actual) !== canonicalJson(required)) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_fault_matrix_invalid",
      "fault matrix must contain each AM0 fault injection exactly once",
    );
  }
}

function verifyManifest(manifest: AgentMemoryEvidenceManifestV1): void {
  unique(manifest.cases.map(({ caseId }) => caseId), "cases");
  unique(manifest.queries.map(({ queryId }) => queryId), "queries");
  unique(manifest.scopes.map(({ scopeCaseId }) => scopeCaseId), "scopes");
  unique(manifest.faults.map(({ faultId }) => faultId), "faults");
  unique(manifest.commands.map(({ commandId }) => commandId), "commands");
  unique(manifest.characterizationInputs, "characterizationInputs");
  unique(manifest.faults.map(({ injection }) => injection), "fault injections");
  verifyScopeOracle(manifest);
  verifyFaultMatrix(manifest);
  const caseIds = new Set(manifest.cases.map(({ caseId }) => caseId));
  const scopeIds = new Set(manifest.scopes.map(({ scopeCaseId }) => scopeCaseId));
  for (const query of manifest.queries) {
    if (!scopeIds.has(query.scopeCaseId)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_query_scope_missing",
        `query ${query.queryId} names an unknown scope case`,
      );
    }
    if (query.expectedEvidenceCaseIds.some((caseId) => !caseIds.has(caseId))) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_query_evidence_missing",
        `query ${query.queryId} names an unknown evidence case`,
      );
    }
    if (query.mustAbstain !== (query.expectedEvidenceCaseIds.length === 0)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_query_abstention_invalid",
        `query ${query.queryId} has an inconsistent abstention oracle`,
      );
    }
  }
  if (!manifest.cases.some(({ expectedEventCount }) => expectedEventCount >= 10_000)) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_long_history_missing",
      "the corpus must contain a 10k-event characterization case",
    );
  }
  for (const scenario of agentMemoryCorpusScenarios) {
    if (!manifest.cases.some((definition) => definition.scenario === scenario)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_scenario_missing",
        `the corpus does not characterize ${scenario}`,
      );
    }
  }
  for (const outcome of agentMemoryExpectedOutcomes) {
    if (!manifest.cases.some(({ expectedOutcome }) => expectedOutcome === outcome)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_outcome_missing",
        `the corpus does not characterize ${outcome}`,
      );
    }
  }
  for (const commandId of ["am0-baseline", "am0-focused-gate", "am0-validate"]) {
    if (!manifest.commands.some((command) => command.commandId === commandId)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_manifest_command_missing",
        `the manifest is missing ${commandId}`,
      );
    }
  }
  const expectedMetrics = [...metricNames];
  if (canonicalJson(manifest.metrics.required) !== canonicalJson(expectedMetrics)) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_metrics_invalid",
      "required metrics must match the AM0 metric contract",
    );
  }
  if (
    manifest.corpusDefinitionSha256 !== sha256Canonical(manifest.cases) ||
    manifest.queryOracleSha256 !== sha256Canonical(manifest.queries) ||
    manifest.scopeOracleSha256 !== sha256Canonical(manifest.scopes) ||
    manifest.faultMatrixSha256 !== sha256Canonical(manifest.faults)
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_root_mismatch",
      "a manifest collection root does not match its canonical entries",
    );
  }
  if (
    canonicalJson(manifest.guard.descriptor) !==
      canonicalJson(agentMemoryBenchmarkGuardDescriptorV1) ||
    manifest.guard.identitySha256 !== agentMemoryBenchmarkGuardIdentitySha256
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_guard_mismatch",
      "the manifest does not bind the compiled AM0 guard",
    );
  }
}

export function parseAgentMemoryEvidenceManifest(
  source: string,
): AgentMemoryEvidenceManifestV1 {
  try {
    const manifest = agentMemoryEvidenceManifestSchema.parse(
      parseStrictJson(source),
    );
    verifyManifest(manifest);
    return Object.freeze(manifest);
  } catch (error) {
    if (error instanceof AgentMemoryEvidenceError) throw error;
    throw new AgentMemoryEvidenceError(
      "agent_memory_manifest_invalid",
      "agent memory evidence manifest is invalid",
      { cause: error },
    );
  }
}

export async function readAgentMemoryEvidenceManifest(path: string): Promise<{
  readonly manifest: AgentMemoryEvidenceManifestV1;
  readonly source: string;
}> {
  const source = await readFile(path, "utf8");
  return Object.freeze({
    manifest: parseAgentMemoryEvidenceManifest(source),
    source,
  });
}

function verifyReportSelfHash(report: AgentMemoryBaselineReportV1): void {
  const { reportSha256, ...body } = report;
  if (reportSha256 !== sha256Canonical(body)) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_hash_mismatch",
      "baseline report self-hash mismatch",
    );
  }
}

export function parseAgentMemoryBaselineReport(
  source: string,
): AgentMemoryBaselineReportV1 {
  try {
    const report = agentMemoryBaselineReportSchema.parse(parseStrictJson(source));
    verifyReportSelfHash(report);
    return Object.freeze(report);
  } catch (error) {
    if (error instanceof AgentMemoryEvidenceError) throw error;
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_invalid",
      "agent memory baseline report is invalid",
      { cause: error },
    );
  }
}

export function parseAgentMemoryEvidenceReceipt(
  source: string,
): AgentMemoryEvidenceReceiptV1 {
  try {
    const receipt = agentMemoryEvidenceReceiptSchema.parse(
      parseStrictJson(source),
    );
    const { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== sha256Canonical(body)) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_receipt_hash_mismatch",
        "agent memory receipt self-hash mismatch",
      );
    }
    return Object.freeze(receipt);
  } catch (error) {
    if (error instanceof AgentMemoryEvidenceError) throw error;
    throw new AgentMemoryEvidenceError(
      "agent_memory_receipt_invalid",
      "agent memory evidence receipt is invalid",
      { cause: error },
    );
  }
}

export async function captureAgentMemoryInputFingerprint(
  workspaceRoot: string,
  manifest: Readonly<{
    readonly characterizationInputs: readonly string[];
  }>,
): Promise<{
  readonly files: readonly AgentMemoryInputFileV1[];
  readonly fingerprintSha256: string;
}> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const files = [];
  for (const relativePath of manifest.characterizationInputs) {
    const lexicalPath = resolve(workspaceRoot, ...relativePath.split("/"));
    const lexicalMetadata = await lstat(lexicalPath);
    if (!lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink()) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_input_path_unsafe",
        `${relativePath} is not a regular characterization input`,
      );
    }
    const canonicalPath = await realpath(lexicalPath);
    const difference = relative(canonicalRoot, canonicalPath);
    if (
      difference === "" ||
      difference === ".." ||
      difference.startsWith(`..${sep}`) ||
      isAbsolute(difference)
    ) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_input_path_unsafe",
        `${relativePath} resolves outside the characterization workspace`,
      );
    }
    const bytes = await readFile(canonicalPath);
    files.push(Object.freeze({
      bytes: bytes.byteLength,
      path: relativePath,
      sha256: sha256Bytes(bytes),
    }));
  }
  return Object.freeze({
    files: Object.freeze(files),
    fingerprintSha256: sha256Canonical(files),
  });
}

function deterministicCases(
  cases: readonly AgentMemoryBaselineCaseReportV1[],
): readonly unknown[] {
  return cases.map((value) => Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "durationMs"),
  ));
}

function summarize(
  cases: readonly AgentMemoryBaselineCaseReportV1[],
): z.infer<typeof reportSummarySchema> {
  return Object.freeze({
    caseCount: cases.length,
    contextProtectedOverflowCount: cases.filter(
      ({ outcome }) => outcome === "context_protected_overflow",
    ).length,
    contextUnsafeCompactionCount: cases.filter(
      ({ outcome }) => outcome === "context_unsafe_compaction",
    ).length,
    maxEventCount: Math.max(...cases.map(({ eventCount }) => eventCount)),
    plannedCount: cases.filter(({ outcome }) => outcome === "planned").length,
    totalEventCount: cases.reduce(
      (total, { eventCount }) => total + eventCount,
      0,
    ),
  });
}

export function createAgentMemoryBaselineReport(input: Readonly<{
  readonly cases: readonly AgentMemoryBaselineCaseReportV1[];
  readonly checkout: z.infer<typeof checkoutSchema>;
  readonly credentialReadAttemptCount: number;
  readonly exactCommand: string;
  readonly inputFiles: readonly z.infer<typeof inputFileSchema>[];
  readonly inputFingerprintSha256: string;
  readonly manifest: AgentMemoryEvidenceManifestV1;
  readonly manifestSource: string;
  readonly networkAttemptCount: number;
  readonly nodeVersion: string;
  readonly now: Date;
  readonly platform: "linux" | "win32";
  readonly providerCallCount: number;
}>): AgentMemoryBaselineReportV1 {
  if (Number.isNaN(input.now.getTime())) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_time_invalid",
      "baseline report creation time must be a valid instant",
    );
  }
  const deterministicResultSha256 = sha256Canonical({
    cases: deterministicCases(input.cases),
    corpusDefinitionSha256: input.manifest.corpusDefinitionSha256,
    faultMatrixSha256: input.manifest.faultMatrixSha256,
    queryOracleSha256: input.manifest.queryOracleSha256,
    scopeOracleSha256: input.manifest.scopeOracleSha256,
  });
  const body = {
    cases: input.cases,
    checkout: input.checkout,
    corpusDefinitionSha256: input.manifest.corpusDefinitionSha256,
    createdAt: input.now.toISOString(),
    deterministicResultSha256,
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
    memoryConfigSha256: agentMemoryOffConfigSha256,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    queryOracleSha256: input.manifest.queryOracleSha256,
    schemaVersion: 1,
    scopeOracleSha256: input.manifest.scopeOracleSha256,
    summary: summarize(input.cases),
  } as const;
  return agentMemoryBaselineReportSchema.parse({
    ...body,
    reportSha256: sha256Canonical(body),
  });
}

function verifyCases(
  manifest: AgentMemoryEvidenceManifestV1,
  report: AgentMemoryBaselineReportV1,
): void {
  if (report.cases.length !== manifest.cases.length) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_case_set_mismatch",
      "baseline report does not contain the exact manifest case set",
    );
  }
  const mismatches: string[] = [];
  for (let index = 0; index < manifest.cases.length; index += 1) {
    const expected = manifest.cases[index]!;
    const actual = report.cases[index]!;
    if (
      actual.caseId !== expected.caseId ||
      actual.caseDefinitionSha256 !== sha256Canonical(expected) ||
      actual.eventCount !== expected.expectedEventCount ||
      actual.sourceEventsApplied !== expected.expectedEventCount ||
      actual.outcome !== expected.expectedOutcome ||
      actual.errorCode !==
        (expected.expectedOutcome === "planned" ? null : expected.expectedOutcome)
    ) {
      mismatches.push(
        `${expected.caseId}:expected=${expected.expectedOutcome},observed=${actual.outcome}`,
      );
      continue;
    }
    const planned = actual.outcome === "planned";
    const alwaysAvailable = [
      actual.fullEstimatedInputTokens,
      actual.projectedItemCount,
      actual.protectedEstimatedTokens,
    ];
    const planOnlyValues = [
      actual.archivedItemCount,
      actual.canonicalContextSha256,
      actual.includedItemCount,
      actual.plannedInputTokens,
    ];
    if (
      alwaysAvailable.some((value) => value === null) ||
      (planned
        ? planOnlyValues.some((value) => value === null)
        : planOnlyValues.some((value) => value !== null))
    ) {
      throw new AgentMemoryEvidenceError(
        "agent_memory_report_nullability_mismatch",
        `baseline report case ${expected.caseId} misrepresents unavailable metrics`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_case_mismatch",
      `baseline report cases do not match their oracles (${mismatches.join("; ")})`,
    );
  }
}

export function evaluateAgentMemoryEvidence(input: Readonly<{
  readonly currentCheckoutFingerprintSha256: string;
  readonly currentInputFingerprintSha256: string;
  readonly manifest: AgentMemoryEvidenceManifestV1;
  readonly manifestSource: string;
  readonly report: AgentMemoryBaselineReportV1;
}>): AgentMemoryEvidenceReceiptV1 {
  verifyManifest(input.manifest);
  const report = input.report;
  verifyReportSelfHash(report);
  const baselineCommand = input.manifest.commands.find(
    ({ commandId }) => commandId === "am0-baseline",
  )?.command;
  if (
    report.manifestSourceSha256 !== sha256Bytes(input.manifestSource) ||
    report.corpusDefinitionSha256 !== input.manifest.corpusDefinitionSha256 ||
    report.queryOracleSha256 !== input.manifest.queryOracleSha256 ||
    report.scopeOracleSha256 !== input.manifest.scopeOracleSha256 ||
    report.faultMatrixSha256 !== input.manifest.faultMatrixSha256 ||
    report.inputFingerprintSha256 !== input.currentInputFingerprintSha256 ||
    report.inputFingerprintSha256 !== sha256Canonical(report.inputFiles) ||
    report.checkout.fingerprintSha256 !==
      input.currentCheckoutFingerprintSha256 ||
    report.exactCommand !== baselineCommand ||
    report.memoryConfigSha256 !== agentMemoryOffConfigSha256 ||
    report.nodeVersion !== process.version ||
    report.platform !== process.platform
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_binding_mismatch",
      "baseline report is not bound to the current manifest and inputs",
    );
  }
  if (
    report.guard.guardIdentitySha256 !== agentMemoryBenchmarkGuardIdentitySha256 ||
    report.guard.networkAttemptCount !== 0 ||
    report.guard.credentialReadAttemptCount !== 0 ||
    report.guard.providerCallCount !== 0
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_guard_failed",
      "baseline report observed a forbidden network, credential, or provider attempt",
    );
  }
  verifyCases(input.manifest, report);
  if (
    report.deterministicResultSha256 !== sha256Canonical({
      cases: deterministicCases(report.cases),
      corpusDefinitionSha256: report.corpusDefinitionSha256,
      faultMatrixSha256: report.faultMatrixSha256,
      queryOracleSha256: report.queryOracleSha256,
      scopeOracleSha256: report.scopeOracleSha256,
    }) ||
    canonicalJson(report.summary) !== canonicalJson(summarize(report.cases))
  ) {
    throw new AgentMemoryEvidenceError(
      "agent_memory_report_summary_mismatch",
      "baseline report deterministic root or summary is invalid",
    );
  }
  const body = {
    checkoutFingerprintSha256: report.checkout.fingerprintSha256,
    corpusSha256: report.corpusDefinitionSha256,
    createdAt: report.createdAt,
    deterministicResultSha256: report.deterministicResultSha256,
    evidenceId: input.manifest.evidenceId,
    exactCommand: report.exactCommand,
    inputFingerprintSha256: report.inputFingerprintSha256,
    manifestSha256: report.manifestSourceSha256,
    memoryConfigSha256: report.memoryConfigSha256,
    nodeVersion: report.nodeVersion,
    platform: report.platform,
    reportSha256: report.reportSha256,
    schemaVersion: 1,
    status: "pass",
    testCountSemantics: "required_characterization_cases",
    testsFailed: 0,
    testsPassed: report.summary.caseCount,
    testsSkipped: 0,
  } as const;
  return agentMemoryEvidenceReceiptSchema.parse({
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
      throw new AgentMemoryEvidenceError(
        "agent_memory_evidence_path_conflict",
        `${filename} already exists with different bytes`,
      );
    }
  }
  return path;
}

export async function writeAgentMemoryBaselineReport(
  directory: string,
  report: AgentMemoryBaselineReportV1,
): Promise<string> {
  return writeCanonicalNoReplace(
    directory,
    `agent-memory-baseline-${report.reportSha256}.json`,
    report,
  );
}

export async function writeAgentMemoryEvidenceReceipt(
  directory: string,
  receipt: AgentMemoryEvidenceReceiptV1,
): Promise<string> {
  return writeCanonicalNoReplace(
    directory,
    `agent-memory-receipt-${receipt.receiptSha256}.json`,
    receipt,
  );
}
