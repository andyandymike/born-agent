import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ApplicationControlError } from "../../src/control-plane/application-errors.js";
import { DefaultApplicationQueryService } from "../../src/control-plane/application-query-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { createStrictCodec } from "../../src/control-plane/application-protocol.js";
import { ApplicationQueryRegistry, type ApplicationQueryDefinitionV1 } from "../../src/control-plane/application-query-registry.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { LocalOwnerPrincipalAuthority } from "../../src/control-plane/local-owner-principal.js";
import { PaginationCursorStore } from "../../src/control-plane/pagination-cursor-store.js";
import { RepositoryRegistry } from "../../src/control-plane/repository-registry.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";
import { SessionOwnerBroker } from "../../src/control-plane/session-owner-broker.js";
import { SessionProjectionService } from "../../src/control-plane/session-projection-service.js";
import { SessionRegistry } from "../../src/control-plane/session-registry.js";
import { createCatalogQueryRegistry } from "../../src/control-plane/use-cases/catalog-queries.js";

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
  const authority = await loadOrCreateHostControlAuthority({ root: await directory("bornagent-phase21a-query-") });
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const repositories = new RepositoryRegistry(artifacts, authority.identity, authority.paths);
  const sessions = new SessionRegistry(authority.paths, repositories);
  const disclosureProfileSha256 = sha256Canonical({ profile: "phase21a.local-owner", schema_version: 1 });
  const sessionProjection = new SessionProjectionService({
    broker: new SessionOwnerBroker(),
    disclosureProfileSha256,
    repositories,
    sessions,
    signer: new SessionLedgerHeadSigner(authority.integrityKey),
  });
  const principalAuthority = new LocalOwnerPrincipalAuthority(authority.localOwner, authority.localOwnerScopes);
  const operations = new ControlOperationJournal(authority.paths);
  const service = new DefaultApplicationQueryService({
    createRequestId: randomUUID,
    cursors: new PaginationCursorStore(authority.integrityKey, authority.paths),
    delivery: new SessionDeliveryCoordinator(),
    hostRuntime: createNodeApplicationHostRuntime(),
    principalAuthority,
    queries: createCatalogQueryRegistry({
      artifacts,
      controllerId: authority.identity.controllerId,
      disclosureProfileSha256,
      operations,
      repositories,
      sessionProjection,
      sessions,
    }),
  });
  const context = {
    principal: authority.localOwner,
    surface: { clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const },
  };
  const serviceFor = (definition: ApplicationQueryDefinitionV1) => new DefaultApplicationQueryService({
    createRequestId: randomUUID,
    cursors: new PaginationCursorStore(authority.integrityKey, authority.paths),
    delivery: new SessionDeliveryCoordinator(),
    hostRuntime: createNodeApplicationHostRuntime(),
    principalAuthority,
    queries: new ApplicationQueryRegistry([definition]),
  });
  return { authority, context, repositories, service, serviceFor, sessionProjection, sessions };
}

function maliciousDefinition(
  overrides: Partial<ApplicationQueryDefinitionV1> = {},
): ApplicationQueryDefinitionV1 {
  return {
    execute: () => Promise.resolve({
      hasMore: false,
      lastItemIdentitySha256: null,
      nextOffset: 0,
      result: { ok: true },
    }),
    pagination: { cursorKind: null, maximumBytes: 4096, maximumCursorLifetimeMs: 60_000, maximumItems: 1 },
    payloadCodec: createStrictCodec({ maximumBytes: 64, schema: z.object({}).strict(), schemaId: "phase21a.test.query.payload.v1" }),
    projectionOwner: "RepositoryRegistry",
    queryKind: "test.fixed_query",
    readStableSnapshot: (scope) => Promise.resolve({
      resourceScope: scope,
      resourceVersion: { kind: "revision", revision: 1, sha256: "a".repeat(64) },
      snapshot: Object.freeze({}),
      snapshotIdentitySha256: "b".repeat(64),
    }),
    redactionProfileId: "phase21a.repository.public.v1",
    requiredScopes: ["repository.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["revision"], allowCurrentVersion: true, resourceKind: "repository_catalog" }],
    ...overrides,
  };
}

describe("Phase 21A application query service", () => {
  it("keeps repository content and version on one snapshot across a concurrent append", async () => {
    const { context, repositories, service } = await fixture();
    await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root: await directory("bornagent-phase21a-snapshot-before-"),
    });
    const originalSnapshot = repositories.publicSnapshot.bind(repositories);
    let appended = false;
    vi.spyOn(repositories, "publicSnapshot").mockImplementation(async () => {
      const stable = await originalSnapshot();
      if (!appended) {
        appended = true;
        await repositories.register({
          expectedHead: await repositories.head(),
          operationId: randomUUID(),
          root: await directory("bornagent-phase21a-snapshot-after-"),
        });
      }
      return stable;
    });

    const response = await service.query(context, {
      atVersion: null,
      pageCursor: null,
      payload: { limit: 200 },
      queryKind: "repository.list",
      requestId: randomUUID(),
      resourceScope: repositories.resourceScope,
      schemaVersion: 1,
    });
    expect(response.status).toBe("ok");
    expect(response.resourceVersion).toMatchObject({ kind: "revision", revision: 1 });
    expect((response.result?.value as { repositories: readonly unknown[] }).repositories).toHaveLength(1);
    expect((await repositories.head()).revision).toBe(2);
  });

  it("binds every paginated page to one exact authorized snapshot", async () => {
    const { context, repositories, service } = await fixture();
    for (const name of ["left", "right"]) {
      await repositories.register({
        expectedHead: await repositories.head(),
        operationId: randomUUID(),
        root: await directory(`bornagent-phase21a-${name}-`),
      });
    }
    const first = await service.query(context, {
      atVersion: null,
      pageCursor: null,
      payload: { limit: 1 },
      queryKind: "repository.list",
      requestId: randomUUID(),
      resourceScope: repositories.resourceScope,
      schemaVersion: 1,
    });
    expect(first.status).toBe("ok");
    expect((first.result?.value as { repositories: readonly unknown[] }).repositories).toHaveLength(1);
    expect(first.result?.nextPageCursor).not.toBeNull();

    const second = await service.query(
      { ...context, surface: { ...context.surface, connectionId: randomUUID() } },
      {
        atVersion: first.resourceVersion,
        pageCursor: first.result!.nextPageCursor,
        payload: { limit: 1 },
        queryKind: "repository.list",
        requestId: randomUUID(),
        resourceScope: repositories.resourceScope,
        schemaVersion: 1,
      },
    );
    expect(second.status).toBe("ok");
    expect((second.result?.value as { repositories: readonly unknown[] }).repositories).toHaveLength(1);
    expect(second.result?.nextPageCursor).toBeNull();

    const tampered = await service.query(context, {
      atVersion: first.resourceVersion,
      pageCursor: first.result!.nextPageCursor,
      payload: { limit: 2 },
      queryKind: "repository.list",
      requestId: randomUUID(),
      resourceScope: repositories.resourceScope,
      schemaVersion: 1,
    });
    expect(tampered).toMatchObject({ status: "resync_required", error: { code: "control_resync_required" } });
  });

  it("projects a catalog-only session without creating an empty JSONL", async () => {
    const { context, repositories, service, sessions } = await fixture();
    const root = await directory("bornagent-phase21a-empty-session-");
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root,
    });
    const created = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    const response = await service.query(context, {
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "session.view",
      requestId: randomUUID(),
      resourceScope: {
        kind: "session",
        repositoryId: repository.registration.repositoryId,
        sessionId: created.entry.sessionId,
        teamId: null,
      },
      schemaVersion: 1,
    });
    expect(response.status).toBe("ok");
    expect(response.ledgerHead).toEqual(created.entry.initialLedgerHead);
    expect(response.result?.value).toMatchObject({ outcome: "not_started", runs: [] });
    await expect(access(join(root, ".bornagent", "sessions", `${created.entry.sessionId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never turns a durable materialization intent into a fresh empty session", async () => {
    const { repositories, sessionProjection, sessions } = await fixture();
    const root = await directory("bornagent-phase21a-intent-session-");
    const repository = await repositories.register({
      expectedHead: await repositories.head(),
      operationId: randomUUID(),
      root,
    });
    const created = await sessions.create({
      expectedHead: await sessions.head(repository.registration.repositoryId),
      operationId: randomUUID(),
      repositoryId: repository.registration.repositoryId,
    });
    await sessions.appendMaterializationIntent({
      expectedHead: created.head,
      intent: {
        expectedZeroHeadSha256: sha256Canonical(created.entry.initialLedgerHead),
        intendedStorageIdentitySha256: sha256Canonical({ repositoryId: repository.registration.repositoryId, sessionId: created.entry.sessionId }),
        materializationIntentId: randomUUID(),
        operationId: randomUUID(),
        preparedActionSha256: "a".repeat(64),
        repositoryId: repository.registration.repositoryId,
        sessionId: created.entry.sessionId,
      },
    });
    const snapshot = await sessionProjection.read({
      repositoryId: repository.registration.repositoryId,
      requestedHead: null,
      sessionId: created.entry.sessionId,
    });
    expect(snapshot.projection.projection).toMatchObject({
      blockers: ["materialization_pending_or_unknown"],
      outcome: "materialization_pending_or_unknown",
    });
    expect(snapshot.head.publicHead.sequence).toBe(0);
  });

  it("rejects projection owners that swap scope, version, or snapshot identity", async () => {
    const { context, repositories, serviceFor } = await fixture();
    const scope = repositories.resourceScope;
    const request = {
      atVersion: { kind: "revision" as const, revision: 1, sha256: "a".repeat(64) },
      pageCursor: null,
      payload: {},
      queryKind: "test.fixed_query",
      requestId: randomUUID(),
      resourceScope: scope,
      schemaVersion: 1 as const,
    };
    const variants: readonly ApplicationQueryDefinitionV1[] = [
      maliciousDefinition({
        readStableSnapshot: () => Promise.resolve({
          resourceScope: { controllerId: randomUUID(), kind: "repository_catalog" },
          resourceVersion: request.atVersion,
          snapshot: {},
          snapshotIdentitySha256: "b".repeat(64),
        }),
      }),
      maliciousDefinition({
        readStableSnapshot: () => Promise.resolve({
          resourceScope: scope,
          resourceVersion: { kind: "revision", revision: 2, sha256: "c".repeat(64) },
          snapshot: {},
          snapshotIdentitySha256: "b".repeat(64),
        }),
      }),
      maliciousDefinition({
        readStableSnapshot: () => Promise.resolve({
          resourceScope: scope,
          resourceVersion: request.atVersion,
          snapshot: {},
          snapshotIdentitySha256: "not-a-sha256",
        }),
      }),
    ];
    for (const definition of variants) {
      const response = await serviceFor(definition).query(context, { ...request, requestId: randomUUID() });
      expect(response).toMatchObject({ error: { code: "control_operation_corrupt" }, status: "rejected" });
    }
  });

  it("rejects unbounded owner pagination and unregistered owner/profile pairs", async () => {
    const { context, repositories, serviceFor } = await fixture();
    expect(() => new ApplicationQueryRegistry([
      maliciousDefinition({ projectionOwner: "UntrustedFilesystemProjector" }),
    ])).toThrow(/unregistered built-in owner/u);
    expect(() => new ApplicationQueryRegistry([
      maliciousDefinition({ redactionProfileId: "phase21a.unregistered.v1" }),
    ])).toThrow(/unregistered built-in owner or redaction profile/u);

    const service = serviceFor(maliciousDefinition({
      execute: () => Promise.resolve({
        hasMore: true,
        lastItemIdentitySha256: "d".repeat(64),
        nextOffset: 2,
        result: [{ id: 1 }, { id: 2 }],
      }),
    }));
    const response = await service.query(context, {
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "test.fixed_query",
      requestId: randomUUID(),
      resourceScope: repositories.resourceScope,
      schemaVersion: 1,
    });
    expect(response).toMatchObject({ error: { code: "control_operation_corrupt" }, status: "rejected" });
  });

  it("recursively redacts query values and never reflects owner error text", async () => {
    const { context, repositories, serviceFor } = await fixture();
    const secret = "Authorization: Bearer phase21a-secret-sentinel-9374";
    const request = {
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "test.fixed_query",
      requestId: randomUUID(),
      resourceScope: repositories.resourceScope,
      schemaVersion: 1 as const,
    };
    const successful = await serviceFor(maliciousDefinition({
      execute: () => Promise.resolve({
        hasMore: false,
        lastItemIdentitySha256: null,
        nextOffset: 0,
        result: { nested: [{ value: secret }] },
      }),
    })).query(context, request);
    expect(successful.status).toBe("ok");
    expect(JSON.stringify(successful)).not.toContain("phase21a-secret-sentinel-9374");
    expect(successful.result?.value).toMatchObject({ nested: [{ value: "Authorization: Bearer [redacted]" }] });

    const rejected = await serviceFor(maliciousDefinition({
      execute: () => Promise.reject(new ApplicationControlError("control_target_invalid", secret)),
    })).query(context, { ...request, requestId: randomUUID() });
    expect(rejected).toMatchObject({ error: { code: "control_target_invalid" }, status: "rejected" });
    expect(JSON.stringify(rejected)).not.toContain("phase21a-secret-sentinel-9374");
  });
});
