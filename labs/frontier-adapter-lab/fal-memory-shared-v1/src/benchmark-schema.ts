import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

export const SHARED_MEMORY_BENCHMARK_ID = "fal-memory-shared-v1" as const;
export const SHARED_MEMORY_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal-memory-shared-v1" as const;

export const benchmarkSplits = [
  "development",
  "calibration",
  "evaluation",
] as const;

export const sharedProbeTypes = [
  "direct_user_fact",
  "assistant_or_tool_outcome",
  "cross_session_synthesis",
  "temporal_reasoning",
  "knowledge_update",
  "mixed_memory_receipt",
  "absent_fact",
  "semantic_near_miss",
  "filtered_scope_or_lifecycle",
  "incomplete_evidence_chain",
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(160);
const boundedText = z.string().min(1).max(16_384);
const evidenceRef = z.string().regex(/^(?:record|receipt):[a-z0-9-]+(?::[a-z0-9-]+)?$/u);

const benchmarkSplitSchema = z.enum(benchmarkSplits);
const probeTypeSchema = z.enum(sharedProbeTypes);

const memoryRecordSchema = z.object({
  recordId: identifier,
  title: z.string().min(1).max(512),
  text: boundedText,
  occurredAt: z.string().datetime({ offset: true }),
  repositoryId: identifier,
  principalId: identifier,
  sourceKind: z.enum(["user", "assistant", "tool", "child_receipt", "synthetic_filler"]),
  sourceStatus: z.enum(["available", "stale", "tampered", "unavailable"]),
  lifecycle: z.enum([
    "episode_active",
    "explicit_active",
    "explicit_current",
    "explicit_superseded",
    "explicit_retracted",
  ]),
  revisionGroup: identifier.nullable(),
  sourceEventIds: z.array(identifier).max(8),
}).strict().superRefine((value, context) => {
  const revisioned = value.lifecycle === "explicit_current" ||
    value.lifecycle === "explicit_superseded";
  if (revisioned !== (value.revisionGroup !== null)) {
    context.addIssue({
      code: "custom",
      message: "current/superseded records must carry a revision group and only they may do so",
      path: ["revisionGroup"],
    });
  }
});

const acceptedClaimSchema = z.object({
  claimId: identifier,
  kind: identifier,
  narrative: boundedText,
  evidenceRefs: z.array(z.string().min(1).max(4_096)).max(64),
}).strict();

const acceptedReceiptSchema = z.object({
  kind: z.literal("accepted_child_receipt"),
  delegationId: identifier,
  childAttemptId: identifier,
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  objective: boundedText,
  verifiedClaims: z.array(acceptedClaimSchema).max(64),
  changeBundleRef: z.string().min(1).max(4_096).nullable(),
  verificationGenerationIds: z.array(identifier).max(64),
  receiptSha256: sha256,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...content } = value;
  if (sha256Canonical(content) !== receiptSha256) {
    context.addIssue({
      code: "custom",
      message: "receipt hash does not match its logical content",
      path: ["receiptSha256"],
    });
  }
});

const sourceSessionSchema = z.object({
  sessionId: identifier,
  occurredAt: z.string().datetime({ offset: true }),
  events: z.array(z.object({
    eventId: identifier,
    role: z.enum(["user", "assistant", "tool", "host"]),
    text: boundedText,
  }).strict()).min(1).max(16),
}).strict();

const executorProbeSchema = z.object({
  probeId: identifier,
  query: z.string().min(1).max(2_048),
  contextBudgetTokens: z.number().int().min(1_024).max(32_768),
}).strict();

export const sharedTimelineInputSchema = z.object({
  timelineId: identifier,
  repositoryId: identifier,
  principalId: identifier,
  asOf: z.string().datetime({ offset: true }),
  sourceSessions: z.array(sourceSessionSchema).min(8).max(12),
  records: z.array(memoryRecordSchema).min(64).max(1_024),
  recordPoolSha256: sha256,
  acceptedChildReceipts: z.array(acceptedReceiptSchema).min(1).max(32),
  probes: z.array(executorProbeSchema).length(10),
}).strict().superRefine((value, context) => {
  if (sha256Canonical(value.records) !== value.recordPoolSha256) {
    context.addIssue({
      code: "custom",
      message: "record pool hash does not match the actual ordered pool",
      path: ["recordPoolSha256"],
    });
  }
  const recordIds = value.records.map((entry) => entry.recordId);
  if (new Set(recordIds).size !== recordIds.length) {
    context.addIssue({ code: "custom", message: "record IDs must be unique", path: ["records"] });
  }
  const probeIds = value.probes.map((entry) => entry.probeId);
  if (new Set(probeIds).size !== probeIds.length) {
    context.addIssue({ code: "custom", message: "probe IDs must be unique", path: ["probes"] });
  }
  const sessionIds = value.sourceSessions.map((entry) => entry.sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) {
    context.addIssue({
      code: "custom",
      message: "source session IDs must be unique",
      path: ["sourceSessions"],
    });
  }
});

export const sharedExecutorPackSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  split: benchmarkSplitSchema,
  timelines: z.array(sharedTimelineInputSchema).min(1).max(12),
}).strict();

const answerAtomSchema = z.object({
  key: identifier,
  value: z.string().min(1).max(1_024),
}).strict();

const probeGoldenSchema = z.object({
  probeId: identifier,
  probeType: probeTypeSchema,
  querySurfaceFamilyId: identifier,
  judgment: z.enum(["must_answer", "must_abstain", "baseline_parity_control"]),
  languageProfile: z.enum(["zh_to_en", "en_to_zh", "zh_to_zh", "en_to_en"]),
  retrievalProfile: z.enum([
    "lexical_strong",
    "semantic_paraphrase",
    "cross_lingual",
    "multi_evidence",
    "filtered_negative",
    "insufficient_evidence",
  ]),
  requiredEvidenceGroups: z.array(z.array(evidenceRef).min(1).max(8)).max(8),
  admissiblePartialEvidenceRefs: z.array(evidenceRef).max(16),
  forbiddenEvidenceRefs: z.array(evidenceRef).max(16),
  answerAtoms: z.array(answerAtomSchema).max(8),
  expectedAction: z.enum(["answer", "abstain"]),
  abstentionReason: z.enum([
    "no_evidence",
    "near_miss_only",
    "filtered_target_only",
    "incomplete_evidence",
  ]).nullable(),
}).strict().superRefine((value, context) => {
  const required = new Set(value.requiredEvidenceGroups.flat());
  const partial = new Set(value.admissiblePartialEvidenceRefs);
  const forbidden = new Set(value.forbiddenEvidenceRefs);
  if ([...required].some((entry) => partial.has(entry) || forbidden.has(entry)) ||
      [...partial].some((entry) => forbidden.has(entry))) {
    context.addIssue({
      code: "custom",
      message: "required, partial, and forbidden evidence sets must be disjoint",
    });
  }
  if (value.judgment === "must_answer") {
    if (
      value.requiredEvidenceGroups.length === 0 ||
      value.answerAtoms.length === 0 ||
      value.expectedAction !== "answer" ||
      value.abstentionReason !== null
    ) {
      context.addIssue({ code: "custom", message: "must-answer golden is incomplete" });
    }
  } else if (value.judgment === "must_abstain") {
    if (
      value.requiredEvidenceGroups.length !== 0 ||
      value.answerAtoms.length !== 0 ||
      value.expectedAction !== "abstain" ||
      value.abstentionReason === null
    ) {
      context.addIssue({ code: "custom", message: "must-abstain golden is inconsistent" });
    }
  }
});

const timelineGoldenSchema = z.object({
  timelineId: identifier,
  scenarioFamilyId: identifier,
  sourceCohortId: identifier,
  independenceUnitId: identifier,
  receiptPressure: z.enum(["low_unique", "medium_shared_evidence", "high_duplicate_claims"]),
  memoryDensity: z.enum(["small_128", "medium_384", "large_1024"]),
  probes: z.array(probeGoldenSchema).length(10),
}).strict();

export const sharedGoldenPackSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  split: benchmarkSplitSchema,
  timelines: z.array(timelineGoldenSchema).min(1).max(12),
}).strict();

const familyCardSchema = z.object({
  timelineId: identifier,
  split: benchmarkSplitSchema,
  scenarioFamilyId: identifier,
  sourceCohortId: identifier,
  independenceUnitId: identifier,
  parentTaskDomain: identifier,
  semanticTopicKey: identifier,
  semanticSummary: z.string().min(1).max(1_024),
  entityKeys: z.array(identifier).min(2).max(16),
  provenance: z.literal("curated_synthetic_structured_timeline"),
  semanticReview: z.literal("author_reviewed_not_independent"),
  candidateSourceVisibleToAuthor: z.literal(true),
  candidateSharedOutputsSeenBeforeSeal: z.literal(false),
}).strict();

export const sharedFamilyRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  cards: z.array(familyCardSchema).min(1).max(24),
}).strict();

const fileIdentitySchema = z.object({
  bytes: z.number().int().positive(),
  sha256,
}).strict();

export const sharedProtocolSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  design: z.object({
    timelineCount: z.literal(24),
    probesPerTimeline: z.literal(10),
    answerablePerTimeline: z.literal(6),
    abstentionPerTimeline: z.literal(4),
    developmentTimelines: z.literal(6),
    calibrationTimelines: z.literal(6),
    evaluationTimelines: z.literal(12),
  }).strict(),
  arms: z.tuple([
    z.literal("fts_recency_plus_projection"),
    z.literal("local_embedding_plus_projection"),
    z.literal("fts_recency_plus_context_fold"),
    z.literal("local_embedding_plus_context_fold"),
  ]),
  primaryMetrics: z.tuple([
    z.literal("macro_grounded_success"),
    z.literal("support_set_recall_at_5"),
    z.literal("all_support_found_at_10"),
    z.literal("retrieval_aurc"),
    z.literal("forbidden_hit_count"),
    z.literal("context_tokens"),
  ]),
  operatingPointContract: z.object({
    thresholdDomain: z.literal("all_observed_top100_similarity_micros_plus_reject_all"),
    minimumMacroSupportRecallAt5DeltaMicros: z.literal(100_000),
    minimumMacroAllSupportFoundAt10DeltaMicros: z.literal(0),
    maximumCandidateAddedMustAbstainTop5Cases: z.literal(0),
    maximumCandidateAddedForbiddenTop5Cases: z.literal(0),
    maximumProjectionSecurityFailures: z.literal(0),
    selectionOrder: z.tuple([
      z.literal("eligible_first"),
      z.literal("macro_support_recall_at_5_desc"),
      z.literal("macro_all_support_found_at_10_desc"),
      z.literal("threshold_desc"),
    ]),
    diagnosticSelectionOrder: z.tuple([
      z.literal("projection_security_failures_asc"),
      z.literal("candidate_added_must_abstain_top_5_cases_asc"),
      z.literal("candidate_added_forbidden_top_5_cases_asc"),
      z.literal("macro_support_recall_at_5_desc"),
      z.literal("macro_all_support_found_at_10_desc"),
      z.literal("threshold_desc"),
    ]),
    readerDiagnosticAllowedWhenRetrievalRefuted: z.literal(true),
    foldingSelectionRule: z.literal("candidate_tokens_lte_75_percent_and_bytes_not_greater"),
    readerRequiredBeforeEvaluation: z.literal(true),
    minimumReaderMustAnswerGroundedSuccessCasesPerArm: z.literal(1),
    maximumReaderInvalidArms: z.literal(0),
    maximumReaderSecurityRegressions: z.literal(0),
    maximumFoldReaderGroundedRegressionCases: z.literal(0),
  }).strict(),
  independenceUnit: z.literal("timeline"),
  evaluationPolicy: z.literal("one_shot_then_reveal_and_downgrade_to_known_regression"),
  scorePolicy: z.literal("stage_specific_no_single_composite_winner"),
}).strict();

export const candidateFreezeSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  freezeRole: z.literal("pre_calibration_implementation_freeze"),
  frozenAt: z.string().datetime({ offset: true }),
  sourceCommit: z.null(),
  sourceState: z.literal("working_tree_not_promotion_eligible"),
  contextFoldingImplementationSha256: sha256,
  localEmbeddingImplementationSha256: sha256,
  candidateImplementationsFrozen: z.literal(true),
  sharedCalibrationRunState: z.literal("not_run"),
  sharedOperatingPointState: z.literal("not_selected_before_shared_calibration"),
  evaluationExecutionFreezeRequired: z.literal(true),
  candidateSharedOutputsSeenBeforeFreeze: z.literal(false),
  authoringBlindness: z.literal("not_proven_method_aware"),
  runtimeBlindnessRequiredForEvaluation: z.literal(true),
  promotionEvidenceAllowed: z.literal(false),
}).strict();

export const evaluationCommitmentSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  packId: identifier,
  createdAt: z.string().datetime({ offset: true }),
  state: z.literal("committed_unrevealed"),
  commitmentDomain: z.literal("bornagent-fal-memory-shared-v1-evaluation-pack"),
  saltedPackCommitmentSha256: sha256,
  nonceBytes: z.literal(32),
  candidateFreezeSha256: sha256,
  protocolSha256: sha256,
  timelineCount: z.literal(12),
  probeCount: z.literal(120),
  answerableCount: z.literal(72),
  abstentionCount: z.literal(48),
  workerMountPolicy: z.literal("evaluation_input_only_no_repo_no_goldens_no_network"),
  revealPolicy: z.literal("publish_nonce_pack_observations_and_receipt_after_first_run"),
}).strict();

const publicFilesSchema = z.object({
  "protocol.json": fileIdentitySchema,
  "candidate-freeze.json": fileIdentitySchema,
  "family-registry.json": fileIdentitySchema,
  "development-inputs.json": fileIdentitySchema,
  "development-goldens.json": fileIdentitySchema,
  "calibration-inputs.json": fileIdentitySchema,
  "calibration-goldens.json": fileIdentitySchema,
  "evaluation-commitment.json": fileIdentitySchema,
}).strict();

export const sharedPublicManifestSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal(SHARED_MEMORY_BENCHMARK_ID),
  evidenceState: z.literal("public_dev_calibration_with_unrevealed_evaluation_commitment"),
  createdAt: z.string().datetime({ offset: true }),
  files: publicFilesSchema,
  manifestSha256: sha256,
}).strict();

export type BenchmarkSplit = typeof benchmarkSplits[number];
export type SharedExecutorPack = Readonly<z.infer<typeof sharedExecutorPackSchema>>;
export type SharedGoldenPack = Readonly<z.infer<typeof sharedGoldenPackSchema>>;
export type SharedFamilyRegistry = Readonly<z.infer<typeof sharedFamilyRegistrySchema>>;
export type SharedPublicManifest = Readonly<z.infer<typeof sharedPublicManifestSchema>>;

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedExact(value: string): string {
  return value.normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function parseEvidence(value: string): Readonly<{
  claimId: string | null;
  kind: "record" | "receipt";
  primaryId: string;
}> {
  const [kind, primaryId, claimId] = value.split(":");
  if ((kind !== "record" && kind !== "receipt") || primaryId === undefined) {
    throw new Error(`invalid shared benchmark evidence ref: ${value}`);
  }
  return Object.freeze({
    claimId: claimId ?? null,
    kind,
    primaryId,
  });
}

function recordIsEligible(
  record: z.infer<typeof memoryRecordSchema>,
  timeline: z.infer<typeof sharedTimelineInputSchema>,
): boolean {
  return record.repositoryId === timeline.repositoryId &&
    record.principalId === timeline.principalId &&
    record.sourceStatus === "available" &&
    record.lifecycle !== "explicit_retracted" &&
    record.lifecycle !== "explicit_superseded";
}

function verifyEvidenceReference(
  value: string,
  timeline: z.infer<typeof sharedTimelineInputSchema>,
  mustBeEligible: boolean,
): void {
  const parsed = parseEvidence(value);
  if (parsed.kind === "record") {
    const record = timeline.records.find((entry) => entry.recordId === parsed.primaryId);
    if (record === undefined) throw new Error(`missing evidence record ${value}`);
    if (mustBeEligible && !recordIsEligible(record, timeline)) {
      throw new Error(`required evidence record is not eligible: ${value}`);
    }
    return;
  }
  const receipt = timeline.acceptedChildReceipts.find(
    (entry) => entry.delegationId === parsed.primaryId,
  );
  const claim = receipt?.verifiedClaims.find((entry) => entry.claimId === parsed.claimId);
  if (receipt === undefined || claim === undefined) {
    throw new Error(`missing receipt evidence ${value}`);
  }
}

function validateSplit(
  executor: SharedExecutorPack,
  goldens: SharedGoldenPack,
  registry: SharedFamilyRegistry,
): void {
  if (executor.split !== goldens.split) throw new Error("executor/golden split mismatch");
  const expectedTimelineCount = executor.split === "evaluation" ? 12 : 6;
  if (executor.timelines.length !== expectedTimelineCount ||
      goldens.timelines.length !== expectedTimelineCount) {
    throw new Error(`${executor.split} timeline count mismatch`);
  }
  const cards = registry.cards.filter((entry) => entry.split === executor.split);
  if (cards.length !== expectedTimelineCount) {
    throw new Error(`${executor.split} family registry count mismatch`);
  }
  for (let index = 0; index < executor.timelines.length; index += 1) {
    const timeline = executor.timelines[index];
    const timelineGolden = goldens.timelines[index];
    if (timeline === undefined || timelineGolden === undefined ||
        timeline.timelineId !== timelineGolden.timelineId) {
      throw new Error(`${executor.split} timeline/golden order mismatch`);
    }
    const card = cards.find((entry) => entry.timelineId === timeline.timelineId);
    if (card === undefined ||
        card.scenarioFamilyId !== timelineGolden.scenarioFamilyId ||
        card.sourceCohortId !== timelineGolden.sourceCohortId ||
        card.independenceUnitId !== timelineGolden.independenceUnitId) {
      throw new Error(`${timeline.timelineId} family registry mismatch`);
    }
    const expectedDensity = timelineGolden.memoryDensity === "small_128"
      ? 128
      : timelineGolden.memoryDensity === "medium_384" ? 384 : 1_024;
    if (timeline.records.length !== expectedDensity) {
      throw new Error(`${timeline.timelineId} memory density mismatch`);
    }
    const probeTypes = timelineGolden.probes.map((entry) => entry.probeType);
    if (new Set(probeTypes).size !== sharedProbeTypes.length ||
        sharedProbeTypes.some((entry) => !probeTypes.includes(entry))) {
      throw new Error(`${timeline.timelineId} does not contain the ten required probe types`);
    }
    const mustAnswer = timelineGolden.probes.filter((entry) => entry.judgment === "must_answer");
    const mustAbstain = timelineGolden.probes.filter((entry) => entry.judgment === "must_abstain");
    if (mustAnswer.length !== 6 || mustAbstain.length !== 4 ||
        timelineGolden.probes.some((entry) => entry.judgment === "baseline_parity_control")) {
      throw new Error(`${timeline.timelineId} judgment distribution is not 6/4 absolute quality`);
    }
    for (let probeIndex = 0; probeIndex < timeline.probes.length; probeIndex += 1) {
      const inputProbe = timeline.probes[probeIndex];
      const golden = timelineGolden.probes[probeIndex];
      if (inputProbe === undefined || golden === undefined || inputProbe.probeId !== golden.probeId) {
        throw new Error(`${timeline.timelineId} probe/golden order mismatch`);
      }
      if (golden.querySurfaceFamilyId.startsWith(`${executor.split}-`)) {
        throw new Error("query surface family IDs may not be manufactured from split prefixes");
      }
      if (golden.judgment === "must_answer") {
        golden.requiredEvidenceGroups.flat().forEach((entry) =>
          verifyEvidenceReference(entry, timeline, true));
      }
      golden.admissiblePartialEvidenceRefs.forEach((entry) =>
        verifyEvidenceReference(entry, timeline, false));
      golden.forbiddenEvidenceRefs.forEach((entry) =>
        verifyEvidenceReference(entry, timeline, false));
      if (golden.probeType === "filtered_scope_or_lifecycle") {
        const filteredRecords = golden.forbiddenEvidenceRefs.map(parseEvidence)
          .filter((entry) => entry.kind === "record")
          .map((entry) => timeline.records.find((record) => record.recordId === entry.primaryId));
        if (filteredRecords.length === 0 ||
            filteredRecords.some((entry) => entry === undefined || recordIsEligible(entry, timeline))) {
          throw new Error(`${golden.probeId} lacks a real filtered forbidden target`);
        }
      }
      if (golden.probeType === "incomplete_evidence_chain" &&
          golden.admissiblePartialEvidenceRefs.length === 0) {
        throw new Error(`${golden.probeId} lacks admissible partial evidence`);
      }
    }
  }
}

export function validateSharedSplitContract(
  executorInput: unknown,
  goldenInput: unknown,
  registryInput: unknown,
): void {
  validateSplit(
    sharedExecutorPackSchema.parse(executorInput),
    sharedGoldenPackSchema.parse(goldenInput),
    sharedFamilyRegistrySchema.parse(registryInput),
  );
}

export function validateSharedFamilyRegistryDisjoint(registryInput: unknown): void {
  const registry = sharedFamilyRegistrySchema.parse(registryInput);
  const fields = [
    registry.cards.map((entry) => entry.scenarioFamilyId),
    registry.cards.map((entry) => entry.sourceCohortId),
    registry.cards.map((entry) => entry.independenceUnitId),
    registry.cards.map((entry) => entry.semanticTopicKey),
  ];
  for (const values of fields) {
    if (new Set(values).size !== values.length) {
      throw new Error("shared benchmark family registry is not group-disjoint");
    }
  }
  if (registry.cards.some((entry) =>
    /^(?:development|calibration|evaluation)-/u.test(entry.scenarioFamilyId))) {
    throw new Error("scenario family IDs may not be split-prefixed");
  }
}

export function validateSharedQuerySurfaceDisjoint(
  goldenInputs: readonly unknown[],
): void {
  const packs = goldenInputs.map((entry) => sharedGoldenPackSchema.parse(entry));
  const bySplit = new Map<BenchmarkSplit, Set<string>>();
  for (const pack of packs) {
    const surfaces = bySplit.get(pack.split) ?? new Set<string>();
    for (const probe of pack.timelines.flatMap((timeline) => timeline.probes)) {
      surfaces.add(probe.querySurfaceFamilyId);
    }
    bySplit.set(pack.split, surfaces);
  }
  const splits = [...bySplit.entries()];
  for (let leftIndex = 0; leftIndex < splits.length; leftIndex += 1) {
    const left = splits[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < splits.length; rightIndex += 1) {
      const right = splits[rightIndex];
      if (right === undefined) continue;
      if ([...left[1]].some((entry) => right[1].has(entry))) {
        throw new Error(`shared benchmark query surface families overlap: ${left[0]}/${right[0]}`);
      }
    }
  }
}

export async function loadSharedExecutorSplit(
  repositoryRoot: string,
  split: BenchmarkSplit,
): Promise<SharedExecutorPack> {
  const path = join(
    repositoryRoot,
    SHARED_MEMORY_FIXTURE_DIRECTORY,
    `${split}-inputs.json`,
  );
  return Object.freeze(sharedExecutorPackSchema.parse(
    parseStrictJson(await readFile(path, "utf8")),
  ));
}

export async function loadSharedScoringSplit(
  repositoryRoot: string,
  split: BenchmarkSplit,
): Promise<SharedGoldenPack> {
  const path = join(
    repositoryRoot,
    SHARED_MEMORY_FIXTURE_DIRECTORY,
    `${split}-goldens.json`,
  );
  return Object.freeze(sharedGoldenPackSchema.parse(
    parseStrictJson(await readFile(path, "utf8")),
  ));
}

export async function loadAndValidatePublicSharedBenchmark(repositoryRoot: string): Promise<Readonly<{
  calibration: SharedExecutorPack;
  development: SharedExecutorPack;
  manifest: SharedPublicManifest;
  registry: SharedFamilyRegistry;
}>> {
  const directory = join(repositoryRoot, SHARED_MEMORY_FIXTURE_DIRECTORY);
  const manifest = sharedPublicManifestSchema.parse(
    parseStrictJson(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  const { manifestSha256, ...manifestContent } = manifest;
  if (sha256Canonical(manifestContent) !== manifestSha256) {
    throw new Error("shared benchmark manifest logical hash mismatch");
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(directory, path));
    if (bytes.byteLength !== expected.bytes || rawSha256(bytes) !== expected.sha256) {
      throw new Error(`shared benchmark public file identity mismatch: ${path}`);
    }
  }
  const protocol = sharedProtocolSchema.parse(
    parseStrictJson(await readFile(join(directory, "protocol.json"), "utf8")),
  );
  void protocol;
  const freezeBytes = await readFile(join(directory, "candidate-freeze.json"));
  candidateFreezeSchema.parse(parseStrictJson(freezeBytes.toString("utf8")));
  const commitment = evaluationCommitmentSchema.parse(
    parseStrictJson(await readFile(join(directory, "evaluation-commitment.json"), "utf8")),
  );
  if (commitment.candidateFreezeSha256 !== rawSha256(freezeBytes)) {
    throw new Error("evaluation commitment does not bind candidate freeze bytes");
  }
  const protocolBytes = await readFile(join(directory, "protocol.json"));
  if (commitment.protocolSha256 !== rawSha256(protocolBytes)) {
    throw new Error("evaluation commitment does not bind protocol bytes");
  }
  const registry = sharedFamilyRegistrySchema.parse(
    parseStrictJson(await readFile(join(directory, "family-registry.json"), "utf8")),
  );
  const [development, developmentGoldens, calibration, calibrationGoldens] =
    await Promise.all([
      loadSharedExecutorSplit(repositoryRoot, "development"),
      loadSharedScoringSplit(repositoryRoot, "development"),
      loadSharedExecutorSplit(repositoryRoot, "calibration"),
      loadSharedScoringSplit(repositoryRoot, "calibration"),
    ]);
  validateSplit(development, developmentGoldens, registry);
  validateSplit(calibration, calibrationGoldens, registry);

  validateSharedFamilyRegistryDisjoint(registry);
  validateSharedQuerySurfaceDisjoint([developmentGoldens, calibrationGoldens]);
  const developmentText = new Set(development.timelines.flatMap((timeline) => [
    ...timeline.records.flatMap((record) => [
      normalizedExact(record.title),
      normalizedExact(record.text),
    ]),
    ...timeline.probes.map((probe) => normalizedExact(probe.query)),
  ]));
  const calibrationText = calibration.timelines.flatMap((timeline) => [
    ...timeline.records.flatMap((record) => [
      normalizedExact(record.title),
      normalizedExact(record.text),
    ]),
    ...timeline.probes.map((probe) => normalizedExact(probe.query)),
  ]);
  if (calibrationText.some((entry) => developmentText.has(entry))) {
    throw new Error("development/calibration normalized text overlap is not zero");
  }
  return Object.freeze({ calibration, development, manifest, registry });
}
