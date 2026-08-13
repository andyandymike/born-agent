import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import type {
  ApplicationPaginationCursorV1,
  AuthenticatedCallContextV1,
  DeliveryCursorV1,
  ExpectedResourceVersionV1,
  SessionLedgerHeadV1,
} from "../../src/control-plane/application-protocol.js";
import {
  createPhase21ALocalControlPlane,
  type Phase21ALocalControlPlane,
} from "../../src/control-plane/local-control-plane.js";
import {
  contextForRuntime,
  planeForRuntime,
} from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

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

type SessionScope = Readonly<{
  kind: "session";
  repositoryId: string;
  sessionId: string;
  teamId: null;
}>;

async function fixture(): Promise<Readonly<{
  broker: SessionOwnerBroker;
  context: AuthenticatedCallContextV1;
  plane: Phase21ALocalControlPlane;
  scope: SessionScope;
  stateRoot: string;
  zeroHead: SessionLedgerHeadV1;
  zeroScope: SessionScope;
}>> {
  const stateRoot = await directory("bornagent-phase21a-delivery-state-");
  const repositoryRoot = await directory("bornagent-phase21a-delivery-repository-");
  const broker = new SessionOwnerBroker();
  const plane = await createPhase21ALocalControlPlane({
    broker,
    launcher: { launch: () => Promise.reject(new Error("delivery test must not launch a run")) },
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
  const zero = await plane.sessions.create({
    expectedHead: created.head,
    operationId: randomUUID(),
    repositoryId: repository.registration.repositoryId,
  });
  const scope = Object.freeze({
    kind: "session" as const,
    repositoryId: repository.registration.repositoryId,
    sessionId: created.entry.sessionId,
    teamId: null,
  });
  const zeroScope = Object.freeze({
    kind: "session" as const,
    repositoryId: repository.registration.repositoryId,
    sessionId: zero.entry.sessionId,
    teamId: null,
  });
  const writer = await V2SessionWriter.createNew(repositoryRoot, created.entry.sessionId);
  cleanup.push(() => writer.close().catch(() => undefined));
  const runId = randomUUID();
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId,
    sessionId: created.entry.sessionId,
    timestamp: () => "2026-08-12T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "agent",
      input: { role: "user", text: "verify contiguous delivery" },
      max_duration_ms: 10_000,
      max_steps: 1,
      max_tokens: 100,
      max_tool_output_bytes: 1_024,
      model: "phase21a-delivery",
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
      adapter: "phase21a-delivery",
      adapter_version: "1",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "a".repeat(64),
      model: "phase21a-delivery",
      provider: "ollama",
    },
    type: "backend.selected",
  });
  const release = broker.register(
    created.entry.sessionId,
    plane.sessionProjection.activeReadPort({ entry: created.entry, writer }),
  );
  cleanup.push(release);
  return Object.freeze({
    broker,
    context: plane.context("cli", "phase21a-delivery-client"),
    plane,
    scope,
    stateRoot,
    zeroHead: zero.entry.initialLedgerHead,
    zeroScope,
  });
}

async function eventsPage(
  plane: Phase21ALocalControlPlane,
  context: AuthenticatedCallContextV1,
  scope: SessionScope,
  input: Readonly<{
    atVersion?: ExpectedResourceVersionV1 | null;
    deliveryCursor?: DeliveryCursorV1 | null;
    pageCursor?: ApplicationPaginationCursorV1 | null;
  }> = {},
) {
  return plane.queries.query(context, {
    atVersion: input.atVersion ?? null,
    deliveryCursor: input.deliveryCursor ?? null,
    pageCursor: input.pageCursor ?? null,
    payload: { limit: 1 },
    queryKind: "session.events_page",
    requestId: randomUUID(),
    resourceScope: scope,
    schemaVersion: 1,
  });
}

async function fullView(
  plane: Phase21ALocalControlPlane,
  context: AuthenticatedCallContextV1,
  scope: SessionScope,
) {
  return plane.queries.query(context, {
    atVersion: null,
    pageCursor: null,
    payload: {},
    queryKind: "session.view",
    requestId: randomUUID(),
    resourceScope: scope,
    schemaVersion: 1,
  });
}

async function prepareMessage(
  plane: Phase21ALocalControlPlane,
  context: AuthenticatedCallContextV1,
  scope: SessionScope,
  head: SessionLedgerHeadV1,
  key: string,
) {
  const payload = { command: "agent" as const, task: "delivery-gated mutation", verbose: false };
  return plane.actions.prepare(context, {
    actionKind: "session.message.submit",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: key,
    requestId: randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: scope,
    },
  });
}

describe("Phase 21A application delivery integration", () => {
  it("keeps a gap freeze across command-scoped application facades in one Host process", async () => {
    const stateRoot = await directory("bornagent-phase21a-shared-delivery-state-");
    const repositoryRoot = await directory("bornagent-phase21a-shared-delivery-repository-");
    const runtime = createRuntime({ controlPlaneStateRoot: stateRoot, cwd: repositoryRoot });
    const firstPlane = await planeForRuntime(runtime, createMemoryIO().io);
    const context = contextForRuntime(firstPlane, runtime, "tui");
    const sessionId = randomUUID();
    const cursor = firstPlane.delivery.installFullSnapshot(context, {
      head: Object.freeze({
        eventId: randomUUID(),
        eventIntegrityToken: `slh_v1_${"a".repeat(43)}`,
        schemaVersion: 1,
        sequence: 1,
        sessionId,
      }),
      rawEventSha256: "a".repeat(64),
    });
    expect(() => firstPlane.delivery.deliverEventPage(context, {
      continuationCursor: Object.freeze({ ...cursor, afterEventId: randomUUID() }),
      events: Object.freeze([]),
      sessionId,
    })).toThrow(expect.objectContaining({ code: "control_resync_required" }));

    const nextCommandPlane = await planeForRuntime(runtime, createMemoryIO().io);
    expect(nextCommandPlane).toBe(firstPlane);
    expect(nextCommandPlane.delivery).toBe(firstPlane.delivery);
    expect(() => nextCommandPlane.delivery.assertMutationAllowed(context, sessionId))
      .toThrow(expect.objectContaining({ code: "control_resync_required" }));
  });

  it("returns non-null zero/tail cursors and accepts normal pages plus an exact duplicate", async () => {
    const { context, plane, scope, zeroScope } = await fixture();
    const zero = await fullView(plane, context, zeroScope);
    expect(zero.deliveryCursor).toMatchObject({
      afterEventId: null,
      afterEventIntegrityToken: null,
      afterSequence: 0,
      sessionId: zeroScope.sessionId,
    });
    expect(zero.projectionIdentity?.ledgerHead).toEqual(zero.ledgerHead);

    const first = await eventsPage(plane, context, scope);
    expect(first).toMatchObject({
      deliveryCursor: { afterSequence: 1, sessionId: scope.sessionId },
      status: "ok",
    });
    expect(first.result?.nextPageCursor).not.toBeNull();
    expect(first.projectionIdentity?.ledgerHead).toEqual(first.ledgerHead);
    expect(first.liveObservation).toBeNull();

    const duplicate = await eventsPage(plane, context, scope, {
      deliveryCursor: first.deliveryCursor,
    });
    expect(duplicate.status).toBe("ok");
    expect(duplicate.deliveryCursor).toEqual(first.deliveryCursor);

    const second = await eventsPage(plane, context, scope, {
      atVersion: first.resourceVersion,
      deliveryCursor: first.deliveryCursor,
      pageCursor: first.result!.nextPageCursor,
    });
    expect(second).toMatchObject({
      deliveryCursor: { afterSequence: 2, sessionId: scope.sessionId },
      ledgerHead: { sequence: 2 },
      status: "ok",
    });
    expect(second.deliveryCursor).toMatchObject({
      afterEventId: second.ledgerHead?.eventId,
      afterEventIntegrityToken: second.ledgerHead?.eventIntegrityToken,
      deliveryGeneration: first.deliveryCursor?.deliveryGeneration,
    });
    expect(second.projectionIdentity?.projectionSha256).toBe(first.projectionIdentity?.projectionSha256);
  });

  it("freezes only the affected client/session on gaps or tamper and full view thaws it", async () => {
    const { context, plane, scope, zeroHead, zeroScope } = await fixture();
    const first = await eventsPage(plane, context, scope);
    const preparedBeforeFreeze = await prepareMessage(
      plane,
      context,
      scope,
      first.ledgerHead!,
      "prepared-before-freeze",
    );
    expect(preparedBeforeFreeze.status).toBe("ok");
    const gapContext = plane.context("tui", "phase21a-gap-client");
    const gap = await eventsPage(plane, gapContext, scope, {
      atVersion: first.resourceVersion,
      pageCursor: first.result!.nextPageCursor,
    });
    expect(gap).toMatchObject({ error: { code: "control_resync_required" }, status: "resync_required" });
    expect(plane.delivery.stateFor(gapContext, scope.sessionId)).toMatchObject({
      resyncReason: "sequence_gap",
      status: "resync_required",
    });

    const tamperedCursor = Object.freeze({ ...first.deliveryCursor!, afterEventId: randomUUID() });
    const tampered = await eventsPage(plane, context, scope, { deliveryCursor: tamperedCursor });
    expect(tampered).toMatchObject({ error: { code: "control_resync_required" }, status: "resync_required" });
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({
      resyncReason: "event_identity_mismatch",
      status: "resync_required",
    });
    expect(await plane.actions.commit(context, {
      idempotencyKey: "commit-while-frozen",
      preparedActionId: preparedBeforeFreeze.result!.prepared.preparedActionId,
      preparedActionSha256: preparedBeforeFreeze.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    })).toMatchObject({ error: { code: "control_resync_required" }, status: "resync_required" });
    expect(await plane.operations.list()).toHaveLength(0);
    expect(await prepareMessage(plane, context, scope, first.ledgerHead!, "frozen-session"))
      .toMatchObject({ error: { code: "control_resync_required" }, status: "resync_required" });

    const otherClient = plane.context("cli", "phase21a-other-client");
    expect((await prepareMessage(plane, otherClient, scope, first.ledgerHead!, "other-client")).status).toBe("ok");
    expect((await prepareMessage(plane, context, zeroScope, zeroHead, "other-session")).status).toBe("ok");

    const resynced = await fullView(plane, context, scope);
    expect(resynced).toMatchObject({ deliveryCursor: { afterSequence: 2 }, status: "ok" });
    expect(plane.delivery.stateFor(context, scope.sessionId)).toMatchObject({
      resyncReason: null,
      status: "ready",
    });
    expect((await prepareMessage(plane, context, scope, resynced.ledgerHead!, "after-resync")).status).toBe("ok");
  });

  it("changes generation on local-plane restart and requires a full snapshot before mutation", async () => {
    const { broker, context, plane, scope, stateRoot } = await fixture();
    const first = await eventsPage(plane, context, scope);
    const restarted = await createPhase21ALocalControlPlane({
      broker,
      launcher: { launch: () => Promise.reject(new Error("delivery test must not launch a run")) },
      stateRoot,
    });
    expect(restarted.delivery.deliveryGeneration).not.toBe(plane.delivery.deliveryGeneration);
    const restartedContext = restarted.context("cli", context.surface.clientId);
    const oldGeneration = await eventsPage(restarted, restartedContext, scope, {
      atVersion: first.resourceVersion,
      deliveryCursor: first.deliveryCursor,
      pageCursor: first.result!.nextPageCursor,
    });
    expect(oldGeneration).toMatchObject({
      error: { code: "control_resync_required" },
      status: "resync_required",
    });
    expect(restarted.delivery.stateFor(restartedContext, scope.sessionId)).toMatchObject({
      resyncReason: "delivery_generation_changed",
      status: "resync_required",
    });
    expect(await prepareMessage(restarted, restartedContext, scope, first.ledgerHead!, "restart-frozen"))
      .toMatchObject({ status: "resync_required" });

    const snapshot = await fullView(restarted, restartedContext, scope);
    expect(snapshot.deliveryCursor?.deliveryGeneration).toBe(restarted.delivery.deliveryGeneration);
    expect(snapshot.deliveryCursor?.deliveryGeneration).not.toBe(first.deliveryCursor?.deliveryGeneration);
    expect((await prepareMessage(restarted, restartedContext, scope, snapshot.ledgerHead!, "restart-thawed")).status)
      .toBe("ok");
  });
});
