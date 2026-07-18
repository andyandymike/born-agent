import { z } from "zod";

import {
  completedRunReportSchema,
  incompleteRunReportSchema,
} from "../reports/run-report-schema.js";
import { canonicalJson, sha256Canonical } from "./canonical-json.js";
import {
  createCompletedRunReport,
  createIncompleteRunReport,
} from "./completion-report-renderer.js";
import { COMPLETION_REASON_CODES } from "./completion-types.js";
import type {
  CompletionEvidence,
  IncompleteEvidence,
} from "./completion-types.js";
import { dockerExecutionImageIdentitySchema } from "../execution/docker/acquisition/docker-image-identity.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeInteger = z.number().int().nonnegative();
const boundedString = (bytes: number) =>
  z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= bytes,
    `must not exceed ${bytes} UTF-8 bytes`,
  );
const relativePath = boundedString(4_096).refine(
  (value) =>
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes(".."),
  "must be a normalized workspace-relative path",
);
const relativeCwd = relativePath.or(z.literal("."));

const snapshotFile = z
  .object({ path: relativePath, sha256 })
  .strict();

const verificationSnapshot = z
  .object({
    changedFiles: z.array(snapshotFile).max(10_000),
    commandInputs: z.array(snapshotFile).max(10_000),
    deletedFiles: z.array(z.never()).max(0),
    generation: nonnegativeInteger,
    gitHeadSha256: sha256,
    gitIndexSha256: sha256,
    journalSha256: sha256,
    packageScriptSha256: sha256.optional(),
    sourceStateSha256: sha256,
  })
  .strict();

const changedFile = z
  .object({
    addedLines: nonnegativeInteger,
    kind: z.enum(["create", "modify"]),
    path: relativePath,
    postimageSha256: sha256,
    preimageSha256: sha256.nullable(),
    removedLines: nonnegativeInteger,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === "create" && value.preimageSha256 !== null) ||
      (value.kind === "modify" && value.preimageSha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "changed-file kind does not match preimage identity",
      });
    }
  });

const diffCheck = z
  .object({
    checkedPaths: z.array(relativePath).max(10_000),
    detail: boundedString(4_096),
    diffSha256: sha256,
    status: z.enum(["failed", "not_run", "passed"]),
  })
  .strict();

const commandOutput = z
  .object({
    artifactRefs: z.array(boundedString(200)).max(128),
    eventRefs: z.array(boundedString(200)).max(128),
    stderrSummary: boundedString(4_096),
    stdoutSummary: boundedString(4_096),
    totalBytes: nonnegativeInteger,
    truncated: z.boolean(),
  })
  .strict();

const executionEnvironment = z
  .object({
    executor: z.enum(["local", "docker"]),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
    imageIdentity: dockerExecutionImageIdentitySchema.optional(),
    isolation: z.enum(["none", "docker"]),
    network: z.enum(["host", "none"]),
    policyVersion: boundedString(128),
    resourceLimits: z
      .object({
        cpus: z.number().min(0.25).max(8),
        memoryMiB: z.number().int().min(256).max(8_192),
        pids: z.number().int().min(32).max(1_024),
        tmpMiB: z.number().int().min(16).max(1_024),
      })
      .strict()
      .optional(),
    snapshotSha256: sha256.optional(),
  })
  .strict();

const sandboxEphemeralChanges = z
  .object({
    afterSha256: sha256,
    beforeSha256: sha256,
    created: nonnegativeInteger,
    deleted: nonnegativeInteger,
    modified: nonnegativeInteger,
    paths: z.array(relativePath).max(256),
    specialEntries: nonnegativeInteger,
    truncated: z.boolean(),
  })
  .strict();

const verification = z
  .object({
    actionSha256: sha256,
    afterSnapshot: verificationSnapshot,
    approved: z.boolean(),
    argv: z.array(boundedString(4_096)).min(1).max(65),
    beforeSnapshot: verificationSnapshot,
    classification: z.enum(["build", "check", "lint", "test", "typecheck"]),
    completedEventPersisted: z.boolean(),
    cwd: relativeCwd,
    durationMs: nonnegativeInteger,
    executionId: z.string().uuid(),
    executionEnvironment: executionEnvironment.optional(),
    exitCode: z.number().int().nullable(),
    generationAtCompletion: nonnegativeInteger,
    generationAtStart: nonnegativeInteger,
    inputsKnown: z.boolean(),
    output: commandOutput,
    purpose: z.literal("verify"),
    sandboxEphemeralChanges: sandboxEphemeralChanges.optional(),
    stale: z.boolean(),
    verificationId: z.string().uuid().optional(),
  })
  .strict();

const modelEvidence = z
  .object({
    backend: z.enum(["fake", "ollama"]),
    endpointScope: z.enum(["in_process", "literal_loopback"]),
    kind: z.enum(["contract_verified", "local_live_verified"]),
    remoteBillableRequests: z.literal(0),
  })
  .strict();

const commonEvidenceFields = {
  changedByRun: z.array(changedFile).max(10_000),
  diffCheck,
  modelEvidence,
  modelNarrative: boundedString(8 * 1_024),
  preExistingDirtyPaths: z.array(relativePath).max(10_000),
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),
  verifications: z.array(verification).max(1_000),
};

export const completionEvidenceSchema = z
  .object({
    ...commonEvidenceFields,
    finalSnapshot: verificationSnapshot,
  })
  .strict();

export const incompleteEvidenceSchema = z
  .object({
    ...commonEvidenceFields,
    finalSnapshot: verificationSnapshot.nullable(),
    reason: z.enum(COMPLETION_REASON_CODES),
  })
  .strict();

const completedProjection = z
  .object({
    evidence: completionEvidenceSchema,
    evidence_sha256: sha256,
    outcome: z.literal("completed"),
    report: completedRunReportSchema,
    report_sha256: sha256,
  })
  .strict();

const incompleteProjection = z
  .object({
    evidence: incompleteEvidenceSchema,
    evidence_sha256: sha256,
    outcome: z.literal("incomplete"),
    report: incompleteRunReportSchema,
    report_sha256: sha256,
  })
  .strict();

export const persistedCompletionEvidenceSchema = z
  .discriminatedUnion("outcome", [completedProjection, incompleteProjection])
  .superRefine((value, context) => {
    if (sha256Canonical(value.evidence) !== value.evidence_sha256) {
      context.addIssue({ code: "custom", message: "completion evidence hash mismatch" });
    }
    const expected =
      value.outcome === "completed"
        ? createCompletedRunReport(value.evidence)
        : createIncompleteRunReport(value.evidence);
    if (
      value.report.report_hash !== value.report_sha256 ||
      canonicalJson(expected) !== canonicalJson(value.report)
    ) {
      context.addIssue({ code: "custom", message: "completion report does not match evidence" });
    }
  });

export type PersistedCompletionEvidence = z.infer<
  typeof persistedCompletionEvidenceSchema
>;

export function createPersistedCompletionEvidence(
  evidence: CompletionEvidence | IncompleteEvidence,
): PersistedCompletionEvidence {
  if ("reason" in evidence) {
    const report = createIncompleteRunReport(evidence);
    return persistedCompletionEvidenceSchema.parse({
      evidence,
      evidence_sha256: sha256Canonical(evidence),
      outcome: "incomplete",
      report,
      report_sha256: report.report_hash,
    });
  }
  const report = createCompletedRunReport(evidence);
  return persistedCompletionEvidenceSchema.parse({
    evidence,
    evidence_sha256: sha256Canonical(evidence),
    outcome: "completed",
    report,
    report_sha256: report.report_hash,
  });
}
