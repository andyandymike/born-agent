import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../../src/completion/canonical-json.js";

import type { CliIO, CliRuntime } from "../../src/cli/types.js";
import type { ApplicationCommitBindingV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import { CliDelegationCompositeOwnerPort } from "../../src/control-plane/adapters/delegation-composite-cli-port.js";
import { CliGraphCompositeOwnerPort } from "../../src/control-plane/adapters/graph-composite-cli-port.js";
import { ForegroundGraphControlRegistry } from "../../src/control-plane/foreground-graph-control-registry.js";
import { ActiveDelegationControlRegistry } from "../../src/control-plane/active-delegation-control-registry.js";
import { ActiveOwnerCompositeControlRegistry } from "../../src/control-plane/active-owner-composite-control-registry.js";
import type { DelegationCompositeOwnerPortV1 } from "../../src/control-plane/use-cases/delegation-composite-actions.js";
import type { DecodedStoredEvent } from "../../src/events/event-decoder-registry.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";

const SHA = "a".repeat(64);
const RAW = "b".repeat(64);
const SIGNER = new SessionLedgerHeadSigner(Buffer.alloc(32, 7));

function event(sessionId: string, sequence: number, type: string, data: unknown): DecodedStoredEvent {
  return {
    data,
    eventId: randomUUID(),
    recordedAt: "2026-08-12T00:00:00.000Z",
    runId: null,
    schemaVersion: 1,
    scope: "session",
    sessionId,
    sessionSeq: sequence,
    type,
  } as unknown as DecodedStoredEvent;
}

function binding(actionKind: string): ApplicationCommitBindingV1 {
  return Object.freeze({
    actionKind,
    authorizationDecisionSha256: SHA,
    operationId: randomUUID(),
    preparedActionSha256: SHA,
    principalId: "local_owner",
    schemaVersion: 1,
  });
}

function origin(commit: ApplicationCommitBindingV1) {
  return Object.freeze({
    application_commit: Object.freeze({
      action_kind: commit.actionKind,
      authorization_decision_sha256: commit.authorizationDecisionSha256,
      operation_id: commit.operationId,
      prepared_action_sha256: commit.preparedActionSha256,
      principal_id: commit.principalId,
      schema_version: 1,
    }),
  });
}

function authenticatedOrigin(commit: ApplicationCommitBindingV1) {
  return Object.freeze({
    ...origin(commit),
    kind: "authenticated_surface",
  });
}

function head(sessionId: string, expected: DecodedStoredEvent): SessionLedgerHeadV1 {
  return SIGNER.create({
    eventId: expected.eventId,
    rawEventSha256: RAW,
    sequence: expected.sessionSeq,
    sessionId,
  }).publicHead;
}

const io = Object.freeze({
  stderr: Object.freeze({ write: vi.fn() }),
  stdout: Object.freeze({ write: vi.fn() }),
}) as unknown as CliIO;

describe("Phase 21A production composite response-loss reconciliation", () => {
  it("reconciles an exact pre-effect cancellation through unrelated later appends and rejects admitted or forged evidence", async () => {
    const sessionId = randomUUID();
    const applicationCommit = binding("worktree.allocate");
    const expected = event(sessionId, 1, "run.started", {});
    const graphId = randomUUID();
    const payload = Object.freeze({
      allowDirty: false,
      revision: 1,
      sha256: SHA,
      sourceNodeId: "build",
    });
    const targetIdentitySha256 = sha256Canonical({
      action_kind: "worktree.allocate",
      payload,
      schema_version: 1,
    });
    const prepared = event(sessionId, 2, "task_worktree.allocation.prepared", {
      graph_id: graphId,
      graph_revision: 1,
      graph_sha256: SHA,
      origin: origin(applicationCommit),
    });
    const terminal = event(sessionId, 3, "task_effect.admission.terminal", {
      action_kind: "worktree.allocate",
      graph_id: graphId,
      graph_revision: 1,
      graph_sha256: SHA,
      origin: origin(applicationCommit),
      outcome: "cancelled",
      target_identity_sha256: targetIdentitySha256,
    });
    const unrelated = event(sessionId, 4, "run.started", {});
    const evidence = vi.fn(async () => ({
      projection: { events: [expected, prepared, terminal, unrelated] },
      rawSha256: new Map([expected, prepared, terminal, unrelated].map((item) => [item.eventId, RAW])),
    }) as never);
    const owner = new CliGraphCompositeOwnerPort({
      activeOwnerComposites: new ActiveOwnerCompositeControlRegistry(),
      foregroundGraphControls: new ForegroundGraphControlRegistry(),
      io,
      readObservationEvidence: evidence,
      runtime: { cwd: "D:\\unused" } as unknown as CliRuntime,
      signer: SIGNER,
    });
    const input = {
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({ actionKind: "worktree.allocate" as const, payload }),
      sessionId,
    };
    const recovered = await owner.reconcile!(input);
    expect(recovered).toMatchObject({
      primaryEventType: "task_effect.admission.terminal",
      result: {
        actionKind: "worktree.allocate",
        kind: "pre_effect_terminal",
        outcome: "cancelled",
        targetIdentitySha256,
      },
      resolvedHead: { eventId: terminal.eventId, sequence: 3 },
      underlyingOperationRefs: [],
    });

    const admitted = event(sessionId, 4, "task_worktree.allocation.approved", {
      graph_id: graphId,
      graph_revision: 1,
      graph_sha256: SHA,
    });
    evidence.mockResolvedValueOnce({
      projection: { events: [expected, prepared, terminal, admitted] },
      rawSha256: new Map([expected, prepared, terminal, admitted].map((item) => [item.eventId, RAW])),
    } as never);
    await expect(owner.reconcile!(input)).resolves.toBeNull();

    const forged = event(sessionId, 3, "task_effect.admission.terminal", {
      ...(terminal.data as Readonly<Record<string, unknown>>),
      target_identity_sha256: "c".repeat(64),
    });
    evidence.mockResolvedValueOnce({
      projection: { events: [expected, prepared, forged] },
      rawSha256: new Map([expected, prepared, forged].map((item) => [item.eventId, RAW])),
    } as never);
    await expect(owner.reconcile!(input)).resolves.toBeNull();
  });

  it("reconciles a Delegation typed cancel before admission and requires its exact authenticated request and terminal", async () => {
    const sessionId = randomUUID();
    const delegationId = randomUUID();
    const applicationCommit = binding("delegation.start");
    const cancelCommit = binding("delegation.cancel");
    const expected = event(sessionId, 1, "run.started", {});
    const cancelRequestId = randomUUID();
    const cancel = event(sessionId, 2, "delegation.cancel.requested", {
      cancel_request_id: cancelRequestId,
      delegation_id: delegationId,
      origin: authenticatedOrigin(cancelCommit),
    });
    const ownerTerminal = event(sessionId, 3, "delegation.owner.pre_effect.terminal", {
      cancel_request_event_id: cancel.eventId,
      cancel_request_id: cancelRequestId,
      delegation_id: delegationId,
      origin: authenticatedOrigin(applicationCommit),
      outcome: "cancelled",
    });
    const unrelated = event(sessionId, 4, "run.started", {});
    const readObservationEvidence = vi.fn(async () => ({
      events: [expected, cancel, ownerTerminal, unrelated],
      rawSha256: new Map([expected, cancel, ownerTerminal, unrelated].map((item) => [item.eventId, RAW])),
    }) as never);
    const owner = new CliDelegationCompositeOwnerPort({
      activeDelegations: new ActiveDelegationControlRegistry(),
      interaction: Object.freeze({ createApprovalPrompt: () => ({} as never) }),
      readObservationEvidence,
      runtime: { cwd: "D:\\unused" } as never,
      signer: SIGNER,
    });
    const input = {
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({ actionKind: "delegation.start" as const, payload: Object.freeze({ delegationId }) }),
      sessionId,
    };
    const recovered = await owner.reconcile!(input);
    expect(recovered).toMatchObject({
      primaryEventType: "delegation.owner.pre_effect.terminal",
      result: {
        cancelRequestEventId: cancel.eventId,
        cancelRequestId,
        delegationId,
        kind: "pre_effect_terminal",
        outcome: "cancelled",
        terminalEventId: ownerTerminal.eventId,
      },
      resolvedHead: { eventId: ownerTerminal.eventId, sequence: 3 },
    });
    expect(recovered?.underlyingOperationRefs).toHaveLength(1);

    const forgedCancel = event(sessionId, 2, "delegation.cancel.requested", {
      cancel_request_id: cancelRequestId,
      delegation_id: delegationId,
      origin: { kind: "user" },
    });
    readObservationEvidence.mockResolvedValueOnce({
      events: [expected, forgedCancel, ownerTerminal],
      rawSha256: new Map([expected, forgedCancel, ownerTerminal].map((item) => [item.eventId, RAW])),
    } as never);
    await expect(owner.reconcile!(input)).resolves.toBeNull();
  });

  it("rebuilds a complete worktree cleanup result from exact raw refs without calling the effect owner", async () => {
    const sessionId = randomUUID();
    const applicationCommit = binding("worktree.cleanup");
    const expected = event(sessionId, 1, "run.started", {});
    const workspaceId = randomUUID();
    const effectOperationId = randomUUID();
    const requested = event(sessionId, 2, "task_worktree.cleanup.requested", {
      archive_sha256: null,
      graph_id: randomUUID(),
      graph_revision: 1,
      graph_sha256: SHA,
      operation_id: effectOperationId,
      origin: origin(applicationCommit),
      workspace_id: workspaceId,
    });
    const completed = event(sessionId, 3, "task_worktree.cleanup.completed", {
      graph_id: (requested.data as Readonly<Record<string, unknown>>).graph_id,
      graph_revision: 1,
      graph_sha256: SHA,
      operation_id: effectOperationId,
      status: "removed",
      workspace_id: workspaceId,
    });
    const unrelated = event(sessionId, 4, "run.started", {});
    const createManager = vi.fn(() => { throw new Error("effect owner must not be called"); });
    const readObservationEvidence = vi.fn(async () => ({
      projection: { events: [expected, requested, completed, unrelated] },
      rawSha256: new Map([[expected.eventId, RAW], [requested.eventId, RAW], [completed.eventId, RAW], [unrelated.eventId, RAW]]),
    }) as never);
    const owner = new CliGraphCompositeOwnerPort({
      activeOwnerComposites: new ActiveOwnerCompositeControlRegistry(),
      foregroundGraphControls: new ForegroundGraphControlRegistry(),
      io,
      readObservationEvidence,
      runtime: { createManagedWorktreeManager: createManager, cwd: "D:\\unused" } as unknown as CliRuntime,
      signer: SIGNER,
    });
    const result = await owner.reconcile!({
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({
        actionKind: "worktree.cleanup" as const,
        payload: Object.freeze({
          archiveAndRemove: false,
          graphId: (requested.data as Readonly<Record<string, unknown>>).graph_id as string,
          nodeId: "build",
          revision: 1,
          sha256: SHA,
        }),
      }),
      sessionId,
    });
    expect(createManager).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      applicationOperationId: applicationCommit.operationId,
      primaryEventType: "task_worktree.cleanup.requested",
      result: { archiveSha256: null, status: "removed", workspaceId },
    });
    expect(result?.domainRecordRefs).toHaveLength(1);
    expect(result?.underlyingOperationRefs).toHaveLength(1);
    expect(result?.resolvedHead).toMatchObject({ eventId: completed.eventId, sequence: 3 });

    const mismatched = await owner.reconcile!({
      applicationCommit: Object.freeze({ ...applicationCommit, principalId: "different_owner" }),
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({
        actionKind: "worktree.cleanup" as const,
        payload: Object.freeze({
          archiveAndRemove: false,
          graphId: (requested.data as Readonly<Record<string, unknown>>).graph_id as string,
          nodeId: "build",
          revision: 1,
          sha256: SHA,
        }),
      }),
      sessionId,
    });
    expect(mismatched).toBeNull();

    const tamperedHead = Object.freeze({ ...head(sessionId, expected), eventIntegrityToken: `slh_v1_${"a".repeat(43)}` });
    const tampered = await owner.reconcile!({
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: tamperedHead,
      repositoryId: randomUUID(),
      request: Object.freeze({
        actionKind: "worktree.cleanup" as const,
        payload: Object.freeze({
          archiveAndRemove: false,
          graphId: (requested.data as Readonly<Record<string, unknown>>).graph_id as string,
          nodeId: "build",
          revision: 1,
          sha256: SHA,
        }),
      }),
      sessionId,
    });
    expect(tampered).toBeNull();

    readObservationEvidence.mockResolvedValueOnce({
      projection: { events: [expected, requested] },
      rawSha256: new Map([[expected.eventId, RAW], [requested.eventId, RAW]]),
    } as never);
    const partial = await owner.reconcile!({
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({
        actionKind: "worktree.cleanup" as const,
        payload: Object.freeze({
          archiveAndRemove: false,
          graphId: (requested.data as Readonly<Record<string, unknown>>).graph_id as string,
          nodeId: "build",
          revision: 1,
          sha256: SHA,
        }),
      }),
      sessionId,
    });
    expect(partial).toBeNull();
    expect(createManager).not.toHaveBeenCalled();
  });

  it("returns null for a partial Delegation resume fence and never enters Phase 20 recovery/launch", async () => {
    const sessionId = randomUUID();
    const delegationId = randomUUID();
    const applicationCommit = binding("delegation.resume");
    const expected = event(sessionId, 1, "run.started", {});
    const resume = event(sessionId, 2, "delegation.resume.requested", {
      delegation_id: delegationId,
      origin: origin(applicationCommit),
    });
    const launch = vi.fn(() => { throw new Error("launch must not be called"); });
    const reconcileUnderlying = vi.fn(() => { throw new Error("underlying recovery must not be called"); });
    const owner = new CliDelegationCompositeOwnerPort({
      activeDelegations: new ActiveDelegationControlRegistry(),
      interaction: Object.freeze({ createApprovalPrompt: () => ({} as never) }),
      readObservationEvidence: vi.fn(async () => ({
        events: [expected, resume],
        rawSha256: new Map([[expected.eventId, RAW], [resume.eventId, RAW]]),
      }) as never),
      runtime: {
        createDelegationChildLauncher: launch,
        cwd: "D:\\unused",
        env: Object.freeze({}),
        onCancel: () => () => undefined,
        platform: "win32",
        randomUUID,
        reconcileDelegationPreEffectOperation: reconcileUnderlying,
        timestamp: () => "2026-08-12T00:00:00.000Z",
      },
      signer: SIGNER,
    });
    const result = await owner.reconcile!({
      applicationCommit,
      authenticatedMutation: {} as never,
      expectedHead: head(sessionId, expected),
      repositoryId: randomUUID(),
      request: Object.freeze({ actionKind: "delegation.resume" as const, payload: Object.freeze({ delegationId }) }),
      sessionId,
    } as Parameters<NonNullable<DelegationCompositeOwnerPortV1["reconcile"]>>[0]);
    expect(result).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(reconcileUnderlying).not.toHaveBeenCalled();
  });
});
