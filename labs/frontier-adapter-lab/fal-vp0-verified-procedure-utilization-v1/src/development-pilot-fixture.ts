import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { AGENT_SYSTEM_INSTRUCTIONS } from "../../../../src/agent/system-instructions.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { modelQualificationRecordSchema } from "../../../../src/model/model-qualification-schema.js";
import { parseUserPolicyConfig } from "../../../../src/policy/runtime-policy-schema.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

export const VP0_DEVELOPMENT_PILOT_FIXTURE =
  "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-deepseek-pilot-v1" as const;
export const VP0_DEVELOPMENT_PILOT_ID =
  "fal-vp0-deepseek-development-pilot-v1" as const;
export const VP0_DEVELOPMENT_PILOT_PROFILE =
  "vp0-development-deepseek" as const;
export const VP0_DEVELOPMENT_PILOT_SELECTOR =
  "bornagent.fal-vp0-development/procedure-carrier" as const;
const DS0_EXPERIMENT_ID = "fal-ds0-deepseek-tool-actor-v1" as const;
const DS0_POLICY_PROFILE = "fal-ds0-deepseek-remote-v1" as const;
const DS0_CONFIRMED_MAXIMUM_USD_MICROS = 120_000 as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeRef = z.string().min(1).max(512).superRefine((value, context) => {
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    context.addIssue({ code: "custom", message: "expected one normalized relative reference" });
  }
});

export type DevelopmentPilotArm = "baseline" | "candidate";

const protocolSchema = z.object({
  schemaVersion: z.literal(1),
  pilotId: z.literal(VP0_DEVELOPMENT_PILOT_ID),
  experimentId: z.literal("fal-vp0-verified-procedure-utilization-v1"),
  evidenceClass: z.literal("development_directional_actual_model_effect_only"),
  vp0GateEligible: z.literal(false),
  provider: z.literal("deepseek"),
  model: z.literal("deepseek-v4-flash"),
  baseUrl: z.literal("https://api.deepseek.com"),
  caseFixtureRoot: z.literal("fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-deepseek-pilot-v1/cases"),
  pairCount: z.literal(3),
  actorAttemptCount: z.literal(6),
  fixedExecutionOrder: z.tuple([
    z.literal("inclusive-boundary:baseline"),
    z.literal("inclusive-boundary:candidate"),
    z.literal("end-exclusive-page-window:candidate"),
    z.literal("end-exclusive-page-window:baseline"),
    z.literal("one-based-retry-cap:baseline"),
    z.literal("one-based-retry-cap:candidate"),
  ]),
  treatment: z.object({
    baseline: z.literal("same_public_task_without_procedure"),
    candidate: z.literal("same_public_task_plus_one_user_selected_generic_boundary_and_state_contract_procedure_pack"),
  }).strict(),
  perAttemptCaps: z.object({
    maximumProviderRequests: z.literal(6),
    maximumReportedUncachedInputTokens: z.literal(64_000),
    maximumReportedCacheReadTokens: z.literal(4_000),
    maximumReportedOutputTokens: z.literal(1_300),
    maximumReportedTotalTokens: z.literal(69_300),
    runtimeReportedTokenCeiling: z.literal(69_300),
    maximumOutputTokensPerRequest: z.literal(512),
    maximumWallTimeMs: z.number().int().positive().max(600_000),
  }).strict(),
  toolProfile: z.object({
    id: z.literal("public-microtask-minimal-production-v1"),
    allowedToolIds: z.tuple([
      z.literal("list_files"),
      z.literal("read_file"),
      z.literal("apply_patch"),
      z.literal("run_command"),
      z.literal("finish_task"),
    ]),
    implementationBoundary: z.literal("production_registry_restricted_model_surface"),
  }).strict(),
  ds0EntryEvidence: z.object({
    acceptedClasses: z.tuple([
      z.literal("ds0_product_completion_passed"),
      z.literal("functional_entry_only"),
    ]),
    primaryPilotOutcome: z.literal("independent_fresh_verifier_task_success"),
    secondaryPilotOutcome: z.literal("bornagent_verified_finish_task_completion"),
    functionalEntryIsProductCompletionEvidence: z.literal(false),
    functionalEntryIsQualityEvidence: z.literal(false),
  }).strict(),
  batchCaps: z.object({
    maximumConcurrentAttempts: z.literal(1),
    maximumEstimatedPeakCostUsdMicros: z.literal(180_000),
    conservativePeakUpperBoundUsdMicros: z.literal(179_592),
    conservativePeakUpperBoundFormula: z.string().min(1).max(256),
    combinedWithDs0MaximumUsdMicros: z.literal(300_000),
  }).strict(),
  authorization: z.object({
    defaultMode: z.literal("offline_plan_only"),
    remoteCallsAuthorizedByFixture: z.literal(false),
    requiresRunLocalAuthorizeRemoteFlag: z.literal(true),
    requiresRunLocalMaximumCost: z.literal(true),
    apiKeyPresenceIsAuthorization: z.literal(false),
  }).strict(),
  retention: z.object({
    trackedRawProviderResponseAllowed: z.literal(false),
    rawProviderReasoningAllowed: z.literal(false),
    apiKeyPersistenceAllowed: z.literal(false),
    absolutePathPersistenceAllowed: z.literal(false),
    attemptWorkspacesDeletedAfterSanitizedObservation: z.literal(true),
  }).strict(),
  nonClaims: z.array(z.string().min(1).max(512)).min(4),
}).strict();

const caseIdSchema = z.enum([
  "inclusive-boundary",
  "end-exclusive-page-window",
  "one-based-retry-cap",
]);

const caseSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: caseIdSchema,
  family: z.enum(["boundary-projection", "half-open-window", "capped-growth"]),
  publicRoot: z.literal("public"),
  targetRelativePath: relativeRef,
  verifier: z.object({
    cwd: z.literal("."),
    argv: z.tuple([z.literal("node"), z.literal("verify.mjs")]),
  }).strict(),
  task: z.string().min(80).max(2_048),
  exactFinalSource: z.string().min(1).max(2_048),
}).strict().superRefine((value, context) => {
  const expectedFamily = {
    "inclusive-boundary": "boundary-projection",
    "end-exclusive-page-window": "half-open-window",
    "one-based-retry-cap": "capped-growth",
  } as const;
  if (value.family !== expectedFamily[value.caseId]) {
    context.addIssue({ code: "custom", message: "development pilot case/family mismatch" });
  }
  if ([value.targetRelativePath, "verify.mjs", "node verify.mjs"].some((needle) =>
    value.task.toLowerCase().includes(needle.toLowerCase()))) {
    context.addIssue({ code: "custom", message: "development pilot task leaks target or verifier details" });
  }
});

const pricingSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  provider: z.literal("deepseek"),
  modelAlias: z.literal("deepseek-v4-flash"),
  peak: z.object({
    cachedInput: z.number().nonnegative(),
    uncachedInput: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }).strict(),
  offPeak: z.object({
    cachedInput: z.number().nonnegative(),
    uncachedInput: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }).strict(),
  pricingSha256: sha256,
}).passthrough();

const usageAggregateSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  completeUsageEvents: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  partialUsageEvents: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export const developmentPilotQualificationDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("deepseek"),
  model: z.literal("deepseek-v4-flash"),
  baseUrl: z.literal("https://api.deepseek.com"),
  qualificationStatus: z.literal("passed"),
  qualificationEvidenceKind: z.literal("model_capability_probe_suite"),
  qualificationEvidenceRef: relativeRef,
  qualificationEvidenceSha256: sha256,
  qualificationRequestCount: z.number().int().min(1).max(6),
  qualificationCompletedRequestCount: z.number().int().min(1).max(6),
  qualificationUsageCapability: z.enum(["complete", "not_reported"]),
}).strict().superRefine((value, context) => {
  if (value.qualificationCompletedRequestCount > value.qualificationRequestCount) {
    context.addIssue({ code: "custom", message: "completed qualification requests exceed attempts" });
  }
});

const ds0QualificationDescriptorSchema = z.object({
  baseUrl: z.literal("https://api.deepseek.com"),
  completedCount: z.number().int().min(1).max(6),
  evidenceSha256: sha256,
  kind: z.literal("model_capability_probe_suite"),
  model: z.literal("deepseek-v4-flash"),
  provider: z.literal("deepseek"),
  recordSha256: sha256,
  ref: relativeRef,
  requestCount: z.number().int().min(1).max(6),
  schemaVersion: z.literal(1),
  status: z.literal("passed"),
  usageCapability: z.literal("complete"),
}).strict().superRefine((value, context) => {
  if (value.completedCount !== value.requestCount) {
    context.addIssue({ code: "custom", message: "DS0 qualification descriptor is not usage-complete" });
  }
});

const ds0PassedObservationSchema = z.object({
  actor: z.object({
    approvalDecisions: z.array(z.object({
      actionKind: z.enum(["apply_patch", "run_command", "task_worktree.allocate", "task_worktree.cleanup", "task_worktree.promote"]),
      decision: z.enum(["approved", "cancelled", "denied"]),
    }).strict()),
    exitCode: z.literal(0),
    freshVerification: z.object({
      changedPaths: z.tuple([z.literal("fixtures/phase-07-fix-and-verify/src/clamp.mjs")]),
      finalTargetSha256: sha256,
      verifierExitCode: z.literal(0),
    }).strict(),
    reportHash: sha256,
    reportStatus: z.literal("completed"),
    requestCount: z.number().int().min(1).max(6),
    backendMeterUsage: usageAggregateSchema,
    sessionUsage: usageAggregateSchema,
    terminalRunFailed: z.null(),
    unreportedRequestCount: z.literal(0),
    unreportedRequestReserveUsdMicros: z.literal(0),
    usage: usageAggregateSchema,
    usageCrossCheckedAgainstBackendMeter: z.literal(true),
  }).strict(),
  combinedProviderRequests: z.number().int().min(2).max(12),
  configuration: z.object({
    actorConfigurationSha256: sha256,
    codingSystemInstructionSha256: sha256,
  }).strict(),
  cost: z.object({
    actorUnreportedRequestReserveUsdMicros: z.literal(0),
    applicableBand: z.enum(["off_peak", "peak"]),
    boundaryKind: z.literal("estimated_replay_not_provider_bill_cap"),
    combinedApplicableEstimatedUsdMicros: z.number().int().nonnegative(),
    combinedPeakEstimatedUsdMicros: z.number().int().nonnegative(),
    confirmedMaximumUsdMicros: z.literal(DS0_CONFIRMED_MAXIMUM_USD_MICROS),
    isProviderInvoice: z.literal(false),
    preActorPeakBoundUsdMicros: z.number().int().nonnegative(),
    qualificationUnreportedRequestReserveUsdMicros: z.number().int().nonnegative(),
  }).strict(),
  experimentId: z.literal(DS0_EXPERIMENT_ID),
  runId: z.string().regex(/^ds0-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  schemaVersion: z.literal(1),
  privacy: z.object({
    absolutePathsPersisted: z.literal(false),
    apiKeyPersisted: z.literal(false),
    rawProviderReasoningPersisted: z.literal(false),
    rawProviderResponsePersisted: z.literal(false),
  }).strict(),
  protocolSha256: sha256,
  pricingSha256: sha256,
  qualification: z.object({
    evidenceSha256: sha256,
    qualifiedModes: z.array(z.enum(["build", "plan"])).min(1),
    requestCount: z.number().int().min(1).max(6),
    unreportedRequestCount: z.number().int().nonnegative().max(6),
    usage: usageAggregateSchema,
  }).strict(),
  qualificationDescriptor: ds0QualificationDescriptorSchema,
  publicWorkspace: z.object({
    baselineCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    target: z.literal("fixtures/phase-07-fix-and-verify/src/clamp.mjs"),
  }).strict(),
  status: z.literal("passed"),
  observationSha256: sha256,
}).strict();

const ds0FunctionalEntryObservationSchema = ds0PassedObservationSchema.extend({
  actor: z.object({
    approvalDecisions: z.tuple([
      z.object({
        actionKind: z.literal("apply_patch"),
        decision: z.literal("approved"),
      }).strict(),
    ]),
    exitCode: z.literal(7),
    freshVerification: z.object({
      changedPaths: z.tuple([z.literal("fixtures/phase-07-fix-and-verify/src/clamp.mjs")]),
      finalTargetSha256: sha256,
      verifierExitCode: z.literal(0),
    }).strict(),
    reportHash: z.null(),
    reportStatus: z.null(),
    requestCount: z.number().int().min(1).max(6),
    backendMeterUsage: usageAggregateSchema,
    sessionUsage: usageAggregateSchema,
    terminalRunFailed: z.null(),
    unreportedRequestCount: z.literal(0),
    unreportedRequestReserveUsdMicros: z.literal(0),
    usage: usageAggregateSchema,
    usageCrossCheckedAgainstBackendMeter: z.literal(true),
  }).strict(),
  qualificationDescriptor: z.null(),
  status: z.literal("actor_failed"),
}).strict();

const ds0EntryObservationSchema = z.union([
  ds0PassedObservationSchema,
  ds0FunctionalEntryObservationSchema,
]);

export type DevelopmentPilotQualificationDescriptor = Readonly<
  z.infer<typeof developmentPilotQualificationDescriptorSchema>
>;

export interface DevelopmentPilotQualificationEvidence {
  readonly descriptor: DevelopmentPilotQualificationDescriptor;
  readonly ds0ActorReportSha256: string | null;
  readonly ds0EntryEvidenceClass:
    | "ds0_product_completion_passed"
    | "functional_entry_only";
  readonly ds0ObservationSha256: string;
  readonly ds0PricingSha256: string;
  readonly ds0ProtocolSha256: string;
  readonly ds0QualificationRecordSha256: string;
}

export interface DevelopmentPilotCase {
  readonly caseId: z.infer<typeof caseIdSchema>;
  readonly exactFinalSource: string;
  readonly exactFinalSourceSha256: string;
  readonly family: "boundary-projection" | "half-open-window" | "capped-growth";
  readonly initialSource: string;
  readonly initialSourceSha256: string;
  readonly manifestRawSha256: string;
  readonly publicRoot: string;
  readonly publicTreeSha256: string;
  readonly targetRelativePath: string;
  readonly task: string;
  readonly verifier: Readonly<{ readonly argv: readonly ["node", "verify.mjs"]; readonly cwd: "." }>;
}

export interface DevelopmentPilotFixture {
  readonly directory: string;
  readonly cases: readonly DevelopmentPilotCase[];
  readonly policyPath: string;
  readonly policyRawSha256: string;
  readonly pricing: Readonly<z.infer<typeof pricingSchema>>;
  readonly pricingRawSha256: string;
  readonly procedure: string;
  readonly procedureRawSha256: string;
  readonly protocol: Readonly<z.infer<typeof protocolSchema>>;
  readonly protocolRawSha256: string;
  readonly repositoryRoot: string;
  readonly ds0ProtocolSha256: string;
}

function rawSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadDevelopmentPilotFixture(
  repositoryRoot: string,
): Promise<DevelopmentPilotFixture> {
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const directory = resolve(normalizedRepositoryRoot, ...VP0_DEVELOPMENT_PILOT_FIXTURE.split("/"));
  const [protocolRaw, procedure, policyRaw, pricingRaw, ds0ProtocolRaw] = await Promise.all([
    readFile(join(directory, "protocol.json"), "utf8"),
    readFile(join(directory, "verified-procedure.md"), "utf8"),
    readFile(join(directory, "remote-policy.json"), "utf8"),
    readFile(resolve(repositoryRoot, "fixtures/frontier-adapter-lab/ds0-deepseek-tool-actor-v1/pricing-snapshot.json"), "utf8"),
    readFile(resolve(repositoryRoot, "fixtures/frontier-adapter-lab/ds0-deepseek-tool-actor-v1/protocol.json"), "utf8"),
  ]);
  const protocol = protocolSchema.parse(parseStrictJson(protocolRaw));
  const pricing = pricingSchema.parse(parseStrictJson(pricingRaw));
  const policyProfiles = parseUserPolicyConfig(parseStrictJson(policyRaw));
  const policyProfile = policyProfiles.length === 1 ? policyProfiles[0] : undefined;
  const policyAccess = policyProfile?.modelAccess;
  const policyProvider = policyAccess?.kind === "remote_explicit" && policyAccess.providers.length === 1
    ? policyAccess.providers[0]
    : undefined;
  if (
    policyProfile?.id !== VP0_DEVELOPMENT_PILOT_PROFILE ||
    policyProfile.mode !== "remote_explicit" ||
    policyAccess?.kind !== "remote_explicit" ||
    policyAccess.credentialAccess !== "selected_provider_only" ||
    policyAccess.limits.maxProviderRequestsPerRun !== protocol.perAttemptCaps.maximumProviderRequests ||
    policyAccess.limits.maxOutputTokensPerRequest !== protocol.perAttemptCaps.maximumOutputTokensPerRequest ||
    policyAccess.limits.maxReportedTotalTokensPerRun !== protocol.perAttemptCaps.runtimeReportedTokenCeiling ||
    policyProvider?.provider !== protocol.provider ||
    policyProvider.models.length !== 1 ||
    policyProvider.models[0] !== protocol.model ||
    policyProvider.baseUrls.length !== 1 ||
    policyProvider.baseUrls[0] !== protocol.baseUrl ||
    policyProfile.evalAccess.maxAttemptsPerRun !== protocol.perAttemptCaps.maximumProviderRequests ||
    policyProfile.dockerAcquisition.kind !== "deny"
  ) {
    throw new Error("development pilot remote policy drifted from the frozen protocol caps");
  }
  const ds0ProtocolInput = parseStrictJson(ds0ProtocolRaw) as Readonly<Record<string, unknown>>;
  const ds0ProtocolSha256 = sha256.parse(ds0ProtocolInput.protocolSha256);
  if (
    sha256Canonical(Object.fromEntries(
      Object.entries(ds0ProtocolInput).filter(([key]) => key !== "protocolSha256"),
    )) !== ds0ProtocolSha256
  ) {
    throw new Error("development pilot DS0 protocol logical hash mismatch");
  }
  const pricingContent = Object.fromEntries(
    Object.entries(pricing).filter(([key]) => key !== "pricingSha256"),
  );
  if (sha256Canonical(pricingContent) !== pricing.pricingSha256) {
    throw new Error("development pilot pricing snapshot logical hash mismatch");
  }
  if (Math.max(pricing.peak.cachedInput, pricing.peak.uncachedInput, pricing.peak.output) !== 1.32) {
    throw new Error("development pilot conservative cost bound no longer matches peak pricing");
  }
  const conservativePeakUpperBoundUsdMicros = Math.round(
    protocol.actorAttemptCount * (
      protocol.perAttemptCaps.maximumReportedUncachedInputTokens * pricing.peak.uncachedInput +
      protocol.perAttemptCaps.maximumReportedCacheReadTokens * pricing.peak.cachedInput +
      protocol.perAttemptCaps.maximumReportedOutputTokens * pricing.peak.output
    ),
  );
  if (
    protocol.perAttemptCaps.maximumReportedTotalTokens !==
      protocol.perAttemptCaps.maximumReportedUncachedInputTokens +
        protocol.perAttemptCaps.maximumReportedCacheReadTokens +
        protocol.perAttemptCaps.maximumReportedOutputTokens ||
    protocol.batchCaps.conservativePeakUpperBoundUsdMicros !== conservativePeakUpperBoundUsdMicros ||
    protocol.batchCaps.combinedWithDs0MaximumUsdMicros !==
      protocol.batchCaps.maximumEstimatedPeakCostUsdMicros + DS0_CONFIRMED_MAXIMUM_USD_MICROS
  ) {
    throw new Error("development pilot batch cost formulas drifted from the frozen authorization maxima");
  }
  if (!procedure.endsWith("\n") || procedure.includes("DEEPSEEK_API_KEY")) {
    throw new Error("development pilot procedure fixture is not a safe frozen text payload");
  }
  const caseIds = caseIdSchema.options;
  const cases = await Promise.all(caseIds.map(async (caseId): Promise<DevelopmentPilotCase> => {
    const caseDirectory = join(directory, "cases", caseId);
    const manifestRaw = await readFile(join(caseDirectory, "case.json"), "utf8");
    const manifest = caseSchema.parse(parseStrictJson(manifestRaw));
    if (manifest.caseId !== caseId) throw new Error("development pilot case directory identity mismatch");
    const publicRoot = join(caseDirectory, manifest.publicRoot);
    const target = join(publicRoot, ...manifest.targetRelativePath.split("/"));
    const initialSource = await readFile(target, "utf8");
    if (initialSource === manifest.exactFinalSource) {
      throw new Error("development pilot public case is already fixed");
    }
    const files: string[] = [];
    const visit = async (root: string): Promise<void> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) files.push(path);
        else throw new Error("development pilot public case contains a non-file entry");
      }
    };
    await visit(publicRoot);
    const publicTree = await Promise.all(files.sort().map(async (path) => ({
      path: relative(publicRoot, path).split(sep).join("/"),
      sha256: rawSha256(await readFile(path)),
    })));
    return Object.freeze({
      caseId: manifest.caseId,
      exactFinalSource: manifest.exactFinalSource,
      exactFinalSourceSha256: rawSha256(manifest.exactFinalSource),
      family: manifest.family,
      initialSource,
      initialSourceSha256: rawSha256(initialSource),
      manifestRawSha256: rawSha256(manifestRaw),
      publicRoot,
      publicTreeSha256: sha256Canonical(publicTree),
      targetRelativePath: manifest.targetRelativePath,
      task: manifest.task,
      verifier: Object.freeze({ argv: manifest.verifier.argv, cwd: manifest.verifier.cwd }),
    });
  }));
  return Object.freeze({
    cases: Object.freeze(cases),
    directory,
    ds0ProtocolSha256,
    policyPath: join(directory, "remote-policy.json"),
    policyRawSha256: rawSha256(policyRaw),
    pricing: Object.freeze(pricing),
    pricingRawSha256: rawSha256(pricingRaw),
    procedure,
    procedureRawSha256: rawSha256(procedure),
    protocol: Object.freeze(protocol),
    protocolRawSha256: rawSha256(protocolRaw),
    repositoryRoot: normalizedRepositoryRoot,
  });
}

export async function loadDevelopmentPilotQualificationFromDs0Observation(
  path: string,
  fixture: DevelopmentPilotFixture,
): Promise<DevelopmentPilotQualificationEvidence> {
  return await loadDs0QualificationBoundToInstructions(path, fixture, rawSha256(AGENT_SYSTEM_INSTRUCTIONS));
}

/** Reuse only historical model probes before a NEW independent actor qualification.
 * The caller must freeze the expected historical instruction hash in its own source;
 * never derive this expectation from the observation being validated. The normal
 * VP0 entry above continues to require the current actor instructions.
 */
export async function loadHistoricalDs0ModelQualificationForActorPreflight(
  path: string,
  fixture: DevelopmentPilotFixture,
  expectedHistoricalCodingSystemInstructionSha256: string,
): Promise<DevelopmentPilotQualificationEvidence> {
  if (!/^[a-f0-9]{64}$/u.test(expectedHistoricalCodingSystemInstructionSha256)) {
    throw new Error("historical DS0 model reuse requires an explicit frozen instruction hash");
  }
  return await loadDs0QualificationBoundToInstructions(path, fixture, expectedHistoricalCodingSystemInstructionSha256);
}

async function loadDs0QualificationBoundToInstructions(
  path: string,
  fixture: DevelopmentPilotFixture,
  codingSystemInstructionSha256: string,
): Promise<DevelopmentPilotQualificationEvidence> {
  const normalizedPath = resolve(path);
  const input = parseStrictJson(await readFile(normalizedPath, "utf8")) as Readonly<Record<string, unknown>>;
  const observation = ds0EntryObservationSchema.parse(input);
  const actualObservationSha256 = sha256Canonical(Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "observationSha256"),
  ));
  if (actualObservationSha256 !== observation.observationSha256) {
    throw new Error("DS0 entry observation self-hash mismatch");
  }
  if (
    observation.protocolSha256 !== fixture.ds0ProtocolSha256 ||
    observation.pricingSha256 !== fixture.pricing.pricingSha256
  ) {
    throw new Error("DS0 entry observation is not bound to the frozen protocol and pricing");
  }
  const expectedObservationRef = [
    ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs",
    observation.runId,
    "observation.json",
  ].join("/");
  const actualObservationRef = relative(fixture.repositoryRoot, normalizedPath).split(sep).join("/");
  const expectedQualificationRef = [
    ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs",
    observation.runId,
    "qualification-record.json",
  ].join("/");
  if (
    actualObservationRef !== expectedObservationRef ||
    (observation.status === "passed" &&
      observation.qualificationDescriptor.ref !== expectedQualificationRef)
  ) {
    throw new Error("DS0 entry observation or qualification record is outside its bound run directory");
  }
  const qualificationPath = resolve(
    fixture.repositoryRoot,
    ...expectedQualificationRef.split("/"),
  );
  if (dirname(qualificationPath) !== dirname(normalizedPath)) {
    throw new Error("DS0 qualification record does not share the observation run directory");
  }
  const qualificationRecord = modelQualificationRecordSchema.parse(
    parseStrictJson(await readFile(qualificationPath, "utf8")),
  );
  const actorConfigurationSha256 = sha256Canonical({
    codingSystemInstructionSha256,
    model: "deepseek-v4-flash",
    policyProfile: DS0_POLICY_PROFILE,
    protocolSha256: fixture.ds0ProtocolSha256,
    provider: "deepseek",
  });
  const qualificationRecordSha256 = sha256Canonical(qualificationRecord);
  const usageSemantics = qualificationRecord.probeResults.find(
    (result) => result.probeId === "usage_semantics_v1",
  );
  const passedDescriptorMismatch = observation.status === "passed" && (
    observation.qualification.evidenceSha256 !==
      observation.qualificationDescriptor.evidenceSha256 ||
    observation.qualification.requestCount !==
      observation.qualificationDescriptor.requestCount ||
    qualificationRecordSha256 !== observation.qualificationDescriptor.recordSha256 ||
    qualificationRecord.evidenceSha256 !==
      observation.qualificationDescriptor.evidenceSha256 ||
    qualificationRecord.totalRequestCount !==
      observation.qualificationDescriptor.requestCount
  );
  if (
    observation.actor.freshVerification.finalTargetSha256 !== rawSha256([
      "export function clamp(value, minimum, maximum) {",
      "  return Math.min(maximum, Math.max(minimum, value));",
      "}",
      "",
    ].join("\n")) ||
    observation.configuration.codingSystemInstructionSha256 !== codingSystemInstructionSha256 ||
    observation.configuration.actorConfigurationSha256 !== actorConfigurationSha256 ||
    sha256Canonical(observation.actor.backendMeterUsage) !==
      sha256Canonical(observation.actor.sessionUsage) ||
    sha256Canonical(observation.actor.backendMeterUsage) !==
      sha256Canonical(observation.actor.usage) ||
    observation.actor.backendMeterUsage.partialUsageEvents !== 0 ||
    observation.actor.backendMeterUsage.completeUsageEvents !== observation.actor.requestCount ||
    observation.combinedProviderRequests !==
      observation.qualification.requestCount + observation.actor.requestCount ||
    observation.cost.combinedPeakEstimatedUsdMicros >
      observation.cost.confirmedMaximumUsdMicros ||
    !observation.qualification.qualifiedModes.includes("build") ||
    observation.qualification.evidenceSha256 !== qualificationRecord.evidenceSha256 ||
    observation.qualification.requestCount !== qualificationRecord.totalRequestCount ||
    observation.qualification.usage.partialUsageEvents !== 0 ||
    observation.qualification.unreportedRequestCount !==
      observation.qualification.requestCount -
        observation.qualification.usage.completeUsageEvents ||
    observation.cost.qualificationUnreportedRequestReserveUsdMicros !== Math.round(
      observation.qualification.unreportedRequestCount * 8_192 * 1.32,
    ) ||
    passedDescriptorMismatch ||
    !qualificationRecord.qualifiedModes.includes("build") ||
    usageSemantics?.status !== "passed" ||
    usageSemantics.observed.availability !== "complete" ||
    qualificationRecord.identity.provider !== "deepseek" ||
    qualificationRecord.identity.model !== "deepseek-v4-flash" ||
    qualificationRecord.identity.policyProfileId !== DS0_POLICY_PROFILE
  ) {
    throw new Error("DS0 entry observation does not prove safe functional build qualification");
  }
  const descriptor = developmentPilotQualificationDescriptorSchema.parse({
    schemaVersion: 1,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    qualificationStatus: "passed",
    qualificationEvidenceKind: "model_capability_probe_suite",
    qualificationEvidenceRef: expectedQualificationRef,
    qualificationEvidenceSha256: qualificationRecord.evidenceSha256,
    qualificationRequestCount: qualificationRecord.totalRequestCount,
    qualificationCompletedRequestCount: qualificationRecord.totalRequestCount,
    qualificationUsageCapability: "complete",
  });
  return Object.freeze({
    descriptor: Object.freeze(descriptor),
    ds0ActorReportSha256: observation.actor.reportHash,
    ds0EntryEvidenceClass: observation.status === "passed"
      ? "ds0_product_completion_passed"
      : "functional_entry_only",
    ds0ObservationSha256: observation.observationSha256,
    ds0PricingSha256: observation.pricingSha256,
    ds0ProtocolSha256: observation.protocolSha256,
    ds0QualificationRecordSha256: qualificationRecordSha256,
  });
}
