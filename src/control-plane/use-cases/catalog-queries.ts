import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  SessionCatalog,
  type PublicSessionCatalogEntry,
} from "../../sessions/session-catalog.js";
import { redactSensitiveText } from "../../security/redact.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  createStrictCodec,
  resourceScopeSha256,
  type ExpectedResourceVersionV1,
  type ResourceScopeV1,
} from "../application-protocol.js";
import {
  ApplicationQueryRegistry,
  type ApplicationQueryDefinitionV1,
  type ApplicationQueryExecutionResultV1,
} from "../application-query-registry.js";
import type { ControlArtifactStore } from "../control-artifact-store.js";
import type { ControlOperationJournal } from "../control-operation-journal.js";
import type { RepositoryRegistry } from "../repository-registry.js";
import type { SessionProjectionService, StableSessionApplicationSnapshotV1 } from "../session-projection-service.js";
import type { SessionRegistry } from "../session-registry.js";
import {
  createTaskSurfaceQueryDefinitions,
  type TaskSurfaceQueryOperationPortV1,
} from "./task-surface-queries.js";

const emptyPayload = z.object({}).strict();
const listPayload = z.object({ limit: z.number().int().min(1).max(200) }).strict();
const eventPagePayload = z.object({ limit: z.number().int().min(1).max(500) }).strict();
const tuiEventPagePayload = z.object({ limit: z.number().int().min(1).max(100) }).strict();
const operationPayload = z.object({ operationId: z.string().uuid() }).strict();
const artifactPayload = z.object({ artifactId: z.string().uuid() }).strict();

function exactRevision(requested: ExpectedResourceVersionV1 | null, revision: number, sha256: string): void {
  if (
    requested !== null &&
    (requested.kind !== "revision" || requested.revision !== revision || requested.sha256 !== sha256)
  ) {
    throw new ApplicationControlError("control_stale_projection", "requested resource revision is stale");
  }
}

function page<T>(
  items: readonly T[],
  offset: number,
  limit: number,
  identity: (item: T) => unknown,
): ApplicationQueryExecutionResultV1<readonly T[]> {
  const selected = Object.freeze(items.slice(offset, offset + limit));
  const nextOffset = offset + selected.length;
  return Object.freeze({
    hasMore: nextOffset < items.length,
    lastItemIdentitySha256: selected.length === 0 ? null : sha256Canonical(identity(selected.at(-1)!)),
    nextOffset,
    result: selected,
  });
}

export function createCatalogQueryRegistry(input: {
  readonly artifacts: ControlArtifactStore;
  readonly controllerId: string;
  readonly disclosureProfileSha256: string;
  readonly operations: ControlOperationJournal;
  readonly repositories: RepositoryRegistry;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: SessionRegistry;
  readonly taskSurfaceOperations?: TaskSurfaceQueryOperationPortV1;
}): ApplicationQueryRegistry {
  const repositoryList: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const parsed = listPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as {
        readonly repositories: readonly { readonly repositoryId: string }[];
      };
      const offset = context.paginationBinding?.nextOffset ?? 0;
      const result = page(snapshot.repositories, offset, parsed.limit, (entry) => entry.repositoryId);
      return Promise.resolve({ ...result, result: Object.freeze({ repositories: result.result }) });
    },
    pagination: { cursorKind: "repository.list.v1", maximumBytes: 256 * 1024, maximumCursorLifetimeMs: 5 * 60_000, maximumItems: 200 },
    payloadCodec: createStrictCodec({ maximumBytes: 128, schema: listPayload, schemaId: "phase21a.repository.list.payload.v1" }),
    projectionOwner: "RepositoryRegistry",
    queryKind: "repository.list",
    readStableSnapshot: async (scope, requested) => {
      if (scope.kind !== "repository_catalog" || scope.controllerId !== input.controllerId) {
        throw new ApplicationControlError("control_authorization_denied", "repository catalog is unavailable");
      }
      const catalog = await input.repositories.publicSnapshot();
      const head = catalog.head;
      exactRevision(requested, head.revision, head.catalogSha256);
      const snapshot = Object.freeze({ repositories: catalog.repositories });
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: { kind: "revision" as const, revision: head.revision, sha256: head.catalogSha256 },
        snapshot,
        snapshotIdentitySha256: sha256Canonical({ head, snapshot }),
      });
    },
    redactionProfileId: "phase21a.repository.public.v1",
    requiredScopes: ["repository.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["revision"], allowCurrentVersion: true, resourceKind: "repository_catalog" }],
  };

  const repositoryView: ApplicationQueryDefinitionV1 = {
    execute: (context) => Promise.resolve({
      hasMore: false,
      lastItemIdentitySha256: null,
      nextOffset: 0,
      result: context.stableSnapshot.snapshot,
    }),
    pagination: { cursorKind: null, maximumBytes: 64 * 1024, maximumCursorLifetimeMs: 60_000, maximumItems: 1 },
    payloadCodec: createStrictCodec({ maximumBytes: 16, schema: emptyPayload, schemaId: "phase21a.repository.view.payload.v1" }),
    projectionOwner: "RepositoryRegistry",
    queryKind: "repository.view",
    readStableSnapshot: async (scope, requested) => {
      if (scope.kind !== "repository") throw new ApplicationControlError("control_target_invalid", "repository view requires repository scope");
      const registration = await input.repositories.get(scope.repositoryId);
      const view = await input.repositories.publicView(scope.repositoryId);
      if (registration === null || view === null) throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
      exactRevision(requested, 1, registration.registrationSha256);
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: { kind: "revision" as const, revision: 1, sha256: registration.registrationSha256 },
        snapshot: view,
        snapshotIdentitySha256: sha256Canonical(view),
      });
    },
    redactionProfileId: "phase21a.repository.public.v1",
    requiredScopes: ["repository.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["revision"], allowCurrentVersion: true, resourceKind: "repository" }],
  };

  const sessionList: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const parsed = listPayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as {
        readonly diagnostics: Readonly<{
          readonly bytes: number;
          readonly filesDiscovered: number;
          readonly filesScanned: number;
          readonly truncated: boolean;
        }>;
        readonly sessions: readonly (PublicSessionCatalogEntry & {
          readonly catalogState: "legacy_unadopted" | "registered";
          readonly materialization: "materialized" | "not_started" | "pending_or_unknown";
        })[];
      };
      const result = page(snapshot.sessions, context.paginationBinding?.nextOffset ?? 0, parsed.limit, (entry) => entry.sessionId);
      return Promise.resolve({
        ...result,
        result: Object.freeze({ diagnostics: snapshot.diagnostics, sessions: result.result }),
      });
    },
    pagination: { cursorKind: "session.list.v1", maximumBytes: 256 * 1024, maximumCursorLifetimeMs: 5 * 60_000, maximumItems: 200 },
    payloadCodec: createStrictCodec({ maximumBytes: 128, schema: listPayload, schemaId: "phase21a.session.list.payload.v1" }),
    projectionOwner: "SessionRegistry",
    queryKind: "session.list",
    readStableSnapshot: async (scope, requested) => {
      if (scope.kind !== "session_catalog") throw new ApplicationControlError("control_target_invalid", "session list requires session-catalog scope");
      const catalog = await input.sessions.project(scope.repositoryId);
      exactRevision(requested, catalog.head.revision, catalog.head.catalogSha256);
      const registration = await input.repositories.get(scope.repositoryId);
      if (registration === null || registration.status !== "active") {
        throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
      }
      const root = await input.repositories.readRoot(registration);
      const legacy = await new SessionCatalog(root).scan(200);
      const legacyById = new Map(legacy.entries.map((entry) => {
        const { path: _path, ...publicEntry } = entry;
        void _path;
        return [entry.sessionId, Object.freeze({
          ...publicEntry,
          ...(publicEntry.error === undefined ? {} : { error: "session_unavailable" }),
          taskSummary: redactSensitiveText(publicEntry.taskSummary),
        })] as const;
      }));
      const sessions: Array<PublicSessionCatalogEntry & {
        readonly catalogState: "legacy_unadopted" | "registered";
        readonly materialization: "materialized" | "not_started" | "pending_or_unknown";
      }> = [];
      for (const entry of catalog.entries) {
        const materialization = catalog.materializations.some((marker) => marker.sessionId === entry.sessionId)
          ? "materialized" as const
          : catalog.intents.some((intent) => intent.sessionId === entry.sessionId)
            ? "pending_or_unknown" as const
            : "not_started" as const;
        try {
          const projected = await input.sessionProjection.read({
            repositoryId: scope.repositoryId,
            requestedHead: null,
            sessionId: entry.sessionId,
          });
          const catalogDisplay = projected.projection.projection.display?.catalog;
          if (catalogDisplay === undefined) {
            throw new ApplicationControlError("control_operation_corrupt", "session projection omitted its catalog display");
          }
          sessions.push(Object.freeze({
            ...catalogDisplay,
            catalogState: "registered" as const,
            materialization,
          }));
        } catch (error) {
          const fallback = legacyById.get(entry.sessionId);
          sessions.push(Object.freeze({
            ...(fallback ?? {
              changedCount: 0,
              lastTimestamp: null,
              model: null,
              provider: null,
              resumeStatus: "not_resumable" as const,
              sessionId: entry.sessionId,
              status: "invalid",
              taskSummary: "",
            }),
            catalogState: "registered" as const,
            error: error instanceof ApplicationControlError ? error.code : "session_unavailable",
            materialization,
          }));
        }
        legacyById.delete(entry.sessionId);
      }
      for (const legacyEntry of legacyById.values()) {
        sessions.push(Object.freeze({
          ...legacyEntry,
          catalogState: "legacy_unadopted" as const,
          materialization: "materialized" as const,
        }));
      }
      sessions.sort((left, right) => {
        if (left.lastTimestamp === right.lastTimestamp) return left.sessionId.localeCompare(right.sessionId);
        if (left.lastTimestamp === null) return 1;
        if (right.lastTimestamp === null) return -1;
        return right.lastTimestamp.localeCompare(left.lastTimestamp);
      });
      const diagnostics = Object.freeze({
        bytes: legacy.diagnostics.bytes,
        filesDiscovered: legacy.diagnostics.filesDiscovered,
        filesScanned: legacy.diagnostics.filesScanned,
        truncated: legacy.diagnostics.truncated,
      });
      const stableSessions = Object.freeze(sessions);
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: { kind: "revision" as const, revision: catalog.head.revision, sha256: catalog.head.catalogSha256 },
        snapshot: Object.freeze({ diagnostics, sessions: stableSessions }),
        snapshotIdentitySha256: sha256Canonical({ diagnostics, head: catalog.head, sessions: stableSessions }),
      });
    },
    redactionProfileId: "phase21a.session.catalog.v1",
    requiredScopes: ["session.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["revision"], allowCurrentVersion: true, resourceKind: "session_catalog" }],
  };

  const readSessionSnapshot = async (
    scope: ResourceScopeV1,
    requested: ExpectedResourceVersionV1 | null,
  ) => {
    if (scope.kind !== "session") throw new ApplicationControlError("control_target_invalid", "session query requires session scope");
    if (requested !== null && requested.kind !== "session_ledger_head") {
      throw new ApplicationControlError("control_target_invalid", "session query requires a ledger-head version");
    }
    const snapshot = await input.sessionProjection.read({
      repositoryId: scope.repositoryId,
      requestedHead: requested?.kind === "session_ledger_head" ? requested.head : null,
      sessionId: scope.sessionId,
    });
    return Object.freeze({
      resourceScope: scope,
      resourceVersion: { kind: "session_ledger_head" as const, head: snapshot.head.publicHead },
      snapshot,
      snapshotIdentitySha256: sha256Canonical({
        events: snapshot.eventMetadata,
        projection_identity: snapshot.projection.identity,
      }),
    });
  };

  const sessionView: ApplicationQueryDefinitionV1 = {
    execute: (context) => {
      const snapshot = context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1;
      return Promise.resolve({
        hasMore: false,
        lastItemIdentitySha256: null,
        ledgerHead: snapshot.head.publicHead,
        nextOffset: 0,
        projectionIdentity: snapshot.projection.identity,
        result: snapshot.projection.projection,
        sessionDelivery: {
          head: snapshot.head.publicHead,
          kind: "full_snapshot" as const,
          rawEventSha256: snapshot.head.rawEventSha256,
        },
      });
    },
    pagination: { cursorKind: null, maximumBytes: 1024 * 1024, maximumCursorLifetimeMs: 60_000, maximumItems: 1 },
    payloadCodec: createStrictCodec({ maximumBytes: 16, schema: emptyPayload, schemaId: "phase21a.session.view.payload.v1" }),
    projectionOwner: "SessionProjectionService",
    queryKind: "session.view",
    readStableSnapshot: readSessionSnapshot,
    redactionProfileId: "phase21a.session.local-owner.v1",
    requiredScopes: ["session.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["session_ledger_head"], allowCurrentVersion: true, resourceKind: "session" }],
  };

  const sessionEvents: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const parsed = eventPagePayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1;
      const result = page(
        snapshot.eventMetadata,
        context.paginationBinding?.nextOffset ?? 0,
        parsed.limit,
        (event) => ({ eventId: event.eventId, sequence: event.sequence }),
      );
      const offset = context.paginationBinding?.nextOffset ?? 0;
      return Promise.resolve({
        ...result,
        ledgerHead: snapshot.head.publicHead,
        projectionIdentity: snapshot.projection.identity,
        result: Object.freeze({
          displayEvents: Object.freeze(snapshot.tuiDisplayEvents.slice(offset, offset + result.result.length)),
          events: result.result,
        }),
        sessionDelivery: {
          events: Object.freeze(snapshot.deliveryEvents.slice(offset, offset + result.result.length)),
          kind: "event_page" as const,
          sessionId: snapshot.resourceScope.sessionId,
        },
      });
    },
    pagination: { cursorKind: "session.events.v1", maximumBytes: 512 * 1024, maximumCursorLifetimeMs: 5 * 60_000, maximumItems: 500 },
    payloadCodec: createStrictCodec({ maximumBytes: 128, schema: eventPagePayload, schemaId: "phase21a.session.events-page.payload.v1" }),
    projectionOwner: "SessionProjectionService",
    queryKind: "session.events_page",
    readStableSnapshot: readSessionSnapshot,
    redactionProfileId: "phase21a.session.local-owner-events.v1",
    requiredScopes: ["session.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["session_ledger_head"], allowCurrentVersion: true, resourceKind: "session" }],
  };

  const sessionTuiEvents: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const parsed = tuiEventPagePayload.parse(payload);
      const snapshot = context.stableSnapshot.snapshot as StableSessionApplicationSnapshotV1;
      const result = page(
        snapshot.tuiDisplayEvents,
        context.paginationBinding?.nextOffset ?? 0,
        parsed.limit,
        (event) => ({ eventId: event.eventId, sequence: event.sessionSeq }),
      );
      return Promise.resolve({
        ...result,
        ledgerHead: snapshot.head.publicHead,
        projectionIdentity: snapshot.projection.identity,
        result: Object.freeze({ events: result.result }),
      });
    },
    pagination: {
      cursorKind: "session.tui-events.v1",
      maximumBytes: 512 * 1024,
      maximumCursorLifetimeMs: 5 * 60_000,
      maximumItems: 100,
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 128,
      schema: tuiEventPagePayload,
      schemaId: "phase21a.session.tui-events-page.payload.v1",
    }),
    projectionOwner: "SessionProjectionService",
    queryKind: "session.tui_events_page",
    readStableSnapshot: readSessionSnapshot,
    redactionProfileId: "phase21a.session.tui-display.v1",
    requiredScopes: ["session.read"],
    resourceContracts: [{
      acceptedAtVersionKinds: ["session_ledger_head"],
      allowCurrentVersion: true,
      resourceKind: "session",
    }],
  };

  const operationView: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const { operationId } = operationPayload.parse(payload);
      const operations = context.stableSnapshot.snapshot as readonly { readonly operationId: string }[];
      const operation = operations.find((candidate) => candidate.operationId === operationId);
      if (operation === undefined) throw new ApplicationControlError("control_authorization_denied", "operation is unavailable");
      return Promise.resolve({ hasMore: false, lastItemIdentitySha256: null, nextOffset: 0, result: operation });
    },
    pagination: { cursorKind: null, maximumBytes: 1024 * 1024, maximumCursorLifetimeMs: 60_000, maximumItems: 1 },
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: operationPayload, schemaId: "phase21a.operation.view.payload.v1" }),
    projectionOwner: "ControlOperationJournal",
    queryKind: "operation.view",
    readStableSnapshot: async (scope, requested) => {
      if (scope.kind !== "controller" || scope.controllerId !== input.controllerId) {
        throw new ApplicationControlError("control_authorization_denied", "controller operation scope is unavailable");
      }
      const operations = Object.freeze(await input.operations.list());
      const aggregateSha256 = sha256Canonical(operations.map((operation) => ({
        operation_id: operation.operationId,
        record_sha256: operation.recordSha256,
        revision: operation.operationRevision,
      })));
      exactRevision(requested, operations.reduce((sum, operation) => sum + operation.operationRevision, 0), aggregateSha256);
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: {
          kind: "revision" as const,
          revision: operations.reduce((sum, operation) => sum + operation.operationRevision, 0),
          sha256: aggregateSha256,
        },
        snapshot: operations,
        snapshotIdentitySha256: aggregateSha256,
      });
    },
    redactionProfileId: "phase21a.operation.local-owner.v1",
    requiredScopes: ["control.operation.read"],
    resourceContracts: [{ acceptedAtVersionKinds: ["revision"], allowCurrentVersion: true, resourceKind: "controller" }],
  };

  const artifactMetadata: ApplicationQueryDefinitionV1 = {
    execute: (context, payload) => {
      const { artifactId } = artifactPayload.parse(payload);
      const records = context.stableSnapshot.snapshot as readonly Awaited<ReturnType<ControlArtifactStore["readRecord"]>>[];
      const record = records.find((candidate) => candidate.artifactId === artifactId);
      if (record === undefined) throw new ApplicationControlError("control_authorization_denied", "artifact is unavailable");
      return Promise.resolve({
        hasMore: false,
        lastItemIdentitySha256: null,
        nextOffset: 0,
        result: input.artifacts.reference({
          disclosure: "opaque",
          disclosureProfileSha256: input.disclosureProfileSha256,
          record,
        }),
      });
    },
    pagination: { cursorKind: null, maximumBytes: 64 * 1024, maximumCursorLifetimeMs: 60_000, maximumItems: 1 },
    payloadCodec: createStrictCodec({ maximumBytes: 256, schema: artifactPayload, schemaId: "phase21a.artifact.metadata.payload.v1" }),
    projectionOwner: "ControlArtifactStore",
    queryKind: "artifact.metadata",
    readStableSnapshot: async (scope, requested) => {
      const records = Object.freeze((await input.artifacts.listRecords()).filter(
        (record) => resourceScopeSha256(record.resourceScope) === resourceScopeSha256(scope),
      ));
      const aggregateSha256 = sha256Canonical(records.map((record) => ({
        artifact_id: record.artifactId,
        record_sha256: record.recordSha256,
      })));
      exactRevision(requested, records.length, aggregateSha256);
      return Object.freeze({
        resourceScope: scope,
        resourceVersion: { kind: "revision" as const, revision: records.length, sha256: aggregateSha256 },
        snapshot: records,
        snapshotIdentitySha256: aggregateSha256,
      });
    },
    redactionProfileId: "phase21a.artifact.metadata-opaque.v1",
    requiredScopes: ["artifact.metadata.read"],
    resourceContracts: [
      "controller",
      "repository_catalog",
      "repository",
      "session_catalog",
      "session",
    ].map((resourceKind) => ({
      acceptedAtVersionKinds: ["revision"] as const,
      allowCurrentVersion: true,
      resourceKind: resourceKind as ResourceScopeV1["kind"],
    })),
  };

  const taskSurfaceQueries = createTaskSurfaceQueryDefinitions({
    operations: input.taskSurfaceOperations ?? Object.freeze({
      inspectDelegationOperationSidecars: () => Promise.resolve(Object.freeze([])),
    }),
    readSessionSnapshot,
    repositories: input.repositories,
  });

  return new ApplicationQueryRegistry([
    repositoryList,
    repositoryView,
    sessionList,
    sessionView,
    sessionEvents,
    sessionTuiEvents,
    operationView,
    artifactMetadata,
    ...taskSurfaceQueries,
  ]);
}
