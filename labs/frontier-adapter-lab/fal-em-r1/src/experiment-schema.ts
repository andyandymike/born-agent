import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

export const EM_R1_EXPERIMENT_ID = "fal-em-r1-selective-hybrid-v2" as const;
export const EM_R1_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal-em-r1-selective-hybrid-v2" as const;
export const EM_R1_MODEL_ID = "Xenova/multilingual-e5-small" as const;
export const EM_R1_MODEL_REVISION =
  "761b726dd34fb83930e26aab4e9ac3899aa1fa78" as const;
export const EM_R1_HISTORICAL_THRESHOLD_MICROS = 780_000;
export const EM_R1_RRF_K = 60;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(128);
const boundedText = z.string().min(1).max(8_192);

export const emR1PoolRowSchema = z.object({
  key: identifier,
  title: boundedText,
  text: boundedText,
  occurredAt: z.string().datetime({ offset: true }),
  scope: z.enum(["current", "foreign_repository", "foreign_principal"]),
  sourceStatus: z.enum(["available", "stale", "tampered", "unavailable"]),
  lifecycle: z.enum([
    "episode_active",
    "explicit_active",
    "explicit_retracted",
    "explicit_superseded",
    "explicit_current",
  ]),
  revisionGroup: identifier.nullable(),
  actionParameters: z.record(z.string(), z.string()).nullable(),
}).strict().superRefine((value, context) => {
  const grouped = value.lifecycle === "explicit_superseded" ||
    value.lifecycle === "explicit_current";
  if (grouped !== (value.revisionGroup !== null)) {
    context.addIssue({
      code: "custom",
      message: "only superseded/current rows use revisionGroup",
      path: ["revisionGroup"],
    });
  }
  if (value.scope !== "current" && value.lifecycle !== "episode_active") {
    context.addIssue({
      code: "custom",
      message: "foreign-scope rows must be immutable episodes",
      path: ["scope"],
    });
  }
});

export const emR1PoolSchema = z.object({
  schemaVersion: z.literal(2),
  experimentId: z.literal(EM_R1_EXPERIMENT_ID),
  split: z.enum(["calibration", "evaluation"]),
  rows: z.array(emR1PoolRowSchema).length(128),
}).strict().superRefine((value, context) => {
  const keys = value.rows.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "pool row keys must be unique", path: ["rows"] });
  }
  const groups = new Map<string, typeof value.rows>();
  for (const entry of value.rows) {
    if (entry.revisionGroup === null) continue;
    groups.set(entry.revisionGroup, [...(groups.get(entry.revisionGroup) ?? []), entry]);
  }
  for (const [group, entries] of groups) {
    if (
      entries.length !== 2 ||
      entries[0]?.lifecycle !== "explicit_superseded" ||
      entries[1]?.lifecycle !== "explicit_current"
    ) {
      context.addIssue({
        code: "custom",
        message: `revision group ${group} must be ordered superseded/current`,
        path: ["rows"],
      });
    }
  }
});

const querySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text"), value: z.string().min(1).max(1_024) }).strict(),
  z.object({ mode: z.literal("exact_record"), targetRecordKey: identifier }).strict(),
]);

export const emR1CaseSchema = z.object({
  caseId: identifier,
  split: z.enum(["calibration", "evaluation"]),
  class: z.enum(["representative", "security"]),
  category: z.enum([
    "semantic_answerable",
    "exact_control",
    "phrase_control",
    "temporal_control",
    "far_unrelated",
    "lexical_collision",
    "semantic_near_miss",
    "boilerplate_collision",
    "filtered_target_abstention",
  ]),
  scenarioFamilyId: identifier,
  queryTemplateId: identifier,
  distractorPoolId: identifier,
  query: querySchema,
  filteredTargetKind: z.enum([
    "wrong_repository",
    "wrong_principal",
    "stale_source",
    "tampered_source",
    "unavailable_source",
    "retracted",
    "superseded",
    "no_current_revision",
  ]).nullable(),
  golden: z.object({
    answerability: z.enum(["answerable", "must_abstain"]),
    allowedRelevantRecordKeys: z.array(identifier).max(8),
    forbiddenRecordKeys: z.array(identifier).max(8),
    expectedQueryRoute: z.enum(["exact_bypass", "lexical", "hybrid"]),
    requiredRank: z.union([z.literal(1), z.literal(5)]).nullable(),
    expectedCurrentRevisionKey: identifier.nullable(),
    expectedActionParametersSha256: sha256.nullable(),
  }).strict(),
}).strict();

export const emR1CasePackSchema = z.object({
  schemaVersion: z.literal(2),
  experimentId: z.literal(EM_R1_EXPERIMENT_ID),
  split: z.enum(["calibration", "evaluation"]),
  cases: z.array(emR1CaseSchema).length(48),
}).strict();

const fileIdentitySchema = z.object({ bytes: z.number().int().nonnegative(), sha256 }).strict();

export const emR1ManifestSchema = z.object({
  schemaVersion: z.literal(2),
  experimentId: z.literal(EM_R1_EXPERIMENT_ID),
  evidenceState: z.literal("working_tree_full"),
  createdAt: z.string().datetime({ offset: true }),
  corpusRevision: z.literal(2),
  dataFrozenBeforeCandidateImplementation: z.literal(false),
  freezeStage: z.literal("candidate_mechanism_frozen_before_corpus_revision_2_threshold_run"),
  revisionReason: z.literal("revision 1 failed the live FTS-empty adequacy preflight before evaluation"),
  supersededInvalidPreflightReceiptSha256: sha256,
  evaluationGoldensSealedUntilCalibrationEligible: z.literal(true),
  sourceCommit: z.null(),
  reimplementationMode: z.literal("reimplementation_from_v1_contract"),
  dataAdequacy: z.object({
    calibrationCases: z.literal(48),
    evaluationCases: z.literal(48),
    calibrationPoolRows: z.literal(128),
    evaluationPoolRows: z.literal(128),
    answerablePerSplit: z.literal(24),
    unanswerablePerSplit: z.literal(24),
    minimumFtsEmptyVectorNegativesPerSplit: z.literal(16),
    minimumEligibleDistractorsPerAbstentionCase: z.number().int().min(32),
    crossSplitScenarioFamilyOverlap: z.literal(0),
    crossSplitQueryTemplateOverlap: z.literal(0),
    crossSplitDistractorPoolOverlap: z.literal(0),
    normalizedTitleTextExactOverlap: z.literal(0),
  }).strict(),
  files: z.object({
    "prior-evidence-assessment.json": fileIdentitySchema,
    "reference-anchors.json": fileIdentitySchema,
    "calibration-pool.json": fileIdentitySchema,
    "calibration-cases.json": fileIdentitySchema,
    "evaluation-pool.json": fileIdentitySchema,
    "evaluation-cases.json": fileIdentitySchema,
  }).strict(),
  manifestSha256: sha256,
}).strict();

export type EmR1PoolRow = Readonly<z.infer<typeof emR1PoolRowSchema>>;
export type EmR1Pool = Readonly<z.infer<typeof emR1PoolSchema>>;
export type EmR1Case = Readonly<z.infer<typeof emR1CaseSchema>>;
export type EmR1CasePack = Readonly<z.infer<typeof emR1CasePackSchema>>;
export type EmR1Manifest = Readonly<z.infer<typeof emR1ManifestSchema>>;

export interface LoadedEmR1Split {
  readonly cases: EmR1CasePack;
  readonly manifest: EmR1Manifest;
  readonly pool: EmR1Pool;
}

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

function verifySplitContract(pool: EmR1Pool, cases: EmR1CasePack): void {
  if (pool.split !== cases.split) throw new Error("EM-R1 pool/case split mismatch");
  const rowKeys = new Set(pool.rows.map((entry) => entry.key));
  const caseIds = cases.cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) throw new Error("EM-R1 case IDs are not unique");
  const expectedCounts = Object.freeze({
    semantic_answerable: 16,
    exact_control: 2,
    phrase_control: 2,
    temporal_control: 4,
    far_unrelated: 4,
    lexical_collision: 4,
    semantic_near_miss: 4,
    boilerplate_collision: 4,
    filtered_target_abstention: 8,
  });
  for (const [category, count] of Object.entries(expectedCounts)) {
    if (cases.cases.filter((entry) => entry.category === category).length !== count) {
      throw new Error(`EM-R1 ${cases.split} ${category} count mismatch`);
    }
  }
  if (cases.cases.filter((entry) => entry.golden.answerability === "answerable").length !== 24 ||
      cases.cases.filter((entry) => entry.golden.answerability === "must_abstain").length !== 24) {
    throw new Error(`EM-R1 ${cases.split} answerability is not 24/24`);
  }
  for (const entry of cases.cases) {
    if (entry.split !== cases.split) throw new Error(`EM-R1 case ${entry.caseId} split mismatch`);
    const referenced = [
      ...entry.golden.allowedRelevantRecordKeys,
      ...entry.golden.forbiddenRecordKeys,
      ...(entry.golden.expectedCurrentRevisionKey === null
        ? []
        : [entry.golden.expectedCurrentRevisionKey]),
      ...(entry.query.mode === "exact_record" ? [entry.query.targetRecordKey] : []),
    ];
    if (referenced.some((key) => !rowKeys.has(key))) {
      throw new Error(`EM-R1 case ${entry.caseId} references a missing pool row`);
    }
    if (entry.golden.answerability === "answerable") {
      if (entry.golden.allowedRelevantRecordKeys.length === 0 || entry.golden.requiredRank === null) {
        throw new Error(`EM-R1 answerable case ${entry.caseId} lacks a rank-bound golden`);
      }
    } else if (
      entry.golden.allowedRelevantRecordKeys.length !== 0 ||
      entry.golden.requiredRank !== null
    ) {
      throw new Error(`EM-R1 abstention case ${entry.caseId} has an answerable golden`);
    }
  }
  const eligible = pool.rows.filter((entry) =>
    entry.scope === "current" && entry.sourceStatus === "available" &&
    !["explicit_retracted", "explicit_superseded"].includes(entry.lifecycle));
  if (eligible.length < 32) throw new Error(`EM-R1 ${cases.split} lacks eligible distractors`);
}

export async function loadEmR1Split(
  repositoryRoot: string,
  split: "calibration" | "evaluation",
): Promise<LoadedEmR1Split> {
  const directory = join(repositoryRoot, EM_R1_FIXTURE_DIRECTORY);
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = emR1ManifestSchema.parse(parseStrictJson(manifestBytes.toString("utf8")));
  const { manifestSha256, ...logicalManifest } = manifest;
  if (sha256Canonical(logicalManifest) !== manifestSha256) {
    throw new Error("EM-R1 logical manifest hash mismatch");
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(directory, path));
    if (bytes.byteLength !== expected.bytes || rawSha256(bytes) !== expected.sha256) {
      throw new Error(`EM-R1 fixture ${path} does not match its frozen identity`);
    }
  }
  const pool = emR1PoolSchema.parse(parseStrictJson(await readFile(
    join(directory, `${split}-pool.json`), "utf8",
  )));
  const cases = emR1CasePackSchema.parse(parseStrictJson(await readFile(
    join(directory, `${split}-cases.json`), "utf8",
  )));
  verifySplitContract(pool, cases);
  return Object.freeze({ cases, manifest, pool });
}

export async function validateEmR1CrossSplitCorpus(repositoryRoot: string): Promise<Readonly<{
  crossSplitDistractorPoolOverlap: number;
  crossSplitNormalizedTextOverlap: number;
  crossSplitQueryTemplateOverlap: number;
  crossSplitScenarioFamilyOverlap: number;
}>> {
  const [calibration, evaluation] = await Promise.all([
    loadEmR1Split(repositoryRoot, "calibration"),
    loadEmR1Split(repositoryRoot, "evaluation"),
  ]);
  const overlaps = (left: readonly string[], right: readonly string[]): number => {
    const known = new Set(left);
    return new Set(right.filter((entry) => known.has(entry))).size;
  };
  const result = Object.freeze({
    crossSplitDistractorPoolOverlap: overlaps(
      calibration.cases.cases.map((entry) => entry.distractorPoolId),
      evaluation.cases.cases.map((entry) => entry.distractorPoolId),
    ),
    crossSplitNormalizedTextOverlap: overlaps(
      calibration.pool.rows.flatMap((entry) =>
        [normalizedExact(entry.title), normalizedExact(entry.text)]),
      evaluation.pool.rows.flatMap((entry) =>
        [normalizedExact(entry.title), normalizedExact(entry.text)]),
    ),
    crossSplitQueryTemplateOverlap: overlaps(
      calibration.cases.cases.map((entry) => entry.queryTemplateId),
      evaluation.cases.cases.map((entry) => entry.queryTemplateId),
    ),
    crossSplitScenarioFamilyOverlap: overlaps(
      calibration.cases.cases.map((entry) => entry.scenarioFamilyId),
      evaluation.cases.cases.map((entry) => entry.scenarioFamilyId),
    ),
  });
  if (Object.values(result).some((entry) => entry !== 0)) {
    throw new Error("EM-R1 calibration/evaluation isolation contract failed");
  }
  return result;
}
