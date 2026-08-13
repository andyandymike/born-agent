import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ApplicationActionExecutionContextV1 } from "../../src/control-plane/application-action-registry.js";
import type { PreparedActionV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import type { DurableRecordReferenceV1 } from "../../src/control-plane/control-operation-schema.js";
import {
  createGraphCancelAction,
  type GraphCancelOwnerPortV1,
} from "../../src/control-plane/use-cases/graph-cancel-action.js";
import type { SessionDomainActionDependenciesV1 } from "../../src/control-plane/use-cases/session-domain-action-support.js";

const SHA = "a".repeat(64);

function fixture(input: Readonly<{ readonly partial?: boolean }> = {}) {
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const backgroundOperationId = randomUUID();
  const head: SessionLedgerHeadV1 = Object.freeze({
    eventId: randomUUID(),
    eventIntegrityToken: `slh_v1_${"a".repeat(43)}`,
    schemaVersion: 1,
    sequence: 7,
    sessionId,
  });
  const primary: DurableRecordReferenceV1 = Object.freeze({
    ledgerId: `session:${sessionId}`,
    ownerKind: "session",
    recordId: randomUUID(),
    recordSha256: SHA,
    sequence: 8,
  });
  const effect: DurableRecordReferenceV1 = Object.freeze({
    ledgerId: `background:${backgroundOperationId}`,
    ownerKind: "effect",
    recordId: `cancel:${operationId}`,
    recordSha256: "b".repeat(64),
    sequence: null,
  });
  const commit = Object.freeze({
    applicationOperationId: operationId,
    domainRecordRefs: Object.freeze([primary]),
    primaryDomainRecord: primary,
    primaryEventType: "task_graph.cancel.requested" as const,
    resolvedHead: Object.freeze({ ...head, eventId: primary.recordId, sequence: 8 }),
    result: Object.freeze({
      accepted: true as const,
      controlSha256: effect.recordSha256,
      delivery: "background_control_queued" as const,
      graph: Object.freeze({ graphId: randomUUID(), graphSha256: SHA, revision: 1 }) as never,
      operationId: backgroundOperationId,
      requestId: operationId,
      terminal: false as const,
      workerId: randomUUID(),
    }),
    underlyingOperationRefs: input.partial === true ? Object.freeze([]) : Object.freeze([effect]),
  });
  const execute = vi.fn(async () => { throw new Error("execute must not be called during response-loss recovery"); });
  const reconcile = vi.fn(async () => input.partial === true ? null : commit);
  const owner: GraphCancelOwnerPortV1 = Object.freeze({ execute, reconcile });
  const definition = createGraphCancelAction({ dependencies: {} as SessionDomainActionDependenciesV1, owner });
  const context: ApplicationActionExecutionContextV1 = Object.freeze({
    applicationCommit: Object.freeze({
      actionKind: "graph.cancel",
      authorizationDecisionSha256: SHA,
      operationId,
      preparedActionSha256: SHA,
      principalId: "local-owner",
      schemaVersion: 1,
    }),
    authorizationDecisionSha256: SHA,
    call: Object.freeze({
      principal: Object.freeze({
        authenticationId: "local-auth",
        grantRevision: 1,
        grantSha256: SHA,
        kind: "human" as const,
        principalId: "local-owner",
      }),
      surface: Object.freeze({ clientId: "client", connectionId: "connection", surface: "cli" as const }),
    }),
    operationId,
    requestId: randomUUID(),
    resolvedTarget: Object.freeze({
      resourceScope: Object.freeze({ kind: "session" as const, repositoryId: randomUUID(), sessionId, teamId: null }),
      resourceVersion: Object.freeze({ head, kind: "session_ledger_head" as const }),
      targetIdentity: Object.freeze({ session_id: sessionId }),
      targetIdentitySha256: SHA,
    }),
  });
  return {
    context,
    definition,
    execute,
    payload: Object.freeze({ reason: "stop exact background owner", revision: 1, sha256: SHA }),
    prepared: { preparedActionSha256: SHA } as PreparedActionV1,
    reconcile,
  };
}

describe("Phase 21A Graph cancel composite action", () => {
  it("uses only observation recovery for response loss and returns exact session/control refs", async () => {
    const value = fixture();
    const result = await value.definition.reconcile!(value.context, value.payload, value.prepared);
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.reconcile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resolvedResourceVersion: { kind: "session_ledger_head", head: { sequence: 8 } },
      result: { delivery: "background_control_queued", requestId: value.context.operationId, terminal: false },
      underlyingOperationRefs: [{ ownerKind: "effect", recordId: `cancel:${value.context.operationId}` }],
    });
  });

  it("returns null for partial owner evidence without dispatching or inventing a result", async () => {
    const value = fixture({ partial: true });
    expect(await value.definition.reconcile!(value.context, value.payload, value.prepared)).toBeNull();
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.reconcile).toHaveBeenCalledTimes(1);
  });
});
