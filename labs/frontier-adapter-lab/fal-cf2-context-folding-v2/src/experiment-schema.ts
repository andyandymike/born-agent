import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  canonicalJson,
  sha256Canonical,
} from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import { acceptedChildReceiptContextSchema } from "./context-fold.js";

export const CF2_EXPERIMENT_ID = "fal-cf2-context-folding-v2" as const;
export const CF2_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal-cf2-context-folding-v2" as const;
export const CF2_LAB_DIRECTORY =
  "labs/frontier-adapter-lab/fal-cf2-context-folding-v2" as const;

export const CF2_PRIOR_RECEIPT_SHA256 =
  "88cac12c8010d24266bcc2900fc5f4ee3a9f9724329f63d27f9633a931cd3d9b" as const;
export const CF2_PRIOR_CANDIDATE_SHA256 =
  "b63740754e947af6a37d571380936d9c57eaa865b35f91cf5323d434c68c3981" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceCommitId = z.string().regex(/^[a-f0-9]{40,64}$/u);
const caseId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96);
const relativeArtifactRef = z.string()
  .min(1)
  .max(512)
  .refine((value) =>
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-z]:/iu.test(value) &&
    !value.split("/").includes(".."), {
      message: "artifact refs must be normalized relative paths",
    });
const traceArtifactRef = relativeArtifactRef.refine(
  (value) => value.startsWith("traces/evaluation/"),
  { message: "trace artifacts must stay under traces/evaluation" },
);

export const cf2MechanicalCaseSchema = z.object({
  caseId,
  evidenceKind: z.enum(["generated_fixture", "verified_route_fixture", "stress"]),
  caseRole: z.enum(["mechanical", "security", "known_regression"]),
  route: z.enum(["direct_projection", "verified_receipt"]),
  multiChild: z.boolean(),
  input: z.object({
    receiptCount: z.number().int().min(1).max(8),
    claimsPerReceipt: z.number().int().min(0).max(16),
    narrativeBytes: z.number().int().min(1).max(12 * 1024),
    evidencePerClaim: z.number().int().min(0).max(16),
    contentMode: z.enum(["unique", "exact_duplicate", "shared_evidence"]),
    status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    includeChangeBundle: z.boolean(),
    verificationIdsPerReceipt: z.number().int().min(0).max(32),
    binding: z.enum(["current", "wrong_goal"]),
    accepted: z.boolean(),
    claimStatusMode: z.enum(["verified", "mixed_unverified_stale"]),
    artifactFault: z.enum(["sha_mismatch"]).nullable(),
    reverseRevisionOrder: z.boolean(),
    poisonNarrative: z.boolean(),
    candidateFault: z.enum(["none", "throw", "deadline_expired", "invalid"]),
    candidateEnabled: z.boolean(),
  }).strict(),
  expected: z.object({
    projectedReceiptCount: z.number().int().nonnegative().max(8),
    projectedClaimCount: z.number().int().nonnegative().max(128),
    candidateInvoked: z.boolean(),
    candidateSelected: z.boolean().nullable(),
    baselineFallback: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.multiChild !== (value.input.receiptCount > 1)) {
    context.addIssue({
      code: "custom",
      message: "multiChild must match receiptCount",
      path: ["multiChild"],
    });
  }
  if (value.route === "direct_projection" && value.evidenceKind !== "generated_fixture" && value.evidenceKind !== "stress") {
    context.addIssue({
      code: "custom",
      message: "direct projection cases must be generated or stress fixtures",
      path: ["evidenceKind"],
    });
  }
  if (value.route === "verified_receipt" && value.evidenceKind !== "verified_route_fixture") {
    context.addIssue({
      code: "custom",
      message: "verified receipt cases must use verified_route_fixture provenance",
      path: ["evidenceKind"],
    });
  }
  if (!value.expected.candidateInvoked && value.expected.candidateSelected !== null) {
    context.addIssue({
      code: "custom",
      message: "non-invoked candidates require null selection expectation",
      path: ["expected", "candidateSelected"],
    });
  }
  if (value.input.artifactFault !== null && value.route !== "verified_receipt") {
    context.addIssue({
      code: "custom",
      message: "artifact faults require verified receipt route",
      path: ["input", "artifactFault"],
    });
  }
});

export const cf2MechanicalCasePackSchema = z.object({
  schemaVersion: z.literal(2),
  cases: z.array(cf2MechanicalCaseSchema).length(20),
}).strict().superRefine((value, context) => {
  const ids = value.cases.map((entry) => entry.caseId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "case IDs must be unique", path: ["cases"] });
  }
  if (value.cases.filter((entry) => entry.route === "verified_receipt").length < 7) {
    context.addIssue({
      code: "custom",
      message: "mechanical pack requires at least seven verified receipt routes",
      path: ["cases"],
    });
  }
  if (value.cases.filter((entry) => entry.caseRole === "security").length < 5) {
    context.addIssue({
      code: "custom",
      message: "mechanical pack requires at least five security cases",
      path: ["cases"],
    });
  }
});

export const cf2TraceProvenanceSchema = z.object({
  caseId,
  evidenceKind: z.literal("trace_replay"),
  caseRole: z.enum(["naturalistic_product_evaluation", "targeted_model_quality"]),
  multiChild: z.boolean(),
  scenarioFamilyId: caseId,
  taskStatusShape: caseId,
  parentRunIdSha256: sha256,
  sourceCommit: sourceCommitId.nullable(),
  sourceDirtyStateSha256: sha256.nullable(),
  capturePoint: z.literal("after_parent_receipt_projection_before_provider_request"),
  captureToolVersion: z.string().min(1).max(64),
  acceptedChildReceiptItemsArtifactRef: traceArtifactRef,
  acceptedChildReceiptItemsSha256: sha256,
  baselineTaskContextArtifactRef: traceArtifactRef,
  baselineTaskContextSha256: sha256,
  redactionTransformId: z.string().min(1).max(128),
  redactionTransformSha256: sha256.nullable(),
  tokenDistributionChanged: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.sourceCommit === null && value.sourceDirtyStateSha256 === null) {
    context.addIssue({
      code: "custom",
      message: "trace must bind a source commit or dirty-state hash",
      path: ["sourceCommit"],
    });
  }
  if (value.sourceCommit !== null && value.sourceDirtyStateSha256 === null) {
    // Clean runs are fully bound by sourceCommit.
  } else if (value.sourceCommit === null && value.sourceDirtyStateSha256 !== null) {
    context.addIssue({
      code: "custom",
      message: "dirty runs must also bind their base source commit",
      path: ["sourceCommit"],
    });
  }
  if (
    (value.redactionTransformId === "none" && value.redactionTransformSha256 !== null) ||
    (value.redactionTransformId !== "none" && value.redactionTransformSha256 === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "redaction identity and hash must be paired",
      path: ["redactionTransformSha256"],
    });
  }
});

const samplingProtocolSchema = z.object({
  protocolId: z.literal("first-n-qualifying-consecutive-runs-v1"),
  protocolSha256: sha256,
  productFitEvaluationRequested: z.boolean(),
  minimumNaturalisticTraces: z.literal(12),
  minimumMultiChildTraces: z.literal(4),
  minimumTaskStatusShapes: z.literal(3),
  selectionFields: z.array(z.enum([
    "authorization",
    "no_secret",
    "capture_complete",
    "task_status_stratum",
    "independent_parent_run",
  ])).length(5),
}).strict();

const manifestContentSchema = z.object({
  schemaVersion: z.literal(2),
  experimentId: z.literal(CF2_EXPERIMENT_ID),
  candidateIdentityMode: z.literal("reimplementation_from_v1_contract"),
  priorEvidenceReceiptSha256: z.literal(CF2_PRIOR_RECEIPT_SHA256),
  priorCandidateImplementationSha256: z.literal(CF2_PRIOR_CANDIDATE_SHA256),
  mechanicalCasePackRef: z.literal("mechanical-cases.json"),
  mechanicalCasePackSha256: sha256,
  mechanicalCaseIds: z.array(caseId).length(20),
  traceDirectoryRef: z.literal("traces/evaluation"),
  traces: z.array(cf2TraceProvenanceSchema).max(64),
  samplingProtocol: samplingProtocolSchema,
  candidateImplementationSha256: sha256,
}).strict();

export const cf2ManifestSchema = manifestContentSchema.extend({
  manifestSha256: sha256,
}).strict().superRefine((value, context) => {
  const expectedProtocolHash = sha256Canonical({
    minimumMultiChildTraces: value.samplingProtocol.minimumMultiChildTraces,
    minimumNaturalisticTraces: value.samplingProtocol.minimumNaturalisticTraces,
    minimumTaskStatusShapes: value.samplingProtocol.minimumTaskStatusShapes,
    protocolId: value.samplingProtocol.protocolId,
    selectionFields: value.samplingProtocol.selectionFields,
  });
  if (value.samplingProtocol.protocolSha256 !== expectedProtocolHash) {
    context.addIssue({
      code: "custom",
      message: "sampling protocol hash mismatch",
      path: ["samplingProtocol", "protocolSha256"],
    });
  }
  if (value.samplingProtocol.productFitEvaluationRequested) {
    const traces = value.traces.filter((entry) =>
      entry.caseRole === "naturalistic_product_evaluation" &&
      !entry.tokenDistributionChanged);
    if (traces.length < value.samplingProtocol.minimumNaturalisticTraces) {
      context.addIssue({
        code: "custom",
        message: "product-fit evaluation requires twelve eligible naturalistic traces",
        path: ["traces"],
      });
    }
    if (traces.filter((entry) => entry.multiChild).length < value.samplingProtocol.minimumMultiChildTraces) {
      context.addIssue({
        code: "custom",
        message: "product-fit evaluation requires four multi-child traces",
        path: ["traces"],
      });
    }
    if (new Set(traces.map((entry) => entry.taskStatusShape)).size < value.samplingProtocol.minimumTaskStatusShapes) {
      context.addIssue({
        code: "custom",
        message: "product-fit evaluation requires three task/status shapes",
        path: ["traces"],
      });
    }
    if (new Set(traces.map((entry) => entry.parentRunIdSha256)).size !== traces.length) {
      context.addIssue({
        code: "custom",
        message: "naturalistic traces must come from independent parent runs",
        path: ["traces"],
      });
    }
  }
  const { manifestSha256, ...content } = value;
  if (manifestSha256 !== sha256Canonical(content)) {
    context.addIssue({ code: "custom", message: "manifest logical hash mismatch" });
  }
});

const claimResultsSchema = z.tuple([
  z.object({
    claimId: z.literal("lossless"),
    result: z.enum(["supported", "refuted"]),
  }).strict(),
  z.object({
    claimId: z.literal("security_fixture"),
    result: z.enum(["supported", "refuted"]),
  }).strict(),
  z.object({
    claimId: z.literal("fallback_equivalence"),
    result: z.enum(["supported", "refuted"]),
  }).strict(),
  z.object({
    claimId: z.literal("pack_isolation"),
    result: z.enum(["supported", "refuted"]),
  }).strict(),
  z.object({
    claimId: z.literal("trace_token_benefit"),
    result: z.literal("not_run"),
  }).strict(),
  z.object({
    claimId: z.literal("model_completion"),
    result: z.literal("not_run"),
  }).strict(),
]);

const caseResultSchema = z.object({
  caseId,
  evidenceKind: z.enum(["generated_fixture", "verified_route_fixture", "stress"]),
  caseRole: z.enum(["mechanical", "security", "known_regression"]),
  candidateInvoked: z.boolean(),
  candidateSelected: z.boolean().nullable(),
  baselineProviderContextSha256: sha256,
  selectedProviderContextSha256: sha256,
  baselineTokens: z.number().int().positive(),
  candidateTokens: z.number().int().positive().nullable(),
  losslessExpansion: z.boolean().nullable(),
  fallbackEquivalent: z.boolean(),
  modelCalls: z.literal(0),
  toolCalls: z.literal(0),
  networkCalls: z.literal(0),
  status: z.enum(["pass", "fail"]),
}).strict();

const sourceStateFileSchema = z.object({
  path: relativeArtifactRef,
  sha256,
}).strict();

const packEvidenceSchema = z.object({
  command: z.literal("pnpm pack --dry-run --json"),
  commandSucceeded: z.boolean(),
  labEntryCount: z.number().int().nonnegative(),
  candidateEntryCount: z.number().int().nonnegative(),
  packedContentMarkerCount: z.number().int().nonnegative(),
  productionSourceMarkerCount: z.number().int().nonnegative(),
  staticPolicyPassed: z.boolean(),
  result: z.enum(["passed", "failed"]),
}).strict();

const receiptContentSchema = z.object({
  schemaVersion: z.literal(2),
  experimentId: z.literal(CF2_EXPERIMENT_ID),
  sourceCommit: sourceCommitId.nullable(),
  sourceDirtyStateSha256: sha256.nullable(),
  sourceStateFiles: z.array(sourceStateFileSchema).min(12).max(64),
  productionSourceTreeSha256: sha256,
  manifestSha256: sha256,
  candidateImplementationSha256: sha256,
  priorEvidenceReceiptSha256: z.literal(CF2_PRIOR_RECEIPT_SHA256),
  priorCandidateImplementationSha256: z.literal(CF2_PRIOR_CANDIDATE_SHA256),
  lifecycle: z.literal("closed"),
  evidenceValidity: z.literal("limited"),
  implementationFidelity: z.enum(["verified", "failed"]),
  claimResults: claimResultsSchema,
  productFit: z.literal("inconclusive"),
  promotion: z.literal("blocked"),
  direction: z.enum(["retain", "revise"]),
  reproducibility: z.enum(["working_tree_full", "exact_commit_full"]),
  candidateLifecycle: z.literal("retained_disabled"),
  cases: z.array(caseResultSchema).length(20),
  aggregate: z.object({
    mechanicalCases: z.literal(20),
    mechanicalFailures: z.number().int().nonnegative().max(20),
    verifiedRouteCases: z.number().int().nonnegative().max(20),
    securityCases: z.number().int().nonnegative().max(20),
    candidateInvocations: z.number().int().nonnegative().max(20),
    candidateSelections: z.number().int().nonnegative().max(20),
    naturalisticTraceCount: z.literal(0),
    modelQualityTaskCount: z.literal(0),
  }).strict(),
  packEvidence: packEvidenceSchema,
  platformEvidence: z.object({
    windows: z.enum(["passed", "failed", "not_run"]),
    linux: z.enum(["passed", "failed", "not_run"]),
    packed: z.enum(["passed", "failed", "not_run"]),
  }).strict(),
  actualFocusedMinutes: z.number().int().nonnegative().nullable(),
}).strict();

export const cf2ReceiptSchema = receiptContentSchema.extend({
  receiptSha256: sha256,
}).strict().superRefine((value, context) => {
  const caseIds = value.cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) {
    context.addIssue({ code: "custom", message: "receipt case IDs must be unique" });
  }
  for (const [index, entry] of value.cases.entries()) {
    if (!entry.candidateInvoked && entry.candidateSelected !== null) {
      context.addIssue({
        code: "custom",
        message: "non-invoked receipt cases require null candidate selection",
        path: ["cases", index, "candidateSelected"],
      });
    }
    if (entry.candidateInvoked && entry.candidateSelected === null) {
      context.addIssue({
        code: "custom",
        message: "invoked receipt cases require a boolean candidate selection",
        path: ["cases", index, "candidateSelected"],
      });
    }
    if (entry.fallbackEquivalent !== (entry.candidateSelected !== true)) {
      context.addIssue({
        code: "custom",
        message: "fallback equivalence must match candidate selection",
        path: ["cases", index, "fallbackEquivalent"],
      });
    }
  }

  const expectedAggregate = {
    mechanicalCases: value.cases.length,
    mechanicalFailures: value.cases.filter((entry) => entry.status === "fail").length,
    verifiedRouteCases: value.cases.filter((entry) =>
      entry.evidenceKind === "verified_route_fixture").length,
    securityCases: value.cases.filter((entry) => entry.caseRole === "security").length,
    candidateInvocations: value.cases.filter((entry) => entry.candidateInvoked).length,
    candidateSelections: value.cases.filter((entry) => entry.candidateSelected === true).length,
    naturalisticTraceCount: 0,
    modelQualityTaskCount: 0,
  } as const;
  for (const [key, expected] of Object.entries(expectedAggregate)) {
    if (value.aggregate[key as keyof typeof expectedAggregate] !== expected) {
      context.addIssue({
        code: "custom",
        message: `receipt aggregate mismatch for ${key}`,
        path: ["aggregate", key],
      });
    }
  }

  const sourcePaths = value.sourceStateFiles.map((entry) => entry.path);
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    context.addIssue({ code: "custom", message: "source-state paths must be unique" });
  }
  if (sourcePaths.some((path, index) => index > 0 &&
    (sourcePaths[index - 1]?.localeCompare(path) ?? -1) >= 0)) {
    context.addIssue({ code: "custom", message: "source-state paths must be sorted" });
  }
  const candidateSource = value.sourceStateFiles.find((entry) =>
    entry.path === `${CF2_LAB_DIRECTORY}/src/context-fold.ts`);
  if (candidateSource === undefined || value.candidateImplementationSha256 !== sha256Canonical({
    files: candidateSource === undefined ? [] : [candidateSource],
    schemaVersion: 2,
  })) {
    context.addIssue({ code: "custom", message: "candidate identity does not match source state" });
  }
  const expectedDirtyState = sha256Canonical({
    baseSourceCommit: value.sourceCommit,
    files: value.sourceStateFiles,
    productionSourceTreeSha256: value.productionSourceTreeSha256,
    schemaVersion: 2,
  });
  if (value.reproducibility === "working_tree_full") {
    if (value.sourceCommit === null || value.sourceDirtyStateSha256 !== expectedDirtyState) {
      context.addIssue({
        code: "custom",
        message: "working-tree reproducibility requires base commit and exact source-state hash",
      });
    }
  } else if (value.sourceCommit === null || value.sourceDirtyStateSha256 !== null) {
    context.addIssue({
      code: "custom",
      message: "exact-commit reproducibility requires a commit and null dirty-state hash",
    });
  }

  const packPassed = value.packEvidence.commandSucceeded &&
    value.packEvidence.staticPolicyPassed &&
    value.packEvidence.labEntryCount === 0 &&
    value.packEvidence.candidateEntryCount === 0 &&
    value.packEvidence.packedContentMarkerCount === 0 &&
    value.packEvidence.productionSourceMarkerCount === 0;
  if ((value.packEvidence.result === "passed") !== packPassed) {
    context.addIssue({ code: "custom", message: "pack evidence result is inconsistent" });
  }
  if (value.platformEvidence.packed !== value.packEvidence.result) {
    context.addIssue({ code: "custom", message: "packed platform result is inconsistent" });
  }
  const mechanicsPassed = expectedAggregate.mechanicalFailures === 0;
  const implementationVerified = mechanicsPassed && packPassed;
  if ((value.implementationFidelity === "verified") !== implementationVerified) {
    context.addIssue({ code: "custom", message: "implementation fidelity is inconsistent" });
  }
  if (value.direction !== (implementationVerified ? "retain" : "revise")) {
    context.addIssue({ code: "custom", message: "direction is inconsistent" });
  }
  for (const claim of value.claimResults.slice(0, 3)) {
    if (claim.result !== (mechanicsPassed ? "supported" : "refuted")) {
      context.addIssue({ code: "custom", message: `${claim.claimId} result is inconsistent` });
    }
  }
  if (value.claimResults[3].result !== (packPassed ? "supported" : "refuted")) {
    context.addIssue({ code: "custom", message: "pack isolation claim is inconsistent" });
  }

  const { receiptSha256, ...content } = value;
  if (receiptSha256 !== cf2ReceiptLogicalIdentity(content)) {
    context.addIssue({ code: "custom", message: "receipt logical hash mismatch" });
  }
});

export type Cf2MechanicalCase = Readonly<z.infer<typeof cf2MechanicalCaseSchema>>;
export type Cf2MechanicalCasePack = Readonly<z.infer<typeof cf2MechanicalCasePackSchema>>;
export type Cf2Manifest = Readonly<z.infer<typeof cf2ManifestSchema>>;
export type Cf2CaseResult = Readonly<z.infer<typeof caseResultSchema>>;
export type Cf2ReceiptContent = Readonly<z.infer<typeof receiptContentSchema>>;
export type Cf2Receipt = Readonly<z.infer<typeof cf2ReceiptSchema>>;

export interface LoadedCf2Corpus {
  readonly casePack: Cf2MechanicalCasePack;
  readonly manifest: Cf2Manifest;
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function cf2ManifestLogicalIdentity(
  input: Omit<Cf2Manifest, "manifestSha256">,
): string {
  return sha256Canonical(input);
}

export function cf2ReceiptLogicalIdentity(input: Cf2ReceiptContent): string {
  return sha256Canonical({ ...input, actualFocusedMinutes: null });
}

export function createCf2Receipt(input: unknown): Cf2Receipt {
  const content = receiptContentSchema.parse(input);
  return Object.freeze(cf2ReceiptSchema.parse({
    ...content,
    receiptSha256: cf2ReceiptLogicalIdentity(content),
  }));
}

function resolveTraceArtifact(repositoryRoot: string, artifactRef: string): string {
  const fixtureRoot = resolve(repositoryRoot, CF2_FIXTURE_DIRECTORY);
  const artifactPath = resolve(fixtureRoot, artifactRef);
  const fromRoot = relative(fixtureRoot, artifactPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`CF2 trace artifact escapes the evidence pack: ${artifactRef}`);
  }
  return artifactPath;
}

export async function verifyCf2TraceArtifacts(
  repositoryRoot: string,
  traces: readonly Readonly<z.infer<typeof cf2TraceProvenanceSchema>>[],
): Promise<void> {
  for (const trace of traces) {
    const receiptBytes = await readFile(resolveTraceArtifact(
      repositoryRoot,
      trace.acceptedChildReceiptItemsArtifactRef,
    ));
    if (rawSha256(receiptBytes) !== trace.acceptedChildReceiptItemsSha256) {
      throw new Error(`CF2 trace receipt artifact hash mismatch: ${trace.caseId}`);
    }
    const receipts = acceptedChildReceiptContextSchema.parse(
      parseStrictJson(receiptBytes.toString("utf8")),
    );

    const contextBytes = await readFile(resolveTraceArtifact(
      repositoryRoot,
      trace.baselineTaskContextArtifactRef,
    ));
    if (rawSha256(contextBytes) !== trace.baselineTaskContextSha256) {
      throw new Error(`CF2 trace task-context artifact hash mismatch: ${trace.caseId}`);
    }
    const taskContext = z.record(z.string(), z.unknown()).parse(
      parseStrictJson(contextBytes.toString("utf8")),
    );
    if (canonicalJson(taskContext.acceptedChildReceipts ?? []) !== canonicalJson(receipts)) {
      throw new Error(`CF2 trace artifacts disagree on accepted receipts: ${trace.caseId}`);
    }
  }
}

export async function loadCf2Corpus(repositoryRoot: string): Promise<LoadedCf2Corpus> {
  const directory = join(repositoryRoot, CF2_FIXTURE_DIRECTORY);
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = cf2ManifestSchema.parse(parseStrictJson(manifestBytes.toString("utf8")));
  const casePackBytes = await readFile(join(directory, manifest.mechanicalCasePackRef));
  if (rawSha256(casePackBytes) !== manifest.mechanicalCasePackSha256) {
    throw new Error("CF2 mechanical case pack does not match its manifest hash");
  }
  const casePack = cf2MechanicalCasePackSchema.parse(
    parseStrictJson(casePackBytes.toString("utf8")),
  );
  if (
    manifest.mechanicalCaseIds.length !== casePack.cases.length ||
    manifest.mechanicalCaseIds.some((id, index) => id !== casePack.cases[index]?.caseId)
  ) {
    throw new Error("CF2 manifest case order does not match mechanical-cases.json");
  }
  await verifyCf2TraceArtifacts(repositoryRoot, manifest.traces);
  return Object.freeze({ casePack, manifest });
}
