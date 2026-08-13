import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { createSessionsResumePhase9ExecutionPort } from "../../src/commands/sessions.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { CliSessionResumeOwnerPort } from "../../src/control-plane/adapters/session-resume-cli-adapter.js";
import {
  executeSessionResumeThroughRuntimeAdapter,
  type SessionResumePhase9ExecutionPortV1,
} from "../../src/control-plane/adapters/session-resume-runtime-adapter.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";
import type { SessionResumeOwnerPortV1 } from "../../src/control-plane/use-cases/session-resume-action.js";
import { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
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

async function sessionIdentity(workspace: string): Promise<Readonly<{ id: string; path: string }>> {
  const root = join(workspace, ".bornagent", "sessions");
  const name = (await readdir(root)).find((candidate) => candidate.endsWith(".jsonl"));
  if (name === undefined) throw new Error("session fixture was not materialized");
  return Object.freeze({ id: name.slice(0, -".jsonl".length), path: join(root, name) });
}

async function initialApplicationSession(prefix: string) {
  const cwd = await directory(`bornagent-phase21a-${prefix}-repo-`);
  const controlPlaneStateRoot = await directory(`bornagent-phase21a-${prefix}-state-`);
  const createModelBackend = vi.fn(
    (request: { readonly model: string; readonly provider: string }) =>
      new FakeStreamingChatClient(fixedStream(["bounded answer"]), {
        model: request.model,
        provider: request.provider as "anthropic" | "ollama" | "openai",
      }),
  );
  const runtime = createRuntime({
    controlPlaneStateRoot,
    createModelBackend,
    createSessionWriter: V2SessionWriter.create,
    cwd,
    env: {},
  });
  const first = createMemoryIO();
  expect(await runCli([
    "agent",
    "create a resumable application session",
    "--task-profile",
    "read-only",
    "--provider",
    "ollama",
    "--model",
    "qwen3:1.7b",
  ], first.io, runtime), first.readStderr()).toBe(0);
  return Object.freeze({
    controlPlaneStateRoot,
    createModelBackend,
    cwd,
    runtime,
    session: await sessionIdentity(cwd),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 21A session resume application action", () => {
  it("turns product sessions resume SIGINT into an exact durable cancel and closes its barrier", async () => {
    const fixture = await initialApplicationSession("resume-sigint");
    const client = new FakeStreamingChatClient(waitForAbort());
    const hostSigintListeners = new Set<() => void>();
    const runtime = createRuntime({
      controlPlaneStateRoot: fixture.controlPlaneStateRoot,
      createModelBackend: () => client,
      createSessionWriter: V2SessionWriter.create,
      cwd: fixture.cwd,
      env: {},
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
      randomUUID,
    });
    const output = createMemoryIO();
    const execution = runCli([
      "sessions",
      "resume",
      fixture.session.id,
      "--message",
      "wait for typed resume cancellation",
      "--allow-degraded-resume",
    ], output.io, runtime);

    await vi.waitFor(() => expect(client.calls).toHaveLength(1), { timeout: 15_000 });
    expect(hostSigintListeners.size).toBeGreaterThan(0);
    for (const listener of [...hostSigintListeners]) listener();
    expect(await execution, output.readStderr()).toBe(130);
    expect(output.readStderr()).toContain("cancel requested:");

    const events = await readStoredSession(fixture.session.path);
    const resumeRequest = events.findLast((event) => event.type === "session.resume.requested");
    if (resumeRequest?.type !== "session.resume.requested" || resumeRequest.data.new_run_id === undefined) {
      throw new TypeError("resume cancellation request is unavailable");
    }
    const runId = resumeRequest.data.new_run_id;
    const startedIndex = events.findIndex((event) =>
      event.scope === "run" && event.runId === runId && event.type === "run.started"
    );
    const requestIndex = events.findIndex((event) =>
      event.scope === "run" && event.runId === runId && event.type === "run.cancel.requested"
    );
    const terminalIndex = events.findIndex((event) =>
      event.scope === "run" && event.runId === runId && event.type === "run.cancelled"
    );
    expect(requestIndex).toBeGreaterThan(startedIndex);
    expect(terminalIndex).toBeGreaterThan(requestIndex);
    const request = events[requestIndex]!;
    expect(events[terminalIndex]?.data).toMatchObject({
      application_cancel_request: { request_event_id: request.eventId },
      reason: "user",
    });

    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new TypeError("resume repository is unavailable");
    const barrier = await plane.sessions.readRunCancelBarrier(
      repository.repositoryId,
      fixture.session.id,
      runId,
    );
    expect(barrier.request).not.toBeNull();
    expect(barrier.binding).not.toBeNull();
    expect(barrier.terminal).not.toBeNull();
    const operations = await plane.operations.list();
    expect(operations.filter((operation) => operation.actionKind === "run.cancel")).toHaveLength(1);
    const resumeOperation = operations.find((operation) => operation.actionKind === "session.resume");
    expect(resumeOperation).toMatchObject({
      state: "completed",
    });
    expect(resumeOperation?.operationId).not.toBe(runId);
  }, 30_000);

  it("reconciles a cancelled resume after the terminal fsync but before barrier close", async () => {
    const fixture = await initialApplicationSession("resume-cancel-close-loss");
    const close = vi.spyOn(SessionRegistry.prototype, "closeRunCancelBarrier");
    close.mockImplementationOnce(async () => {
      throw new Error("injected crash after cancelled terminal before registry close");
    });
    const client = new FakeStreamingChatClient(waitForAbort());
    const hostSigintListeners = new Set<() => void>();
    const runtime = createRuntime({
      controlPlaneStateRoot: fixture.controlPlaneStateRoot,
      createModelBackend: () => client,
      createSessionWriter: V2SessionWriter.create,
      cwd: fixture.cwd,
      env: {},
      onCancel: (listener) => {
        hostSigintListeners.add(listener);
        return () => { hostSigintListeners.delete(listener); };
      },
      randomUUID,
    });
    const output = createMemoryIO();
    const execution = runCli([
      "sessions",
      "resume",
      fixture.session.id,
      "--message",
      "crash after the cancellation terminal",
      "--allow-degraded-resume",
    ], output.io, runtime);
    await vi.waitFor(() => expect(client.calls).toHaveLength(1), { timeout: 15_000 });
    for (const listener of [...hostSigintListeners]) listener();

    expect(await execution, output.readStderr()).toBe(130);
    expect(close).toHaveBeenCalledTimes(2);
    const events = await readStoredSession(fixture.session.path);
    const request = events.findLast((event) => event.type === "session.resume.requested");
    if (request?.type !== "session.resume.requested" || request.data.new_run_id === undefined) {
      throw new TypeError("reconciled resume run is unavailable");
    }
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new TypeError("resume repository is unavailable");
    const barrier = await plane.sessions.readRunCancelBarrier(
      repository.repositoryId,
      fixture.session.id,
      request.data.new_run_id,
    );
    expect(barrier.terminal).not.toBeNull();
    expect((await plane.operations.list()).find((operation) =>
      operation.actionKind === "session.resume"
    )).toMatchObject({ state: "completed" });
  }, 30_000);

  it("rejects a same-sequence/event head with a forged opaque integrity token before dispatch", async () => {
    const fixture = await initialApplicationSession("resume-token-negative");
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new TypeError("repository is unavailable");
    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.repositoryId,
      requestedHead: null,
      sessionId: fixture.session.id,
    });
    const sourceRunId = (await readStoredSession(fixture.session.path)).findLast((event) =>
      event.scope === "run" && event.type === "run.started"
    )?.runId;
    if (sourceRunId === undefined || snapshot.head.publicHead.eventIntegrityToken === null) {
      throw new TypeError("resume source evidence is unavailable");
    }
    const token = snapshot.head.publicHead.eventIntegrityToken;
    const forgedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const dispatch = vi.fn(async () => 0);
    const owner = new CliSessionResumeOwnerPort({ dispatch, runtime: fixture.runtime });
    const applicationCommit = Object.freeze({
      actionKind: "session.resume",
      authorizationDecisionSha256: "a".repeat(64),
      operationId: randomUUID(),
      preparedActionSha256: "b".repeat(64),
      principalId: "local_owner",
      schemaVersion: 1 as const,
    });
    await expect(owner.execute({
      applicationCommit,
      authenticatedMutation: {
        actionIdentitySha256: "c".repeat(64),
        applicationCommit,
        authenticationId: randomUUID(),
        requestId: randomUUID(),
        surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" },
      },
      expectedHead: { ...snapshot.head.publicHead, eventIntegrityToken: forgedToken },
      payload: { allowDegradedResume: true },
      repositoryId: repository.repositoryId,
      runLifecycle: { activate: async () => { throw new Error("must not activate"); } },
      sessionId: fixture.session.id,
      sourceRunId,
    })).rejects.toMatchObject({ code: "resume_stale_projection" });
    expect(dispatch).not.toHaveBeenCalled();
  }, 30_000);

  it("strictly rejects duplicate JSON keys in raw resume evidence before dispatch", async () => {
    const fixture = await initialApplicationSession("resume-strict-json-negative");
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new TypeError("repository is unavailable");
    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.repositoryId,
      requestedHead: null,
      sessionId: fixture.session.id,
    });
    const stored = await readFile(fixture.session.path, "utf8");
    const lines = stored.slice(0, -1).split("\n");
    const tail = lines.at(-1);
    if (tail === undefined || !tail.startsWith("{")) throw new TypeError("session tail is unavailable");
    lines[lines.length - 1] = `{"schema_version":2,${tail.slice(1)}`;
    await writeFile(fixture.session.path, `${lines.join("\n")}\n`, "utf8");
    const dispatch = vi.fn(async () => 0);
    const owner = new CliSessionResumeOwnerPort({ dispatch, runtime: fixture.runtime });
    const applicationCommit = Object.freeze({
      actionKind: "session.resume",
      authorizationDecisionSha256: "d".repeat(64),
      operationId: randomUUID(),
      preparedActionSha256: "e".repeat(64),
      principalId: "local_owner",
      schemaVersion: 1 as const,
    });
    await expect(owner.execute({
      applicationCommit,
      authenticatedMutation: {
        actionIdentitySha256: "f".repeat(64),
        applicationCommit,
        authenticationId: randomUUID(),
        requestId: randomUUID(),
        surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" },
      },
      expectedHead: snapshot.head.publicHead,
      payload: { allowDegradedResume: true },
      repositoryId: repository.repositoryId,
      runLifecycle: { activate: async () => { throw new Error("must not activate"); } },
      sessionId: fixture.session.id,
      sourceRunId: randomUUID(),
    })).rejects.toThrow(/duplicate object key/u);
    expect(dispatch).not.toHaveBeenCalled();
  }, 30_000);

  it("returns a typed TUI outcome while the Phase 9 port owns the exact composite effects", async () => {
    const fixture = await initialApplicationSession("resume-tui");
    const output = createMemoryIO();

    const resumed = await executeSessionResumeThroughRuntimeAdapter({
      io: output.io,
      phase9: createSessionsResumePhase9ExecutionPort(fixture.runtime, output.io),
      request: {
        allowDegradedResume: true,
        inputSurface: "tui",
        message: "continue through the TUI adapter",
        sessionId: fixture.session.id,
      },
      runtime: fixture.runtime,
    });
    expect(resumed.exitCode, output.readStderr()).toBe(0);
    expect(resumed).toMatchObject({
      diagnostic: null,
      envelope: {
        result: {
          exitCode: 0,
          resumeMode: "canonical_degraded",
          terminal: "run.completed",
        },
        status: "ok",
      },
    });

    expect(output.readStdout()).toContain("Resume mode: canonical_degraded");
    expect(output.readStdout()).toContain("Pending effects: none");
    expect(output.readStderr()).toContain(`Resume session ${fixture.session.id} from its exact durable head.`);
    expect(fixture.createModelBackend).toHaveBeenCalledTimes(2);

    const events = await readStoredSession(fixture.session.path);
    const request = events.find((event) => event.type === "session.resume.requested");
    expect(request?.data).toMatchObject({
      application_commit: { action_kind: "session.resume" },
      message: "continue through the TUI adapter",
    });
    if (request?.type !== "session.resume.requested" || request.data.application_commit === undefined) {
      throw new Error("application resume request is unavailable");
    }
    const started = events.find((event) =>
      event.scope === "run" &&
      event.type === "run.started" &&
      event.runId === request.data.new_run_id
    );
    expect(started?.data).toMatchObject({
      application_commit: request.data.application_commit,
      resume_of_run_id: request.data.source_run_id,
    });

    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("query-only plane must not launch"); } },
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const operation = (await plane.operations.list()).find((candidate) => candidate.actionKind === "session.resume");
    expect(operation).toMatchObject({
      primaryDomainRecord: { recordId: request.eventId },
      state: "completed",
    });
    expect(operation?.underlyingOperationRefs.map((reference) => reference.recordId)).toEqual([
      started?.eventId,
      events.find((event) =>
        event.scope === "run" &&
        event.runId === request.data.new_run_id &&
        ["run.budget_exceeded", "run.cancelled", "run.completed", "run.failed", "run.incomplete"].includes(event.type)
      )?.eventId,
    ]);
  }, 30_000);

  it("rejects a stale TUI projection as typed data without dispatching or rendering a CLI error", async () => {
    const fixture = await initialApplicationSession("resume-tui-stale");
    const output = createMemoryIO();
    const execute = vi.fn<SessionResumePhase9ExecutionPortV1["execute"]>(async () => 0);

    const resumed = await executeSessionResumeThroughRuntimeAdapter({
      io: output.io,
      phase9: Object.freeze({ execute }),
      request: {
        allowDegradedResume: true,
        expectedSessionSeq: Number.MAX_SAFE_INTEGER,
        inputSurface: "tui",
        message: undefined,
        sessionId: fixture.session.id,
      },
      runtime: fixture.runtime,
    });

    expect(resumed).toMatchObject({
      diagnostic: { code: "control_stale_projection" },
      envelope: { status: "rejected" },
      exitCode: 2,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(output.readStderr()).toBe("");
  }, 30_000);

  it("blocks replay after a durable request-before-launch crash prefix", async () => {
    const fixture = await initialApplicationSession("resume-crash");
    let orphanRunId: string | undefined;
    const execute = vi.fn<SessionResumeOwnerPortV1["execute"]>(async (input) => {
      orphanRunId = fixture.runtime.randomUUID();
      const writer = await V2SessionWriter.openExisting(fixture.cwd, input.sessionId);
      try {
        await writer.appendPhase21SessionResumeRequested(input.applicationCommit.operationId, {
          application_commit: {
            action_kind: input.applicationCommit.actionKind,
            authorization_decision_sha256: input.applicationCommit.authorizationDecisionSha256,
            operation_id: input.applicationCommit.operationId,
            prepared_action_sha256: input.applicationCommit.preparedActionSha256,
            principal_id: input.applicationCommit.principalId,
            schema_version: 1,
          },
          approval_request_ids: [],
          message: "crash after durable request",
          new_run_id: orphanRunId,
          requested_mode: "canonical_degraded",
          source_run_id: input.sourceRunId,
        });
      } finally {
        await writer.close();
      }
      throw Object.assign(new Error("injected loss after request and before launch"), {
        code: "resume_request_without_start",
      });
    });
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("message launch must not run"); } },
      sessionResumeOwner: Object.freeze({ execute }),
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new Error("registered repository is unavailable");
    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.repositoryId,
      requestedHead: null,
      sessionId: fixture.session.id,
    });
    const payload = Object.freeze({ allowDegradedResume: true, message: "crash after durable request" });
    const context = plane.context("tui", fixture.runtime.randomUUID());
    const prepared = await plane.actions.prepare(context, {
      actionKind: "session.resume",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "phase21a.resume.crash.prepare",
      requestId: fixture.runtime.randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: snapshot.resourceScope,
      },
    });
    expect(prepared.status, prepared.error?.message).toBe("ok");
    if (prepared.result === null) throw new Error("resume prepare failed");
    const commitRequest = Object.freeze({
      idempotencyKey: "phase21a.resume.crash.commit",
      preparedActionId: prepared.result.prepared.preparedActionId,
      preparedActionSha256: prepared.result.prepared.preparedActionSha256,
      requestId: fixture.runtime.randomUUID(),
      schemaVersion: 1 as const,
    });

    const crashed = await plane.actions.commit(context, commitRequest);
    expect(crashed).toMatchObject({
      error: { code: "control_operation_busy" },
      status: "rejected",
    });
    expect(execute).toHaveBeenCalledOnce();
    const operation = (await plane.operations.list()).find((candidate) => candidate.actionKind === "session.resume");
    expect(operation).toMatchObject({
      errorCode: "control_action_reconcile_incomplete",
      state: "blocked_unknown_effect",
    });

    const replayed = await plane.actions.commit(context, {
      ...commitRequest,
      requestId: fixture.runtime.randomUUID(),
    });
    expect(replayed).toMatchObject({
      error: { code: "control_operation_busy" },
      operationId: operation?.operationId,
      status: "rejected",
    });
    expect(execute).toHaveBeenCalledOnce();

    const events = await readStoredSession(fixture.session.path);
    const requests = events.filter((event) => event.type === "session.resume.requested");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.eventId).toBe(operation?.operationId);
    expect(events.some((event) =>
      event.scope === "run" && event.type === "run.started" && event.runId === orphanRunId
    )).toBe(false);
  }, 30_000);

  it("reconciles a complete exact resume prefix without invoking the owner twice", async () => {
    const fixture = await initialApplicationSession("resume-reconcile");
    let resumedRunId: string | undefined;
    const execute = vi.fn<SessionResumeOwnerPortV1["execute"]>(async (input) => {
      resumedRunId = fixture.runtime.randomUUID();
      const writer = await V2SessionWriter.openExisting(fixture.cwd, input.sessionId);
      try {
        const persistedCommit = {
          action_kind: input.applicationCommit.actionKind,
          authorization_decision_sha256: input.applicationCommit.authorizationDecisionSha256,
          operation_id: input.applicationCommit.operationId,
          prepared_action_sha256: input.applicationCommit.preparedActionSha256,
          principal_id: input.applicationCommit.principalId,
          schema_version: 1 as const,
        };
        await writer.appendPhase21SessionResumeRequested(input.applicationCommit.operationId, {
          application_commit: persistedCommit,
          approval_request_ids: [],
          message: "recover complete resume evidence",
          new_run_id: resumedRunId,
          requested_mode: "canonical_degraded",
          source_run_id: input.sourceRunId,
        });
        const publisher = new EventPublisher({
          randomUUID: fixture.runtime.randomUUID,
          renderer: { render: () => undefined },
          runId: resumedRunId,
          sessionId: input.sessionId,
          timestamp: fixture.runtime.timestamp,
          writer,
        });
        await publisher.publish({
          data: {
            application_commit: persistedCommit,
            command: "agent",
            input: { role: "user", text: "recover complete resume evidence" },
            max_duration_ms: 1_000,
            max_steps: 1,
            max_tokens: 100,
            max_tool_output_bytes: 1_024,
            model: "phase21a-resume-reconcile",
            provider: "ollama",
            request_timeout_ms: 1_000,
            resume_mode: "canonical_degraded",
            resume_of_run_id: input.sourceRunId,
            tools: [],
            tools_enabled: true,
            workspace: fixture.cwd,
            workspace_fingerprint: "a".repeat(64),
          },
          type: "run.started",
        });
        await publisher.publish({
          data: {
            adapter: "phase21a-resume-reconcile",
            adapter_version: "1",
            capabilities: {
              cancellation: "abort_signal",
              reasoning: "none",
              streaming: true,
              tools: "strict",
              usage: "complete",
            },
            config_fingerprint: "b".repeat(64),
            model: "phase21a-resume-reconcile",
            provider: "ollama",
            resume_capability: "canonical_only",
          },
          type: "backend.selected",
        });
        await publisher.publish({
          data: {
            category: "internal",
            code: "injected_response_loss",
            duration_ms: 1,
            message: "terminal persisted before response loss",
            retryable: false,
          },
          type: "run.failed",
        });
      } finally {
        await writer.close();
      }
      throw Object.assign(new Error("injected response loss after exact terminal"), {
        code: "resume_owner_active",
      });
    });
    const plane = await createPhase21ALocalControlPlane({
      launcher: { launch: async () => { throw new Error("message launch must not run"); } },
      sessionResumeOwner: Object.freeze({ execute }),
      stateRoot: fixture.controlPlaneStateRoot,
    });
    const repository = (await plane.repositories.list())[0];
    if (repository === undefined) throw new Error("registered repository is unavailable");
    const snapshot = await plane.sessionProjection.read({
      repositoryId: repository.repositoryId,
      requestedHead: null,
      sessionId: fixture.session.id,
    });
    const payload = Object.freeze({ allowDegradedResume: true, message: "recover complete resume evidence" });
    const context = plane.context("cli", fixture.runtime.randomUUID());
    const prepared = await plane.actions.prepare(context, {
      actionKind: "session.resume",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "phase21a.resume.reconcile.prepare",
      requestId: fixture.runtime.randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: snapshot.resourceScope,
      },
    });
    expect(prepared.status, prepared.error?.message).toBe("ok");
    if (prepared.result === null) throw new Error("resume prepare failed");

    const committed = await plane.actions.commit(context, {
      idempotencyKey: "phase21a.resume.reconcile.commit",
      preparedActionId: prepared.result.prepared.preparedActionId,
      preparedActionSha256: prepared.result.prepared.preparedActionSha256,
      requestId: fixture.runtime.randomUUID(),
      schemaVersion: 1,
    });
    expect(committed).toMatchObject({
      result: {
        exitCode: 1,
        newRunId: resumedRunId,
        resumeMode: "canonical_degraded",
        terminal: "run.failed",
      },
      status: "ok",
    });
    expect(execute).toHaveBeenCalledOnce();
    const operation = (await plane.operations.list()).find((candidate) => candidate.actionKind === "session.resume");
    expect(operation).toMatchObject({ state: "completed" });
    expect(operation?.underlyingOperationRefs).toHaveLength(2);
  }, 30_000);
});
