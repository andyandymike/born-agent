import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { LocalOwnerPrincipalAuthority } from "../../src/control-plane/local-owner-principal.js";
import { PreparedActionStore } from "../../src/control-plane/prepared-action-store.js";
import { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { SessionProjectionService } from "../../src/control-plane/session-projection-service.js";
import { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { createCatalogActionRegistry } from "../../src/control-plane/use-cases/catalog-actions.js";
import {
  createSessionMessageAction,
  type SessionMessageLaunchPortV1,
} from "../../src/control-plane/use-cases/session-message-action.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { persistedTaskUserOrigin } from "../../src/coordination/task-control-plane.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A session.message.submit", () => {
  it("materializes intent, authenticated run start, marker and terminal exactly once", async () => {
    const authority = await loadOrCreateHostControlAuthority({ root: await directory("bornagent-phase21a-message-") });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
    const sessions = new SessionRegistry(authority.paths, repositories);
    const broker = new SessionOwnerBroker();
    const projection = new SessionProjectionService({
      broker,
      disclosureProfileSha256: sha256Canonical({ profile: "local-owner", schema_version: 1 }),
      repositories,
      sessions,
      signer: new SessionLedgerHeadSigner(authority.integrityKey),
    });
    const launcher: SessionMessageLaunchPortV1 = {
      launch: async (input) => {
        await input.writer.appendTaskEvent("goal.created", {
          goal_id: randomUUID(),
          objective: input.payload.task,
          origin: persistedTaskUserOrigin(input.surface, input.authenticatedMutation),
          parent_goal_id: null,
          replaces_active_goal: null,
          revision: 1,
        });
        const publisher = new EventPublisher({
          randomUUID,
          renderer: { render: () => undefined },
          runId: input.runId,
          sessionId: input.sessionId,
          timestamp: () => new Date().toISOString(),
          writer: input.writer,
        });
        const started = await publisher.publish({
          data: {
            application_commit: {
              action_kind: input.applicationCommit.actionKind,
              authorization_decision_sha256: input.applicationCommit.authorizationDecisionSha256,
              operation_id: input.applicationCommit.operationId,
              prepared_action_sha256: input.applicationCommit.preparedActionSha256,
              principal_id: input.applicationCommit.principalId,
              schema_version: 1,
            },
            command: "agent",
            input: { role: "user", text: input.payload.task },
            max_duration_ms: 10_000,
            max_steps: 1,
            max_tokens: 100,
            max_tool_output_bytes: 1_024,
            model: "phase21a-fake",
            provider: "ollama",
            request_timeout_ms: 1_000,
            tools: [],
            tools_enabled: true,
            workspace: input.repositoryRoot,
          },
          type: "run.started",
        });
        if (started.type !== "run.started") throw new TypeError("expected run start");
        await input.onRunStarted(started);
        await publisher.publish({
          data: {
            adapter: "phase21a-fake",
            adapter_version: "1",
            capabilities: {
              cancellation: "abort_signal",
              reasoning: "none",
              streaming: true,
              tools: "strict",
              usage: "complete",
            },
            config_fingerprint: "b".repeat(64),
            model: "phase21a-fake",
            provider: "ollama",
          },
          type: "backend.selected",
        });
        await publisher.publish({
          data: {
            category: "internal",
            code: "fake_terminal",
            duration_ms: 1,
            message: "deterministic test terminal",
            retryable: false,
          },
          type: "run.failed",
        });
        return Object.freeze({ exitCode: 1 });
      },
    };
    const action = createSessionMessageAction({
      broker,
      launcher,
      recurringTasks: createNodeApplicationHostRuntime(),
      repositories,
      sessionProjection: projection,
      sessions,
    });
    const journal = new ControlOperationJournal(authority.paths);
    const service = new DefaultAgentRunApplicationService({
      actions: createCatalogActionRegistry({ additionalDefinitions: [action], repositories, sessions }),
      artifacts,
      createRequestId: randomUUID,
      delivery: new SessionDeliveryCoordinator(),
      hostRuntime: createNodeApplicationHostRuntime(),
      journal,
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
    });
    const root = await directory("bornagent-phase21a-message-repo-");
    const repository = await repositories.register({ expectedHead: await repositories.head(), operationId: randomUUID(), root });
    const created = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    const context = {
      principal: authority.localOwner,
      surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const },
    };
    const payload = { command: "agent" as const, task: "implement the bounded change", verbose: false };
    const prepared = await service.prepare(context, {
      actionKind: "session.message.submit",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "message-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: created.entry.initialLedgerHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: {
          kind: "session",
          repositoryId: repository.registration.repositoryId,
          sessionId: created.entry.sessionId,
          teamId: null,
        },
      },
    });
    expect(prepared.status).toBe("ok");
    const committed = await service.commit(context, {
      idempotencyKey: "message-K1",
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(committed.status).toBe("ok");
    expect(committed.result).toMatchObject({ exitCode: 1, recovered: false, terminal: "run.failed" });
    const catalog = await sessions.project(repository.registration.repositoryId);
    expect(catalog.intents).toHaveLength(1);
    expect(catalog.materializations).toHaveLength(1);
    expect(catalog.materializations[0]).toMatchObject({
      firstEventId: expect.any(String),
      firstEventOperationId: committed.operationId,
      origin: "phase21_application",
    });
    const events = await readStoredSession(join(root, ".bornagent", "sessions", `${created.entry.sessionId}.jsonl`));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      eventId: catalog.materializations[0]!.firstEventId,
      type: "goal.created",
      data: { origin: { application_commit: { operation_id: committed.operationId } } },
    });
    const started = events.find((event) => event.type === "run.started");
    expect(started?.data).toMatchObject({ application_commit: { operation_id: committed.operationId } });

    const replay = await service.commit(context, {
      idempotencyKey: "message-K2",
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(replay.operationId).toBe(committed.operationId);
    expect(await readStoredSession(join(root, ".bornagent", "sessions", `${created.entry.sessionId}.jsonl`))).toHaveLength(4);
  });
});
