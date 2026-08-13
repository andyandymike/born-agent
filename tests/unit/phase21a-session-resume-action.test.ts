import { describe, expect, it, vi } from "vitest";

import {
  createSessionResumeAction,
  type SessionResumeOwnerPortV1,
} from "../../src/control-plane/use-cases/session-resume-action.js";
import type { PreparedActionV1 } from "../../src/control-plane/application-protocol.js";
import type { SessionProjectionService } from "../../src/control-plane/session-projection-service.js";
import type { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import type { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";

const repositoryId = "10000000-0000-4000-8000-000000000021";
const sessionId = "20000000-0000-4000-8000-000000000021";
const sourceRunId = "30000000-0000-4000-8000-000000000021";
const newRunId = "40000000-0000-4000-8000-000000000021";
const operationId = "50000000-0000-4000-8000-000000000021";
const startedEventId = "60000000-0000-4000-8000-000000000021";
const terminalEventId = "70000000-0000-4000-8000-000000000021";

const head = Object.freeze({
  eventId: "80000000-0000-4000-8000-000000000021",
  eventIntegrityToken: `slh_v1_${"A".repeat(43)}`,
  schemaVersion: 1 as const,
  sequence: 8,
  sessionId,
});

function projection() {
  return Object.freeze({
    head: Object.freeze({ publicHead: head, rawEventSha256: "a".repeat(64) }),
    projection: Object.freeze({
      identity: Object.freeze({
        disclosureProfileSha256: "b".repeat(64),
        ledgerHead: head,
        projectionSha256: "c".repeat(64),
        projectorId: "phase21a.resume.fake",
        projectorVersion: 1,
        schemaVersion: 1 as const,
        sessionId,
      }),
      projection: Object.freeze({ runs: Object.freeze([{ runId: sourceRunId, status: "completed" }]) }),
    }),
    resourceScope: Object.freeze({ kind: "session" as const, repositoryId, sessionId, teamId: null }),
  });
}

function reference(recordId: string, sequence: number) {
  return Object.freeze({
    ledgerId: `session:${sessionId}`,
    ownerKind: "session" as const,
    recordId,
    recordSha256: String(sequence).repeat(64).slice(0, 64),
    sequence,
  });
}

function noCancelSessions(): SessionRegistry {
  return {
    readRunCancelBarrier: vi.fn(async () => Object.freeze({
      binding: null,
      observations: Object.freeze([]),
      owner: null,
      request: null,
      terminal: null,
    })),
  } as unknown as SessionRegistry;
}

describe("Phase 21A typed session resume action", () => {
  it("passes only typed resume authority to a narrow owner and links its exact composite refs", async () => {
    const execute = vi.fn<SessionResumeOwnerPortV1["execute"]>(async (input) => Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      approvalExpiryReferences: Object.freeze([]),
      primaryDomainRecord: reference(input.applicationCommit.operationId, 9),
      requestEventType: "session.resume.requested" as const,
      result: Object.freeze({
        exitCode: 0,
        newRunId,
        resumeMode: "exact" as const,
        sourceRunId,
        terminal: "run.completed" as const,
      }),
      runStartedEventType: "run.started" as const,
      runStartedReference: reference(startedEventId, 10),
      terminalEventType: "run.completed" as const,
      terminalReference: reference(terminalEventId, 11),
    }));
    const action = createSessionResumeAction({
      broker: new SessionOwnerBroker(),
      owner: Object.freeze({ execute }),
      recurringTasks: createNodeApplicationHostRuntime(),
      repositories: {} as RepositoryRegistry,
      sessionProjection: { read: vi.fn(async () => projection()) } as unknown as SessionProjectionService,
      sessions: noCancelSessions(),
    });
    const payload = Object.freeze({ allowDegradedResume: false });
    const resolved = await action.resolveTarget({
      expectedVersion: { head, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: { kind: "session", repositoryId, sessionId, teamId: null },
    }, payload);
    const applicationCommit = Object.freeze({
      actionKind: "session.resume",
      authorizationDecisionSha256: "d".repeat(64),
      operationId,
      preparedActionSha256: "e".repeat(64),
      principalId: "local_owner",
      schemaVersion: 1 as const,
    });
    const result = await action.execute({
      applicationCommit,
      authorizationDecisionSha256: applicationCommit.authorizationDecisionSha256,
      call: Object.freeze({
        principal: Object.freeze({
          authenticationId: "auth",
          grantRevision: 1,
          grantSha256: "9".repeat(64),
          kind: "human" as const,
          principalId: "local_owner",
        }),
        surface: Object.freeze({ clientId: "client", connectionId: "connection", surface: "tui" as const }),
      }),
      operationId,
      requestId: "90000000-0000-4000-8000-000000000021",
      resolvedTarget: resolved,
    }, payload, {
      preparedActionSha256: applicationCommit.preparedActionSha256,
    } as PreparedActionV1);
    expect(execute).toHaveBeenCalledOnce();
    const ownerInput = execute.mock.calls[0]![0];
    expect(ownerInput).toMatchObject({
      applicationCommit,
      authenticatedMutation: { surface: { surface: "tui" } },
      expectedHead: head,
      payload,
      repositoryId,
      sessionId,
      sourceRunId,
    });
    expect(Object.keys(ownerInput).sort()).toEqual([
      "applicationCommit",
      "authenticatedMutation",
      "expectedHead",
      "payload",
      "repositoryId",
      "runLifecycle",
      "sessionId",
      "sourceRunId",
    ]);
    expect(result).toMatchObject({
      domainRecordRefs: [{ recordId: operationId }],
      primaryDomainRecord: { recordId: operationId },
      result: { newRunId, terminal: "run.completed" },
      underlyingOperationRefs: [{ recordId: startedEventId }, { recordId: terminalEventId }],
    });
  });

  it("blocks a durable cancel request before invoking the resume owner", async () => {
    const execute = vi.fn<SessionResumeOwnerPortV1["execute"]>();
    const sessions = {
      readRunCancelBarrier: vi.fn(async () => ({
        binding: null,
        observations: [],
        owner: null,
        request: { fact: {}, reference: reference(operationId, 1) },
        terminal: null,
      })),
    } as unknown as SessionRegistry;
    const action = createSessionResumeAction({
      broker: new SessionOwnerBroker(),
      owner: Object.freeze({ execute }),
      recurringTasks: createNodeApplicationHostRuntime(),
      repositories: {} as RepositoryRegistry,
      sessionProjection: { read: vi.fn(async () => projection()) } as unknown as SessionProjectionService,
      sessions,
    });
    await expect(action.resolveTarget({
      expectedVersion: { head, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: { kind: "session", repositoryId, sessionId, teamId: null },
    }, { allowDegradedResume: false })).rejects.toMatchObject({
      code: "control_operation_busy",
      message: expect.stringMatching(/run_cancel_pending/u),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a resumed run cancelled without the exact authenticated lifecycle binding", async () => {
    const execute = vi.fn<SessionResumeOwnerPortV1["execute"]>(async (input) => Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      approvalExpiryReferences: Object.freeze([]),
      primaryDomainRecord: reference(input.applicationCommit.operationId, 9),
      requestEventType: "session.resume.requested" as const,
      result: Object.freeze({
        exitCode: 130,
        newRunId,
        resumeMode: "exact" as const,
        sourceRunId,
        terminal: "run.cancelled" as const,
      }),
      runStartedEventType: "run.started" as const,
      runStartedReference: reference(startedEventId, 10),
      terminalEventType: "run.cancelled" as const,
      terminalReference: reference(terminalEventId, 11),
    }));
    const action = createSessionResumeAction({
      broker: new SessionOwnerBroker(),
      owner: Object.freeze({ execute }),
      recurringTasks: createNodeApplicationHostRuntime(),
      repositories: {} as RepositoryRegistry,
      sessionProjection: { read: vi.fn(async () => projection()) } as unknown as SessionProjectionService,
      sessions: noCancelSessions(),
    });
    const payload = Object.freeze({ allowDegradedResume: false });
    const resolved = await action.resolveTarget({
      expectedVersion: { head, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: { kind: "session", repositoryId, sessionId, teamId: null },
    }, payload);
    const applicationCommit = Object.freeze({
      actionKind: "session.resume",
      authorizationDecisionSha256: "d".repeat(64),
      operationId,
      preparedActionSha256: "e".repeat(64),
      principalId: "local_owner",
      schemaVersion: 1 as const,
    });
    await expect(action.execute({
      applicationCommit,
      authorizationDecisionSha256: applicationCommit.authorizationDecisionSha256,
      call: Object.freeze({
        principal: Object.freeze({
          authenticationId: "auth",
          grantRevision: 1,
          grantSha256: "9".repeat(64),
          kind: "human" as const,
          principalId: "local_owner",
        }),
        surface: Object.freeze({ clientId: "client", connectionId: "connection", surface: "cli" as const }),
      }),
      operationId,
      requestId: "90000000-0000-4000-8000-000000000022",
      resolvedTarget: resolved,
    }, payload, {
      preparedActionSha256: applicationCommit.preparedActionSha256,
    } as PreparedActionV1)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
      message: expect.stringMatching(/lifecycle proof/u),
    });
  });
});
