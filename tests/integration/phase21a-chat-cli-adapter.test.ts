import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import {
  contextForRuntime,
  planeForRuntime,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { prepareCliChatExecution } from "../../src/control-plane/adapters/chat-cli-port.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { readStoredSession } from "../../src/sessions/read-stored-session.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { FakeStreamingChatClient, fixedStream, waitForAbort } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

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

describe("Phase 21A product Chat application adapter", () => {
  it("turns product CLI SIGINT into one durable typed cancel before signalling Chat", async () => {
    const cwd = await directory("bornagent-phase21a-chat-sigint-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-chat-sigint-state-");
    const memory = createMemoryIO();
    const client = new FakeStreamingChatClient(waitForAbort());
    const hostSigintListeners = new Set<() => void>();
    const runtime = createRuntime({
      controlPlaneStateRoot,
      createModelBackend: () => client,
      cwd,
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
    });

    const execution = runCli(
      ["chat", "wait for CLI SIGINT", "--provider", "ollama", "--no-tools"],
      memory.io,
      runtime,
    );
    await vi.waitFor(() => expect(client.calls).toHaveLength(1), { timeout: 10_000 });
    expect(hostSigintListeners.size).toBeGreaterThan(0);
    for (const listener of [...hostSigintListeners]) listener();
    await expect(execution).resolves.toBe(130);
    expect(memory.readStderr()).toContain("cancel requested:");

    const files = (await readdir(join(cwd, ".bornagent", "sessions")))
      .filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const events = await readStoredSession(join(cwd, ".bornagent", "sessions", files[0]!));
    const requestIndex = events.findIndex((event) => event.type === "run.cancel.requested");
    const terminalIndex = events.findIndex((event) => event.type === "run.cancelled");
    expect(requestIndex).toBeGreaterThan(events.findIndex((event) => event.type === "run.started"));
    expect(terminalIndex).toBeGreaterThan(requestIndex);
    const request = events[requestIndex]!;
    expect(events[terminalIndex]?.data).toMatchObject({
      application_cancel_request: { request_event_id: request.eventId },
      reason: "user",
    });

    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.map((operation) => operation.actionKind).sort()).toEqual([
      "repository.register",
      "run.cancel",
      "session.create",
      "session.message.submit",
    ].sort());
    expect(operations.every((operation) => operation.state === "completed")).toBe(true);
  }, 20_000);

  it("creates one catalog session and commits the authenticated seq1 Chat start", async () => {
    const cwd = await directory("bornagent-phase21a-chat-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-chat-state-");
    const memory = createMemoryIO();
    const modelTurns = vi.fn(() => new FakeStreamingChatClient(fixedStream(["host chat"] )));
    const runtime = createRuntime({
      controlPlaneStateRoot,
      createModelBackend: modelTurns,
      cwd,
    });

    expect(await runCli(["chat", "hello from Host", "--provider", "ollama"], memory.io, runtime), memory.readStderr()).toBe(0);
    expect(memory.readStdout()).toBe("host chat\n");
    expect(modelTurns).toHaveBeenCalledTimes(1);

    const files = (await readdir(join(cwd, ".bornagent", "sessions")))
      .filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const events = await readStoredSession(join(cwd, ".bornagent", "sessions", files[0]!));
    expect(events[0]).toMatchObject({
      sessionSeq: 1,
      type: "run.started",
      data: {
        application_commit: {
          action_kind: "session.message.submit",
          principal_id: "local_owner",
        },
        command: "chat",
        input: { role: "user", text: "hello from Host" },
      },
    });
    expect(events.at(-1)?.type).toBe("run.completed");
    const operationId = (events[0]!.data as { application_commit: { operation_id: string } })
      .application_commit.operation_id;
    expect(events[0]).toMatchObject({ eventId: operationId, runId: operationId });

    const plane = await planeForRuntime(runtime, memory.io);
    const repository = (await plane.repositories.list()).find((entry) => entry.status === "active");
    if (repository === undefined) throw new TypeError("Chat repository catalog entry is unavailable");
    const catalog = await plane.sessions.project(repository.repositoryId);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.initialLedgerHead).toMatchObject({
      eventId: null,
      eventIntegrityToken: null,
      sequence: 0,
    });
    expect(catalog.intents).toHaveLength(1);
    expect(catalog.materializations).toMatchObject([{
      firstEventId: events[0]!.eventId,
      firstEventOperationId: operationId,
      origin: "phase21_application",
    }]);

    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    const operations = await new ControlOperationJournal(authority.paths).list();
    expect(operations.map((operation) => operation.actionKind).sort()).toEqual([
      "repository.register",
      "session.create",
      "session.message.submit",
    ].sort());
    expect(operations.every((operation) => operation.state === "completed")).toBe(true);
  });

  it("does not make a model request or create a catalog session when preflight rejects", async () => {
    const cwd = await directory("bornagent-phase21a-chat-deny-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-chat-deny-state-");
    const createModelBackend = vi.fn(() => {
      throw new Error("backend must not be selected for invalid timeout");
    });
    const memory = createMemoryIO();

    expect(await runCli(
      ["chat", "invalid", "--provider", "ollama", "--timeout-ms", "999"],
      memory.io,
      createRuntime({ controlPlaneStateRoot, createModelBackend, cwd }),
    )).toBe(2);
    expect(createModelBackend).not.toHaveBeenCalled();
    await expect(readdir(join(cwd, ".bornagent", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    const authority = await loadOrCreateHostControlAuthority({ root: controlPlaneStateRoot });
    expect(await new ControlOperationJournal(authority.paths).list()).toHaveLength(0);
  });

  it("forwards typed application cancellation and persists its exact terminal binding", async () => {
    const cwd = await directory("bornagent-phase21a-chat-cancel-repo-");
    const memory = createMemoryIO();
    const client = new FakeStreamingChatClient(waitForAbort());
    const runtime = createRuntime({
      createModelBackend: () => client,
      cwd,
    });
    const prepared = await prepareCliChatExecution({
      io: memory.io,
      options: {
        model: undefined,
        prompt: "wait for typed cancel",
        provider: "ollama",
        timeoutMs: "10000",
        toolsEnabled: false,
        verbose: false,
      },
      runtime,
    });
    if (!prepared.ok) throw new Error(`Chat preflight failed with ${String(prepared.exitCode)}`);
    expect(client.calls).toHaveLength(0);
    const sessionId = runtime.randomUUID();
    const runId = runtime.randomUUID();
    const writer = await V2SessionWriter.createNew(cwd, sessionId);
    const controller = new AbortController();
    const cancelOperationId = runtime.randomUUID();
    const ownerGenerationSha256 = "c".repeat(64);
    const cancellation: {
      binding?: Readonly<{
        readonly request_event_id: string;
        readonly request_event_sha256: string;
        readonly target_owner_generation_sha256: string;
      }>;
    } = {};
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const execution = prepared.execution.execute({
      applicationCancellation: {
        signal: controller.signal,
        terminalBinding: () => cancellation.binding,
      },
      applicationCommit: {
        actionKind: "session.message.submit",
        authorizationDecisionSha256: "d".repeat(64),
        operationId: runId,
        preparedActionSha256: "e".repeat(64),
        principalId: "local_owner",
        schemaVersion: 1,
      },
      onRunStarted: async () => { started?.(); },
      payload: prepared.payload,
      repositoryRoot: cwd,
      runId,
      sessionId,
      writer,
    });
    await didStart;
    await vi.waitFor(() => {
      expect(writer.events.some((event) => event.type === "backend.selected")).toBe(true);
    });
    const request = await writer.appendPhase21RunControlEvent(
      runId,
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
        target_owner_generation_sha256: ownerGenerationSha256,
        target_run_id: runId,
      },
    );
    cancellation.binding = Object.freeze({
      request_event_id: request.eventId,
      request_event_sha256: writer.readDurableEventIdentity(request.eventId).rawEventSha256,
      target_owner_generation_sha256: ownerGenerationSha256,
    });
    controller.abort();
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    expect(writer.events.map((event) => event.type)).toEqual([
      "run.started",
      "backend.selected",
      "run.cancel.requested",
      "run.cancelled",
    ]);
    expect(writer.events.at(-1)?.data).toMatchObject({
      application_cancel_request: cancellation.binding,
      reason: "user",
    });
    await writer.close();
  });

  it("routes run.cancel through the active product Chat owner and closes the exact barrier", async () => {
    const cwd = await directory("bornagent-phase21a-product-chat-cancel-repo-");
    const controlPlaneStateRoot = await directory("bornagent-phase21a-product-chat-cancel-state-");
    const memory = createMemoryIO();
    const client = new FakeStreamingChatClient(waitForAbort());
    const runtime = createRuntime({
      controlPlaneStateRoot,
      createModelBackend: () => client,
      cwd,
    });
    const chat = runCli(
      ["chat", "wait for Host cancel", "--provider", "ollama", "--no-tools"],
      memory.io,
      runtime,
    );
    await vi.waitFor(() => expect(client.calls).toHaveLength(1), { timeout: 5_000 });

    const plane = await planeForRuntime(runtime, memory.io);
    const context = contextForRuntime(plane, runtime, "cli");
    const repository = (await plane.repositories.list()).find((entry) => entry.status === "active");
    if (repository === undefined) throw new TypeError("product Chat repository is unavailable");
    const catalog = await plane.sessions.project(repository.repositoryId);
    const entry = catalog.entries[0];
    if (entry === undefined) throw new TypeError("product Chat session is unavailable");
    const messageOperation = (await plane.operations.list()).find((operation) =>
      operation.actionKind === "session.message.submit"
    );
    if (messageOperation === undefined) throw new TypeError("product Chat operation is unavailable");
    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.repositoryId,
      requestedHead: null,
      sessionId: entry.sessionId,
    });
    const payload = Object.freeze({ reason: "user" as const, runId: messageOperation.operationId });
    const prepared = await plane.actions.prepare(context, {
      actionKind: "run.cancel",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "product-chat-cancel-prepare",
      requestId: runtime.randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: snapshot.resourceScope,
      },
    });
    expect(prepared.status, prepared.error?.message).toBe("ok");
    const cancelled = await plane.actions.commit(context, {
      idempotencyKey: "product-chat-cancel-K1",
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: runtime.randomUUID(),
      schemaVersion: 1,
    });
    expect(cancelled).toMatchObject({
      result: { runId: messageOperation.operationId, signalStatus: "exact_owner_signalled" },
      status: "ok",
    });
    await expect(chat).resolves.toBe(130);

    const events = await readStoredSession(join(cwd, ".bornagent", "sessions", `${entry.sessionId}.jsonl`));
    const request = events.find((event) => event.type === "run.cancel.requested");
    const terminal = events.find((event) => event.type === "run.cancelled");
    expect(request?.eventId).toBe(cancelled.operationId);
    expect(terminal?.data).toMatchObject({
      application_cancel_request: { request_event_id: cancelled.operationId },
    });
    expect(await plane.sessions.readRunCancelBarrier(
      repository.repositoryId,
      entry.sessionId,
      messageOperation.operationId,
    )).toMatchObject({
      binding: { fact: { cancelOperationId: cancelled.operationId } },
      terminal: { fact: { cancelOperationId: cancelled.operationId } },
    });
  });
});
