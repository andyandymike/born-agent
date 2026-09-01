import { describe, expect, it } from "vitest";

import { createContextItem } from "../../src/context/context-item.js";
import { DeterministicTokenEstimator } from "../../src/context/token-estimator.js";
import {
  createPublicSyntheticRemoteMemoryGrantV1,
  publicSyntheticRemoteMemoryExcerptSha256,
  publicSyntheticRemoteMemoryTaskSha256,
  assertPublicSyntheticRemoteMemoryGrantAllowsPreparedRecall,
  assertPublicSyntheticRemoteMemoryGrantIdentity,
  verifyPublicSyntheticRemoteMemoryGrantV1,
} from "../../src/memory/recall/public-synthetic-remote-memory-grant.js";
import { createRecallSelectionV1 } from "../../src/memory/recall/ml3-recall-contract.js";

const SHA = {
  authorization: "a".repeat(64),
  root: "b".repeat(64),
  record: "c".repeat(64),
  request: "d".repeat(64),
  source: "e".repeat(64),
} as const;
const recordId = `memory_${"1".repeat(64)}`;
const revisionId = `revision_${"2".repeat(64)}`;
const task = "Apply the saved MEM-E0 public repository constraint.";
const scope = Object.freeze({
  applicationRepositoryId: "repo-public-mem-e0",
  canonicalRootIdentitySha256: SHA.root,
  ownerPrincipalId: "principal-public-mem-e0",
});

function preparedRecall(content = "BORNAGENT_HISTORICAL_EVIDENCE_V1_BEGIN\npublic synthetic\nEND") {
  const estimator = new DeterministicTokenEstimator({
    model: "deepseek-v4-flash",
    provider: "deepseek",
    tokenizer: "deterministic",
    version: "mem-rd0-test-v1",
  });
  const item = createContextItem({
    authority: "historical_only",
    content,
    kind: "historical_memory",
    metadata: {
      recall_selection_sha256: "f".repeat(64),
      record_id: recordId,
      record_sha256: SHA.record,
      source_reference_sha256: SHA.source,
    },
    pairing: null,
    priority: "low",
    protectedCategory: null,
    recency: 0,
    role: "system",
    sourceEventIds: ["event-public-mem-e0"],
    turnId: "run-public-mem-e0",
    visibility: "provider_context",
  }, estimator);
  const selection = createRecallSelectionV1({
    abstentionReason: null,
    budget: {
      contextTargetTokens: 32_768,
      estimatedTokensUsed: item.estimatedTokens,
      injectedTokenLimit: 1_024,
      textBytesUsed: Buffer.byteLength(content, "utf8"),
    },
    query: {
      querySha256: "3".repeat(64),
      retrieverId: "fts5-v2",
      retrieverVersion: "2",
    },
    request: {
      requestSha256: SHA.request,
      runId: "run-public-mem-e0",
      sessionId: "session-public-mem-e0",
      step: 1,
    },
    scope,
    selectedRecords: [{
      activeStatus: "available",
      estimatedTokens: item.estimatedTokens,
      occurredAt: "2026-09-01T00:00:00.000Z",
      reason: "lexical_bm25",
      recordId,
      recordSha256: SHA.record,
      revisionId,
      sourceReferenceSha256: SHA.source,
      sourceStatus: "available",
      textBytes: Buffer.byteLength(content, "utf8"),
    }],
  });
  return Object.freeze({ items: Object.freeze([item]), selection });
}

function grant(content: string) {
  return createPublicSyntheticRemoteMemoryGrantV1({
    allowedRecords: [{
      disclosureClass: "public_synthetic",
      excerptContentSha256: publicSyntheticRemoteMemoryExcerptSha256(content),
      recordId,
      recordSha256: SHA.record,
      sourceReferenceSha256: SHA.source,
    }],
    authorizationRefSha256: SHA.authorization,
    canonicalRootIdentitySha256: SHA.root,
    maximumSelectedRecords: 1,
    model: "deepseek-v4-flash",
    ownerPrincipalId: scope.ownerPrincipalId,
    policyProfileId: "fal-mem-e0-remote-v1",
    provider: "deepseek",
    purpose: "fal_mem_e0_public_synthetic_effect_eval",
    repositoryId: scope.applicationRepositoryId,
    runId: "run-public-mem-e0",
    schemaVersion: 1,
    sessionId: "session-public-mem-e0",
    taskSha256: publicSyntheticRemoteMemoryTaskSha256(task),
    transportScope: "provider_network",
  });
}

describe("public synthetic remote memory grant", () => {
  it("binds one exact run, scope, provider, task, record and rendered excerpt", () => {
    const prepared = preparedRecall();
    const value = grant(prepared.items[0]!.content);
    expect(verifyPublicSyntheticRemoteMemoryGrantV1(value).grantSha256)
      .toBe(value.grantSha256);
    expect(assertPublicSyntheticRemoteMemoryGrantIdentity({
      grant: value,
      model: "deepseek-v4-flash",
      policyProfileId: "fal-mem-e0-remote-v1",
      provider: "deepseek",
      runId: "run-public-mem-e0",
      scope,
      sessionId: "session-public-mem-e0",
      task,
    }).grantSha256).toBe(value.grantSha256);
    expect(() => assertPublicSyntheticRemoteMemoryGrantAllowsPreparedRecall({
      grant: value,
      prepared,
    })).not.toThrow();
  });

  it("rejects self-hash, run identity and outgoing excerpt tampering", () => {
    const prepared = preparedRecall();
    const value = grant(prepared.items[0]!.content);
    expect(() => verifyPublicSyntheticRemoteMemoryGrantV1({
      ...value,
      model: "different-model",
    })).toThrow(/hash does not match/u);
    expect(() => assertPublicSyntheticRemoteMemoryGrantIdentity({
      grant: value,
      model: "deepseek-v4-flash",
      policyProfileId: "fal-mem-e0-remote-v1",
      provider: "deepseek",
      runId: "different-run",
      scope,
      sessionId: "session-public-mem-e0",
      task,
    })).toThrow(/identity does not match/u);
    expect(() => assertPublicSyntheticRemoteMemoryGrantAllowsPreparedRecall({
      grant: value,
      prepared: preparedRecall("different public bytes"),
    })).toThrow(/bytes do not match/u);
  });
});
