import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";

export const FAL_EM0_EXPERIMENT_ID =
  "fal-em0-local-embedding-hybrid-v1" as const;
export const FAL_EM0_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal-em0-local-embedding-v1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const caseId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96);
const recordKey = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96);
const boundedText = z.string().min(1).max(4_096).refine(
  (value) => Buffer.byteLength(value, "utf8") <= 4_096,
  "fixture text exceeds its UTF-8 byte bound",
);

export const falEm0CategorySchema = z.enum([
  "exact_phrase_lexical",
  "chinese_semantic",
  "english_semantic",
  "cross_lingual",
  "temporal_update_conflict",
  "negative_abstention_collision",
  "security_scope_freshness_poison",
]);

const falEm0RecordSchema = z.object({
  key: recordKey,
  text: boundedText,
  occurredAt: z.string().datetime({ offset: true }),
  scope: z.enum(["current", "foreign_repository", "foreign_principal"]).default("current"),
  sourceStatus: z.enum(["available", "stale"]).default("available"),
  lifecycle: z.enum([
    "episode_active",
    "explicit_active",
    "explicit_retracted",
    "explicit_superseded",
    "explicit_current",
  ]).default("episode_active"),
  revisionGroup: recordKey.nullable().default(null),
}).strict().superRefine((value, context) => {
  const grouped = value.lifecycle === "explicit_superseded" ||
    value.lifecycle === "explicit_current";
  if (grouped !== (value.revisionGroup !== null)) {
    context.addIssue({
      code: "custom",
      message: "only superseded/current explicit records use revisionGroup",
      path: ["revisionGroup"],
    });
  }
  if (value.lifecycle !== "episode_active" && value.scope !== "current") {
    context.addIssue({
      code: "custom",
      message: "foreign-scope fixtures use immutable episode records",
      path: ["scope"],
    });
  }
});

const falEm0QuerySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("text"),
    value: z.string().max(1_024).refine(
      (value) => Buffer.byteLength(value, "utf8") <= 1_024,
      "fixture query exceeds the ML2 UTF-8 byte bound",
    ),
  }).strict(),
  z.object({
    mode: z.literal("exact_record"),
    targetRecordKey: recordKey,
  }).strict(),
]);

const falEm0ExpectedSchema = z.object({
  relevantRecordKeys: z.array(recordKey).max(8),
  forbiddenRecordKeys: z.array(recordKey).max(8),
  expectedAbstention: z.boolean(),
  expectedQueryKind: z.enum(["exact_id", "lexical", "quoted_phrase"]),
  baselineRequirement: z.enum(["must_find_relevant", "must_abstain", "observe_quality"]),
  requireTop1: z.boolean().default(false),
  entryGateEligible: z.boolean(),
  actionParameter: z.object({
    expected: boundedText,
    forbidden: boundedText,
  }).strict().nullable().default(null),
  lexicalGapReason: z.enum([
    "no_literal_term_overlap",
    "lexical_collision",
  ]).nullable().default(null),
}).strict();

export const falEm0CaseSchema = z.object({
  caseId,
  class: z.enum(["representative", "security", "stress"]),
  split: z.enum(["calibration", "evaluation"]),
  category: falEm0CategorySchema,
  query: falEm0QuerySchema,
  records: z.array(falEm0RecordSchema).min(3).max(12),
  expected: falEm0ExpectedSchema,
}).strict().superRefine((value, context) => {
  const keys = value.records.map((record) => record.key);
  const keySet = new Set(keys);
  if (keySet.size !== keys.length) {
    context.addIssue({ code: "custom", message: "record keys must be unique", path: ["records"] });
  }
  const expectedKeys = [
    ...value.expected.relevantRecordKeys,
    ...value.expected.forbiddenRecordKeys,
  ];
  for (const key of expectedKeys) {
    if (!keySet.has(key)) {
      context.addIssue({
        code: "custom",
        message: "expected record key is missing from the case",
        path: ["expected"],
      });
    }
  }
  if (value.expected.relevantRecordKeys.some((key) =>
    value.expected.forbiddenRecordKeys.includes(key))) {
    context.addIssue({
      code: "custom",
      message: "relevant and forbidden record keys must be disjoint",
      path: ["expected"],
    });
  }
  if (
    value.query.mode === "exact_record" &&
    !keySet.has(value.query.targetRecordKey)
  ) {
    context.addIssue({
      code: "custom",
      message: "exact query target is missing from the case",
      path: ["query", "targetRecordKey"],
    });
  }
  if (
    value.query.mode === "exact_record" &&
    value.expected.expectedQueryKind !== "exact_id"
  ) {
    context.addIssue({
      code: "custom",
      message: "exact record query must expect exact_id",
      path: ["expected", "expectedQueryKind"],
    });
  }
  if (
    value.expected.baselineRequirement === "must_abstain" &&
    !value.expected.expectedAbstention
  ) {
    context.addIssue({
      code: "custom",
      message: "must_abstain cases must expect abstention",
      path: ["expected", "expectedAbstention"],
    });
  }
  if (
    value.expected.baselineRequirement === "must_find_relevant" &&
    value.expected.relevantRecordKeys.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "must_find_relevant cases require a relevant record",
      path: ["expected", "relevantRecordKeys"],
    });
  }
  if (
    value.expected.entryGateEligible &&
    (
      value.split !== "evaluation" ||
      !["chinese_semantic", "english_semantic", "cross_lingual"].includes(value.category) ||
      value.expected.lexicalGapReason === null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "entry-gate cases must be evaluation semantic cases with a gap reason",
      path: ["expected", "entryGateEligible"],
    });
  }
  const grouped = new Map<string, typeof value.records>();
  for (const record of value.records) {
    if (record.revisionGroup === null) continue;
    const entries = grouped.get(record.revisionGroup) ?? [];
    grouped.set(record.revisionGroup, [...entries, record]);
  }
  for (const [group, entries] of grouped) {
    if (
      entries.length !== 2 ||
      entries[0]?.lifecycle !== "explicit_superseded" ||
      entries[1]?.lifecycle !== "explicit_current"
    ) {
      context.addIssue({
        code: "custom",
        message: `revision group ${group} must contain ordered superseded/current records`,
        path: ["records"],
      });
    }
  }
});

export const FAL_EM0_CORPUS_CONTRACT = Object.freeze({
  schemaVersion: 1,
  caseCount: 36,
  categoryCounts: Object.freeze({
    exact_phrase_lexical: 6,
    chinese_semantic: 8,
    english_semantic: 4,
    cross_lingual: 4,
    temporal_update_conflict: 4,
    negative_abstention_collision: 4,
    security_scope_freshness_poison: 6,
  }),
  splitCounts: Object.freeze({ calibration: 8, evaluation: 28 }),
  evaluationSemanticCases: 12,
  minimumRepresentativeCases: 24,
  minimumActionSensitiveCases: 4,
  maximumStressCases: 6,
});

export const FAL_EM0_CORPUS_CONTRACT_SHA256 =
  sha256Canonical(FAL_EM0_CORPUS_CONTRACT);

export const falEm0CasePackSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(falEm0CaseSchema).length(FAL_EM0_CORPUS_CONTRACT.caseCount),
}).strict().superRefine((value, context) => {
  const ids = value.cases.map((entry) => entry.caseId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "case IDs must be unique", path: ["cases"] });
  }
  for (const [category, count] of Object.entries(FAL_EM0_CORPUS_CONTRACT.categoryCounts)) {
    if (value.cases.filter((entry) => entry.category === category).length !== count) {
      context.addIssue({
        code: "custom",
        message: `${category} must contain exactly ${String(count)} cases`,
        path: ["cases"],
      });
    }
  }
  for (const [split, count] of Object.entries(FAL_EM0_CORPUS_CONTRACT.splitCounts)) {
    if (value.cases.filter((entry) => entry.split === split).length !== count) {
      context.addIssue({
        code: "custom",
        message: `${split} must contain exactly ${String(count)} cases`,
        path: ["cases"],
      });
    }
  }
  const semantic = ["chinese_semantic", "english_semantic", "cross_lingual"];
  const evaluationSemantic = value.cases.filter((entry) =>
    entry.split === "evaluation" && semantic.includes(entry.category));
  if (
    evaluationSemantic.length !== FAL_EM0_CORPUS_CONTRACT.evaluationSemanticCases ||
    evaluationSemantic.some((entry) => !entry.expected.entryGateEligible)
  ) {
    context.addIssue({
      code: "custom",
      message: "all 12 evaluation semantic cases must be entry-gate eligible",
      path: ["cases"],
    });
  }
  const calibrationSemantic = value.cases.filter((entry) =>
    entry.split === "calibration" && semantic.includes(entry.category));
  const calibrationNegative = value.cases.filter((entry) =>
    entry.split === "calibration" &&
    entry.category === "negative_abstention_collision");
  const calibrationControl = value.cases.filter((entry) =>
    entry.split === "calibration" &&
    ["exact_phrase_lexical", "temporal_update_conflict"].includes(entry.category));
  if (
    calibrationSemantic.length !== 4 ||
    calibrationNegative.length !== 2 ||
    calibrationControl.length !== 2
  ) {
    context.addIssue({
      code: "custom",
      message: "calibration split must be 4 semantic, 2 negative, and 2 control cases",
      path: ["cases"],
    });
  }
  if (value.cases.filter((entry) => entry.class === "representative").length <
    FAL_EM0_CORPUS_CONTRACT.minimumRepresentativeCases) {
    context.addIssue({
      code: "custom",
      message: "case pack has too few representative cases",
      path: ["cases"],
    });
  }
  if (value.cases.filter((entry) => entry.class === "stress").length >
    FAL_EM0_CORPUS_CONTRACT.maximumStressCases) {
    context.addIssue({
      code: "custom",
      message: "case pack has too many stress cases",
      path: ["cases"],
    });
  }
  if (value.cases.filter((entry) => entry.expected.actionParameter !== null).length <
    FAL_EM0_CORPUS_CONTRACT.minimumActionSensitiveCases) {
    context.addIssue({
      code: "custom",
      message: "case pack requires four action-sensitive cases",
      path: ["cases"],
    });
  }
  if (value.cases.some((entry) =>
    entry.category === "security_scope_freshness_poison" &&
    (entry.split !== "evaluation" || entry.class !== "security"))) {
    context.addIssue({
      code: "custom",
      message: "all security cases must remain blind evaluation cases",
      path: ["cases"],
    });
  }
});

export const falEm0ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_EM0_EXPERIMENT_ID),
  casePackRef: z.literal("cases.json"),
  casePackSha256: sha256,
  caseIds: z.array(caseId).length(FAL_EM0_CORPUS_CONTRACT.caseCount),
  calibrationCaseIds: z.array(caseId).length(FAL_EM0_CORPUS_CONTRACT.splitCounts.calibration),
  evaluationCaseIds: z.array(caseId).length(FAL_EM0_CORPUS_CONTRACT.splitCounts.evaluation),
  corpusContractSha256: z.literal(FAL_EM0_CORPUS_CONTRACT_SHA256),
  manifestSha256: sha256,
}).strict();

export type FalEm0CaseV1 = Readonly<z.infer<typeof falEm0CaseSchema>>;
export type FalEm0CasePackV1 = Readonly<z.infer<typeof falEm0CasePackSchema>>;
export type FalEm0ManifestV1 = Readonly<z.infer<typeof falEm0ManifestSchema>>;

export interface LoadedFalEm0CorpusV1 {
  readonly casePack: FalEm0CasePackV1;
  readonly manifest: FalEm0ManifestV1;
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function falEm0ManifestLogicalIdentity(
  manifest: Omit<FalEm0ManifestV1, "manifestSha256">,
): string {
  return sha256Canonical(manifest);
}

export async function loadFalEm0Corpus(
  repositoryRoot: string,
): Promise<LoadedFalEm0CorpusV1> {
  const directory = join(repositoryRoot, FAL_EM0_FIXTURE_DIRECTORY);
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = falEm0ManifestSchema.parse(
    parseStrictJson(manifestBytes.toString("utf8")),
  );
  const casePackBytes = await readFile(join(directory, manifest.casePackRef));
  if (rawSha256(casePackBytes) !== manifest.casePackSha256) {
    throw new Error("FAL-EM0 case pack does not match its manifest hash");
  }
  const casePack = falEm0CasePackSchema.parse(
    parseStrictJson(casePackBytes.toString("utf8")),
  );
  const { manifestSha256, ...logicalManifest } = manifest;
  if (falEm0ManifestLogicalIdentity(logicalManifest) !== manifestSha256) {
    throw new Error("FAL-EM0 manifest logical hash is invalid");
  }
  const caseIds = casePack.cases.map((entry) => entry.caseId);
  const calibrationCaseIds = casePack.cases
    .filter((entry) => entry.split === "calibration")
    .map((entry) => entry.caseId);
  const evaluationCaseIds = casePack.cases
    .filter((entry) => entry.split === "evaluation")
    .map((entry) => entry.caseId);
  if (
    manifest.caseIds.some((id, index) => id !== caseIds[index]) ||
    manifest.calibrationCaseIds.some((id, index) => id !== calibrationCaseIds[index]) ||
    manifest.evaluationCaseIds.some((id, index) => id !== evaluationCaseIds[index])
  ) {
    throw new Error("FAL-EM0 manifest case order does not match cases.json");
  }
  return Object.freeze({ casePack, manifest });
}
