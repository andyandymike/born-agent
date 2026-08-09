import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  originVerificationReceiptMatchesCompletedEvent,
  originVerificationReceiptSchema,
} from "../../src/worktrees/origin-verification-receipt.js";

const sha = "a".repeat(64);

function receipt() {
  const body = {
    actionSha256: sha,
    afterSourceStateSha256: sha,
    beforeSourceStateSha256: sha,
    bundleSha256: sha,
    cleanupVerified: true,
    commandSha256: sha,
    durationMs: 12,
    exitCode: 0,
    graphId: "94000000-0000-4000-8000-000000000019",
    graphRevision: 1,
    graphSha256: sha,
    originSourceSnapshotSha256: sha,
    promotionOperationId: "94000000-0000-4000-8000-000000000020",
    schemaVersion: 1 as const,
    status: "passed" as const,
    stderrBytes: 0,
    stdoutBytes: 4,
    termination: "exit" as const,
    verificationId: "94000000-0000-4000-8000-000000000021",
    verificationNodeId: "verify",
    workspaceId: "94000000-0000-4000-8000-000000000022",
  };
  return { ...body, receiptSha256: sha256Canonical(body) };
}

describe("Phase 19 origin verification receipt", () => {
  it("accepts one self-hashed exact receipt and rejects field tampering", () => {
    const valid = receipt();
    expect(originVerificationReceiptSchema.parse(valid).status).toBe("passed");
    expect(originVerificationReceiptSchema.safeParse({ ...valid, stdoutBytes: 5 }).success).toBe(false);
  });

  it("requires every durable completion field to match the receipt", () => {
    const valid = originVerificationReceiptSchema.parse(receipt());
    const event = {
      action_sha256: valid.actionSha256,
      after_source_state_sha256: valid.afterSourceStateSha256,
      before_source_state_sha256: valid.beforeSourceStateSha256,
      bundle_sha256: valid.bundleSha256,
      cleanup_verified: valid.cleanupVerified,
      command_sha256: valid.commandSha256,
      exit_code: valid.exitCode,
      graph_id: valid.graphId,
      graph_revision: valid.graphRevision,
      graph_sha256: valid.graphSha256,
      origin_source_snapshot_sha256: valid.originSourceSnapshotSha256,
      promotion_operation_id: valid.promotionOperationId,
      receipt_artifact_id: `sha256:${sha}`,
      receipt_sha256: valid.receiptSha256,
      status: valid.status,
      termination: valid.termination,
      verification_id: valid.verificationId,
      verification_node_id: valid.verificationNodeId,
      workspace_id: valid.workspaceId,
    } as const;
    expect(originVerificationReceiptMatchesCompletedEvent(valid, event)).toBe(true);
    expect(originVerificationReceiptMatchesCompletedEvent(valid, {
      ...event,
      command_sha256: "b".repeat(64),
    })).toBe(false);
  });
});
