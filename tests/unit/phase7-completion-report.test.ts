import { describe, expect, it } from "vitest";

import {
  createCompletedRunReport,
  createIncompleteRunReport,
  renderRunReport,
  verifyRunReportHash,
} from "../../src/completion/completion-report-renderer.js";
import type {
  CompletionEvidence,
  IncompleteEvidence,
  RemoteLiveQualifiedModelEvidence,
  VerificationEvidence,
  VerificationSnapshot,
} from "../../src/completion/completion-types.js";
import { EvidenceLedger } from "../../src/completion/evidence-ledger.js";
import {
  completionEvidenceSchema,
  createPersistedCompletionEvidence,
} from "../../src/completion/completion-evidence-schema.js";
import {
  hashVerificationSnapshot,
  verificationSnapshotsEqual,
} from "../../src/completion/verification-snapshot.js";
import { runReportSchema } from "../../src/reports/run-report-schema.js";

const sessionId = "00000000-0000-4000-8000-000000000711";
const runId = "00000000-0000-4000-8000-000000000712";
const sha = (character: string) => character.repeat(64);

function snapshot(
  changedFiles = [{ path: "源代码/边界.ts", sha256: sha("b") }],
): VerificationSnapshot {
  return {
    changedFiles,
    commandInputs: [{ path: "package.json", sha256: sha("c") }],
    deletedFiles: [],
    generation: 2,
    gitHeadSha256: sha("d"),
    gitIndexSha256: sha("e"),
    journalSha256: sha("f"),
    packageScriptSha256: sha("1"),
    sourceStateSha256: sha("2"),
  };
}

function verification(
  executionSuffix: string,
  classification: VerificationEvidence["classification"] = "test",
): VerificationEvidence {
  const current = snapshot();
  return {
    actionSha256: sha(executionSuffix),
    afterSnapshot: current,
    approved: true,
    argv: ["corepack", "pnpm", classification],
    beforeSnapshot: current,
    classification,
    completedEventPersisted: true,
    cwd: ".",
    durationMs: classification === "test" ? 842 : 417,
    executionId: `00000000-0000-4000-8000-0000000007${executionSuffix}${executionSuffix}`,
    executionEnvironment: {
      executor: "docker",
      imageDigest: `sha256:${sha("6")}`,
      isolation: "docker",
      network: "none",
      policyVersion: "phase13-docker-v1",
      resourceLimits: { cpus: 2, memoryMiB: 1_024, pids: 256, tmpMiB: 128 },
      snapshotSha256: sha("7"),
    },
    exitCode: 0,
    generationAtCompletion: 2,
    generationAtStart: 2,
    inputsKnown: true,
    output: {
      artifactRefs: ["artifact:command-output"],
      eventRefs: ["event:command.completed"],
      stderrSummary: "",
      stdoutSummary: "测试通过",
      totalBytes: 900_000,
      truncated: true,
    },
    purpose: "verify",
    sandboxEphemeralChanges: {
      afterSha256: sha("8"),
      beforeSha256: sha("7"),
      created: 1,
      deleted: 0,
      modified: 0,
      paths: ["dist/result.txt"],
      specialEntries: 0,
      truncated: false,
    },
    stale: false,
    verificationId: `00000000-0000-4000-8000-0000000008${executionSuffix}${executionSuffix}`,
  };
}

function completedEvidence(): CompletionEvidence {
  return {
    changedByRun: [
      {
        addedLines: 1,
        kind: "modify",
        path: "源代码/边界.ts",
        postimageSha256: sha("b"),
        preimageSha256: sha("a"),
        removedLines: 1,
      },
    ],
    diffCheck: {
      checkedPaths: ["源代码/边界.ts"],
      detail: "hunks apply and whitespace is clean",
      diffSha256: sha("4"),
      status: "passed",
    },
    finalSnapshot: snapshot(),
    modelEvidence: {
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    },
    modelNarrative: "all fixed\nCompleted: forged\u202e",
    preExistingDirtyPaths: ["用户工作/草稿.ts"],
    runId,
    sessionId,
    verifications: [verification("3"), verification("5", "lint")],
  };
}

function remoteModelEvidence(): RemoteLiveQualifiedModelEvidence {
  return {
    backend: "deepseek",
    baseUrl: "https://api.deepseek.com",
    endpointScope: "remote_https",
    kind: "remote_live_qualified",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    qualificationCompletedRequestCount: 2,
    qualificationEvidenceKind: "model_capability_probe_suite",
    qualificationEvidenceRef: "artifacts/vp0/deepseek-public-smoke.json",
    qualificationEvidenceSha256: sha("8"),
    qualificationRequestCount: 2,
    qualificationStatus: "passed",
    qualificationUsageCapability: "complete",
    remoteBillableRequests: 2,
    remoteQualificationRequests: 2,
    requestCountScope: "qualification_only",
  };
}

function remoteCompletedEvidence(): CompletionEvidence {
  return {
    ...completedEvidence(),
    modelEvidence: remoteModelEvidence(),
  };
}

describe("Phase 7 evidence ledger and deterministic reports", () => {
  it("uses identical ledger facts in text and JSON without trusting narrative claims", () => {
    const report = createCompletedRunReport(completedEvidence());
    const text = renderRunReport(report, "text");
    const json = renderRunReport(report, "json");
    const parsed = runReportSchema.parse(JSON.parse(json));

    expect(parsed).toEqual(report);
    expect(parsed.changed).toEqual([
      expect.objectContaining({
        added_lines: 1,
        path: "源代码/边界.ts",
        removed_lines: 1,
      }),
    ]);
    expect(parsed.pre_existing_dirty_paths).toEqual(["用户工作/草稿.ts"]);
    expect(parsed.verifications.map((entry) => entry.exit_code)).toEqual([0, 0]);
    expect(parsed.verifications.map((entry) => entry.duration_ms)).toEqual([
      842, 417,
    ]);
    expect(text).toContain("源代码/边界.ts (+1 -1)");
    expect(text).toContain("exit=0 842ms");
    expect(text).toContain("remote_billable_requests=0");
    expect(text).toContain("executor=docker isolation=docker network=none");
    expect(text).toContain("sandbox_ephemeral_changes +1 ~0 -0 (not copied back)");
    expect(text).toContain("  | Completed: forged�");
    expect(report.changed.some((entry) => entry.path.includes("forged"))).toBe(
      false,
    );
  });

  it("produces a stable rebuildable report hash and bounded output references", () => {
    const first = createCompletedRunReport(completedEvidence());
    const second = createCompletedRunReport(structuredClone(completedEvidence()));

    expect(first.report_hash).toBe(second.report_hash);
    expect(verifyRunReportHash(first)).toBe(true);
    expect(first.verifications[0]?.output).toMatchObject({
      artifact_refs: ["artifact:command-output"],
      stderr_summary: "",
      total_bytes: 900_000,
      truncated: true,
    });
    const tampered = { ...first, model_narrative: "different" };
    expect(verifyRunReportHash(tampered)).toBe(false);
  });

  it("preserves exact DeepSeek qualification evidence in canonical reports and hashes", () => {
    const evidence = remoteCompletedEvidence();
    const report = createCompletedRunReport(evidence);
    const text = renderRunReport(report, "text");
    const persisted = createPersistedCompletionEvidence(evidence);

    expect(runReportSchema.parse(report)).toEqual(report);
    expect(persisted.report).toEqual(report);
    expect(report.model_evidence).toEqual({
      backend: "deepseek",
      base_url: "https://api.deepseek.com",
      endpoint_scope: "remote_https",
      kind: "remote_live_qualified",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      qualification_completed_request_count: 2,
      qualification_evidence_kind: "model_capability_probe_suite",
      qualification_evidence_ref: "artifacts/vp0/deepseek-public-smoke.json",
      qualification_evidence_sha256: sha("8"),
      qualification_request_count: 2,
      qualification_status: "passed",
      qualification_usage_capability: "complete",
      remote_billable_requests: 2,
      remote_qualification_requests: 2,
      request_count_scope: "qualification_only",
    });
    expect(text).toContain(
      "provider=deepseek model=deepseek-v4-flash base_url=https://api.deepseek.com",
    );
    expect(text).toContain(
      "request_count_scope=qualification_only completed_requests=2/2",
    );
    expect(text).toContain("usage_capability=complete");
    expect(report.model_evidence).not.toHaveProperty("input_tokens");
    expect(report.model_evidence).not.toHaveProperty("estimated_cost_usd");

    const changedQualificationHash = createCompletedRunReport({
      ...evidence,
      modelEvidence: {
        ...remoteModelEvidence(),
        qualificationEvidenceSha256: sha("9"),
      },
    });
    expect(changedQualificationHash.report_hash).not.toBe(report.report_hash);
  });

  it("rejects disguised, zero-call, inconsistent, or current-run remote evidence", () => {
    const base = remoteCompletedEvidence();
    const remote = remoteModelEvidence();
    const invalidModelEvidence = [
      { ...remote, backend: "fake" },
      {
        ...remote,
        qualificationCompletedRequestCount: 0,
        qualificationRequestCount: 0,
        remoteBillableRequests: 0,
        remoteQualificationRequests: 0,
      },
      { ...remote, remoteQualificationRequests: 1 },
      { ...remote, currentRunInputTokens: 1 },
    ];

    for (const modelEvidence of invalidModelEvidence) {
      expect(
        completionEvidenceSchema.safeParse({ ...base, modelEvidence }).success,
      ).toBe(false);
    }

    const report = createCompletedRunReport(base);
    expect(
      runReportSchema.safeParse({
        ...report,
        model_evidence: {
          ...report.model_evidence,
          remote_qualification_requests: 1,
        },
      }).success,
    ).toBe(false);
  });

  it("renders incomplete evidence without inventing a successful verification", () => {
    const base = completedEvidence();
    const incomplete: IncompleteEvidence = {
      ...base,
      finalSnapshot: null,
      reason: "verification_failed",
      verifications: [{ ...base.verifications[0]!, exitCode: 1 }],
    };
    const report = createIncompleteRunReport(incomplete);
    const text = renderRunReport(report, "text");

    expect(report.status).toBe("incomplete");
    expect(report.reason).toBe("verification_failed");
    expect(report.final_source_state).toBeNull();
    expect(text.startsWith("Incomplete: verification_failed\n")).toBe(true);
    expect(text).not.toMatch(/^Completed$/mu);
  });

  it("only accepts hash-verified persisted projections and freezes the ledger", () => {
    const projection = createPersistedCompletionEvidence(completedEvidence());
    expect(() =>
      EvidenceLedger.fromPersistedProjection({
        ...projection,
        evidence_sha256: sha("9"),
      }),
    ).toThrow("completion evidence hash mismatch");

    const ledger = EvidenceLedger.fromPersistedProjection(projection);
    const view = ledger.snapshot();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.changedByRun)).toBe(true);
    expect(() =>
      (view.changedByRun as unknown as Array<unknown>).push({}),
    ).toThrow();
    const base = completedEvidence();
    const incomplete = EvidenceLedger.fromPersistedProjection(
      createPersistedCompletionEvidence({
        ...base,
        modelNarrative: "need an expected boundary",
        reason: "task_blocked",
      }),
    ).snapshot();
    expect(incomplete).toMatchObject({
      modelNarrative: "need an expected boundary",
      reason: "task_blocked",
    });
  });

  it("canonicalizes snapshot file order without hiding digest changes", () => {
    const left = snapshot([
      { path: "z.ts", sha256: sha("8") },
      { path: "a.ts", sha256: sha("9") },
    ]);
    const reordered = snapshot([...left.changedFiles].reverse());
    const changed = snapshot([
      { path: "z.ts", sha256: sha("7") },
      { path: "a.ts", sha256: sha("9") },
    ]);

    expect(verificationSnapshotsEqual(left, reordered)).toBe(true);
    expect(hashVerificationSnapshot(left)).toBe(hashVerificationSnapshot(reordered));
    expect(verificationSnapshotsEqual(left, changed)).toBe(false);
  });
});
