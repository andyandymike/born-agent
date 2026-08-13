import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import type { ApplicationActionExecutionContextV1 } from "../../src/control-plane/application-action-registry.js";
import type { AuthenticatedCallContextV1, PreparedActionV1 } from "../../src/control-plane/application-protocol.js";
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
  type SessionMessagePayloadV1,
} from "../../src/control-plane/use-cases/session-message-action.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { EventPublisher } from "../../src/events/event-publisher.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

interface CrashFixture {
  readonly action: ReturnType<typeof createSessionMessageAction>;
  readonly context: ApplicationActionExecutionContextV1;
  readonly payload: SessionMessagePayloadV1;
  readonly prepared: PreparedActionV1;
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly sessions: SessionRegistry;
}

async function crashFixture(launcher: SessionMessageLaunchPortV1): Promise<CrashFixture> {
  const authority = await loadOrCreateHostControlAuthority({ root: await directory("bornagent-phase21a-crash-state-") });
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
  const sessions = new SessionRegistry(authority.paths, repositories);
  const broker = new SessionOwnerBroker();
  const projection = new SessionProjectionService({
    broker,
    disclosureProfileSha256: sha256Canonical({ profile: "crash-prefix", schema_version: 1 }),
    repositories,
    sessions,
    signer: new SessionLedgerHeadSigner(authority.integrityKey),
  });
  const action = createSessionMessageAction({
    broker,
    launcher,
    recurringTasks: createNodeApplicationHostRuntime(),
    repositories,
    sessionProjection: projection,
    sessions,
  });
  const service = new DefaultAgentRunApplicationService({
    actions: createCatalogActionRegistry({ additionalDefinitions: [action], repositories, sessions }),
    artifacts,
    createRequestId: randomUUID,
    delivery: new SessionDeliveryCoordinator(),
    hostRuntime: createNodeApplicationHostRuntime(),
    journal: new ControlOperationJournal(authority.paths),
    preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
    principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
  });
  const root = await directory("bornagent-phase21a-crash-repo-");
  const repository = await repositories.register({ expectedHead: await repositories.head(), operationId: randomUUID(), root });
  const created = await sessions.create({
    expectedHead: await sessions.head(repository.registration.repositoryId),
    operationId: randomUUID(),
    repositoryId: repository.registration.repositoryId,
  });
  const call: AuthenticatedCallContextV1 = Object.freeze({
    principal: authority.localOwner,
    surface: Object.freeze({ clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const }),
  });
  const payload = Object.freeze({ command: "agent" as const, task: "recover one exact materialization", verbose: false });
  const target = Object.freeze({
    expectedVersion: Object.freeze({ head: created.entry.initialLedgerHead, kind: "session_ledger_head" as const }),
    kind: "existing_resource" as const,
    resourceScope: Object.freeze({
      kind: "session" as const,
      repositoryId: repository.registration.repositoryId,
      sessionId: created.entry.sessionId,
      teamId: null,
    }),
  });
  const preparedEnvelope = await service.prepare(call, {
    actionKind: "session.message.submit",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: randomUUID(),
    requestId: randomUUID(),
    schemaVersion: 1,
    target,
  });
  if (preparedEnvelope.status !== "ok" || preparedEnvelope.result === null) throw new Error("fixture prepare failed");
  const prepared = preparedEnvelope.result.prepared;
  const operationId = randomUUID();
  const authorizationDecisionSha256 = "d".repeat(64);
  const applicationCommit = Object.freeze({
    actionKind: "session.message.submit",
    authorizationDecisionSha256,
    operationId,
    preparedActionSha256: prepared.preparedActionSha256,
    principalId: authority.localOwner.principalId,
    schemaVersion: 1 as const,
  });
  return Object.freeze({
    action,
    context: Object.freeze({
      applicationCommit,
      authorizationDecisionSha256,
      call,
      operationId,
      requestId: randomUUID(),
      resolvedTarget: await action.resolveTarget(target, payload),
    }),
    payload,
    prepared,
    repositoryId: repository.registration.repositoryId,
    sessionId: created.entry.sessionId,
    sessionPath: join(root, ".bornagent", "sessions", `${created.entry.sessionId}.jsonl`),
    sessions,
  });
}

async function publishRunPrefix(
  input: Parameters<SessionMessageLaunchPortV1["launch"]>[0],
  authorizationDecisionSha256: string,
): Promise<void> {
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: () => new Date().toISOString(),
    writer: input.writer,
  });
  await publisher.publish({
    data: {
      application_commit: {
        action_kind: input.applicationCommit.actionKind,
        authorization_decision_sha256: authorizationDecisionSha256,
        operation_id: input.applicationCommit.operationId,
        prepared_action_sha256: input.applicationCommit.preparedActionSha256,
        principal_id: input.applicationCommit.principalId,
        schema_version: 1,
      },
      command: "agent",
      input: { role: "user", text: input.payload.task },
      max_duration_ms: 1_000,
      max_steps: 1,
      max_tokens: 100,
      max_tool_output_bytes: 1_024,
      model: "phase21a-crash-fake",
      provider: "ollama",
      request_timeout_ms: 1_000,
      tools: [],
      tools_enabled: true,
      workspace: input.repositoryRoot,
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      adapter: "phase21a-crash-fake",
      adapter_version: "1",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "c".repeat(64),
      model: "phase21a-crash-fake",
      provider: "ollama",
    },
    type: "backend.selected",
  });
  await publisher.publish({
    data: {
      category: "internal",
      code: "injected_crash_prefix",
      duration_ms: 1,
      message: "durable terminal before injected response loss",
      retryable: false,
    },
    type: "run.failed",
  });
}

describe("Phase 21A seq0 crash-prefix recovery", () => {
  it("never recreates or relaunches after an intent-owned session file is lost", async () => {
    let launches = 0;
    const fixture = await crashFixture({
      launch: async () => {
        launches += 1;
        throw new Error("injected crash after file creation");
      },
    });
    await expect(fixture.action.execute(fixture.context, fixture.payload, fixture.prepared)).rejects.toThrow(/injected crash/u);
    expect((await fixture.sessions.project(fixture.repositoryId)).intents).toHaveLength(1);
    await rm(fixture.sessionPath, { force: true });

    await expect(fixture.action.execute(fixture.context, fixture.payload, fixture.prepared)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });
    expect(launches).toBe(1);
    await expect(access(fixture.sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles an exact first event and terminal without relaunching when the marker was lost", async () => {
    let launches = 0;
    const fixture = await crashFixture({
      launch: async (input) => {
        launches += 1;
        await publishRunPrefix(input, input.applicationCommit.authorizationDecisionSha256);
        throw new Error("injected response loss before marker");
      },
    });
    await expect(fixture.action.execute(fixture.context, fixture.payload, fixture.prepared)).rejects.toThrow(/response loss/u);
    expect((await fixture.sessions.project(fixture.repositoryId)).materializations).toHaveLength(0);

    const recovered = await fixture.action.execute(fixture.context, fixture.payload, fixture.prepared);
    expect(recovered.result).toMatchObject({ recovered: true, terminal: "run.failed" });
    expect(launches).toBe(1);
    expect((await fixture.sessions.project(fixture.repositoryId)).materializations[0]).toMatchObject({
      firstEventActionKind: fixture.context.applicationCommit.actionKind,
      firstEventAuthorizationDecisionSha256: fixture.context.applicationCommit.authorizationDecisionSha256,
      firstEventOperationId: fixture.context.operationId,
      firstEventPreparedActionSha256: fixture.prepared.preparedActionSha256,
      firstEventPrincipalId: fixture.context.applicationCommit.principalId,
    });
  });

  it("rejects a same-operation first event with a different authorization digest", async () => {
    let launches = 0;
    const fixture = await crashFixture({
      launch: async (input) => {
        launches += 1;
        await publishRunPrefix(input, "f".repeat(64));
        throw new Error("injected mismatched durable prefix");
      },
    });
    await expect(fixture.action.execute(fixture.context, fixture.payload, fixture.prepared)).rejects.toThrow(/mismatched durable prefix/u);

    await expect(fixture.action.execute(fixture.context, fixture.payload, fixture.prepared)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });
    expect(launches).toBe(1);
    expect((await fixture.sessions.project(fixture.repositoryId)).materializations).toHaveLength(0);
  });
});
