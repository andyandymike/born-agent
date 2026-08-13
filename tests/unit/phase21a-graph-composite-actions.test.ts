import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
} from "../../src/control-plane/application-action-registry.js";
import type { PreparedActionV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import type { DurableRecordReferenceV1 } from "../../src/control-plane/control-operation-schema.js";
import {
  createGraphCompositeActionDefinitions,
  type GraphCompositeOwnerPortV1,
} from "../../src/control-plane/use-cases/graph-composite-actions.js";
import type { SessionDomainActionDependenciesV1 } from "../../src/control-plane/use-cases/session-domain-action-support.js";

const SHA = "a".repeat(64);

function fixture(input: Readonly<{
  readonly actionKind?: "graph.retry" | "worktree.cleanup";
  readonly ownerOperationId?: string;
  readonly preEffectTerminal?: boolean;
  readonly withReconcile?: boolean;
}> = {}) {
  const actionKind = input.actionKind ?? "worktree.cleanup";
  const sessionId = randomUUID();
  const repositoryId = randomUUID();
  const operationId = randomUUID();
  const eventId = randomUUID();
  const head: SessionLedgerHeadV1 = Object.freeze({
    eventId,
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
  const commit = async (request: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]) => {
    const underlyingOperationRefs = actionKind === "graph.retry" || input.preEffectTerminal === true
      ? Object.freeze([])
      : Object.freeze([{ ...reference, recordId: randomUUID(), sequence: 9 }]);
    const end = underlyingOperationRefs.at(-1) ?? reference;
    return Object.freeze({
      applicationOperationId: input.ownerOperationId ?? request.applicationCommit.operationId,
      domainRecordRefs: Object.freeze([reference]),
      primaryDomainRecord: reference,
      primaryEventType: input.preEffectTerminal === true
        ? "task_effect.admission.terminal"
        : actionKind === "graph.retry"
        ? "task_node.retry.requested"
        : "task_worktree.cleanup.requested",
      resolvedHead: Object.freeze({ ...head, eventId: end.recordId, sequence: end.sequence! }),
      result: input.preEffectTerminal === true
        ? Object.freeze({
            actionKind: "worktree.cleanup" as const,
            kind: "pre_effect_terminal" as const,
            outcome: "cancelled" as const,
            targetIdentitySha256: SHA,
          })
        : Object.freeze({ archiveSha256: null, status: "removed" as const, workspaceId: randomUUID() }),
      underlyingOperationRefs,
    });
  };
  const owner: GraphCompositeOwnerPortV1 = Object.freeze({
    preflight: vi.fn(async () => undefined),
    execute: vi.fn(commit),
    ...(input.withReconcile === true ? { reconcile: vi.fn(commit) } : {}),
  });
  const dependencies = {
    sessionProjection: {
      read: vi.fn(async () => Object.freeze({
        head: Object.freeze({ publicHead: Object.freeze({ ...head, sequence: 99 }) }),
      })),
    },
  } as unknown as SessionDomainActionDependenciesV1;
  const definition = createGraphCompositeActionDefinitions({ dependencies, owner })
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
  const prepared = { preparedActionSha256: SHA } as PreparedActionV1;
  const payload = actionKind === "graph.retry"
    ? Object.freeze({
        attemptNumber: 1,
        attemptTerminal: "known_failed" as const,
        nodeId: "build",
        revision: 1,
        sha256: SHA,
        terminalEventId: randomUUID(),
      })
    : Object.freeze({
        archiveAndRemove: false,
        graphId: randomUUID(),
        nodeId: "build",
        revision: 1,
        sha256: SHA,
      });
  return { context, definition, operationId, owner, payload, prepared, reference };
}

describe("Phase 21A Graph composite actions", () => {
  it("registers the canonical run/resume and managed-worktree action families", () => {
    const actions = createGraphCompositeActionDefinitions({
      dependencies: {} as SessionDomainActionDependenciesV1,
      owner: {
        preflight: async () => undefined,
        execute: async () => { throw new Error("unused"); },
      },
    }).map((definition) => definition.actionKind);
    expect(actions).toEqual([
      "graph.run",
      "graph.resume",
      "graph.retry",
      "worktree.allocate",
      "promotion.apply",
      "promotion.verify_origin",
      "worktree.cleanup",
    ]);
  });

  it("passes only authenticated exact bindings to a fake owner and returns its bounded refs", async () => {
    const value = fixture();
    const result = await value.definition.execute(
      value.context,
      value.payload,
      value.prepared,
    ) as ApplicationActionExecutionResultV1;
    expect(value.owner.execute).toHaveBeenCalledTimes(1);
    expect(value.owner.execute).toHaveBeenCalledWith(expect.objectContaining({
      applicationCommit: expect.objectContaining({ operationId: value.operationId }),
      authenticatedMutation: expect.objectContaining({
        applicationCommit: expect.objectContaining({ operationId: value.operationId }),
      }),
      expectedHead: value.context.resolvedTarget.resourceVersion.kind === "session_ledger_head"
        ? value.context.resolvedTarget.resourceVersion.head
        : null,
      request: expect.objectContaining({ actionKind: "worktree.cleanup", payload: value.payload }),
    }));
    expect(result.primaryDomainRecord).toEqual(value.reference);
    expect(result.domainRecordRefs).toEqual([value.reference]);
    expect(result.underlyingOperationRefs).toHaveLength(1);
    expect(result.resolvedResourceVersion).toMatchObject({ kind: "session_ledger_head", head: { sequence: 9 } });
  });

  it("binds an exact failed attempt for retry and accepts no invented underlying refs", async () => {
    const value = fixture({ actionKind: "graph.retry" });
    const result = await value.definition.execute(
      value.context,
      value.payload,
      value.prepared,
    ) as ApplicationActionExecutionResultV1;
    expect(value.owner.execute).toHaveBeenCalledWith(expect.objectContaining({
      applicationCommit: expect.objectContaining({
        actionKind: "graph.retry",
        operationId: value.operationId,
      }),
      request: {
        actionKind: "graph.retry",
        payload: value.payload,
      },
    }));
    expect(result.primaryDomainRecord).toEqual(value.reference);
    expect(result.underlyingOperationRefs).toEqual([]);
    expect(value.definition.display(value.context.resolvedTarget, value.payload)).toMatchObject({
      summary: "Authorize attempt 1 of node build for one fresh retry.",
      warnings: [expect.stringContaining("fresh attempt")],
    });
  });

  it("accepts an exact durable pre-effect terminal without inventing effect references", async () => {
    const value = fixture({ preEffectTerminal: true });
    const result = await value.definition.execute(
      value.context,
      value.payload,
      value.prepared,
    ) as ApplicationActionExecutionResultV1;
    expect(result.result).toMatchObject({
      actionKind: "worktree.cleanup",
      kind: "pre_effect_terminal",
      outcome: "cancelled",
    });
    expect(result.primaryDomainRecord).toEqual(value.reference);
    expect(result.underlyingOperationRefs).toEqual([]);
  });

  it("fails closed when an owner commit predicate is bound to another application operation", async () => {
    const value = fixture({ ownerOperationId: randomUUID() });
    await expect(value.definition.execute(value.context, value.payload, value.prepared))
      .rejects.toEqual(expect.objectContaining({ code: "control_operation_busy" }));
    expect(value.owner.execute).toHaveBeenCalledTimes(1);
  });

  it("routes response-loss recovery to the observation-only owner port for every composite family", async () => {
    const value = fixture({ withReconcile: true });
    expect(createGraphCompositeActionDefinitions({
      dependencies: {} as SessionDomainActionDependenciesV1,
      owner: value.owner,
    }).every((definition) => definition.reconcile !== undefined)).toBe(true);
    const result = await value.definition.reconcile!(value.context, value.payload, value.prepared) as ApplicationActionExecutionResultV1;
    expect(value.owner.execute).not.toHaveBeenCalled();
    expect(value.owner.reconcile).toHaveBeenCalledTimes(1);
    expect(result.primaryDomainRecord).toEqual(value.reference);
  });
});
