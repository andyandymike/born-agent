import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import type { ChatExecutionPortV1 } from "../../src/control-plane/use-cases/session-message-action.js";
import { EventPublisher } from "../../src/events/event-publisher.js";

const temporary: string[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A Chat response-loss reconciliation", () => {
  it("rebuilds a complete result from exact JSONL facts without a second Chat dispatch", async () => {
    const stateRoot = await directory("bornagent-phase21a-chat-loss-state-");
    const repositoryRoot = await directory("bornagent-phase21a-chat-loss-repo-");
    const dispatch = vi.fn<ChatExecutionPortV1["execute"]>(async (input) => {
      const publisher = new EventPublisher({
        randomUUID: (() => {
          let first = true;
          return () => {
            if (first) {
              first = false;
              return input.runId;
            }
            return randomUUID();
          };
        })(),
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
          command: "chat",
          input: { role: "user", text: input.payload.prompt },
          model: "phase21a-chat",
          provider: "ollama",
          timeout_ms: 1_000,
          tools: [],
          tools_enabled: false,
          workspace: input.repositoryRoot,
        },
        type: "run.started",
      });
      if (started.type !== "run.started") throw new TypeError("expected run start");
      await input.onRunStarted(started);
      await publisher.publish({
        data: {
          adapter: "phase21a-chat",
          adapter_version: "1",
          capabilities: {
            cancellation: "abort_signal",
            reasoning: "none",
            streaming: true,
            tools: "none",
            usage: "complete",
          },
          config_fingerprint: "a".repeat(64),
          model: "phase21a-chat",
          provider: "ollama",
          resume_capability: "none",
        },
        type: "backend.selected",
      });
      await publisher.publish({
        data: { delta: "durable result" },
        type: "text.delta",
      });
      await publisher.publish({
        data: { duration_ms: 1, model_turns: 1, output_chars: 14, tool_calls: 0 },
        type: "run.completed",
      });
      return Object.freeze({ exitCode: 0 });
    });
    const plane = await createPhase21ALocalControlPlane({
      chatExecution: { execute: dispatch },
      launcher: { launch: async () => { throw new Error("agent launcher must not run"); } },
      stateRoot,
    });
    const context = plane.context("cli");
    const registered = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const created = await plane.sessions.create({
      expectedHead: await plane.sessions.head(registered.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: registered.registration.repositoryId,
    });
    const payload = Object.freeze({
      command: "chat" as const,
      prompt: "recover this exact Chat",
      provider: "ollama",
      toolsEnabled: false,
      verbose: false,
    });
    const prepared = await plane.actions.prepare(context, {
      actionKind: "session.message.submit",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "chat-response-loss-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: created.entry.initialLedgerHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: {
          kind: "session",
          repositoryId: registered.registration.repositoryId,
          sessionId: created.entry.sessionId,
          teamId: null,
        },
      },
    });
    expect(prepared.status).toBe("ok");

    const storeJson = plane.artifacts.storeJson.bind(plane.artifacts);
    let inject = true;
    vi.spyOn(plane.artifacts, "storeJson").mockImplementation(async (input) => {
      if (inject && input.createdByOperationId !== null && input.transportVisibility === "resource_authorized") {
        inject = false;
        throw new Error("injected result-store response loss");
      }
      return storeJson(input);
    });
    const first = await plane.actions.commit(context, {
      idempotencyKey: "chat-response-loss-K1",
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(first.status).toBe("rejected");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const linked = (await plane.operations.list()).find((operation) =>
      operation.actionKind === "session.message.submit"
    );
    expect(linked).toMatchObject({ resultArtifact: null, state: "domain_records_linked" });

    const recoveredPlane = await createPhase21ALocalControlPlane({
      chatExecution: { execute: async () => { throw new Error("reconcile must not dispatch Chat"); } },
      launcher: { launch: async () => { throw new Error("reconcile must not launch Agent"); } },
      stateRoot,
    });
    const recovered = await recoveredPlane.actions.commit(context, {
      idempotencyKey: "chat-response-loss-K2",
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(recovered).toMatchObject({
      operationId: linked?.operationId,
      result: { exitCode: 0, recovered: true, terminal: "run.completed" },
      status: "ok",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a durable start with no terminal and never re-dispatches", async () => {
    const stateRoot = await directory("bornagent-phase21a-chat-partial-state-");
    const repositoryRoot = await directory("bornagent-phase21a-chat-partial-repo-");
    const dispatch = vi.fn<ChatExecutionPortV1["execute"]>(async (input) => {
      const publisher = new EventPublisher({
        randomUUID: () => input.runId,
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
          command: "chat", input: { role: "user", text: input.payload.prompt },
          model: "phase21a-chat", provider: "ollama", timeout_ms: 1_000,
          tools: [], tools_enabled: false, workspace: input.repositoryRoot,
        },
        type: "run.started",
      });
      if (started.type !== "run.started") throw new TypeError("expected run start");
      await input.onRunStarted(started);
      throw new Error("injected model response loss before terminal");
    });
    const plane = await createPhase21ALocalControlPlane({
      chatExecution: { execute: dispatch },
      launcher: { launch: async () => { throw new Error("agent launcher must not run"); } },
      stateRoot,
    });
    const context = plane.context("cli");
    const registered = await plane.repositories.register({ expectedHead: await plane.repositories.head(), operationId: randomUUID(), root: repositoryRoot });
    const created = await plane.sessions.create({ expectedHead: await plane.sessions.head(registered.registration.repositoryId), operationId: randomUUID(), repositoryId: registered.registration.repositoryId });
    const payload = { command: "chat" as const, prompt: "partial", toolsEnabled: false, verbose: false };
    const prepared = await plane.actions.prepare(context, {
      actionKind: "session.message.submit", payload, payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "chat-partial-prepare", requestId: randomUUID(), schemaVersion: 1,
      target: { expectedVersion: { head: created.entry.initialLedgerHead, kind: "session_ledger_head" }, kind: "existing_resource", resourceScope: { kind: "session", repositoryId: registered.registration.repositoryId, sessionId: created.entry.sessionId, teamId: null } },
    });
    const first = await plane.actions.commit(context, {
      idempotencyKey: "chat-partial-K1", preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256, requestId: randomUUID(), schemaVersion: 1,
    });
    expect(first.status).toBe("rejected");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const replay = await plane.actions.commit(context, {
      idempotencyKey: "chat-partial-K2", preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256, requestId: randomUUID(), schemaVersion: 1,
    });
    expect(replay).toMatchObject({ error: { code: "control_operation_busy" }, status: "rejected" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
