import { describe, expect, it } from "vitest";

import { canonicalDelegationIdentity } from "../../src/delegation/delegation-identity.js";
import { computeDelegationAuthority, delegationAuthorityCeiling } from "../../src/delegation/delegable-authority.js";
import { normalizeDelegationRevision } from "../../src/delegation/delegation-schema.js";
import { phase20Budget, phase20Content } from "../phase20-test-helpers.js";

describe("Phase 20A delegation authority contract", () => {
  it("normalizes order-insensitive authority and path fields into one identity", () => {
    const left = phase20Content();
    const right = normalizeDelegationRevision({
      ...left,
      authorityRequest: { ...left.authorityRequest, toolIds: [...left.authorityRequest.toolIds].reverse() },
      workspace: { ...left.workspace, declaredPathPrefixes: [...left.workspace.declaredPathPrefixes].reverse() },
    });
    expect(canonicalDelegationIdentity(left).delegationSha256).toBe(canonicalDelegationIdentity(right).delegationSha256);
  });

  it("rejects coding drafts without the Host completion gate", () => {
    const coding = phase20Content({ coding: true });
    expect(() => normalizeDelegationRevision({
      ...coding,
      authorityRequest: { ...coding.authorityRequest, toolIds: ["apply_patch"] },
    })).toThrow(/finish_task/u);
  });

  it("never grants hard-denied delegation or lifecycle aliases", () => {
    const request = phase20Content().authorityRequest;
    const ceiling = delegationAuthorityCeiling({
      taskProfiles: ["read-only"],
      toolIds: [...request.toolIds, "propose_delegation"],
      capabilityIds: [],
      modelProfileIds: ["local-free-v1"],
      workspaceModes: ["origin_read_only"],
      maximumBudget: phase20Budget(),
      maximumContextBytes: 32 * 1024,
      maximumAttempts: 1,
    });
    const decision = computeDelegationAuthority({
      request: { ...request, toolIds: [...request.toolIds, "propose_delegation"] },
      workspace: phase20Content().workspace,
      requestedBudget: phase20Budget(),
      requestedContextBytes: 32 * 1024,
      requestedMaximumAttempts: 1,
      requestedModelProfileId: "local-free-v1",
      ceilings: [ceiling],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.denied).toContainEqual(expect.objectContaining({ id: "propose_delegation", kind: "tool" }));
  });
});
