import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationQueryRequestV1 } from "../../src/control-plane/application-protocol.js";
import {
  createPhase21ALocalControlPlane,
  type ActiveSessionWriterObserverFactoryV1,
} from "../../src/control-plane/local-control-plane.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { TuiSessionProjectionPort } from "../../src/tui/tui-session-projection-port.js";

const temporary: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const stateRoot = await directory("bornagent-phase21a-tui-projection-state-");
  const repositoryRoot = await directory("bornagent-phase21a-tui-projection-repository-");
  const broker = new SessionOwnerBroker();
  const plane = await createPhase21ALocalControlPlane({
    broker,
    launcher: { launch: () => Promise.reject(new Error("projection test must not launch a run")) },
    stateRoot,
  });
  const repository = await plane.repositories.register({
    expectedHead: await plane.repositories.head(),
    operationId: randomUUID(),
    root: repositoryRoot,
  });
  const created = await plane.sessions.create({
    expectedHead: await plane.sessions.head(repository.registration.repositoryId),
    operationId: randomUUID(),
    repositoryId: repository.registration.repositoryId,
  });
  const writer = await V2SessionWriter.createNew(repositoryRoot, created.entry.sessionId);
  cleanup.push(() => writer.close().catch(() => undefined));
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: randomUUID(),
    sessionId: created.entry.sessionId,
    timestamp: () => "2026-08-12T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "agent",
      input: { role: "user", text: "Authorization: Bearer local-owner-secret" },
      max_duration_ms: 10_000,
      max_steps: 1,
      max_tokens: 100,
      max_tool_output_bytes: 1_024,
      model: "phase21a-tui",
      provider: "ollama",
      request_timeout_ms: 1_000,
      tools: [],
      tools_enabled: true,
      workspace: repositoryRoot,
    },
    type: "run.started",
  });
  const release = broker.register(
    created.entry.sessionId,
    plane.sessionProjection.activeReadPort({ entry: created.entry, writer }),
  );
  cleanup.push(release);
  const context = plane.context("tui", "phase21a-tui-projection-client");
  const scope = Object.freeze({
    kind: "session" as const,
    repositoryId: repository.registration.repositoryId,
    sessionId: created.entry.sessionId,
    teamId: null,
  });
  return { broker, context, created, plane, publisher, scope, writer };
}

describe("Phase 21A typed TUI session projection", () => {
  it("reads an exact active-owner prefix without projecting an unrelated in-flight tail", async () => {
    const stateRoot = await directory("bornagent-phase21a-prefix-projection-state-");
    const repositoryRoot = await directory("bornagent-phase21a-prefix-projection-repository-");
    const broker = new SessionOwnerBroker();
    const plane = await createPhase21ALocalControlPlane({
      broker,
      launcher: { launch: () => Promise.reject(new Error("prefix projection test must not launch a run")) },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const repositoryId = repository.registration.repositoryId;
    const created = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repositoryId),
      operationId: randomUUID(),
      repositoryId,
    });
    const writer = await V2SessionWriter.createNew(repositoryRoot, created.entry.sessionId);
    cleanup.push(() => writer.close().catch(() => undefined));
    const ownerPort = plane.sessionProjection.activeReadPort({ entry: created.entry, writer });
    const exact = await ownerPort.readStableSnapshot();
    const readStableSnapshot = vi.fn(() => Promise.reject(new Error("newer transient tail must not be projected")));
    const readStablePrefix = vi.fn(() => Promise.resolve(exact));
    cleanup.push(broker.register(created.entry.sessionId, { readStablePrefix, readStableSnapshot }));

    await expect(plane.sessionProjection.read({
      repositoryId,
      requestedHead: exact.head.publicHead,
      sessionId: created.entry.sessionId,
    })).resolves.toMatchObject({ head: { publicHead: exact.head.publicHead } });
    expect(readStablePrefix).toHaveBeenCalledOnce();
    expect(readStableSnapshot).not.toHaveBeenCalled();
  });

  it("publishes a composite owner writer through the broker until its durable close", async () => {
    const stateRoot = await directory("bornagent-phase21a-composite-projection-state-");
    const repositoryRoot = await directory("bornagent-phase21a-composite-projection-repository-");
    const broker = new SessionOwnerBroker();
    const activeWriterObserverFactory: { current?: ActiveSessionWriterObserverFactoryV1 } = {};
    const plane = await createPhase21ALocalControlPlane({
      broker,
      delegationCompositeOwnerFactory: (_signer, observerFactory) => {
        activeWriterObserverFactory.current = observerFactory;
        return Object.freeze({
          execute: () => Promise.reject(new Error("projection lifecycle test must not dispatch Delegation")),
        });
      },
      launcher: { launch: () => Promise.reject(new Error("projection lifecycle test must not launch a run")) },
      stateRoot,
    });
    const repository = await plane.repositories.register({
      expectedHead: await plane.repositories.head(),
      operationId: randomUUID(),
      root: repositoryRoot,
    });
    const repositoryId = repository.registration.repositoryId;
    const created = await plane.sessions.create({
      expectedHead: await plane.sessions.head(repositoryId),
      operationId: randomUUID(),
      repositoryId,
    });
    const writer = await V2SessionWriter.createNew(repositoryRoot, created.entry.sessionId);
    cleanup.push(() => writer.close().catch(() => undefined));
    if (activeWriterObserverFactory.current === undefined) throw new Error("active writer observer factory was not composed");
    const observe = await activeWriterObserverFactory.current({
      repositoryId,
      sessionId: created.entry.sessionId,
    });

    observe(writer);
    expect(broker.activePort(created.entry.sessionId)).not.toBeNull();
    await expect(plane.sessionProjection.read({
      repositoryId,
      requestedHead: null,
      sessionId: created.entry.sessionId,
    })).resolves.toMatchObject({ head: { publicHead: { sequence: 0 } } });

    await writer.close();
    expect(broker.activePort(created.entry.sessionId)).toBeNull();
  });

  it("refreshes an active owner through invalidation and exact typed query prefixes", async () => {
    const { broker, context, plane, publisher, scope } = await fixture();
    const invalidated: string[] = [];
    const stop = broker.subscribeInvalidations((sessionId) => invalidated.push(sessionId));
    cleanup.push(stop);
    let appended = false;
    const port = new TuiSessionProjectionPort({
      context,
      createRequestId: randomUUID,
      delivery: plane.delivery,
      ensureSession: async () => scope,
      queries: {
        query: async (call, request) => {
          const result = await plane.queries.query(call, request);
          if (!appended && request.queryKind === "session.view" && result.status === "ok") {
            appended = true;
            await publisher.publish({
              data: {
                adapter: "phase21a-tui",
                adapter_version: "1",
                capabilities: {
                  cancellation: "abort_signal",
                  reasoning: "none",
                  streaming: true,
                  tools: "strict",
                  usage: "complete",
                },
                config_fingerprint: "a".repeat(64),
                model: "phase21a-tui",
                provider: "ollama",
              },
              type: "backend.selected",
            });
          }
          return result;
        },
      },
      subscribeInvalidations: (listener) => broker.subscribeInvalidations(listener),
    });

    const first = await port.load(scope.sessionId);
    expect(first.ledgerHead.sequence).toBe(1);
    expect(first.events).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain("local-owner-secret");
    expect(JSON.stringify(first)).not.toContain("raw_event_sha256");
    expect(invalidated).toContain(scope.sessionId);

    const refreshed = await port.load(scope.sessionId);
    expect(refreshed.ledgerHead.sequence).toBe(2);
    expect(refreshed.events.map((event) => event.sessionSeq)).toEqual([1, 2]);
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({ status: "ready" });
  });

  it("freezes on a malformed display-page gap and only a full view resync thaws it", async () => {
    const { broker, context, plane, scope } = await fixture();
    let corrupt = true;
    const queries = {
      query: async (call: typeof context, request: ApplicationQueryRequestV1) => {
        const result = await plane.queries.query(call, request);
        if (
          corrupt &&
          request.queryKind === "session.tui_events_page" &&
          result.status === "ok" &&
          result.result !== null
        ) {
          const value = result.result.value as { readonly events: readonly Record<string, unknown>[] };
          return Object.freeze({
            ...result,
            result: Object.freeze({
              ...result.result,
              value: Object.freeze({
                events: Object.freeze(value.events.map((event) => Object.freeze({ ...event, sessionSeq: 2 }))),
              }),
            }),
          });
        }
        return result;
      },
    };
    const port = new TuiSessionProjectionPort({
      context,
      createRequestId: randomUUID,
      delivery: plane.delivery,
      ensureSession: async () => scope,
      queries,
      subscribeInvalidations: (listener) => broker.subscribeInvalidations(listener),
    });

    await expect(port.load(scope.sessionId)).rejects.toMatchObject({ code: "control_resync_required" });
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({ status: "resync_required" });
    expect(() => plane.delivery.assertMutationAllowed(context, scope.sessionId))
      .toThrow(expect.objectContaining({ code: "control_resync_required" }));

    corrupt = false;
    const resynced = await port.load(scope.sessionId);
    expect(resynced.events).toHaveLength(1);
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({
      resyncReason: null,
      status: "ready",
    });
    expect(() => plane.delivery.assertMutationAllowed(context, scope.sessionId)).not.toThrow();
  });

  it("does not freeze delivery when an exact display page is transiently writer-busy", async () => {
    const { broker, context, plane, scope } = await fixture();
    let busy = true;
    const port = new TuiSessionProjectionPort({
      context,
      createRequestId: randomUUID,
      delivery: plane.delivery,
      ensureSession: async () => scope,
      queries: {
        query: async (call, request) => {
          if (busy && request.queryKind === "session.tui_events_page") {
            busy = false;
            return Object.freeze({
              deliveryCursor: null,
              error: Object.freeze({
                code: "control_operation_busy" as const,
                message: "application query rejected (control_operation_busy)",
              }),
              ledgerHead: null,
              liveObservation: null,
              operationId: null,
              projectionIdentity: null,
              requestId: request.requestId,
              resourceScope: request.resourceScope,
              resourceVersion: request.atVersion,
              result: null,
              schemaVersion: 1 as const,
              sessionId: scope.sessionId,
              status: "rejected" as const,
              warnings: Object.freeze([]),
            });
          }
          return plane.queries.query(call, request);
        },
      },
      subscribeInvalidations: (listener) => broker.subscribeInvalidations(listener),
    });

    await expect(port.load(scope.sessionId)).rejects.toMatchObject({ code: "control_operation_busy" });
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({ status: "ready" });
    expect(() => plane.delivery.assertMutationAllowed(context, scope.sessionId)).not.toThrow();

    await expect(port.load(scope.sessionId)).resolves.toMatchObject({ ledgerHead: { sequence: 1 } });
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({ status: "ready" });
  });
});
