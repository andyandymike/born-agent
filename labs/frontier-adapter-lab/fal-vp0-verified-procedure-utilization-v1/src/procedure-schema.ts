import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { inspectMemoryAdmission } from "../../../../src/memory/episodes/memory-admission.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  FAL_VP0_HOST_FACT_EVALUATOR,
  boundedNfcText,
  hostFactValueSchema,
  identifierSchema,
  isStrictlySortedUnique,
  logicalIdentity,
  nonnegativeIntegerSchema,
  relativeArtifactRefSchema,
  sha256Schema,
} from "./protocol.js";

const procedureTextSchema = (maximumBytes: number) => boundedNfcText(maximumBytes)
  .refine((value) => !value.includes("\r"), "procedure text must use LF")
  .refine(
    (value) => !value.includes("BORNAGENT_UNTRUSTED_SKILL_CONTENT_V1"),
    "procedure text cannot contain the reserved Skill envelope marker",
  );

const sortedSha256ArraySchema = z.array(sha256Schema).max(256).superRefine((value, context) => {
  if (!isStrictlySortedUnique(value)) {
    context.addIssue({ code: "custom", message: "digest arrays must be sorted and unique" });
  }
});

export const falVp0LineageArtifactSchema = z.object({
  artifactId: identifierSchema,
  kind: z.enum([
    "workspace",
    "task",
    "generator",
    "template",
    "mutation",
    "verifier",
    "golden",
    "ancestry",
  ]),
  relativeRef: relativeArtifactRefSchema,
  rawFileSha256: sha256Schema,
}).strict();

export const falVp0LineageFingerprintsSchema = z.object({
  comparatorVersion: z.literal("fal-vp0-lineage-v1"),
  languageSurfaceSha256: sha256Schema,
  moduleTopologySha256: sha256Schema,
  failureMechanismSha256: sha256Schema,
  verificationMethodSha256: sha256Schema,
  changeSurfaceSha256: sha256Schema,
  targetSymbolElementSha256s: sortedSha256ArraySchema,
  literalElementSha256s: sortedSha256ArraySchema,
  expectedOutputElementSha256s: sortedSha256ArraySchema,
  allowedRepositoryConventionElementSha256s: sortedSha256ArraySchema,
  targetSymbolSetSha256: sha256Schema,
  literalSetSha256: sha256Schema,
  expectedOutputSetSha256: sha256Schema,
  allowedRepositoryConventionSetSha256: sha256Schema,
  solutionShapeSha256: sha256Schema,
  goldenDiffSha256: sha256Schema,
  derivationArtifacts: z.array(falVp0LineageArtifactSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  const sets = [
    ["targetSymbolSetSha256", value.targetSymbolSetSha256, value.targetSymbolElementSha256s],
    ["literalSetSha256", value.literalSetSha256, value.literalElementSha256s],
    ["expectedOutputSetSha256", value.expectedOutputSetSha256, value.expectedOutputElementSha256s],
    [
      "allowedRepositoryConventionSetSha256",
      value.allowedRepositoryConventionSetSha256,
      value.allowedRepositoryConventionElementSha256s,
    ],
  ] as const;
  for (const [field, actual, elements] of sets) {
    if (actual !== sha256Canonical(elements)) {
      context.addIssue({ code: "custom", message: `${field} does not bind its elements`, path: [field] });
    }
  }
  const ids = value.derivationArtifacts.map((entry) => entry.artifactId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "lineage artifact IDs must be unique" });
  }
});

export const falVp0SourceArtifactSchema = z.object({
  artifactId: identifierSchema,
  kind: z.enum([
    "session_range",
    "episode",
    "completion_evidence",
    "run_report",
    "verification",
    "source_state",
  ]),
  relativeRef: relativeArtifactRefSchema,
  bytes: nonnegativeIntegerSchema,
  rawFileSha256: sha256Schema,
  logicalSha256: sha256Schema.nullable(),
}).strict();

const sourceBindingContentSchema = z.object({
  schemaVersion: z.literal(1),
  sourceBindingId: identifierSchema,
  sourceMode: z.enum(["public_fixture", "trace_redacted"]),
  procedureFamilyId: identifierSchema,
  scenarioFamilyId: identifierSchema,
  templateLineageId: identifierSchema,
  solutionShapeId: identifierSchema,
  lineageFingerprints: falVp0LineageFingerprintsSchema,
  scope: z.object({
    ownerPrincipalId: identifierSchema,
    applicationRepositoryId: identifierSchema,
    canonicalRootIdentitySha256: sha256Schema,
  }).strict(),
  sourceIdentity: z.object({
    sessionId: identifierSchema,
    runId: identifierSchema,
  }).strict(),
  sessionRange: z.object({
    relativeRef: relativeArtifactRefSchema,
    startByte: nonnegativeIntegerSchema,
    endByte: nonnegativeIntegerSchema,
    rawSpanSha256: sha256Schema,
  }).strict(),
  artifacts: z.array(falVp0SourceArtifactSchema).min(6).max(32),
  episodeRecordId: identifierSchema,
  episodeRecordSha256: sha256Schema,
  taskInputSha256: sha256Schema,
  completionEvidenceSha256: sha256Schema,
  runReportSha256: sha256Schema,
  finalSourceStateSha256: sha256Schema,
  relevantVerificationSha256s: z.array(sha256Schema).min(1).max(32),
  redactionProvenance: z.object({
    transformId: identifierSchema,
    transformSha256: sha256Schema,
    redactedArtifactSha256: sha256Schema,
    exactLedgerArtifactId: identifierSchema,
    exactLedgerSha256: sha256Schema,
  }).strict().nullable(),
}).strict();

export const falVp0SourceBindingSchema = sourceBindingContentSchema.extend({
  sourceBindingSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.sessionRange.endByte <= value.sessionRange.startByte) {
    context.addIssue({ code: "custom", message: "source range must be non-empty", path: ["sessionRange"] });
  }
  if ((value.sourceMode === "trace_redacted") !== (value.redactionProvenance !== null)) {
    context.addIssue({
      code: "custom",
      message: "trace_redacted sources require exact redaction provenance",
      path: ["redactionProvenance"],
    });
  }
  const artifactIds = value.artifacts.map((entry) => entry.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({ code: "custom", message: "source artifact IDs must be unique", path: ["artifacts"] });
  }
  const requiredKinds = new Set([
    "session_range",
    "episode",
    "completion_evidence",
    "run_report",
    "verification",
    "source_state",
  ]);
  for (const kind of value.artifacts.map((entry) => entry.kind)) requiredKinds.delete(kind);
  if (requiredKinds.size > 0) {
    context.addIssue({ code: "custom", message: "source binding is missing required artifact kinds" });
  }
  if (value.sourceBindingSha256 !== logicalIdentity(value, "sourceBindingSha256")) {
    context.addIssue({ code: "custom", message: "source binding logical hash mismatch" });
  }
});

export const falVp0SupportRefSchema = z.object({
  sourceBindingId: identifierSchema,
  artifactId: identifierSchema,
  startByte: nonnegativeIntegerSchema,
  endByte: nonnegativeIntegerSchema,
  rawSpanSha256: sha256Schema,
  supportKind: z.enum(["observation", "action", "verification", "state", "constraint"]),
}).strict().superRefine((value, context) => {
  if (value.endByte <= value.startByte) {
    context.addIssue({ code: "custom", message: "support range must be non-empty" });
  }
});

const supportRefsSchema = z.array(falVp0SupportRefSchema).min(1).max(16).superRefine((value, context) => {
  const keys = value.map((entry) =>
    `${entry.sourceBindingId}:${entry.artifactId}:${String(entry.startByte)}:${String(entry.endByte)}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "support refs must be unique" });
  }
});

const predicateExpectedSchema = z.union([
  hostFactValueSchema,
  z.array(boundedNfcText(512)).min(1).max(32),
]);

export const falVp0PredicateSchema = z.object({
  evaluatorVersion: z.literal(FAL_VP0_HOST_FACT_EVALUATOR),
  factSource: z.enum(["case_manifest", "runtime_preflight", "source_verifier"]),
  factKey: identifierSchema,
  extractorId: identifierSchema,
  extractorSha256: sha256Schema,
  operator: z.enum([
    "exists",
    "equals",
    "not_equals",
    "one_of",
    "none_of",
    "sha256_equals",
    "semver_satisfies",
  ]),
  expected: predicateExpectedSchema,
  missingPolicy: z.literal("reject"),
}).strict().superRefine((value, context) => {
  if (value.operator === "exists" && value.expected !== null) {
    context.addIssue({ code: "custom", message: "exists expects null", path: ["expected"] });
  }
  if (value.operator !== "one_of" && value.operator !== "none_of" && Array.isArray(value.expected)) {
    context.addIssue({ code: "custom", message: "only set operators accept arrays", path: ["expected"] });
  }
  if (value.operator === "one_of" || value.operator === "none_of") {
    if (!Array.isArray(value.expected) || !isStrictlySortedUnique(value.expected)) {
      context.addIssue({ code: "custom", message: "set expected values must be sorted and unique", path: ["expected"] });
    }
  }
  if (value.operator === "sha256_equals" &&
      (typeof value.expected !== "string" || !/^[a-f0-9]{64}$/u.test(value.expected))) {
    context.addIssue({ code: "custom", message: "sha256_equals requires a lowercase SHA-256", path: ["expected"] });
  }
  if (value.operator === "semver_satisfies" &&
      (typeof value.expected !== "string" ||
        !/^(?:=\d+\.\d+\.\d+|>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+)$/u.test(value.expected))) {
    context.addIssue({ code: "custom", message: "semver_satisfies expected range is invalid", path: ["expected"] });
  }
});

export const falVp0ConditionSchema = z.object({
  conditionId: identifierSchema,
  description: procedureTextSchema(512),
  predicate: falVp0PredicateSchema,
  supportRefs: supportRefsSchema,
}).strict();

export const falVp0GuidanceStepSchema = z.object({
  stepId: identifierSchema,
  guidance: procedureTextSchema(512),
  checkpoint: procedureTextSchema(512),
  guardConditionIds: z.array(identifierSchema).max(8),
  supportRefs: supportRefsSchema,
}).strict();

export const falVp0SupportedTextSchema = z.object({
  textId: identifierSchema,
  text: procedureTextSchema(512),
  supportRefs: supportRefsSchema,
}).strict();

export const falVp0SupportedValueSchema = z.object({
  valueId: identifierSchema,
  value: procedureTextSchema(128),
  supportRefs: supportRefsSchema,
}).strict();

const procedureContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  revision: z.literal(1),
  procedureId: identifierSchema,
  procedureFamilyId: identifierSchema,
  origin: z.literal("human_frozen_from_verified_sources"),
  scope: z.object({
    ownerPrincipalId: identifierSchema,
    applicationRepositoryId: identifierSchema,
    canonicalRootIdentitySha256: sha256Schema,
  }).strict(),
  compatibility: z.object({
    runtimeFamily: falVp0SupportedValueSchema,
    packageManagerFamily: falVp0SupportedValueSchema,
    versionCondition: falVp0ConditionSchema,
  }).strict(),
  activationConditions: z.array(falVp0ConditionSchema).min(1).max(8),
  negativeConditions: z.array(falVp0ConditionSchema).min(1).max(8),
  preconditions: z.array(falVp0ConditionSchema).min(1).max(12),
  guardChecks: z.array(falVp0ConditionSchema).min(1).max(8),
  orderedGuidance: z.array(falVp0GuidanceStepSchema).min(2).max(12),
  terminationConditions: z.array(falVp0ConditionSchema).min(1).max(8),
  successVerifierExpectation: z.object({
    classifications: z.array(z.enum(["build", "check", "lint", "test", "typecheck"]))
      .min(1).max(5),
    description: procedureTextSchema(512),
    requiresFreshVerifier: z.literal(true),
    supportRefs: supportRefsSchema,
  }).strict(),
  knownExceptions: z.array(falVp0SupportedTextSchema).max(8),
  rollbackTarget: z.literal("baseline_source_evidence_dossier"),
  sourceBindings: z.tuple([falVp0SourceBindingSchema, falVp0SourceBindingSchema]),
}).strict();

export const falVp0ProcedureSchema = procedureContentSchema.extend({
  procedureSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const [left, right] = value.sourceBindings;
  if (
    left.sourceBindingId === right.sourceBindingId ||
    left.sourceIdentity.runId === right.sourceIdentity.runId ||
    left.sourceIdentity.sessionId === right.sourceIdentity.sessionId ||
    left.scenarioFamilyId === right.scenarioFamilyId ||
    left.templateLineageId === right.templateLineageId ||
    left.solutionShapeId === right.solutionShapeId
  ) {
    context.addIssue({ code: "custom", message: "procedure sources must be heterogeneous" });
  }
  for (const source of value.sourceBindings) {
    if (
      source.procedureFamilyId !== value.procedureFamilyId ||
      source.scope.ownerPrincipalId !== value.scope.ownerPrincipalId ||
      source.scope.applicationRepositoryId !== value.scope.applicationRepositoryId ||
      source.scope.canonicalRootIdentitySha256 !== value.scope.canonicalRootIdentitySha256
    ) {
      context.addIssue({ code: "custom", message: "procedure/source family or scope mismatch" });
    }
  }
  const expectedId = `vp0:${sha256Canonical({
    experimentId: value.experimentId,
    procedureFamilyId: value.procedureFamilyId,
    revision: value.revision,
    sourceBindingIds: value.sourceBindings.map((entry) => entry.sourceBindingId),
  })}`;
  if (value.procedureId !== expectedId) {
    context.addIssue({ code: "custom", message: "procedure ID is not derived from its sources", path: ["procedureId"] });
  }
  if (value.procedureSha256 !== logicalIdentity(value, "procedureSha256")) {
    context.addIssue({ code: "custom", message: "procedure logical hash mismatch" });
  }
  if (Buffer.byteLength(canonicalJson(value), "utf8") > 32 * 1024) {
    context.addIssue({ code: "custom", message: "canonical procedure exceeds 32 KiB" });
  }
  const sourceIds = new Set(value.sourceBindings.map((entry) => entry.sourceBindingId));
  const allConditions = [
    value.compatibility.versionCondition,
    ...value.activationConditions,
    ...value.negativeConditions,
    ...value.preconditions,
    ...value.guardChecks,
    ...value.terminationConditions,
  ];
  const semanticRefs = [
    value.compatibility.runtimeFamily.supportRefs,
    value.compatibility.packageManagerFamily.supportRefs,
    ...allConditions.map((entry) => entry.supportRefs),
    ...value.orderedGuidance.map((entry) => entry.supportRefs),
    value.successVerifierExpectation.supportRefs,
    ...value.knownExceptions.map((entry) => entry.supportRefs),
  ];
  for (const refs of semanticRefs) {
    const covered = new Set(refs.map((entry) => entry.sourceBindingId));
    if (sourceIds.size !== covered.size || [...sourceIds].some((id) => !covered.has(id))) {
      context.addIssue({ code: "custom", message: "every semantic atom must cover both sources" });
      break;
    }
  }
  const conditionIds = allConditions.map((entry) => entry.conditionId);
  if (new Set(conditionIds).size !== conditionIds.length) {
    context.addIssue({ code: "custom", message: "condition IDs must be unique" });
  }
  const guardIds = new Set(value.guardChecks.map((entry) => entry.conditionId));
  for (const [index, step] of value.orderedGuidance.entries()) {
    if (new Set(step.guardConditionIds).size !== step.guardConditionIds.length ||
        step.guardConditionIds.some((id) => !guardIds.has(id))) {
      context.addIssue({
        code: "custom",
        message: "guidance guard IDs must be unique declared guards",
        path: ["orderedGuidance", index, "guardConditionIds"],
      });
    }
  }
  const admission = inspectMemoryAdmission(collectStrings(value));
  if (!admission.admitted) {
    context.addIssue({ code: "custom", message: `procedure admission rejected: ${admission.reason}` });
  }
});

const reviewerSchema = z.object({
  reviewerId: identifierSchema,
  reviewerIdentitySha256: sha256Schema,
  reviewerInstanceSha256: sha256Schema,
  kind: z.enum(["human", "independent_review_agent"]),
  attestationSha256: sha256Schema,
}).strict();

const adjudicationContentSchema = z.object({
  schemaVersion: z.literal(1),
  procedureSha256: sha256Schema,
  procedureAuthorIdentitySha256: sha256Schema,
  reviewerSeparation: z.enum(["proven", "not_proven"]),
  reviewerSeparationProofSha256: sha256Schema.nullable(),
  reviewers: z.tuple([reviewerSchema, reviewerSchema]),
  atoms: z.array(z.object({
    atomId: identifierSchema,
    atomTextSha256: sha256Schema,
    supportSetSha256: sha256Schema,
    sourceBindingIds: z.tuple([identifierSchema, identifierSchema]),
    reviewerVerdicts: z.tuple([
      z.enum(["entailed", "not_entailed"]),
      z.enum(["entailed", "not_entailed"]),
    ]),
    outcome: z.enum(["unanimous_entailed", "rejected"]),
  }).strict()).min(1).max(128),
  rejectedAtomCount: nonnegativeIntegerSchema,
}).strict();

export const falVp0SupportAdjudicationSchema = adjudicationContentSchema.extend({
  adjudicationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const [left, right] = value.reviewers;
  if (
    left.reviewerId === right.reviewerId ||
    left.reviewerIdentitySha256 === right.reviewerIdentitySha256 ||
    left.reviewerInstanceSha256 === right.reviewerInstanceSha256 ||
    left.attestationSha256 === right.attestationSha256 ||
    left.reviewerIdentitySha256 === value.procedureAuthorIdentitySha256 ||
    right.reviewerIdentitySha256 === value.procedureAuthorIdentitySha256
  ) {
    context.addIssue({ code: "custom", message: "reviewers must be independently identifiable" });
  }
  if ((value.reviewerSeparation === "proven") !== (value.reviewerSeparationProofSha256 !== null)) {
    context.addIssue({ code: "custom", message: "reviewer separation proof/status mismatch" });
  }
  const rejected = value.atoms.filter((atom) => atom.outcome === "rejected").length;
  if (value.rejectedAtomCount !== rejected) {
    context.addIssue({ code: "custom", message: "rejected atom count mismatch" });
  }
  for (const [index, atom] of value.atoms.entries()) {
    const unanimous = atom.reviewerVerdicts.every((entry) => entry === "entailed");
    if ((atom.outcome === "unanimous_entailed") !== unanimous ||
        atom.sourceBindingIds[0] === atom.sourceBindingIds[1]) {
      context.addIssue({ code: "custom", message: "atom adjudication mismatch", path: ["atoms", index] });
    }
  }
  if (value.adjudicationSha256 !== logicalIdentity(value, "adjudicationSha256")) {
    context.addIssue({ code: "custom", message: "adjudication logical hash mismatch" });
  }
});

export type FalVp0Procedure = Readonly<z.infer<typeof falVp0ProcedureSchema>>;
export type FalVp0Predicate = Readonly<z.infer<typeof falVp0PredicateSchema>>;
export type FalVp0SourceBinding = Readonly<z.infer<typeof falVp0SourceBindingSchema>>;
export type FalVp0SupportRef = Readonly<z.infer<typeof falVp0SupportRefSchema>>;

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Readonly<Record<string, unknown>>)
      .flatMap((entry) => collectStrings(entry));
  }
  return [];
}

export function falVp0ProcedureId(input: {
  readonly procedureFamilyId: string;
  readonly sourceBindingIds: readonly [string, string];
}): string {
  return `vp0:${sha256Canonical({
    experimentId: FAL_VP0_EXPERIMENT_ID,
    procedureFamilyId: input.procedureFamilyId,
    revision: 1,
    sourceBindingIds: input.sourceBindingIds,
  })}`;
}

export function withFalVp0SourceBindingHash(
  content: z.input<typeof sourceBindingContentSchema>,
): FalVp0SourceBinding {
  return falVp0SourceBindingSchema.parse({
    ...content,
    sourceBindingSha256: sha256Canonical(content),
  });
}

export function withFalVp0ProcedureHash(
  content: z.input<typeof procedureContentSchema>,
): FalVp0Procedure {
  return falVp0ProcedureSchema.parse({
    ...content,
    procedureSha256: sha256Canonical(content),
  });
}
