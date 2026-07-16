import { z } from "zod";

import { COMPLETION_REASON_CODES } from "../completion/completion-types.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const utf8Within = (maximumBytes: number) =>
  z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
    `must not exceed ${maximumBytes} UTF-8 bytes`,
  );
const relativePathSchema = utf8Within(4096).refine(
  (value) =>
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    }) &&
    !value.split("/").includes(".."),
  "must be a normalized workspace-relative path without control characters",
);
const cwdSchema = relativePathSchema.or(z.literal("."));
const nonnegativeInteger = z.number().int().nonnegative();

export const changedFileReportSchema = z
  .object({
    added_lines: nonnegativeInteger,
    kind: z.enum(["create", "modify"]),
    path: relativePathSchema,
    postimage_sha256: sha256Schema,
    preimage_sha256: sha256Schema.nullable(),
    removed_lines: nonnegativeInteger,
  })
  .strict();

export const diffCheckReportSchema = z
  .object({
    checked_paths: z.array(relativePathSchema).max(10_000),
    detail: utf8Within(4096),
    diff_sha256: sha256Schema,
    status: z.enum(["failed", "not_run", "passed"]),
  })
  .strict();

const outputReportSchema = z
  .object({
    artifact_refs: z.array(utf8Within(200)).max(128),
    event_refs: z.array(utf8Within(200)).max(128),
    stderr_summary: utf8Within(4096),
    stdout_summary: utf8Within(4096),
    total_bytes: nonnegativeInteger,
    truncated: z.boolean(),
  })
  .strict();

export const verificationReportSchema = z
  .object({
    action_sha256: sha256Schema,
    after_snapshot_sha256: sha256Schema,
    argv: z.array(utf8Within(4096)).min(1).max(65),
    before_snapshot_sha256: sha256Schema,
    classification: z.enum(["build", "check", "lint", "test", "typecheck"]),
    cwd: cwdSchema,
    duration_ms: nonnegativeInteger,
    execution_id: z.string().uuid(),
    exit_code: z.number().int().nullable(),
    generation: nonnegativeInteger,
    output: outputReportSchema,
  })
  .strict();

export const sourceStateReportSchema = z
  .object({
    generation: nonnegativeInteger,
    git_head_sha256: sha256Schema,
    git_index_sha256: sha256Schema,
    journal_sha256: sha256Schema,
    snapshot_sha256: sha256Schema,
    source_state_sha256: sha256Schema,
  })
  .strict();

const modelEvidenceReportSchema = z
  .object({
    backend: z.enum(["fake", "ollama"]),
    endpoint_scope: z.enum(["in_process", "literal_loopback"]),
    kind: z.enum(["contract_verified", "local_live_verified"]),
    remote_billable_requests: z.literal(0),
  })
  .strict();

const commonReportFields = {
  changed: z.array(changedFileReportSchema).max(10_000),
  diff_check: diffCheckReportSchema,
  final_source_state: sourceStateReportSchema.nullable(),
  model_evidence: modelEvidenceReportSchema,
  model_narrative: utf8Within(8 * 1024),
  pre_existing_dirty_paths: z.array(relativePathSchema).max(10_000),
  report_hash: sha256Schema,
  run_id: z.string().uuid(),
  schema: z.literal("bornagent.run-report"),
  schema_version: z.literal(1),
  session_id: z.string().uuid(),
  verifications: z.array(verificationReportSchema).max(1_000),
};

export const completedRunReportSchema = z
  .object({
    ...commonReportFields,
    status: z.literal("completed"),
  })
  .strict();

export const incompleteRunReportSchema = z
  .object({
    ...commonReportFields,
    reason: z.enum(COMPLETION_REASON_CODES),
    status: z.literal("incomplete"),
  })
  .strict();

export const runReportSchema = z.discriminatedUnion("status", [
  completedRunReportSchema,
  incompleteRunReportSchema,
]);

export type ChangedFileReport = z.infer<typeof changedFileReportSchema>;
export type CompletedRunReport = z.infer<typeof completedRunReportSchema>;
export type IncompleteRunReport = z.infer<typeof incompleteRunReportSchema>;
export type RunReport = z.infer<typeof runReportSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
