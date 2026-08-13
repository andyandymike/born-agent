import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ApplicationActionRegistry } from "../../src/control-plane/application-action-registry.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import { LocalOwnerPrincipalAuthority } from "../../src/control-plane/local-owner-principal.js";
import { PreparedActionStore } from "../../src/control-plane/prepared-action-store.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { createRunCancelAction } from "../../src/control-plane/use-cases/run-actions.js";
import { taskMutationBlocker } from "../../src/coordination/task-control-plane.js";
import {
  EventPersistenceError,
  EventPublisher,
} from "../../src/events/event-publisher.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../../src/sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A durable run cancellation", () => {
  it.each(["direct_abort", "forged_session_request"] as const)(
    "fails closed when an authenticated owner returns %s without the exact registry barrier",
    async (variant) => {
      const stateRoot = await directory(`bornagent-phase21a-${variant}-state-`);
      const repositoryRoot = await directory(`bornagent-phase21a-${variant}-repo-`);
      const plane = await createPhase21ALocalControlPlane({
        launcher: {
          launch: async (input) => {
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
                model: "phase21a-cancel-negative",
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
            if (variant === "direct_abort") {
              await publisher.publish({
                data: { duration_ms: 1, reason: "user" },
                type: "run.cancelled",
              });
            } else {
              const cancelOperationId = randomUUID();
              const request = await input.writer.appendPhase21RunControlEvent(
                input.runId,
                cancelOperationId,
                "run.cancel.requested",
                {
                  application_commit: {
                    action_kind: "run.cancel",
                    authorization_decision_sha256: "a".repeat(64),
                    operation_id: cancelOperationId,
                    prepared_action_sha256: "b".repeat(64),
                    principal_id: "local_owner",
                    schema_version: 1,
                  },
                  reason: "user",
                  target_owner_generation_sha256: input.writer.lockNonceSha256,
                  target_run_id: input.runId,
                },
              );
              await publisher.publish({
                data: {
                  application_cancel_request: {
                    request_event_id: request.eventId,
                    request_event_sha256:
                      input.writer.readDurableEventIdentity(request.eventId).rawEventSha256,
                    target_owner_generation_sha256: input.writer.lockNonceSha256,
                  },
                  duration_ms: 1,
                  reason: "user",
                },
                type: "run.cancelled",
              });
            }
            return Object.freeze({ exitCode: 130 });
          },
        },
        stateRoot,
      });
      const repository = await plane.repositories.register({
        expectedHead: await plane.repositories.head(),
        operationId: randomUUID(),
        root: repositoryRoot,
      });
      const repositoryId = repository.registration.repositoryId;
      const session = await plane.sessions.create({
        expectedHead: await plane.sessions.head(repositoryId),
        operationId: randomUUID(),
        repositoryId,
      });
      const context = plane.context("cli", randomUUID());
      const payload = { command: "agent" as const, task: "attempt unauthenticated cancellation", verbose: false };
      const prepared = await plane.actions.prepare(context, {
        actionKind: "session.message.submit",
        payload,
        payloadSha256: sha256Canonical(payload),
        prepareIdempotencyKey: `negative-${variant}-prepare`,
        requestId: randomUUID(),
        schemaVersion: 1,
        target: {
          expectedVersion: { head: session.entry.initialLedgerHead, kind: "session_ledger_head" },
          kind: "existing_resource",
          resourceScope: {
            kind: "session",
            repositoryId,
            sessionId: session.entry.sessionId,
            teamId: null,
          },
        },
      });
      const committed = await plane.actions.commit(context, {
        idempotencyKey: `negative-${variant}-commit`,
        preparedActionId: prepared.result!.prepared.preparedActionId,
        preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
        requestId: randomUUID(),
        schemaVersion: 1,
      });
      expect(committed).toMatchObject({
        error: { code: "control_operation_busy" },
        status: "rejected",
      });
      const operation = await plane.operations.findByPreparedAction(
        prepared.result!.prepared.preparedActionId,
      );
      expect(operation?.state).toBe("blocked_unknown_effect");
    },
  );

  it("blocks mutations after a durable request and rejects an unbound legacy terminal", async () => {
    const repositoryRoot = await directory("bornagent-phase21a-cancel-barrier-");
    const sessionId = randomUUID();
    const runId = randomUUID();
    const requestEventId = randomUUID();
    const ownerGenerationSha256 = "a".repeat(64);
    const writer = await V2SessionWriter.createNew(repositoryRoot, sessionId);
    const publisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId,
      sessionId,
      timestamp: () => new Date().toISOString(),
      writer,
    });
    await publisher.publish({
      data: {
        command: "agent",
        input: { role: "user", text: "wait for durable cancellation" },
        max_duration_ms: 10_000,
        max_steps: 1,
        max_tokens: 100,
        max_tool_output_bytes: 1_024,
        model: "phase21a-cancel",
        provider: "ollama",
        request_timeout_ms: 1_000,
        tools: [],
        tools_enabled: true,
        workspace: repositoryRoot,
      },
      type: "run.started",
    });
    await publisher.publish({
      data: {
        adapter: "phase21a-cancel",
        adapter_version: "1",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "strict",
          usage: "complete",
        },
        config_fingerprint: "b".repeat(64),
        model: "phase21a-cancel",
        provider: "ollama",
      },
      type: "backend.selected",
    });
    await writer.appendPhase21RunControlEvent(
      runId,
      requestEventId,
      "run.cancel.requested",
      {
        application_commit: {
          action_kind: "run.cancel",
          authorization_decision_sha256: "c".repeat(64),
          operation_id: requestEventId,
          prepared_action_sha256: "d".repeat(64),
          principal_id: "local_owner",
          schema_version: 1,
        },
        reason: "user",
        target_owner_generation_sha256: ownerGenerationSha256,
        target_run_id: runId,
      },
    );

    expect(
      taskMutationBlocker(reconstructMultiRunSession(writer.events)),
    ).toEqual({
      code: "session_effect_reconciliation_required",
      details: ["pending_run_cancel=1"],
    });
    let rejected: unknown;
    try {
      await publisher.publish({
        data: { duration_ms: 1, reason: "user" },
        type: "run.cancelled",
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(EventPersistenceError);
    expect((rejected as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((rejected as Error & { cause: Error }).cause).message).toMatch(
      /application cancel request/i,
    );

    const path = join(
      repositoryRoot,
      ".bornagent",
      "sessions",
      `${sessionId}.jsonl`,
    );
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    await writer.close();
  });

  it("persists one exact run/owner request before signalling and links the terminal", async () => {
    let acknowledgeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      acknowledgeStarted = resolve;
    });
    const stateRoot = await directory("bornagent-phase21a-cancel-state-");
    const repositoryRoot = await directory("bornagent-phase21a-cancel-repo-");
    const plane = await createPhase21ALocalControlPlane({
      launcher: {
        launch: async (input) => {
          const publisher = new EventPublisher({
            randomUUID,
            renderer: { render: () => undefined },
            runId: input.runId,
            sessionId: input.sessionId,
            timestamp: () => new Date().toISOString(),
            writer: input.writer,
          });
          const runStarted = await publisher.publish({
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
              model: "phase21a-cancel",
              provider: "ollama",
              request_timeout_ms: 1_000,
              tools: [],
              tools_enabled: true,
              workspace: input.repositoryRoot,
            },
            type: "run.started",
          });
          if (runStarted.type !== "run.started") throw new TypeError("expected run start");
          await input.onRunStarted(runStarted);
          await publisher.publish({
            data: {
              adapter: "phase21a-cancel",
              adapter_version: "1",
              capabilities: {
                cancellation: "abort_signal",
                reasoning: "none",
                streaming: true,
                tools: "strict",
                usage: "complete",
              },
              config_fingerprint: "c".repeat(64),
              model: "phase21a-cancel",
              provider: "ollama",
            },
            type: "backend.selected",
          });
          acknowledgeStarted?.();
          if (!input.applicationCancellation.signal.aborted) {
            await new Promise<void>((resolve) => {
              input.applicationCancellation.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          const binding = input.applicationCancellation.terminalBinding();
          if (binding === undefined) throw new TypeError("cancel signal has no durable request binding");
          // Leave several owner polling intervals between signal and terminal.
          // Re-observing the same safety-reducing request must only re-signal;
          // it must never append a second request fact.
          await new Promise((resolve) => setTimeout(resolve, 75));
          await publisher.publish({
            data: {
              application_cancel_request: binding,
              duration_ms: 1,
              reason: "user",
            },
            type: "run.cancelled",
          });
          return Object.freeze({ exitCode: 130 });
        },
      },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const repositoryId = repository.registration.repositoryId;
    const session = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repositoryId),
      operationId: randomUUID(),
      repositoryId,
    });
    const context = plane.context("tui", randomUUID());
    const messagePayload = { command: "agent" as const, task: "wait until cancelled", verbose: false };
    const messagePrepared = await plane.actions.prepare(context, {
      actionKind: "session.message.submit",
      payload: messagePayload,
      payloadSha256: sha256Canonical(messagePayload),
      prepareIdempotencyKey: "message-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: session.entry.initialLedgerHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: { kind: "session", repositoryId, sessionId: session.entry.sessionId, teamId: null },
      },
    });
    const messageCommit = plane.actions.commit(context, {
      idempotencyKey: "message-commit",
      preparedActionId: messagePrepared.result!.prepared.preparedActionId,
      preparedActionSha256: messagePrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    await started;
    const active = await plane.sessionProjection.read({
      repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });
    const messageOperation = await plane.operations.findByPreparedAction(
      messagePrepared.result!.prepared.preparedActionId,
    );
    if (messageOperation === null) throw new TypeError("message operation was not accepted");
    const runId = messageOperation.operationId;
    const cancelPayload = { reason: "user" as const, runId };
    const cancelPrepared = await plane.actions.prepare(context, {
      actionKind: "run.cancel",
      payload: cancelPayload,
      payloadSha256: sha256Canonical(cancelPayload),
      prepareIdempotencyKey: "cancel-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: active.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: active.resourceScope,
      },
    });
    if (cancelPrepared.status !== "ok") {
      throw new Error(`cancel prepare failed: ${JSON.stringify(cancelPrepared.error)}`);
    }
    const cancelled = await plane.actions.commit(context, {
      idempotencyKey: "cancel-K1",
      preparedActionId: cancelPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: cancelPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    if (cancelled.status !== "ok") {
      throw new Error(`cancel commit failed: ${JSON.stringify(cancelled.error)}`);
    }
    expect(cancelled).toMatchObject({
      status: "ok",
      result: { runId, signalStatus: "exact_owner_signalled" },
    });
    const message = await messageCommit;
    expect(message).toMatchObject({ status: "ok", result: { exitCode: 130, terminal: "run.cancelled" } });

    const path = join(repositoryRoot, ".bornagent", "sessions", `${session.entry.sessionId}.jsonl`);
    const events = await readStoredSession(path);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "backend.selected",
      "run.cancel.requested",
      "run.cancelled",
    ]);
    const request = events[2]!;
    const terminal = events[3]!;
    expect(request.eventId).toBe(cancelled.operationId);
    expect(terminal.data).toMatchObject({
      application_cancel_request: {
        request_event_id: request.eventId,
      },
    });
    const rawLines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(rawLines).toHaveLength(4);
    const closedBarrier = await plane.sessions.readRunCancelBarrier(
      repositoryId,
      session.entry.sessionId,
      runId,
    );
    expect(closedBarrier).toMatchObject({
      binding: { fact: { cancelOperationId: cancelled.operationId } },
      request: { fact: { applicationCommit: { operationId: cancelled.operationId } } },
      terminal: { fact: { cancelOperationId: cancelled.operationId } },
    });

    const replay = await plane.actions.commit(context, {
      idempotencyKey: "cancel-K2",
      preparedActionId: cancelPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: cancelPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(replay.operationId).toBe(cancelled.operationId);
    expect((await readStoredSession(path))).toHaveLength(4);
  });

  it("reconciles an exact bound terminal after cancel response loss without signalling twice", async () => {
    let acknowledgeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { acknowledgeStarted = resolve; });
    let abortObservations = 0;
    const broker = new SessionOwnerBroker();
    const stateRoot = await directory("bornagent-phase21a-cancel-loss-state-");
    const repositoryRoot = await directory("bornagent-phase21a-cancel-loss-repo-");
    const plane = await createPhase21ALocalControlPlane({
      broker,
      launcher: {
        launch: async (input) => {
          const publisher = new EventPublisher({
            randomUUID,
            renderer: { render: () => undefined },
            runId: input.runId,
            sessionId: input.sessionId,
            timestamp: () => new Date().toISOString(),
            writer: input.writer,
          });
          const runStarted = await publisher.publish({
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
              model: "phase21a-cancel-loss",
              provider: "ollama",
              request_timeout_ms: 1_000,
              tools: [],
              tools_enabled: true,
              workspace: input.repositoryRoot,
            },
            type: "run.started",
          });
          if (runStarted.type !== "run.started") throw new TypeError("expected run start");
          await input.onRunStarted(runStarted);
          await publisher.publish({
            data: {
              adapter: "phase21a-cancel-loss",
              adapter_version: "1",
              capabilities: {
                cancellation: "abort_signal",
                reasoning: "none",
                streaming: true,
                tools: "strict",
                usage: "complete",
              },
              config_fingerprint: "e".repeat(64),
              model: "phase21a-cancel-loss",
              provider: "ollama",
            },
            type: "backend.selected",
          });
          acknowledgeStarted?.();
          await new Promise<void>((resolve) => {
            input.applicationCancellation.signal.addEventListener("abort", () => {
              abortObservations += 1;
              resolve();
            }, { once: true });
          });
          const binding = input.applicationCancellation.terminalBinding();
          if (binding === undefined) throw new TypeError("cancel signal has no durable binding");
          await publisher.publish({
            data: {
              application_cancel_request: binding,
              duration_ms: 1,
              reason: "user",
            },
            type: "run.cancelled",
          });
          return Object.freeze({ exitCode: 130 });
        },
      },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const repositoryId = repository.registration.repositoryId;
    const session = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repositoryId),
      operationId: randomUUID(),
      repositoryId,
    });
    const context = plane.context("tui", randomUUID());
    const messagePayload = { command: "agent" as const, task: "cancel with lost response", verbose: false };
    const messagePrepared = await plane.actions.prepare(context, {
      actionKind: "session.message.submit",
      payload: messagePayload,
      payloadSha256: sha256Canonical(messagePayload),
      prepareIdempotencyKey: "cancel-loss-message-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: session.entry.initialLedgerHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: { kind: "session", repositoryId, sessionId: session.entry.sessionId, teamId: null },
      },
    });
    const messageCommit = plane.actions.commit(context, {
      idempotencyKey: "cancel-loss-message-commit",
      preparedActionId: messagePrepared.result!.prepared.preparedActionId,
      preparedActionSha256: messagePrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    await started;
    const active = await plane.sessionProjection.read({
      repositoryId,
      requestedHead: null,
      sessionId: session.entry.sessionId,
    });
    const messageOperation = await plane.operations.findByPreparedAction(messagePrepared.result!.prepared.preparedActionId);
    if (messageOperation === null) throw new TypeError("message operation was not accepted");
    const runId = messageOperation.operationId;

    const authority = await loadOrCreateHostControlAuthority({ root: stateRoot });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const base = createRunCancelAction({
      broker,
      sessionProjection: plane.sessionProjection,
      sessions: plane.sessions,
    });
    type CancelPayload = Parameters<typeof base.execute>[1];
    const actions = new ApplicationActionRegistry([{
      ...base,
      execute: async (context, payload: CancelPayload, prepared) => {
        await base.execute(context, payload, prepared);
        const completedMessage = await messageCommit;
        if (completedMessage.status !== "ok") throw new Error("message owner did not persist its terminal");
        throw new Error("injected run.cancel response loss");
      },
    }]);
    const service = new DefaultAgentRunApplicationService({
      actions,
      artifacts,
      createRequestId: randomUUID,
      delivery: new SessionDeliveryCoordinator(),
      hostRuntime: createNodeApplicationHostRuntime(),
      journal: plane.operations,
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
    });
    const cancelPayload = { reason: "user" as const, runId };
    const cancelPrepared = await service.prepare(context, {
      actionKind: "run.cancel",
      payload: cancelPayload,
      payloadSha256: sha256Canonical(cancelPayload),
      prepareIdempotencyKey: "cancel-loss-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: active.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: active.resourceScope,
      },
    });
    expect(cancelPrepared.status, cancelPrepared.error?.message).toBe("ok");
    const cancelled = await service.commit(context, {
      idempotencyKey: "cancel-loss-commit",
      preparedActionId: cancelPrepared.result!.prepared.preparedActionId,
      preparedActionSha256: cancelPrepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });

    expect(cancelled).toMatchObject({
      result: { requestEventId: cancelled.operationId, signalStatus: "exact_owner_signalled" },
      status: "ok",
    });
    expect(abortObservations).toBe(1);
    expect((await plane.operations.read(cancelled.operationId!))?.state).toBe("completed");
    const events = await readStoredSession(join(
      repositoryRoot,
      ".bornagent",
      "sessions",
      `${session.entry.sessionId}.jsonl`,
    ));
    expect(events.filter((event) => event.type === "run.cancel.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
  });
});
