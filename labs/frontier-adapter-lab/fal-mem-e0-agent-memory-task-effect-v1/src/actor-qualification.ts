import { createHash } from "node:crypto";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { MEM_E0_EXPERIMENT_ID } from "./fixture.js";

export const MEM_E0_ACTOR_QUALIFICATION_PROVIDER = "deepseek" as const;
export const MEM_E0_ACTOR_QUALIFICATION_MODEL = "deepseek-v4-flash" as const;
export const MEM_E0_ACTOR_QUALIFICATION_ENDPOINT =
  "https://api.deepseek.com" as const;
export const MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS = 4 as const;
export const MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS = 60_000 as const;
export const MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST =
  2_048 as const;
export const MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL =
  8_192 as const;
export const MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS = 33_609 as const;
export const MEM_E0_ACTOR_QUALIFICATION_PEAK_INPUT_USD_MICROS_PER_MILLION =
  440_000 as const;
export const MEM_E0_ACTOR_QUALIFICATION_PEAK_OUTPUT_USD_MICROS_PER_MILLION =
  1_320_000 as const;
export const MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE = Object.freeze([
  "read_file",
  "apply_patch",
  "run_command",
  "finish_task",
] as const);
export const MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256 = createHash(
  "sha256",
).update("executeAgentThroughApplicationService", "utf8").digest("hex");

const TOKENS_PER_PRICING_UNIT = 1_000_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const relativePathSchema = z.string().min(1).max(256).refine((value) =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("//") &&
  !value.split("/").includes("..") &&
  !/^[A-Za-z]:/u.test(value),
"path must be normalized repository-relative POSIX text");

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

const sortedSha256ListSchema = z.array(sha256Schema).min(1).max(64)
  .superRefine((values, context) => {
    if (!isSortedUnique(values)) {
      context.addIssue({
        code: "custom",
        message: "qualification hash set must be strictly sorted and unique",
      });
    }
  });
const orderedSha256ListSchema = z.array(sha256Schema).max(32);

const sourceSchema = z.object({
  commit: commitSchema,
  implementationSha256s: sortedSha256ListSchema,
  protectedPathsClean: z.boolean(),
  protectedTreeSha256: sha256Schema,
}).strict();
export const memE0ActorQualificationSourceSchema = sourceSchema;

const capsSchema = z.object({
  maximumAuthorizedCostUsdMicros: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  ),
  maximumOutputTokensPerRequest: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
  ),
  maximumOutputTokensTotal: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
  ),
  maximumProviderRequests: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
  ),
  maximumReportedTokens: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
  ),
  retries: z.literal(0),
}).strict();

const actorFreezeContentSchema = z.object({
  adapterConfigSha256: sha256Schema,
  budgetSha256: sha256Schema,
  caps: capsSchema,
  endpoint: z.literal(MEM_E0_ACTOR_QUALIFICATION_ENDPOINT),
  model: z.literal(MEM_E0_ACTOR_QUALIFICATION_MODEL),
  modelAliasMutable: z.literal(true),
  modelQualificationEvidenceSha256: sha256Schema,
  modelQualificationIdentitySha256: sha256Schema,
  modelQualificationObservationSha256: sha256Schema,
  modelQualificationPricingSha256: sha256Schema,
  modelQualificationProtocolSha256: sha256Schema,
  modelQualificationRecordSha256: sha256Schema,
  peakCacheMissInputUsdMicrosPerMillionTokens: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_PEAK_INPUT_USD_MICROS_PER_MILLION,
  ),
  peakOutputUsdMicrosPerMillionTokens: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_PEAK_OUTPUT_USD_MICROS_PER_MILLION,
  ),
  policySha256: sha256Schema,
  pricingSha256: sha256Schema,
  productionPiRuntimeImplementationSha256: sha256Schema,
  provider: z.literal(MEM_E0_ACTOR_QUALIFICATION_PROVIDER),
  providerSource: z.literal("provider_network"),
  qualificationFixtureSha256: sha256Schema,
  qualificationProtocolSha256: sha256Schema,
  systemInstructionSha256: sha256Schema,
  toolCatalogSha256: sha256Schema,
}).strict();

export const memE0ActorQualificationFreezeSchema = actorFreezeContentSchema
  .extend({ actorFreezeSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.budgetSha256 !== sha256Canonical(value.caps)) {
      context.addIssue({
        code: "custom",
        message: "qualification budget hash mismatch",
        path: ["budgetSha256"],
      });
    }
    const { actorFreezeSha256, ...content } = value;
    if (actorFreezeSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "qualification actor freeze canonical self-hash mismatch",
        path: ["actorFreezeSha256"],
      });
    }
  });

const taskSchema = z.object({
  allowedChangedPaths: z.array(relativePathSchema).length(1),
  disclosureClass: z.literal("public_synthetic"),
  hiddenVerifierSha256: sha256Schema,
  initialTargetSha256: sha256Schema,
  initialWorkspaceManifestSha256: sha256Schema,
  memoryMode: z.literal("off"),
  publicVerifierSha256: sha256Schema,
  targetRelativePath: relativePathSchema,
  taskSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.allowedChangedPaths[0] !== value.targetRelativePath) {
    context.addIssue({
      code: "custom",
      message: "qualification allowed change must be the exact target path",
      path: ["allowedChangedPaths"],
    });
  }
});
export const memE0ActorQualificationTaskSchema = taskSchema;

const toolNameSchema = z.enum([
  "apply_patch",
  "finish_task",
  "read_file",
  "run_command",
]);

const runSchema = z.object({
  agentExitCode: z.number().int().min(0).max(130),
  agentLoopObservationSha256: sha256Schema,
  agentLoopObserved: z.boolean(),
  applicationServiceObservationSha256: sha256Schema,
  applicationServiceObserved: z.boolean(),
  approvalDecisions: z.object({
    approved: z.number().int().nonnegative().max(8),
    cancelled: z.number().int().nonnegative().max(8),
    denied: z.number().int().nonnegative().max(8),
  }).strict(),
  approvalObservationSha256s: orderedSha256ListSchema,
  changedPaths: z.array(relativePathSchema).max(4),
  completionEvidenceSha256: sha256Schema,
  domainHarnessUsed: z.boolean(),
  endpointScope: z.enum(["in_process", "local_process", "provider_network"]),
  historicalMemoryItemCount: z.number().int().min(0).max(8),
  memoryMode: z.enum(["local", "off"]),
  modelEvidenceKind: z.enum([
    "contract_verified",
    "remote_live_qualified",
    "unknown",
  ]),
  modelQualificationEvidenceSha256: sha256Schema,
  modelQualificationIdentitySha256: sha256Schema,
  modelQualificationObservationSha256: sha256Schema,
  modelQualificationPricingSha256: sha256Schema,
  modelQualificationProtocolSha256: sha256Schema,
  modelQualificationRecordSha256: sha256Schema,
  modelRequestObservationSha256s: orderedSha256ListSchema,
  observedActorFreezeSha256: sha256Schema,
  observedAdapterConfigSha256: sha256Schema,
  observedInitialWorkspaceManifestSha256: sha256Schema,
  observedPolicySha256: sha256Schema,
  observedProductionPiRuntimeImplementationSha256: sha256Schema,
  observedProtectedTreeSha256: sha256Schema,
  observedPublicVerifierSha256: sha256Schema,
  observedQualificationFixtureSha256: sha256Schema,
  observedQualificationProtocolSha256: sha256Schema,
  observedSourceCommit: commitSchema,
  observedSystemInstructionSha256: sha256Schema,
  observedTaskSha256: sha256Schema,
  observedToolCatalogSha256: sha256Schema,
  orchestrationFailure: z.boolean(),
  pendingEffectCount: z.number().int().nonnegative(),
  productEntrySha256: sha256Schema,
  logicalProviderTurnRequestCount: z.number().int().nonnegative().max(32),
  publicVerifierPassed: z.boolean(),
  remoteMemoryGrantRequested: z.boolean(),
  sessionEventSpanSha256: sha256Schema,
  stderrSha256: sha256Schema,
  stdoutSha256: sha256Schema,
  terminal: z.enum(["bounded_stop", "failed", "verified_finish_task"]),
  toolArgumentSha256s: orderedSha256ListSchema,
  toolNames: z.array(toolNameSchema).max(8),
  toolRegistryCreatedCount: z.number().int().nonnegative().max(8),
  toolSuccessCount: z.number().int().nonnegative().max(8),
  unknownEffectCount: z.number().int().nonnegative(),
}).strict();
export const memE0ActorQualificationRunSchema = runSchema;

const verifierSchema = z.object({
  agentExitedBeforeVerifier: z.boolean(),
  argvSha256: sha256Schema,
  distinctOsProcesses: z.boolean(),
  exitCode: z.number().int().min(0).max(255).nullable(),
  finalTargetSha256: sha256Schema,
  finalWorkspaceManifestSha256: sha256Schema,
  hiddenVerifierOutsideWorkspace: z.boolean(),
  implementationSha256: sha256Schema,
  passed: z.boolean(),
  stderrSha256: sha256Schema,
  stdoutSha256: sha256Schema,
}).strict();

const providerUsageSchema = z.object({
  accountedPeakCostUsdMicros: z.number().int().nonnegative().safe(),
  cacheReadTokens: z.number().int().nonnegative().safe(),
  cacheWriteTokens: z.number().int().nonnegative().safe(),
  completeUsageEvents: z.number().int().nonnegative().max(32),
  inputTokens: z.number().int().nonnegative().safe(),
  isProviderInvoice: z.literal(false),
  maximumAuthorizedCostUsdMicros: z.literal(
    MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  ),
  maximumObservedOutputTokensPerRequest: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  partialUsageEvents: z.number().int().nonnegative().max(32),
  pricingSha256: sha256Schema,
  requestObservationSha256s: orderedSha256ListSchema,
  requestsCompleted: z.number().int().nonnegative().max(32),
  requestsStarted: z.number().int().nonnegative().max(32),
  retries: z.number().int().nonnegative().max(8),
  retryPolicyEvidence: z.object({
    configuredMaximumRetries: z.literal(0),
    evidenceKind: z.literal("frozen_production_implementation_identity"),
    frozenProductionImplementationIdentitySha256: sha256Schema,
    transportRetriesObserved: z.null(),
  }).strict(),
  totalTokens: z.number().int().nonnegative().safe(),
  usageObservationSha256s: orderedSha256ListSchema,
}).strict();
export const memE0ActorQualificationProviderUsageSchema = providerUsageSchema;

const identityInputSchema = z.object({
  freeze: memE0ActorQualificationFreezeSchema,
  source: sourceSchema,
  task: taskSchema,
}).strict();

const completedInputSchema = identityInputSchema.extend({
  providerUsage: providerUsageSchema,
  run: runSchema,
  verifier: verifierSchema,
}).strict();

export const memE0ActorQualificationResultSchema = z.object({
  reasonCode: z.enum([
    "cost_cap_exceeded",
    "exact_product_tool_actor_passed",
    "identity_drift",
    "product_path_failed",
    "qualification_not_authorized",
    "source_not_clean",
    "tool_sequence_failed",
    "usage_incomplete",
    "verifier_failed",
  ]),
  status: z.enum(["failed", "not_run", "passed"]),
}).strict().superRefine((value, context) => {
  const expectedStatus = value.reasonCode === "qualification_not_authorized"
    ? "not_run"
    : value.reasonCode === "exact_product_tool_actor_passed"
      ? "passed"
      : "failed";
  if (value.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      message: "qualification status must match its typed reason",
      path: ["status"],
    });
  }
});

const hygieneSchema = z.object({
  absolutePathsPersisted: z.literal(false),
  rawProviderReasoningPersisted: z.literal(false),
  rawProviderRequestPersisted: z.literal(false),
  rawProviderResponsePersisted: z.literal(false),
  rawStderrPersisted: z.literal(false),
  rawStdoutPersisted: z.literal(false),
  rawToolOutputPersisted: z.literal(false),
}).strict();

const receiptContentSchema = z.object({
  effectClaimAllowed: z.literal(false),
  evidenceClass: z.literal("deepseek_product_tool_actor_qualification"),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  freeze: memE0ActorQualificationFreezeSchema,
  hygiene: hygieneSchema,
  providerCalls: z.number().int().nonnegative().max(32),
  providerUsage: providerUsageSchema.nullable(),
  receiptType: z.literal("mem-e0-deepseek-tool-actor-qualification-v1"),
  result: memE0ActorQualificationResultSchema,
  run: runSchema.nullable(),
  schemaVersion: z.literal(1),
  source: sourceSchema,
  task: taskSchema,
  verifier: verifierSchema.nullable(),
}).strict();

export const memE0ActorQualificationReceiptSchema = receiptContentSchema
  .extend({ receiptSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    const expected = deriveReceiptResult(value);
    if (sha256Canonical(value.result) !== sha256Canonical(expected)) {
      context.addIssue({
        code: "custom",
        message: "qualification result must be scorer-derived",
        path: ["result"],
      });
    }
    const expectedProviderCalls = value.providerUsage?.requestsStarted ?? 0;
    if (value.providerCalls !== expectedProviderCalls) {
      context.addIssue({
        code: "custom",
        message: "qualification provider call count must be usage-derived",
        path: ["providerCalls"],
      });
    }
    const { receiptSha256, ...content } = value;
    if (receiptSha256 !== sha256Canonical(content)) {
      context.addIssue({
        code: "custom",
        message: "qualification receipt canonical self-hash mismatch",
        path: ["receiptSha256"],
      });
    }
  });

export type MemE0ActorQualificationFreeze = Readonly<
  z.infer<typeof memE0ActorQualificationFreezeSchema>
>;
export type MemE0ActorQualificationIdentityInput = Readonly<
  z.input<typeof identityInputSchema>
>;
export type MemE0ActorQualificationCompletedInput = Readonly<
  z.input<typeof completedInputSchema>
>;
export type MemE0ActorQualificationResult = Readonly<
  z.infer<typeof memE0ActorQualificationResultSchema>
>;
export type MemE0ActorQualificationReceipt = Readonly<
  z.infer<typeof memE0ActorQualificationReceiptSchema>
>;

function exactToolSequence(values: readonly string[]): boolean {
  return values.length === MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE.length &&
    values.every(
      (value, index) => value === MEM_E0_ACTOR_QUALIFICATION_TOOL_SEQUENCE[index],
    );
}

function sameSinglePath(values: readonly string[], expected: string): boolean {
  return values.length === 1 && values[0] === expected;
}

function expectedPeakCostUsdMicros(
  usage: z.infer<typeof providerUsageSchema>,
  freeze: z.infer<typeof memE0ActorQualificationFreezeSchema>,
): number {
  const numerator =
    BigInt(
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    ) *
      BigInt(freeze.peakCacheMissInputUsdMicrosPerMillionTokens) +
    BigInt(usage.outputTokens) *
      BigInt(freeze.peakOutputUsdMicrosPerMillionTokens);
  return Number(
    (numerator + BigInt(TOKENS_PER_PRICING_UNIT - 1)) /
      BigInt(TOKENS_PER_PRICING_UNIT),
  );
}

function scoreParsedCompleted(
  input: z.infer<typeof completedInputSchema>,
): MemE0ActorQualificationResult {
  if (!input.source.protectedPathsClean) {
    return Object.freeze({ reasonCode: "source_not_clean", status: "failed" });
  }
  if (
    input.run.observedSourceCommit !== input.source.commit ||
    input.run.observedProtectedTreeSha256 !== input.source.protectedTreeSha256 ||
    input.run.observedActorFreezeSha256 !== input.freeze.actorFreezeSha256 ||
    input.run.observedAdapterConfigSha256 !== input.freeze.adapterConfigSha256 ||
    input.run.observedTaskSha256 !== input.task.taskSha256 ||
    input.run.observedInitialWorkspaceManifestSha256 !==
      input.task.initialWorkspaceManifestSha256 ||
    input.run.observedPublicVerifierSha256 !== input.task.publicVerifierSha256 ||
    input.run.observedPolicySha256 !== input.freeze.policySha256 ||
    input.run.observedProductionPiRuntimeImplementationSha256 !==
      input.freeze.productionPiRuntimeImplementationSha256 ||
    input.run.observedQualificationFixtureSha256 !==
      input.freeze.qualificationFixtureSha256 ||
    input.run.observedQualificationProtocolSha256 !==
      input.freeze.qualificationProtocolSha256 ||
    input.run.observedSystemInstructionSha256 !==
      input.freeze.systemInstructionSha256 ||
    input.run.observedToolCatalogSha256 !== input.freeze.toolCatalogSha256 ||
    input.run.modelQualificationEvidenceSha256 !==
      input.freeze.modelQualificationEvidenceSha256 ||
    input.run.modelQualificationIdentitySha256 !==
      input.freeze.modelQualificationIdentitySha256 ||
    input.run.modelQualificationObservationSha256 !==
      input.freeze.modelQualificationObservationSha256 ||
    input.run.modelQualificationPricingSha256 !==
      input.freeze.modelQualificationPricingSha256 ||
    input.run.modelQualificationProtocolSha256 !==
      input.freeze.modelQualificationProtocolSha256 ||
    input.run.modelQualificationRecordSha256 !==
      input.freeze.modelQualificationRecordSha256 ||
    input.providerUsage.pricingSha256 !== input.freeze.pricingSha256
  ) {
    return Object.freeze({ reasonCode: "identity_drift", status: "failed" });
  }
  if (
    !input.run.applicationServiceObserved ||
    !input.run.agentLoopObserved ||
    input.run.domainHarnessUsed ||
    input.run.endpointScope !== "provider_network" ||
    input.run.modelEvidenceKind !== "remote_live_qualified" ||
    input.run.productEntrySha256 !==
      MEM_E0_ACTOR_QUALIFICATION_PRODUCT_ENTRY_SHA256 ||
    input.run.toolRegistryCreatedCount !== 1 ||
    input.run.memoryMode !== "off" ||
    input.run.historicalMemoryItemCount !== 0 ||
    input.run.remoteMemoryGrantRequested ||
    input.run.orchestrationFailure ||
    input.run.agentExitCode !== 0 ||
    input.run.terminal !== "verified_finish_task"
  ) {
    return Object.freeze({
      reasonCode: "product_path_failed",
      status: "failed",
    });
  }
  if (
    !exactToolSequence(input.run.toolNames) ||
    input.run.toolArgumentSha256s.length !== 4 ||
    new Set(input.run.toolArgumentSha256s).size !== 4 ||
    input.run.approvalObservationSha256s.length !== 2 ||
    input.run.approvalDecisions.approved !== 2 ||
    input.run.approvalDecisions.cancelled !== 0 ||
    input.run.approvalDecisions.denied !== 0 ||
    input.run.toolSuccessCount !== 4 ||
    !sameSinglePath(input.run.changedPaths, input.task.targetRelativePath) ||
    !input.run.publicVerifierPassed ||
    input.run.pendingEffectCount !== 0 ||
    input.run.unknownEffectCount !== 0
  ) {
    return Object.freeze({
      reasonCode: "tool_sequence_failed",
      status: "failed",
    });
  }
  if (
    input.providerUsage.requestsStarted < 1 ||
    input.providerUsage.requestsStarted !== input.providerUsage.requestsCompleted ||
    input.providerUsage.requestsStarted !== input.providerUsage.completeUsageEvents ||
    input.providerUsage.partialUsageEvents !== 0 ||
    input.providerUsage.totalTokens !==
      input.providerUsage.inputTokens +
        input.providerUsage.outputTokens +
        input.providerUsage.cacheReadTokens +
        input.providerUsage.cacheWriteTokens ||
    input.providerUsage.totalTokens === 0 ||
    input.providerUsage.requestObservationSha256s.length !==
      input.providerUsage.requestsStarted ||
    input.providerUsage.usageObservationSha256s.length !==
      input.providerUsage.requestsStarted ||
    input.run.modelRequestObservationSha256s.length !==
      input.providerUsage.requestsStarted ||
    input.run.logicalProviderTurnRequestCount !== input.providerUsage.requestsStarted
  ) {
    return Object.freeze({ reasonCode: "usage_incomplete", status: "failed" });
  }
  if (
    input.providerUsage.requestsStarted >
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS ||
    input.providerUsage.retries !== 0 ||
    input.providerUsage.retryPolicyEvidence.configuredMaximumRetries !== 0 ||
    input.providerUsage.retryPolicyEvidence.transportRetriesObserved !== null ||
    input.providerUsage.retryPolicyEvidence
      .frozenProductionImplementationIdentitySha256 !==
      input.freeze.productionPiRuntimeImplementationSha256 ||
    input.providerUsage.totalTokens >
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS ||
    input.providerUsage.maximumObservedOutputTokensPerRequest >
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST ||
    input.providerUsage.outputTokens >
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL ||
    input.providerUsage.accountedPeakCostUsdMicros !==
      expectedPeakCostUsdMicros(input.providerUsage, input.freeze) ||
    input.providerUsage.accountedPeakCostUsdMicros >
      input.providerUsage.maximumAuthorizedCostUsdMicros
  ) {
    return Object.freeze({
      reasonCode: "cost_cap_exceeded",
      status: "failed",
    });
  }
  if (
    !input.verifier.agentExitedBeforeVerifier ||
    !input.verifier.distinctOsProcesses ||
    !input.verifier.hiddenVerifierOutsideWorkspace ||
    input.verifier.implementationSha256 !== input.task.hiddenVerifierSha256 ||
    input.verifier.finalTargetSha256 === input.task.initialTargetSha256 ||
    input.verifier.exitCode !== 0 ||
    !input.verifier.passed
  ) {
    return Object.freeze({ reasonCode: "verifier_failed", status: "failed" });
  }
  return Object.freeze({
    reasonCode: "exact_product_tool_actor_passed",
    status: "passed",
  });
}

function deriveReceiptResult(
  value: z.infer<typeof receiptContentSchema> | z.infer<
    typeof memE0ActorQualificationReceiptSchema
  >,
): MemE0ActorQualificationResult {
  if (
    value.run === null &&
    value.verifier === null &&
    value.providerUsage === null &&
    value.providerCalls === 0
  ) {
    return Object.freeze({
      reasonCode: "qualification_not_authorized",
      status: "not_run",
    });
  }
  if (
    value.run === null ||
    value.verifier === null ||
    value.providerUsage === null
  ) {
    return Object.freeze({ reasonCode: "product_path_failed", status: "failed" });
  }
  return scoreParsedCompleted(completedInputSchema.parse({
    freeze: value.freeze,
    providerUsage: value.providerUsage,
    run: value.run,
    source: value.source,
    task: value.task,
    verifier: value.verifier,
  }));
}

function qualificationHygiene(): z.infer<typeof hygieneSchema> {
  return Object.freeze({
    absolutePathsPersisted: false,
    rawProviderReasoningPersisted: false,
    rawProviderRequestPersisted: false,
    rawProviderResponsePersisted: false,
    rawStderrPersisted: false,
    rawStdoutPersisted: false,
    rawToolOutputPersisted: false,
  });
}

export function createMemE0ActorQualificationFreeze(value: unknown):
  MemE0ActorQualificationFreeze {
  const inputSchema = actorFreezeContentSchema.omit({
    budgetSha256: true,
    caps: true,
    endpoint: true,
    model: true,
    modelAliasMutable: true,
    peakCacheMissInputUsdMicrosPerMillionTokens: true,
    peakOutputUsdMicrosPerMillionTokens: true,
    provider: true,
    providerSource: true,
  }).strict();
  const input = inputSchema.parse(value);
  const caps = capsSchema.parse({
    maximumAuthorizedCostUsdMicros:
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
    maximumOutputTokensPerRequest:
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
    maximumOutputTokensTotal:
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
    maximumProviderRequests:
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
    maximumReportedTokens:
      MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
    retries: 0,
  });
  const content = actorFreezeContentSchema.parse({
    ...input,
    budgetSha256: sha256Canonical(caps),
    caps,
    endpoint: MEM_E0_ACTOR_QUALIFICATION_ENDPOINT,
    model: MEM_E0_ACTOR_QUALIFICATION_MODEL,
    modelAliasMutable: true,
    peakCacheMissInputUsdMicrosPerMillionTokens:
      MEM_E0_ACTOR_QUALIFICATION_PEAK_INPUT_USD_MICROS_PER_MILLION,
    peakOutputUsdMicrosPerMillionTokens:
      MEM_E0_ACTOR_QUALIFICATION_PEAK_OUTPUT_USD_MICROS_PER_MILLION,
    provider: MEM_E0_ACTOR_QUALIFICATION_PROVIDER,
    providerSource: "provider_network",
  });
  return Object.freeze(memE0ActorQualificationFreezeSchema.parse({
    ...content,
    actorFreezeSha256: sha256Canonical(content),
  }));
}

export function parseMemE0ActorQualificationFreeze(
  value: unknown,
): MemE0ActorQualificationFreeze {
  return Object.freeze(memE0ActorQualificationFreezeSchema.parse(value));
}

export function scoreMemE0ActorQualificationObservation(
  value: unknown,
): MemE0ActorQualificationResult {
  return scoreParsedCompleted(completedInputSchema.parse(value));
}

function sealReceipt(
  content: z.infer<typeof receiptContentSchema>,
): MemE0ActorQualificationReceipt {
  return Object.freeze(memE0ActorQualificationReceiptSchema.parse({
    ...content,
    receiptSha256: sha256Canonical(content),
  }));
}

export function createNotRunMemE0ActorQualificationReceipt(
  value: unknown,
): MemE0ActorQualificationReceipt {
  const input = identityInputSchema.parse(value);
  return sealReceipt(receiptContentSchema.parse({
    effectClaimAllowed: false,
    evidenceClass: "deepseek_product_tool_actor_qualification",
    experimentId: MEM_E0_EXPERIMENT_ID,
    freeze: input.freeze,
    hygiene: qualificationHygiene(),
    providerCalls: 0,
    providerUsage: null,
    receiptType: "mem-e0-deepseek-tool-actor-qualification-v1",
    result: {
      reasonCode: "qualification_not_authorized",
      status: "not_run",
    },
    run: null,
    schemaVersion: 1,
    source: input.source,
    task: input.task,
    verifier: null,
  }));
}

export function createMemE0ActorQualificationReceipt(
  value: unknown,
): MemE0ActorQualificationReceipt {
  const input = completedInputSchema.parse(value);
  const result = scoreParsedCompleted(input);
  return sealReceipt(receiptContentSchema.parse({
    effectClaimAllowed: false,
    evidenceClass: "deepseek_product_tool_actor_qualification",
    experimentId: MEM_E0_EXPERIMENT_ID,
    freeze: input.freeze,
    hygiene: qualificationHygiene(),
    providerCalls: input.providerUsage.requestsStarted,
    providerUsage: input.providerUsage,
    receiptType: "mem-e0-deepseek-tool-actor-qualification-v1",
    result,
    run: input.run,
    schemaVersion: 1,
    source: input.source,
    task: input.task,
    verifier: input.verifier,
  }));
}

export function parseMemE0ActorQualificationReceipt(
  value: unknown,
): MemE0ActorQualificationReceipt {
  return Object.freeze(memE0ActorQualificationReceiptSchema.parse(value));
}
