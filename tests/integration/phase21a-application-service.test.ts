import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { ApplicationActionRegistry } from "../../src/control-plane/application-action-registry.js";
import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { LocalOwnerPrincipalAuthority } from "../../src/control-plane/local-owner-principal.js";
import { PreparedActionStore } from "../../src/control-plane/prepared-action-store.js";
import { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { createCatalogActionRegistry } from "../../src/control-plane/use-cases/catalog-actions.js";
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

async function fixture() {
  const authority = await loadOrCreateHostControlAuthority({ root: await directory("bornagent-phase21a-service-") });
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
  const sessions = new SessionRegistry(authority.paths, repositories);
  const journal = new ControlOperationJournal(authority.paths);
  const service = new DefaultAgentRunApplicationService({
    actions: createCatalogActionRegistry({ repositories, sessions }),
    artifacts,
    createRequestId: randomUUID,
    delivery: new SessionDeliveryCoordinator(),
    hostRuntime: createNodeApplicationHostRuntime(),
    journal,
    preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
    principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
  });
  const context = {
    principal: authority.localOwner,
    surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const },
  };
  return { artifacts, authority, context, journal, repositories, service, sessions };
}

describe("Phase 21A application prepare/commit service", () => {
  it("registers a repository exactly once and replays K2 from the same operation", async () => {
    const { context, journal, repositories, service } = await fixture();
    const root = await directory("bornagent-phase21a-service-repo-");
    const head = await repositories.head();
    const payload = { root };
    const prepared = await service.prepare(context, {
      actionKind: "repository.register",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "prepare-repository",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
        kind: "new_repository",
      },
    });
    expect(prepared.status).toBe("ok");
    expect(await repositories.list()).toHaveLength(0);
    const exact = prepared.result!;
    const committed = await service.commit(context, {
      idempotencyKey: "K1",
      preparedActionId: exact.prepared.preparedActionId,
      preparedActionSha256: exact.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(committed.status).toBe("ok");
    expect(committed.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await repositories.list()).toHaveLength(1);
    expect((await journal.read(committed.operationId!))?.state).toBe("completed");

    const replayed = await service.commit(
      { ...context, surface: { ...context.surface, connectionId: randomUUID() } },
      {
        idempotencyKey: "K2",
        preparedActionId: exact.prepared.preparedActionId,
        preparedActionSha256: exact.prepared.preparedActionSha256,
        requestId: randomUUID(),
        schemaVersion: 1,
      },
    );
    expect(replayed.status).toBe("ok");
    expect(replayed.operationId).toBe(committed.operationId);
    expect(replayed.result).toEqual(committed.result);
    expect(await repositories.list()).toHaveLength(1);
  });

  it("registers a second repository against the complete non-zero catalog head", async () => {
    const { context, repositories, service } = await fixture();
    const roots = [
      await directory("bornagent-phase21a-service-first-repo-"),
      await directory("bornagent-phase21a-service-second-repo-"),
    ];
    for (const [index, root] of roots.entries()) {
      const head = await repositories.head();
      const payload = { root };
      const prepared = await service.prepare(context, {
        actionKind: "repository.register",
        payload,
        payloadSha256: sha256Canonical(payload),
        prepareIdempotencyKey: `prepare-repository-${String(index + 1)}`,
        requestId: randomUUID(),
        schemaVersion: 1,
        target: {
          catalogScope: repositories.resourceScope,
          expectedCatalogVersion: {
            kind: "revision",
            revision: head.revision,
            sha256: head.catalogSha256,
          },
          kind: "new_repository",
        },
      });
      expect(prepared.status, prepared.error?.message).toBe("ok");
      const committed = await service.commit(context, {
        idempotencyKey: `commit-repository-${String(index + 1)}`,
        preparedActionId: prepared.result!.prepared.preparedActionId,
        preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
        requestId: randomUUID(),
        schemaVersion: 1,
      });
      expect(committed.status, committed.error?.message).toBe("ok");
    }
    const registered = await repositories.list();
    expect(registered).toHaveLength(2);
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
    await expect(Promise.all(registered.map((entry) => repositories.readRoot(entry))))
      .resolves.toEqual(canonicalRoots);
  });

  it("creates a zero-head session without materializing an empty JSONL", async () => {
    const { context, repositories, service, sessions } = await fixture();
    const root = await directory("bornagent-phase21a-service-session-");
    const repositoryHead = await repositories.head();
    const repositoryPrepare = await service.prepare(context, {
      actionKind: "repository.register",
      payload: { root },
      payloadSha256: sha256Canonical({ root }),
      prepareIdempotencyKey: "repository",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision", revision: 0, sha256: repositoryHead.catalogSha256 },
        kind: "new_repository",
      },
    });
    const repositoryCommit = await service.commit(context, {
      idempotencyKey: "repository-commit",
      preparedActionId: repositoryPrepare.result!.prepared.preparedActionId,
      preparedActionSha256: repositoryPrepare.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(repositoryCommit.status).toBe("ok");
    const repositoryId = repositoryCommit.resourceScope?.kind === "repository"
      ? repositoryCommit.resourceScope.repositoryId
      : "";
    const sessionHead = await sessions.head(repositoryId);
    const sessionPrepare = await service.prepare(context, {
      actionKind: "session.create",
      payload: {},
      payloadSha256: sha256Canonical({}),
      prepareIdempotencyKey: "session",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: sessions.resourceScope(repositoryId),
        expectedCatalogVersion: { kind: "revision", revision: 0, sha256: sessionHead.catalogSha256 },
        kind: "new_session",
      },
    });
    const sessionCommit = await service.commit(context, {
      idempotencyKey: "session-commit",
      preparedActionId: sessionPrepare.result!.prepared.preparedActionId,
      preparedActionSha256: sessionPrepare.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(sessionCommit.status).toBe("ok");
    expect(sessionCommit.ledgerHead).toMatchObject({ sequence: 0, eventId: null });
    expect(sessionCommit.sessionId).toBeTruthy();
    await expect(access(join(root, ".bornagent", "sessions", `${sessionCommit.sessionId!}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a stale prepared target before accepting an operation", async () => {
    const { context, journal, repositories, service } = await fixture();
    const firstRoot = await directory("bornagent-phase21a-stale-first-");
    const secondRoot = await directory("bornagent-phase21a-stale-second-");
    const head = await repositories.head();
    const prepare = async (key: string, root: string) => service.prepare(context, {
      actionKind: "repository.register",
      payload: { root },
      payloadSha256: sha256Canonical({ root }),
      prepareIdempotencyKey: key,
      requestId: randomUUID(),
      schemaVersion: 1 as const,
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision" as const, revision: 0, sha256: head.catalogSha256 },
        kind: "new_repository" as const,
      },
    });
    const [first, stale] = await Promise.all([prepare("first", firstRoot), prepare("stale", secondRoot)]);
    await service.commit(context, {
      idempotencyKey: "first",
      preparedActionId: first.result!.prepared.preparedActionId,
      preparedActionSha256: first.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    const denied = await service.commit(context, {
      idempotencyKey: "stale",
      preparedActionId: stale.result!.prepared.preparedActionId,
      preparedActionSha256: stale.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1,
    });
    expect(denied).toMatchObject({ status: "rejected", error: { code: "control_stale_projection" } });
    expect(await journal.list()).toHaveLength(1);
  });

  it("allows only one service instance to execute a claimed operation", async () => {
    const authority = await loadOrCreateHostControlAuthority({ root: await directory("bornagent-phase21a-driver-") });
    const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
    const sessions = new SessionRegistry(authority.paths, repositories);
    const base = createCatalogActionRegistry({ repositories, sessions }).get("repository.register");
    let executions = 0;
    let releaseExecution: (() => void) | undefined;
    const executionReleased = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let markStarted: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const actions = new ApplicationActionRegistry([{
      ...base,
      effectClass: "runtime_effect",
      execute: async (...args) => {
        executions += 1;
        markStarted?.();
        await executionReleased;
        return base.execute(...args);
      },
    }]);
    const principalAuthority = new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes);
    const createService = () => new DefaultAgentRunApplicationService({
      actions,
      artifacts,
      createRequestId: randomUUID,
      delivery: new SessionDeliveryCoordinator(),
      hostRuntime: createNodeApplicationHostRuntime(),
      journal: new ControlOperationJournal(authority.paths),
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority,
    });
    const firstService = createService();
    const secondService = createService();
    const context = {
      principal: authority.localOwner,
      surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const },
    };
    const root = await directory("bornagent-phase21a-driver-repo-");
    const head = await repositories.head();
    const payload = { root };
    const prepared = await firstService.prepare(context, {
      actionKind: "repository.register",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "driver-prepare",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
        kind: "new_repository",
      },
    });
    const request = {
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      schemaVersion: 1 as const,
    };
    const firstCommit = firstService.commit(context, { ...request, idempotencyKey: "K1", requestId: randomUUID() });
    await executionStarted;
    const concurrent = await secondService.commit(context, { ...request, idempotencyKey: "K2", requestId: randomUUID() });
    expect(concurrent).toMatchObject({ status: "rejected", error: { code: "control_operation_busy" } });
    expect(executions).toBe(1);
    releaseExecution?.();
    const completed = await firstCommit;
    expect(completed).toMatchObject({ status: "ok" });
    expect((await new ControlOperationJournal(authority.paths).read(completed.operationId!))?.operationRevision).toBe(8);
    expect(await repositories.list()).toHaveLength(1);
  });

  it("never completes a stale same-root catalog operation from another operation's dedup", async () => {
    const { artifacts, authority, context, journal, repositories, sessions } = await fixture();
    const base = createCatalogActionRegistry({ repositories, sessions }).get("repository.register");
    let arrivals = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const actions = new ApplicationActionRegistry([{
      ...base,
      execute: async (...args) => {
        arrivals += 1;
        if (arrivals === 2) release?.();
        await gate;
        return base.execute(...args);
      },
    }]);
    const service = new DefaultAgentRunApplicationService({
      actions,
      artifacts,
      createRequestId: randomUUID,
      delivery: new SessionDeliveryCoordinator(),
      hostRuntime: createNodeApplicationHostRuntime(),
      journal,
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
    });
    const root = await directory("bornagent-phase21a-service-same-root-");
    const head = await repositories.head();
    const prepare = (key: string) => service.prepare(context, {
      actionKind: "repository.register",
      payload: { root },
      payloadSha256: sha256Canonical({ root }),
      prepareIdempotencyKey: key,
      requestId: randomUUID(),
      schemaVersion: 1 as const,
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision" as const, revision: head.revision, sha256: head.catalogSha256 },
        kind: "new_repository" as const,
      },
    });
    const [left, right] = await Promise.all([prepare("same-root-left"), prepare("same-root-right")]);
    const commit = (prepared: typeof left, key: string) => service.commit(context, {
      idempotencyKey: key,
      preparedActionId: prepared.result!.prepared.preparedActionId,
      preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
      requestId: randomUUID(),
      schemaVersion: 1 as const,
    });
    const results = await Promise.all([commit(left, "same-root-left"), commit(right, "same-root-right")]);

    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "control_operation_busy")).toHaveLength(1);
    expect(await repositories.list()).toHaveLength(1);
    const loser = results.find((result) => result.status !== "ok");
    expect((await journal.read(loser!.operationId!))?.state).not.toBe("completed");
  });

  it("reconciles exact catalog records after repository, session, and legacy-adoption response loss", async () => {
    const { artifacts, authority, context, journal, repositories, sessions } = await fixture();
    const root = await directory("bornagent-phase21a-catalog-response-loss-");
    const catalog = createCatalogActionRegistry({ repositories, sessions });
    const actions = new ApplicationActionRegistry([
      "repository.register",
      "session.create",
      "session.adopt_legacy",
    ].map((kind) => {
      const base = catalog.get(kind);
      return {
        ...base,
        execute: async (...args: Parameters<typeof base.execute>) => {
          await base.execute(...args);
          if (kind === "session.adopt_legacy") {
            const payload = args[1] as Readonly<{ readonly sessionId?: unknown }>;
            if (typeof payload.sessionId !== "string") throw new TypeError("legacy session payload is unavailable");
            const writer = await V2SessionWriter.openExisting(root, payload.sessionId);
            try {
              await writer.appendTaskEvent("goal.created", {
                goal_id: randomUUID(),
                objective: "Tail appended after the adoption commit",
                origin: { input_surface: "cli", kind: "user" },
                parent_goal_id: null,
                replaces_active_goal: null,
                revision: 1,
              });
            } finally {
              await writer.close();
            }
          }
          throw new Error(`injected ${kind} response loss`);
        },
      };
    }));
    const service = new DefaultAgentRunApplicationService({
      actions,
      artifacts,
      createRequestId: randomUUID,
      delivery: new SessionDeliveryCoordinator(),
      hostRuntime: createNodeApplicationHostRuntime(),
      journal,
      preparedActions: new PreparedActionStore(authority.integrityKey, authority.paths),
      principalAuthority: new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes),
    });
    const prepareAndCommit = async (input: {
      readonly actionKind: string;
      readonly key: string;
      readonly payload: unknown;
      readonly target: Parameters<typeof service.prepare>[1]["target"];
    }) => {
      const prepared = await service.prepare(context, {
        actionKind: input.actionKind,
        payload: input.payload,
        payloadSha256: sha256Canonical(input.payload),
        prepareIdempotencyKey: `${input.key}-prepare`,
        requestId: randomUUID(),
        schemaVersion: 1,
        target: input.target,
      });
      expect(prepared.status, prepared.error?.message).toBe("ok");
      const committed = await service.commit(context, {
        idempotencyKey: `${input.key}-commit`,
        preparedActionId: prepared.result!.prepared.preparedActionId,
        preparedActionSha256: prepared.result!.prepared.preparedActionSha256,
        requestId: randomUUID(),
        schemaVersion: 1,
      });
      expect(committed.status, committed.error?.message).toBe("ok");
      const operation = await journal.read(committed.operationId!);
      expect(operation).toMatchObject({ state: "completed" });
      expect(operation?.primaryDomainRecord).not.toBeNull();
      expect(operation?.domainRecordRefs).toContainEqual(operation?.primaryDomainRecord);
      return committed;
    };

    const repositoryHead = await repositories.head();
    const repository = await prepareAndCommit({
      actionKind: "repository.register",
      key: "response-loss-repository",
      payload: { root },
      target: {
        catalogScope: repositories.resourceScope,
        expectedCatalogVersion: {
          kind: "revision",
          revision: repositoryHead.revision,
          sha256: repositoryHead.catalogSha256,
        },
        kind: "new_repository",
      },
    });
    if (repository.resourceScope?.kind !== "repository") throw new TypeError("repository recovery result is invalid");
    const repositoryId = repository.resourceScope.repositoryId;

    const sessionHead = await sessions.head(repositoryId);
    await prepareAndCommit({
      actionKind: "session.create",
      key: "response-loss-session",
      payload: {},
      target: {
        catalogScope: sessions.resourceScope(repositoryId),
        expectedCatalogVersion: {
          kind: "revision",
          revision: sessionHead.revision,
          sha256: sessionHead.catalogSha256,
        },
        kind: "new_session",
      },
    });

    const legacySessionId = randomUUID();
    const writer = await V2SessionWriter.createNew(root, legacySessionId);
    await writer.appendTaskEvent("goal.created", {
      goal_id: randomUUID(),
      objective: "Recover legacy adoption after response loss",
      origin: { input_surface: "cli", kind: "user" },
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    await writer.close();
    const adoptionHead = await sessions.head(repositoryId);
    const adopted = await prepareAndCommit({
      actionKind: "session.adopt_legacy",
      key: "response-loss-adoption",
      payload: { sessionId: legacySessionId },
      target: {
        catalogScope: sessions.resourceScope(repositoryId),
        expectedCatalogVersion: {
          kind: "revision",
          revision: adoptionHead.revision,
          sha256: adoptionHead.catalogSha256,
        },
        kind: "new_session",
      },
    });
    expect(adopted.result).toMatchObject({ adopted: true, eventCount: 1 });
    expect(await repositories.list()).toHaveLength(1);
    const projected = await sessions.project(repositoryId);
    expect(projected.entries).toHaveLength(2);
    expect(new Set(projected.entries.map((entry) => entry.createdOperationId)).size).toBe(2);
  });
});
