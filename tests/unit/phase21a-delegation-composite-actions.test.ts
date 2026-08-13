import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
} from "../../src/control-plane/application-action-registry.js";
import type { PreparedActionV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import type { DurableRecordReferenceV1 } from "../../src/control-plane/control-operation-schema.js";
import {
  createDelegationCompositeActionDefinitions,
  type DelegationCompositeResultV1,
  type DelegationCompositeOwnerPortV1,
} from "../../src/control-plane/use-cases/delegation-composite-actions.js";
import type { SessionDomainActionDependenciesV1 } from "../../src/control-plane/use-cases/session-domain-action-support.js";

const SHA = "a".repeat(64);

function fixture(input: Readonly<{
  readonly actionKind?: "delegation.prepare" | "delegation.resume" | "delegation.start";
  readonly ownerOperationId?: string;
  readonly underlying?: readonly DurableRecordReferenceV1[];
  readonly withReconcile?: boolean;
}> = {}) {
  const actionKind = input.actionKind ?? "delegation.prepare";
  const sessionId = randomUUID();
  const repositoryId = randomUUID();
  const operationId = randomUUID();
  const head: SessionLedgerHeadV1 = Object.freeze({
    eventId: randomUUID(),
    eventIntegrityToken: `slh_v1_${"a".repeat(43)}`,
    schemaVersion: 1,
    sequence: 7,
    sessionId,
  });
  const reference: DurableRecordReferenceV1 = Object.freeze({
    ledgerId: `session:${sessionId}`,
    ownerKind: "session",
    recordId: randomUUID(),
    recordSha256: SHA,
    sequence: 8,
  });
  const ownerResult = (): DelegationCompositeResultV1 => actionKind === "delegation.prepare"
    ? Object.freeze({
        kind: "prepared" as const,
        childNotStarted: true as const,
        capsuleBytes: 128,
        capsuleSha256: SHA,
        envelopeSha256: SHA,
        toolCount: 0,
        capabilityCount: 0,
        model: Object.freeze({
          contextCapacity: 1024,
          delegatedToolProfileSha256: SHA,
          envelopeSha256: SHA,
          executionBackend: "canonical_fake" as const,
          modelId: "test",
          networkEligibility: "local_only" as const,
          policyProfileId: "test",
          providerId: "test",
          qualificationId: "test",
          qualificationSha256: SHA,
        }),
        workspace: Object.freeze({
          declaredPathPrefixes: ["."],
          lineageId: SHA,
          logicalWorkspaceId: "workspace",
          mode: "origin_read_only" as const,
          sourceSnapshotSha256: SHA,
        }),
      })
    : actionKind === "delegation.start"
      ? Object.freeze({
          deferred: Object.freeze([]),
          groupId: randomUUID(),
          kind: "group_terminal" as const,
          results: Object.freeze([Object.freeze({
            childRunId: randomUUID(),
            delegationId: randomUUID(),
            receiptSha256: SHA,
            status: "succeeded" as const,
          })]),
          terminalStatus: "completed" as const,
        })
      : Object.freeze({
          kind: "group_takeover" as const,
          takeover: Object.freeze({
            changed: true,
            groupId: randomUUID(),
            previousNonceSha256: SHA,
            releasedLeaseSha256: SHA,
            takeoverEventId: randomUUID(),
          }),
        });
  const commit = async (request: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0]) => {
    const underlyingOperationRefs = input.underlying ?? Object.freeze(Array.from(
      { length: actionKind === "delegation.start" ? 10 : 1 },
      (_, index) => Object.freeze({ ...reference, recordId: randomUUID(), sequence: 9 + index }),
    ));
    const end = underlyingOperationRefs.at(-1) ?? reference;
    return Object.freeze({
      applicationOperationId: input.ownerOperationId ?? request.applicationCommit.operationId,
      domainRecordRefs: Object.freeze([reference]),
      primaryDomainRecord: reference,
      primaryEventType: actionKind === "delegation.prepare"
        ? "delegation.envelope.prepared"
        : actionKind === "delegation.start"
          ? "delegation.group.lease.acquired"
          : "delegation.resume.requested",
      resolvedHead: Object.freeze({ ...head, eventId: end.recordId, sequence: end.sequence! }),
      result: ownerResult(),
      underlyingOperationRefs,
    });
  };
  const owner: DelegationCompositeOwnerPortV1 = Object.freeze({
    execute: vi.fn(commit),
    ...(input.withReconcile === true ? { reconcile: vi.fn(commit) } : {}),
  });
  const dependencies = {
    sessionProjection: {
      read: vi.fn(async () => Object.freeze({
        head: Object.freeze({ publicHead: Object.freeze({ ...head, sequence: 8 }) }),
      })),
    },
  } as unknown as SessionDomainActionDependenciesV1;
  const definition = createDelegationCompositeActionDefinitions({ dependencies, owner })
    .find((candidate) => candidate.actionKind === actionKind)!;
  const context: ApplicationActionExecutionContextV1 = Object.freeze({
    applicationCommit: Object.freeze({
      actionKind,
      authorizationDecisionSha256: SHA,
      operationId,
      preparedActionSha256: SHA,
      principalId: "local_owner",
      schemaVersion: 1,
    }),
    authorizationDecisionSha256: SHA,
    call: Object.freeze({
      principal: Object.freeze({
        authenticationId: "local-auth",
        grantRevision: 1,
        grantSha256: SHA,
        kind: "human" as const,
        principalId: "local_owner",
      }),
      surface: Object.freeze({ clientId: "client", connectionId: "connection", surface: "cli" as const }),
    }),
    operationId,
    requestId: randomUUID(),
    resolvedTarget: Object.freeze({
      resourceScope: Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null }),
      resourceVersion: Object.freeze({ head, kind: "session_ledger_head" as const }),
      targetIdentity: Object.freeze({ session_id: sessionId }),
      targetIdentitySha256: SHA,
    }),
  });
  return {
    context,
    definition,
    operationId,
    owner,
    payload: Object.freeze({ delegationId: randomUUID() }),
    prepared: { preparedActionSha256: SHA } as PreparedActionV1,
    reference,
  };
}

describe("Phase 21A Delegation composite actions", () => {
  it("registers enqueue separately from real prepare/start/resume composition", () => {
    expect(createDelegationCompositeActionDefinitions({
      dependencies: {} as SessionDomainActionDependenciesV1,
      owner: { execute: async () => { throw new Error("unused"); } },
    }).map((definition) => definition.actionKind)).toEqual([
      "delegation.prepare",
      "delegation.start",
      "delegation.resume",
    ]);
  });

  it("passes exact authenticated bindings to the Phase 20 owner and returns its raw refs", async () => {
    const value = fixture();
    const result = await value.definition.execute(
      value.context,
      value.payload,
      value.prepared,
    ) as ApplicationActionExecutionResultV1;
    expect(value.owner.execute).toHaveBeenCalledWith(expect.objectContaining({
      applicationCommit: expect.objectContaining({ operationId: value.operationId }),
      authenticatedMutation: expect.objectContaining({
        applicationCommit: expect.objectContaining({ operationId: value.operationId }),
      }),
      expectedHead: expect.objectContaining({ sequence: 7 }),
      request: expect.objectContaining({ actionKind: "delegation.prepare", payload: value.payload }),
    }));
    expect(result.primaryDomainRecord).toEqual(value.reference);
    expect(result.underlyingOperationRefs).toHaveLength(1);
    expect(result.result).toMatchObject({ kind: "prepared", childNotStarted: true });
    expect(result.resolvedResourceVersion).toMatchObject({ kind: "session_ledger_head", head: { sequence: 9 } });
  });

  it.each(["delegation.start", "delegation.resume"] as const)(
    "enforces the %s owner commit contract without moving Phase 20 authority",
    async (actionKind) => {
      const value = fixture({ actionKind });
      const result = await value.definition.execute(value.context, value.payload, value.prepared) as ApplicationActionExecutionResultV1;
      expect(value.owner.execute).toHaveBeenCalledTimes(1);
      expect(value.owner.execute).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({ actionKind }),
      }));
      expect(result.underlyingOperationRefs).toHaveLength(actionKind === "delegation.start" ? 10 : 1);
      expect(value.definition.reconcile).toBeUndefined();
    },
  );

  it("fails closed for response-loss evidence bound to another operation or a partial ref set", async () => {
    const wrongOwner = fixture({ ownerOperationId: randomUUID() });
    await expect(wrongOwner.definition.execute(wrongOwner.context, wrongOwner.payload, wrongOwner.prepared))
      .rejects.toEqual(expect.objectContaining({ code: "control_operation_busy" }));

    const partial = fixture({ underlying: [] });
    await expect(partial.definition.execute(partial.context, partial.payload, partial.prepared))
      .rejects.toEqual(expect.objectContaining({ code: "control_operation_busy" }));
  });

  it("wires prepare/start/resume recovery only through an explicit observation owner", async () => {
    const value = fixture({ actionKind: "delegation.start", withReconcile: true });
    expect(createDelegationCompositeActionDefinitions({
      dependencies: {} as SessionDomainActionDependenciesV1,
      owner: value.owner,
    }).every((definition) => definition.reconcile !== undefined)).toBe(true);
    const result = await value.definition.reconcile!(value.context, value.payload, value.prepared) as ApplicationActionExecutionResultV1;
    expect(value.owner.execute).not.toHaveBeenCalled();
    expect(value.owner.reconcile).toHaveBeenCalledTimes(1);
    expect(result.primaryDomainRecord).toEqual(value.reference);
  });
});
