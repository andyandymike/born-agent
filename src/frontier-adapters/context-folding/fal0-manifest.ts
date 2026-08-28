import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { DeterministicTokenEstimator } from "../../context/token-estimator.js";
import { parseStrictJson } from "../../system/strict-json.js";

export const FAL0_CONTEXT_FOLDING_EXPERIMENT_ID =
  "fal-cf0-context-folding-lite-v1" as const;
export const FAL0_CONTEXT_FOLDING_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal0-context-folding-v1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const caseId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(96);
const boundedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const fal0ContextFoldingEstimator = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "provider-neutral",
  provider: "bornagent",
  tokenizer: "utf8-bytes-v1",
  version: "fal-cf0-v1",
});

const fal0CaseInputSchema = z.object({
  receiptCount: z.number().int().min(1).max(8),
  claimsPerReceipt: z.number().int().min(0).max(16),
  narrativeBytes: z.number().int().min(1).max(8 * 1024),
  evidencePerClaim: z.number().int().min(0).max(16).default(1),
  rawTrajectoryBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]).default("succeeded"),
  language: z.enum(["english", "chinese"]).default("english"),
  contentMode: z.enum(["unique", "exact_duplicate", "shared_evidence"]).default("unique"),
  reverseRevisionOrder: z.boolean().default(false),
  claimKind: z.enum([
    "answer",
    "file_observation",
    "symbol_observation",
    "change_bundle",
    "verification_result",
  ]).default("answer"),
  includeChangeBundle: z.boolean().default(false),
  verificationIdsPerReceipt: z.number().int().min(0).max(32).default(0),
  claimStatusMode: z.enum(["verified", "mixed_unverified_stale"]).default("verified"),
  binding: z.enum(["current", "wrong_goal"]).default("current"),
  accepted: z.boolean().default(true),
  artifactFault: z.enum(["sha_mismatch"]).nullable().default(null),
  poisonNarrative: z.boolean().default(false),
  candidateFault: z.boolean().default(false),
}).strict();

const fal0CaseExpectedSchema = z.object({
  projectedReceiptCount: boundedCount,
  projectedClaimCount: boundedCount,
  statuses: z.array(z.enum(["succeeded", "failed", "blocked", "cancelled"])).max(8),
  failureCode: z.enum([
    "delegation_receipt_invalid",
    "delegation_artifact_invalid",
  ]).nullable(),
  poisonNarrativeProjected: z.boolean(),
  baselineFallback: z.boolean(),
}).strict();

export const fal0ContextFoldingCaseSchema = z.object({
  caseId,
  class: z.enum(["representative", "security", "stress"]),
  category: z.enum([
    "single_child",
    "multi_child",
    "duplicate_pressure",
    "coding_status",
    "security_freshness",
  ]),
  route: z.enum(["static_projection", "verified_receipt"]),
  input: fal0CaseInputSchema,
  expected: fal0CaseExpectedSchema,
}).strict().superRefine((value, context) => {
  if (value.expected.statuses.length !== value.expected.projectedReceiptCount) {
    context.addIssue({
      code: "custom",
      message: "expected statuses must exactly cover projected receipts",
      path: ["expected", "statuses"],
    });
  }
  if (
    value.expected.projectedClaimCount >
    value.input.receiptCount * value.input.claimsPerReceipt
  ) {
    context.addIssue({
      code: "custom",
      message: "expected projected claims exceed generated claims",
      path: ["expected", "projectedClaimCount"],
    });
  }
  if (
    value.route === "verified_receipt" &&
    value.input.claimsPerReceipt * value.input.evidencePerClaim > 64
  ) {
    context.addIssue({
      code: "custom",
      message: "verified receipt profile exceeds the production evidence bound",
      path: ["input", "evidencePerClaim"],
    });
  }
  if (value.input.artifactFault !== null && value.route !== "verified_receipt") {
    context.addIssue({
      code: "custom",
      message: "artifact faults require the verified receipt route",
      path: ["route"],
    });
  }
});

export const fal0ContextFoldingCasePackSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(fal0ContextFoldingCaseSchema).length(24),
}).strict().superRefine((value, context) => {
  const ids = value.cases.map((entry) => entry.caseId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "case IDs must be unique", path: ["cases"] });
  }
  const expectedCategories = {
    coding_status: 4,
    duplicate_pressure: 4,
    multi_child: 4,
    security_freshness: 6,
    single_child: 6,
  } as const;
  for (const [category, count] of Object.entries(expectedCategories)) {
    if (value.cases.filter((entry) => entry.category === category).length !== count) {
      context.addIssue({
        code: "custom",
        message: `${category} must contain exactly ${String(count)} cases`,
        path: ["cases"],
      });
    }
  }
  if (value.cases.filter((entry) => entry.class === "representative").length < 12) {
    context.addIssue({
      code: "custom",
      message: "case pack requires at least 12 representative cases",
      path: ["cases"],
    });
  }
  if (value.cases.filter((entry) => entry.route === "verified_receipt").length < 4) {
    context.addIssue({
      code: "custom",
      message: "case pack requires at least four real verifier/projector cases",
      path: ["cases"],
    });
  }
});

export const fal0ContextFoldingManifestSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL0_CONTEXT_FOLDING_EXPERIMENT_ID),
  estimatorId: sha256,
  casePackRef: z.literal("cases.json"),
  casePackSha256: sha256,
  caseIds: z.array(caseId).length(24),
  manifestSha256: sha256,
}).strict();

export type Fal0ContextFoldingCaseV1 = Readonly<
  z.infer<typeof fal0ContextFoldingCaseSchema>
>;
export type Fal0ContextFoldingCasePackV1 = Readonly<
  z.infer<typeof fal0ContextFoldingCasePackSchema>
>;
export type Fal0ContextFoldingManifestV1 = Readonly<
  z.infer<typeof fal0ContextFoldingManifestSchema>
>;

export interface LoadedFal0ContextFoldingCorpusV1 {
  readonly casePack: Fal0ContextFoldingCasePackV1;
  readonly manifest: Fal0ContextFoldingManifestV1;
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fal0ManifestLogicalIdentity(
  manifest: Omit<Fal0ContextFoldingManifestV1, "manifestSha256">,
): string {
  return sha256Canonical(manifest);
}

export async function loadFal0ContextFoldingCorpus(
  repositoryRoot: string,
): Promise<LoadedFal0ContextFoldingCorpusV1> {
  const directory = join(repositoryRoot, FAL0_CONTEXT_FOLDING_FIXTURE_DIRECTORY);
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = fal0ContextFoldingManifestSchema.parse(
    parseStrictJson(manifestBytes.toString("utf8")),
  );
  const casePackBytes = await readFile(join(directory, manifest.casePackRef));
  if (rawSha256(casePackBytes) !== manifest.casePackSha256) {
    throw new Error("FAL-CF0 case pack does not match its manifest hash");
  }
  const casePack = fal0ContextFoldingCasePackSchema.parse(
    parseStrictJson(casePackBytes.toString("utf8")),
  );
  const { manifestSha256, ...logicalManifest } = manifest;
  if (fal0ManifestLogicalIdentity(logicalManifest) !== manifestSha256) {
    throw new Error("FAL-CF0 manifest logical hash is invalid");
  }
  if (manifest.estimatorId !== fal0ContextFoldingEstimator.estimatorId) {
    throw new Error("FAL-CF0 manifest uses an unexpected token estimator");
  }
  if (
    manifest.caseIds.length !== casePack.cases.length ||
    manifest.caseIds.some((id, index) => id !== casePack.cases[index]?.caseId)
  ) {
    throw new Error("FAL-CF0 manifest case order does not match cases.json");
  }
  return Object.freeze({ casePack, manifest });
}
