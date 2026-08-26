import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { readStoredSession } from "../../sessions/read-stored-session.js";
import { SessionLock, SessionLockError } from "../../sessions/session-lock.js";
import { SessionPathPolicy } from "../../sessions/session-path-policy.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  createStrictCodec,
  type ApplicationActionTargetV1,
  type ExpectedResourceVersionV1,
} from "../application-protocol.js";
import {
  ApplicationActionRegistry,
  type ApplicationActionDefinitionV1,
  type ApplicationActionExecutionResultV1,
} from "../application-action-registry.js";
import type { CatalogHeadV1, CatalogRecordV1 } from "../catalog-journal.js";
import type {
  PublicRepositoryViewV1,
  RepositoryRegistrationV1,
  RepositoryRegistry,
} from "../repository-registry.js";
import type { SessionCatalogEntryV1 } from "../session-registry.js";
import type { SessionCatalogRegistryV1 } from "../session-registry-ports.js";
import {
  repositoryRegisterResultCodec,
  sessionAdoptLegacyResultCodec,
  sessionCreateResultCodec,
} from "./action-result-codecs.js";

function catalogVersion(head: CatalogHeadV1): ExpectedResourceVersionV1 {
  return Object.freeze({ kind: "revision", revision: head.revision, sha256: head.catalogSha256 });
}

function assertExpectedCatalogHead(target: ApplicationActionTargetV1, head: CatalogHeadV1): void {
  if (
    target.kind === "existing_resource" ||
    target.expectedCatalogVersion.revision !== head.revision ||
    target.expectedCatalogVersion.sha256 !== head.catalogSha256
  ) {
    throw new ApplicationControlError("control_stale_projection", "catalog changed since the prepared target was selected");
  }
}

function catalogReference(record: CatalogRecordV1): Readonly<{
  ledgerId: string;
  ownerKind: "catalog";
  recordId: string;
  recordSha256: string;
  sequence: number;
}> {
  return Object.freeze({
    ledgerId: sha256Canonical(record.resourceScope),
    ownerKind: "catalog",
    recordId: record.recordId,
    recordSha256: record.recordSha256,
    sequence: record.revision,
  });
}

function repositoryRegistrationResult(input: {
  readonly catalogRecord: CatalogRecordV1;
  readonly created: boolean;
  readonly publicView: PublicRepositoryViewV1;
  readonly registration: RepositoryRegistrationV1;
}): ApplicationActionExecutionResultV1 {
  const reference = catalogReference(input.catalogRecord);
  return Object.freeze({
    domainRecordRefs: Object.freeze([reference]),
    primaryDomainRecord: reference,
    resolvedResourceScope: {
      kind: "repository" as const,
      repositoryId: input.registration.repositoryId,
      teamId: null,
    },
    resolvedResourceVersion: {
      kind: "revision" as const,
      revision: 1,
      sha256: input.registration.registrationSha256,
    },
    result: Object.freeze({ created: input.created, repository: input.publicView }),
    underlyingOperationRefs: Object.freeze([]),
  });
}

function sessionCreationResult(input: {
  readonly catalogRecord: CatalogRecordV1;
  readonly entry: SessionCatalogEntryV1;
  readonly legacyEventCount?: number;
}): ApplicationActionExecutionResultV1 {
  const reference = catalogReference(input.catalogRecord);
  return Object.freeze({
    domainRecordRefs: Object.freeze([reference]),
    primaryDomainRecord: reference,
    resolvedResourceScope: {
      kind: "session" as const,
      repositoryId: input.entry.repositoryId,
      sessionId: input.entry.sessionId,
      teamId: null,
    },
    resolvedResourceVersion: { kind: "session_ledger_head" as const, head: input.entry.initialLedgerHead },
    result: input.legacyEventCount === undefined
      ? Object.freeze({ session: input.entry })
      : Object.freeze({ adopted: true, eventCount: input.legacyEventCount, session: input.entry }),
    underlyingOperationRefs: Object.freeze([]),
  });
}

const repositoryRegisterPayloadSchema = z.object({
  root: z.string().min(1).max(4096),
}).strict();

const sessionCreatePayloadSchema = z.object({}).strict();
const sessionAdoptLegacyPayloadSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

interface LegacySessionEvidenceV1 {
  readonly eventCount: number;
  readonly firstEventId: string;
  readonly firstRawEventSha256: string;
  readonly sessionStorageIdentitySha256: string;
}

function hasAuthenticatedApplicationOrigin(event: DecodedStoredEvent): boolean {
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Readonly<Record<string, unknown>>;
  if (typeof data.application_commit === "object" && data.application_commit !== null) return true;
  const origin = data.origin;
  return typeof origin === "object" && origin !== null &&
    (origin as Readonly<Record<string, unknown>>).kind === "authenticated_surface";
}

async function inspectLegacySession(
  repositories: RepositoryRegistry,
  repositoryId: string,
  sessionId: string,
  options: Readonly<{ readonly allowAuthenticatedTail?: boolean }> = {},
): Promise<LegacySessionEvidenceV1> {
  const repository = await repositories.get(repositoryId);
  if (repository === null || repository.status !== "active") {
    throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
  }
  const root = await repositories.readRoot(repository);
  const policy = await SessionPathPolicy.create(root);
  const paths = await policy.inspectExistingSession(sessionId);
  let lock: SessionLock;
  try {
    lock = await SessionLock.acquire(policy, sessionId, { allowStaleRecovery: false });
  } catch (error) {
    if (error instanceof SessionLockError) {
      throw new ApplicationControlError("control_operation_busy", "legacy session has an active or unresolved writer", { cause: error });
    }
    throw error;
  }
  try {
    const before = await readFile(paths.sessionFilePath);
    const events = await readStoredSession(paths.sessionFilePath);
    const after = await readFile(paths.sessionFilePath);
    const firstLineEnd = before.indexOf(0x0a);
    if (
      !before.equals(after) ||
      before.at(-1) !== 0x0a ||
      firstLineEnd < 1 ||
      events.length === 0 ||
      events[0]?.sessionId !== sessionId ||
      events[0]?.sessionSeq !== 1 ||
      events.some((event) => event.sessionId !== sessionId)
    ) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy session is not one stable contiguous history");
    }
    if (options.allowAuthenticatedTail !== true && events.some(hasAuthenticatedApplicationOrigin)) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "authenticated application history cannot be adopted as a legacy session",
      );
    }
    const metadata = await lstat(paths.sessionFilePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy session storage is unsafe");
    }
    return Object.freeze({
      eventCount: events.length,
      firstEventId: events[0]!.eventId,
      firstRawEventSha256: createHash("sha256").update(before.subarray(0, firstLineEnd)).digest("hex"),
      sessionStorageIdentitySha256: sha256Canonical({
        dev: metadata.dev,
        ino: metadata.ino,
        real_path: await realpath(paths.sessionFilePath),
        repository_id: repositoryId,
        schema_version: 1,
        session_id: sessionId,
      }),
    });
  } finally {
    await lock.release();
  }
}

export function createCatalogActionRegistry(input: {
  readonly additionalDefinitions?: readonly ApplicationActionDefinitionV1[];
  readonly repositories: RepositoryRegistry;
  readonly sessions: SessionCatalogRegistryV1;
}): ApplicationActionRegistry {
  const repositoryRegister: ApplicationActionDefinitionV1 = {
    actionKind: "repository.register",
    confirmation: "show_before_commit",
    display: () => ({
      summary: "Register this local repository with the BornAgent controller.",
      warnings: ["The canonical root locator remains Host-internal and is not written to session history."],
    }),
    effectClass: "control_only",
    execute: async (context, payload): Promise<ApplicationActionExecutionResultV1> => {
      const parsed = repositoryRegisterPayloadSchema.parse(payload);
      if (context.resolvedTarget.resourceVersion.kind !== "revision") {
        throw new ApplicationControlError("control_target_invalid", "repository catalog version is invalid");
      }
      // MEMORY-ML5: a non-zero catalog head carries the last record binding.
      // Reconstructing it with nulls makes every second repository registration
      // fail after dispatch. Read the complete head, then verify it is still the
      // exact revision/hash frozen by the prepared action before the registry CAS.
      const expectedHead = await input.repositories.head();
      if (
        expectedHead.revision !== context.resolvedTarget.resourceVersion.revision ||
        expectedHead.catalogSha256 !== context.resolvedTarget.resourceVersion.sha256
      ) {
        throw new ApplicationControlError(
          "control_catalog_conflict",
          "repository catalog changed after the prepared target was resolved",
        );
      }
      const result = await input.repositories.register({
        expectedHead,
        operationId: context.operationId,
        root: parsed.root,
      });
      const publicView = await input.repositories.publicView(result.registration.repositoryId);
      if (publicView === null) throw new ApplicationControlError("control_catalog_corrupt", "registered repository is unavailable");
      if (result.catalogRecord === null) {
        throw new ApplicationControlError(
          "control_catalog_conflict",
          "repository root is already registered by another operation",
        );
      }
      return repositoryRegistrationResult({
        catalogRecord: result.catalogRecord,
        created: result.created,
        publicView,
        registration: result.registration,
      });
    },
    reconcile: async (context, payload, prepared) => {
      // PHASE21: cross-store recovery accepts only the catalog record whose
      // createdOperationId is this operation; same-root dedup is not evidence.
      const parsed = repositoryRegisterPayloadSchema.parse(payload);
      if (
        prepared.target.kind !== "new_repository" ||
        context.resolvedTarget.resourceScope.kind !== "repository_catalog" ||
        prepared.target.catalogScope.kind !== "repository_catalog" ||
        prepared.target.catalogScope.controllerId !== context.resolvedTarget.resourceScope.controllerId
      ) {
        throw new ApplicationControlError("control_target_invalid", "repository reconciliation target is invalid");
      }
      const preview = await input.repositories.previewRoot(parsed.root);
      const recovered = await input.repositories.findByCreatedOperation(context.operationId);
      if (recovered === null) return null;
      if (
        recovered.registration.controllerId !== prepared.target.catalogScope.controllerId ||
        recovered.registration.canonicalRootIdentitySha256 !== preview.canonicalRootIdentitySha256
      ) {
        throw new ApplicationControlError(
          "control_catalog_corrupt",
          "repository operation is bound to another prepared root identity",
        );
      }
      const publicView = await input.repositories.publicView(recovered.registration.repositoryId);
      if (publicView === null) {
        throw new ApplicationControlError("control_catalog_corrupt", "reconciled repository is unavailable");
      }
      return repositoryRegistrationResult({
        catalogRecord: recovered.catalogRecord,
        created: true,
        publicView,
        registration: recovered.registration,
      });
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 8 * 1024,
      schema: repositoryRegisterPayloadSchema,
      schemaId: "phase21a.repository.register.payload.v1",
    }),
    resultCodec: repositoryRegisterResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["repository.register"],
    resolveTarget: async (target, payload) => {
      const parsed = repositoryRegisterPayloadSchema.parse(payload);
      if (target.kind !== "new_repository") {
        throw new ApplicationControlError("control_target_invalid", "repository registration requires a new-repository target");
      }
      const head = await input.repositories.head();
      assertExpectedCatalogHead(target, head);
      const root = await input.repositories.previewRoot(parsed.root);
      const targetIdentity = {
        canonical_root_identity_sha256: root.canonicalRootIdentitySha256,
        catalog_head: head,
        schema_version: 1,
      };
      return Object.freeze({
        resourceScope: input.repositories.resourceScope,
        resourceVersion: catalogVersion(head),
        targetIdentity,
        targetIdentitySha256: sha256Canonical(targetIdentity),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["revision"],
      resourceKinds: ["repository_catalog"],
      targetKind: "new_repository",
    }],
    zeroHeadPolicy: "not_applicable",
  };

  const sessionCreate: ApplicationActionDefinitionV1 = {
    actionKind: "session.create",
    confirmation: "none",
    display: () => ({
      summary: "Create a new, not-yet-started session in this repository.",
      warnings: ["This creates only a catalog entry. No empty JSONL session file is created."],
    }),
    effectClass: "control_only",
    execute: async (context): Promise<ApplicationActionExecutionResultV1> => {
      if (
        context.resolvedTarget.resourceScope.kind !== "session_catalog" ||
        context.resolvedTarget.resourceVersion.kind !== "revision"
      ) {
        throw new ApplicationControlError("control_target_invalid", "session catalog target is invalid");
      }
      const result = await input.sessions.create({
        expectedHead: {
          catalogSha256: context.resolvedTarget.resourceVersion.sha256,
          lastRecordId: null,
          lastRecordSha256: null,
          resourceScope: context.resolvedTarget.resourceScope,
          revision: context.resolvedTarget.resourceVersion.revision,
          schemaVersion: 1,
        },
        operationId: context.operationId,
        repositoryId: context.resolvedTarget.resourceScope.repositoryId,
      });
      return sessionCreationResult(result);
    },
    reconcile: async (context, _payload, prepared) => {
      // PHASE21: a lost application response is reconstructed from the exact
      // createdOperationId record and never by appending a replacement entry.
      if (
        prepared.target.kind !== "new_session" ||
        prepared.target.catalogScope.kind !== "session_catalog" ||
        context.resolvedTarget.resourceScope.kind !== "session_catalog" ||
        prepared.target.catalogScope.repositoryId !== context.resolvedTarget.resourceScope.repositoryId
      ) {
        throw new ApplicationControlError("control_target_invalid", "session creation reconciliation target is invalid");
      }
      const recovered = await input.sessions.findCreatedByOperation(
        prepared.target.catalogScope.repositoryId,
        context.operationId,
      );
      if (recovered === null) return null;
      if (
        recovered.entry.repositoryId !== prepared.target.catalogScope.repositoryId ||
        recovered.entry.legacyAdoption !== undefined
      ) {
        throw new ApplicationControlError("control_catalog_corrupt", "session operation is not an exact new-session record");
      }
      return sessionCreationResult(recovered);
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 128,
      schema: sessionCreatePayloadSchema,
      schemaId: "phase21a.session.create.payload.v1",
    }),
    resultCodec: sessionCreateResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.create"],
    resolveTarget: async (target) => {
      if (target.kind !== "new_session") {
        throw new ApplicationControlError("control_target_invalid", "session creation requires a new-session target");
      }
      const repository = await input.repositories.get(target.catalogScope.repositoryId);
      if (repository === null || repository.status !== "active") {
        throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
      }
      const head = await input.sessions.head(repository.repositoryId);
      assertExpectedCatalogHead(target, head);
      const targetIdentity = {
        catalog_head: head,
        repository_id: repository.repositoryId,
        repository_registration_sha256: repository.registrationSha256,
        schema_version: 1,
      };
      return Object.freeze({
        resourceScope: input.sessions.resourceScope(repository.repositoryId),
        resourceVersion: catalogVersion(head),
        targetIdentity,
        targetIdentitySha256: sha256Canonical(targetIdentity),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["revision"],
      resourceKinds: ["session_catalog"],
      targetKind: "new_session",
    }],
    zeroHeadPolicy: "not_applicable",
  };

  const sessionAdoptLegacy: ApplicationActionDefinitionV1 = {
    actionKind: "session.adopt_legacy",
    confirmation: "none",
    display: (_resolved, payload) => ({
      summary: `Adopt legacy session ${sessionAdoptLegacyPayloadSchema.parse(payload).sessionId} into this repository catalog.`,
      warnings: ["Historical JSONL bytes and their unavailable legacy principal audit remain unchanged."],
    }),
    effectClass: "control_only",
    execute: async (context, payload): Promise<ApplicationActionExecutionResultV1> => {
      const parsed = sessionAdoptLegacyPayloadSchema.parse(payload);
      if (
        context.resolvedTarget.resourceScope.kind !== "session_catalog" ||
        context.resolvedTarget.resourceVersion.kind !== "revision"
      ) {
        throw new ApplicationControlError("control_target_invalid", "legacy adoption requires a session-catalog target");
      }
      const evidence = await inspectLegacySession(
        input.repositories,
        context.resolvedTarget.resourceScope.repositoryId,
        parsed.sessionId,
      );
      const result = await input.sessions.adoptLegacy({
        eventCount: evidence.eventCount,
        expectedHead: {
          catalogSha256: context.resolvedTarget.resourceVersion.sha256,
          lastRecordId: null,
          lastRecordSha256: null,
          resourceScope: context.resolvedTarget.resourceScope,
          revision: context.resolvedTarget.resourceVersion.revision,
          schemaVersion: 1,
        },
        firstEventId: evidence.firstEventId,
        firstRawEventSha256: evidence.firstRawEventSha256,
        operationId: context.operationId,
        repositoryId: context.resolvedTarget.resourceScope.repositoryId,
        sessionId: parsed.sessionId,
        sessionStorageIdentitySha256: evidence.sessionStorageIdentitySha256,
      });
      return sessionCreationResult({ ...result, legacyEventCount: evidence.eventCount });
    },
    reconcile: async (context, payload, prepared) => {
      // PHASE21: legacy adoption recovery re-observes the exact immutable
      // history identity; a matching session ID alone cannot prove the commit.
      const parsed = sessionAdoptLegacyPayloadSchema.parse(payload);
      if (
        prepared.target.kind !== "new_session" ||
        prepared.target.catalogScope.kind !== "session_catalog" ||
        context.resolvedTarget.resourceScope.kind !== "session_catalog" ||
        prepared.target.catalogScope.repositoryId !== context.resolvedTarget.resourceScope.repositoryId
      ) {
        throw new ApplicationControlError("control_target_invalid", "legacy adoption reconciliation target is invalid");
      }
      const recovered = await input.sessions.findCreatedByOperation(
        prepared.target.catalogScope.repositoryId,
        context.operationId,
      );
      if (recovered === null) return null;
      const evidence = await inspectLegacySession(
        input.repositories,
        prepared.target.catalogScope.repositoryId,
        parsed.sessionId,
        { allowAuthenticatedTail: true },
      );
      const adoption = recovered.entry.legacyAdoption;
      if (
        recovered.entry.repositoryId !== prepared.target.catalogScope.repositoryId ||
        recovered.entry.sessionId !== parsed.sessionId ||
        adoption === undefined ||
        adoption.firstEventId !== evidence.firstEventId ||
        adoption.firstRawEventSha256 !== evidence.firstRawEventSha256 ||
        adoption.sessionStorageIdentitySha256 !== evidence.sessionStorageIdentitySha256
      ) {
        throw new ApplicationControlError(
          "control_catalog_corrupt",
          "legacy adoption operation is not bound to the exact surviving history",
        );
      }
      return sessionCreationResult({ ...recovered, legacyEventCount: adoption.eventCount });
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 256,
      schema: sessionAdoptLegacyPayloadSchema,
      schemaId: "phase21a.session.adopt-legacy.payload.v1",
    }),
    resultCodec: sessionAdoptLegacyResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: ["session.create"],
    resolveTarget: async (target, payload) => {
      const parsed = sessionAdoptLegacyPayloadSchema.parse(payload);
      if (target.kind !== "new_session") {
        throw new ApplicationControlError("control_target_invalid", "legacy adoption requires a new-session catalog target");
      }
      const repository = await input.repositories.get(target.catalogScope.repositoryId);
      if (repository === null || repository.status !== "active") {
        throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
      }
      const head = await input.sessions.head(repository.repositoryId);
      assertExpectedCatalogHead(target, head);
      const evidence = await inspectLegacySession(input.repositories, repository.repositoryId, parsed.sessionId);
      const targetIdentity = {
        catalog_head: head,
        first_event_id: evidence.firstEventId,
        first_raw_event_sha256: evidence.firstRawEventSha256,
        repository_id: repository.repositoryId,
        repository_registration_sha256: repository.registrationSha256,
        schema_version: 1,
        session_id: parsed.sessionId,
        session_storage_identity_sha256: evidence.sessionStorageIdentitySha256,
      };
      return Object.freeze({
        resourceScope: input.sessions.resourceScope(repository.repositoryId),
        resourceVersion: catalogVersion(head),
        targetIdentity,
        targetIdentitySha256: sha256Canonical(targetIdentity),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["revision"],
      resourceKinds: ["session_catalog"],
      targetKind: "new_session",
    }],
    zeroHeadPolicy: "not_applicable",
  };

  return new ApplicationActionRegistry([
    repositoryRegister,
    sessionCreate,
    sessionAdoptLegacy,
    ...(input.additionalDefinitions ?? []),
  ]);
}
