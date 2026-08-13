import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { renderDelegationOwnerOutcome } from "../../src/commands/delegations.js";
import {
  releaseCancelledDelegationGroupLease,
  type DelegationOwnerExecutionOutcomeV1,
} from "../../src/delegation/delegation-owner-execution-service.js";
import type { DelegationGroupLeaseRecordV1 } from "../../src/delegation/delegation-group-lease-store.js";
import {
  installDelegationChildCancellationLatch,
  waitForDelegationChildStart,
} from "../../src/delegation/runtime/delegation-child-runtime.js";
import type { DelegationChildControlChannelV1 } from "../../src/delegation/runtime/child-approval-bridge.js";
import type { ExecutableChildEnvelopeV1 } from "../../src/delegation/runtime/executable-child-envelope.js";
import { createMemoryIO } from "../helpers.js";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("Phase 21A surface-neutral owner execution boundaries", () => {
  it("keeps production Agent and Delegation owners outside command modules and broad CLI runtime types", async () => {
    const [
      agentOwner,
      delegationOwner,
      agentApplicationAdapter,
      delegationApplicationOwner,
      agentCommand,
      delegationCommand,
    ] = await Promise.all([
      source("src/agent/agent-execution-service.ts"),
      source("src/delegation/delegation-owner-execution-service.ts"),
      source("src/control-plane/adapters/agent-cli-adapter.ts"),
      source("src/control-plane/adapters/delegation-composite-cli-port.ts"),
      source("src/commands/agent.ts"),
      source("src/commands/delegations.ts"),
    ]);

    for (const owner of [agentOwner, delegationOwner]) {
      expect(owner).not.toMatch(/(?:\.\.\/)*commands\//u);
      expect(owner).not.toMatch(/cli\/types\.js/u);
      expect(owner).not.toMatch(/\bCli(?:IO|Runtime)\b/u);
      expect(owner).not.toMatch(/\b(?:Commander|process\.)/u);
    }
    expect(agentOwner).not.toContain("outcome-report-renderer");
    expect(delegationApplicationOwner).not.toMatch(/(?:\.\.\/)*commands\//u);
    expect(delegationApplicationOwner).not.toMatch(/cli\/types\.js/u);
    expect(agentApplicationAdapter).not.toMatch(/(?:\.\.\/)*commands\/(?:agent|delegations)\.js/u);

    expect(agentCommand).toContain("executeAgentExecution(");
    expect(agentCommand).not.toContain("runAgentLoop(");
    expect(delegationCommand).toContain("executeDelegationOwnerPrepare(");
    expect(delegationCommand).toContain("executeDelegationOwnerStart(");
    expect(delegationCommand).toContain("executeDelegationOwnerResume(");
    for (const ownerOnlySymbol of [
      "DelegationPreparationRuntime",
      "DelegationBudgetLedger",
      "DelegationChildLaunchFailure",
      "BoundedDelegationScheduler",
    ]) expect(delegationCommand).not.toContain(ownerOnlySymbol);
  });

  it("renders the typed Delegation owner result without changing its result, diagnostic, or exit", () => {
    const memory = createMemoryIO();
    const outcome: DelegationOwnerExecutionOutcomeV1 = Object.freeze({
      diagnostic: Object.freeze({
        code: "delegation_effect_reconciliation_required",
        message: "owner terminal predicate was incomplete",
      }),
      exitCode: 8,
      result: Object.freeze({
        kind: "prepared",
        childNotStarted: true,
        capsuleBytes: 128,
        capsuleSha256: "a".repeat(64),
        envelopeSha256: "a".repeat(64),
        toolCount: 0,
        capabilityCount: 0,
        model: Object.freeze({
          contextCapacity: 1024,
          delegatedToolProfileSha256: "a".repeat(64),
          envelopeSha256: "a".repeat(64),
          executionBackend: "canonical_fake",
          modelId: "test",
          networkEligibility: "local_only",
          policyProfileId: "test",
          providerId: "test",
          qualificationId: "test",
          qualificationSha256: "a".repeat(64),
        }),
        workspace: Object.freeze({
          declaredPathPrefixes: ["."],
          lineageId: "a".repeat(64),
          logicalWorkspaceId: "workspace",
          mode: "origin_read_only",
          sourceSnapshotSha256: "a".repeat(64),
        }),
      }),
    });

    expect(renderDelegationOwnerOutcome(outcome, false, memory.io)).toBe(8);
    expect(memory.readStdout()).toBe(
      `Delegation prepared (child not started)\nCapsule: ${"a".repeat(64)}\nEnvelope: ${"a".repeat(64)}\n`,
    );
    expect(memory.readStderr()).toBe(
      "delegation_effect_reconciliation_required: owner terminal predicate was incomplete\n",
    );

    const json = createMemoryIO();
    expect(renderDelegationOwnerOutcome(
      Object.freeze({ ...outcome, diagnostic: null, exitCode: 0 }),
      true,
      json.io,
    )).toBe(0);
    expect(JSON.parse(json.readStdout())).toEqual({
      command: "delegations.prepare",
      ok: true,
      result: expect.objectContaining({
        kind: "prepared",
        childNotStarted: true,
        envelopeSha256: "a".repeat(64),
      }),
      schemaVersion: 1,
    });
    expect(json.readStderr()).toBe("");
  });

  it("never reports a pre-admission cancellation without an exact external lease release", async () => {
    const groupId = "10000000-0000-4000-8000-000000000001";
    const sessionId = "20000000-0000-4000-8000-000000000002";
    const expectedLeaseSha256 = "a".repeat(64);
    const wrongRelease = Object.freeze({
      acquiredAt: "2026-08-12T00:00:00.000Z",
      graphBindingSha256: null,
      groupId: "30000000-0000-4000-8000-000000000003",
      leaseSha256: "b".repeat(64),
      nonceSha256: "c".repeat(64),
      ownerBackgroundOperationId: null,
      ownerKind: "foreground",
      ownerPid: 1,
      ownerProcessStartIdentity: "fixture",
      parentActorId: "40000000-0000-4000-8000-000000000004",
      parentRunId: "50000000-0000-4000-8000-000000000005",
      releaseReason: "cancelled",
      repositoryId: "d".repeat(64),
      revision: 2,
      schemaVersion: 1,
      sessionId,
      state: "released",
      updatedAt: "2026-08-12T00:00:01.000Z",
    }) satisfies DelegationGroupLeaseRecordV1;

    await expect(releaseCancelledDelegationGroupLease({}, {
      expectedLeaseSha256,
      groupId,
      sessionId,
    })).rejects.toMatchObject({ code: "delegation_lease_busy" });
    await expect(releaseCancelledDelegationGroupLease({
      releaseDelegationGroupLease: async () => { throw new Error("injected response loss"); },
    }, {
      expectedLeaseSha256,
      groupId,
      sessionId,
    })).rejects.toThrow("injected response loss");
    await expect(releaseCancelledDelegationGroupLease({
      releaseDelegationGroupLease: async () => wrongRelease,
    }, {
      expectedLeaseSha256,
      groupId,
      sessionId,
    })).rejects.toMatchObject({ code: "delegation_lease_busy" });
  });

  it("latches an exact cancel frame that arrives before the child start barrier", async () => {
    const messageListeners = new Set<(frame: unknown) => void>();
    const closeListeners = new Set<() => void>();
    const channel: DelegationChildControlChannelV1 = {
      connected: true,
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      onMessage: (listener) => {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      send: () => undefined,
    };
    const operationId = "60000000-0000-4000-8000-000000000006";
    const childAttemptId = "70000000-0000-4000-8000-000000000007";
    const envelopeSha256 = "e".repeat(64);
    const startBarrierProofSha256 = "f".repeat(64);
    const envelope = {
      envelopeSha256,
      execution: { operationId, startBarrierNonceSha256: startBarrierProofSha256 },
      prepared: { actor: { attemptId: childAttemptId } },
    } as unknown as ExecutableChildEnvelopeV1;
    const cancellation = installDelegationChildCancellationLatch({
      channel,
      childAttemptId,
      operationId,
    });
    const waiting = waitForDelegationChildStart({
      channel,
      envelope,
      timeoutMs: 1_000,
    });
    for (const listener of [...messageListeners]) listener({
      childAttemptId,
      envelopeSha256,
      frame: "start",
      operationId,
      protocolVersion: 1,
      schemaVersion: 1,
      startBarrierProofSha256,
    });
    await waiting;
    // The one-shot start listener is gone; the independent cancellation
    // listener must remain and latch a frame before execution subscribes.
    expect(messageListeners).toHaveLength(1);
    for (const listener of [...messageListeners]) listener({
      cancelRequestId: "80000000-0000-4000-8000-000000000008",
      childAttemptId,
      frame: "cancel",
      operationId,
      protocolVersion: 1,
      reasonSha256: "1".repeat(64),
      kind: "user_cancel",
      schemaVersion: 1,
    });
    let replayed = 0;
    cancellation.onCancel(() => { replayed += 1; });
    expect(replayed).toBe(1);
    cancellation.dispose();
    expect(messageListeners).toHaveLength(0);
  });

  it("preserves a Host surface-fatal reason for an already active child", () => {
    const messageListeners = new Set<(frame: unknown) => void>();
    const channel: DelegationChildControlChannelV1 = {
      connected: true,
      onClose: () => () => undefined,
      onMessage: (listener) => {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      send: () => undefined,
    };
    const operationId = "60000000-0000-4000-8000-000000000016";
    const childAttemptId = "70000000-0000-4000-8000-000000000017";
    const latch = installDelegationChildCancellationLatch({ channel, childAttemptId, operationId });
    const observed: string[] = [];
    latch.onCancel((reason) => observed.push(reason));
    for (const listener of [...messageListeners]) listener({
      cancelRequestId: "80000000-0000-4000-8000-000000000018",
      childAttemptId,
      frame: "cancel",
      kind: "tui_surface_fatal",
      operationId,
      protocolVersion: 1,
      reasonSha256: "1".repeat(64),
      schemaVersion: 1,
    });
    expect(observed).toEqual(["tui_surface_fatal"]);
    latch.dispose();
  });
});
