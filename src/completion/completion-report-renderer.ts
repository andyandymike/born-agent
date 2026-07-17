import { canonicalJson, sha256Canonical } from "./canonical-json.js";
import type {
  ChangedFileEvidence,
  CompletionEvidence,
  IncompleteEvidence,
  ModelEvidence,
  VerificationEvidence,
  VerificationSnapshot,
} from "./completion-types.js";
import { hashVerificationSnapshot } from "./verification-snapshot.js";
import {
  completedRunReportSchema,
  incompleteRunReportSchema,
  type CompletedRunReport,
  type IncompleteRunReport,
  type RunReport,
  type VerificationReport,
} from "../reports/run-report-schema.js";

export type ReportFormat = "json" | "text";

function safeText(value: string): string {
  return [...value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const unsafeControl =
        code <= 8 ||
        (code >= 11 && code <= 12) ||
        (code >= 14 && code <= 31) ||
        (code >= 127 && code <= 159);
      const bidiControl =
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return unsafeControl || bidiControl ? "�" : character;
    })
    .join("");
}

function sortedChanged(
  changed: readonly ChangedFileEvidence[],
): readonly ChangedFileEvidence[] {
  return [...changed].sort((left, right) => left.path.localeCompare(right.path));
}

function verificationReport(
  verification: VerificationEvidence,
): VerificationReport {
  return {
    action_sha256: verification.actionSha256,
    after_snapshot_sha256: hashVerificationSnapshot(verification.afterSnapshot),
    argv: [...verification.argv],
    before_snapshot_sha256: hashVerificationSnapshot(verification.beforeSnapshot),
    classification: verification.classification,
    cwd: verification.cwd,
    duration_ms: verification.durationMs,
    execution_id: verification.executionId,
    ...(verification.executionEnvironment === undefined
      ? {}
      : {
          execution_environment: {
            executor: verification.executionEnvironment.executor,
            ...(verification.executionEnvironment.imageDigest === undefined
              ? {}
              : { image_digest: verification.executionEnvironment.imageDigest }),
            isolation: verification.executionEnvironment.isolation,
            network: verification.executionEnvironment.network,
            policy_version: verification.executionEnvironment.policyVersion,
            ...(verification.executionEnvironment.resourceLimits === undefined
              ? {}
              : {
                  resource_limits: {
                    cpus: verification.executionEnvironment.resourceLimits.cpus,
                    memory_mib:
                      verification.executionEnvironment.resourceLimits.memoryMiB,
                    pids: verification.executionEnvironment.resourceLimits.pids,
                    tmp_mib:
                      verification.executionEnvironment.resourceLimits.tmpMiB,
                  },
                }),
            ...(verification.executionEnvironment.snapshotSha256 === undefined
              ? {}
              : {
                  snapshot_sha256:
                    verification.executionEnvironment.snapshotSha256,
                }),
          },
        }),
    exit_code: verification.exitCode,
    generation: verification.generationAtCompletion,
    output: {
      artifact_refs: [...verification.output.artifactRefs],
      event_refs: [...verification.output.eventRefs],
      stderr_summary: verification.output.stderrSummary,
      stdout_summary: verification.output.stdoutSummary,
      total_bytes: verification.output.totalBytes,
      truncated: verification.output.truncated,
    },
    ...(verification.sandboxEphemeralChanges === undefined
      ? {}
      : {
          sandbox_ephemeral_changes: {
            after_sha256: verification.sandboxEphemeralChanges.afterSha256,
            before_sha256: verification.sandboxEphemeralChanges.beforeSha256,
            created: verification.sandboxEphemeralChanges.created,
            deleted: verification.sandboxEphemeralChanges.deleted,
            modified: verification.sandboxEphemeralChanges.modified,
            paths: [...verification.sandboxEphemeralChanges.paths],
            special_entries:
              verification.sandboxEphemeralChanges.specialEntries,
            truncated: verification.sandboxEphemeralChanges.truncated,
          },
        }),
  };
}

function changedFileReport(changed: ChangedFileEvidence) {
  return {
    added_lines: changed.addedLines,
    kind: changed.kind,
    path: changed.path,
    postimage_sha256: changed.postimageSha256,
    preimage_sha256: changed.preimageSha256,
    removed_lines: changed.removedLines,
  };
}

function modelEvidenceReport(evidence: ModelEvidence) {
  return {
    backend: evidence.backend,
    endpoint_scope: evidence.endpointScope,
    kind: evidence.kind,
    remote_billable_requests: evidence.remoteBillableRequests,
  };
}

function finalSourceState(snapshot: VerificationSnapshot | null) {
  if (snapshot === null) {
    return null;
  }
  return {
    generation: snapshot.generation,
    git_head_sha256: snapshot.gitHeadSha256,
    git_index_sha256: snapshot.gitIndexSha256,
    journal_sha256: snapshot.journalSha256,
    snapshot_sha256: hashVerificationSnapshot(snapshot),
    source_state_sha256: snapshot.sourceStateSha256,
  };
}

function commonReport(evidence: CompletionEvidence | IncompleteEvidence) {
  return {
    changed: sortedChanged(evidence.changedByRun).map(changedFileReport),
    diff_check: {
      checked_paths: [...evidence.diffCheck.checkedPaths].sort(),
      detail: evidence.diffCheck.detail,
      diff_sha256: evidence.diffCheck.diffSha256,
      status: evidence.diffCheck.status,
    },
    final_source_state: finalSourceState(evidence.finalSnapshot),
    model_evidence: modelEvidenceReport(evidence.modelEvidence),
    model_narrative: evidence.modelNarrative,
    // PHASE7: Dirty baseline paths remain their own field; renderer ordering can
    // never quietly merge a user's pre-run edits into changed-by-run facts.
    pre_existing_dirty_paths: [...evidence.preExistingDirtyPaths].sort(),
    run_id: evidence.runId,
    schema: "bornagent.run-report" as const,
    schema_version: 1 as const,
    session_id: evidence.sessionId,
    verifications: evidence.verifications.map(verificationReport),
  };
}

export function createCompletedRunReport(
  evidence: CompletionEvidence,
): CompletedRunReport {
  const payload = { ...commonReport(evidence), status: "completed" as const };
  return completedRunReportSchema.parse({
    ...payload,
    report_hash: sha256Canonical(payload),
  });
}

export function createIncompleteRunReport(
  evidence: IncompleteEvidence,
): IncompleteRunReport {
  const payload = {
    ...commonReport(evidence),
    reason: evidence.reason,
    status: "incomplete" as const,
  };
  return incompleteRunReportSchema.parse({
    ...payload,
    report_hash: sha256Canonical(payload),
  });
}

export function verifyRunReportHash(report: RunReport): boolean {
  const { report_hash: expected, ...payload } = report;
  return sha256Canonical(payload) === expected;
}

function renderChanged(lines: string[], report: RunReport): void {
  lines.push("Changed:");
  if (report.changed.length === 0) {
    lines.push("  (none)");
    return;
  }
  for (const changed of report.changed) {
    lines.push(
      `  ${safeText(changed.path)} (+${changed.added_lines} -${changed.removed_lines})`,
    );
  }
}

function renderVerifications(lines: string[], report: RunReport): void {
  lines.push(report.status === "completed" ? "Verified:" : "Verifications:");
  if (report.verifications.length === 0) {
    lines.push("  (none)");
    return;
  }
  for (const verification of report.verifications) {
    lines.push(
      `  argv=${canonicalJson(verification.argv)} cwd=${safeText(verification.cwd)} exit=${String(verification.exit_code)} ${verification.duration_ms}ms`,
    );
    lines.push(
      `    output bytes=${verification.output.total_bytes} truncated=${String(verification.output.truncated)} stdout=${JSON.stringify(safeText(verification.output.stdout_summary))} stderr=${JSON.stringify(safeText(verification.output.stderr_summary))}`,
    );
    if (verification.execution_environment !== undefined) {
      lines.push(
        `    environment executor=${verification.execution_environment.executor} isolation=${verification.execution_environment.isolation} network=${verification.execution_environment.network}`,
      );
    }
    if (verification.sandbox_ephemeral_changes !== undefined) {
      const changes = verification.sandbox_ephemeral_changes;
      lines.push(
        `    sandbox_ephemeral_changes +${changes.created} ~${changes.modified} -${changes.deleted} (not copied back)`,
      );
    }
  }
}

function renderTextReport(report: RunReport): string {
  const lines = [
    report.status === "completed" ? "Completed" : `Incomplete: ${report.reason}`,
  ];
  renderChanged(lines, report);
  renderVerifications(lines, report);
  lines.push("Checks:");
  lines.push(
    `  run-local diff check ${report.diff_check.status} (${safeText(report.diff_check.detail)})`,
  );
  lines.push("Pre-existing dirty paths:");
  lines.push(
    ...(report.pre_existing_dirty_paths.length === 0
      ? ["  (none)"]
      : report.pre_existing_dirty_paths.map((path) => `  ${safeText(path)}`)),
  );
  // PHASE7: Patch/test evidence and backend evidence answer different questions.
  // A fake model can drive a real local test; neither fact is allowed to imply the other.
  lines.push("Model evidence:");
  lines.push(
    `  ${report.model_evidence.kind} backend=${report.model_evidence.backend} endpoint=${report.model_evidence.endpoint_scope} remote_billable_requests=${report.model_evidence.remote_billable_requests}`,
  );
  // PHASE7: Narrative is explicitly quoted model text. Changed paths, line counts,
  // commands, durations, and exits above come only from the evidence ledger.
  lines.push("Model narrative (not factual evidence):");
  for (const line of safeText(report.model_narrative).split("\n")) {
    lines.push(`  | ${line}`);
  }
  lines.push(`Report hash: ${report.report_hash}`);
  return `${lines.join("\n")}\n`;
}

export function renderRunReport(report: RunReport, format: ReportFormat): string {
  return format === "json" ? `${canonicalJson(report)}\n` : renderTextReport(report);
}
