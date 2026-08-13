import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  borrowedTaskMutationWriterFactory,
  type TaskMutationContext,
  type TaskMutationWriterFactory,
} from "../../coordination/task-control-plane.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { reconstructMultiRunSession, type ReconstructedMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import { SessionLockError } from "../../sessions/session-lock.js";
import type {
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
  ResolvedApplicationTargetV1,
} from "../application-action-registry.js";
import { ApplicationControlError } from "../application-errors.js";
import type {
  ApplicationActionTargetV1,
  PreparedActionV1,
  SessionLedgerHeadV1,
} from "../application-protocol.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type { RepositoryRegistry } from "../repository-registry.js";
import type { SessionOwnerBroker } from "../session-owner-broker.js";
import type { SessionProjectionService } from "../session-projection-service.js";
import type { SessionCatalogEntryV1, SessionRegistry } from "../session-registry.js";

export interface SessionDomainActionDependenciesV1 {
  readonly broker: SessionOwnerBroker;
  readonly createEventId: () => string;
  readonly repositories: RepositoryRegistry;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: SessionRegistry;
  readonly timestamp: () => string;
  readonly waitForRetry: (delayMs: number) => Promise<void>;
}

async function openSessionWriter(
  dependencies: SessionDomainActionDependenciesV1,
  repositoryRoot: string,
  sessionId: string,
): Promise<V2SessionWriter> {
  for (let attempt = 0; attempt < 512; attempt += 1) {
    try {
      return await V2SessionWriter.openExisting(repositoryRoot, sessionId, {
        createEventId: dependencies.createEventId,
        timestamp: dependencies.timestamp,
      });
    } catch (error) {
      if (!(error instanceof SessionLockError) || error.code !== "active_session_lock" || attempt === 511) {
        throw error;
      }
      await dependencies.waitForRetry(10);
    }
  }
  throw new ApplicationControlError("control_operation_busy", "bounded session writer acquisition did not converge");
}

export function applicationOperationId(event: DecodedStoredEvent): string | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const data = event.data as Readonly<Record<string, unknown>>;
  const direct = data.application_commit;
  if (typeof direct === "object" && direct !== null && "operation_id" in direct) {
    return String((direct as Readonly<Record<string, unknown>>).operation_id);
  }
  const origin = data.origin;
  if (typeof origin !== "object" || origin === null || !("application_commit" in origin)) return null;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof commit === "object" && commit !== null && "operation_id" in commit
    ? String((commit as Readonly<Record<string, unknown>>).operation_id)
    : null;
}

function exactApplicationCommit(
  event: DecodedStoredEvent,
  binding: ApplicationActionExecutionContextV1["applicationCommit"],
): boolean {
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Readonly<Record<string, unknown>>;
  const direct = data.application_commit;
  const origin = data.origin;
  const candidate = typeof direct === "object" && direct !== null
    ? direct
    : typeof origin === "object" && origin !== null
      ? (origin as Readonly<Record<string, unknown>>).application_commit
      : null;
  if (typeof candidate !== "object" || candidate === null) return false;
  const commit = candidate as Readonly<Record<string, unknown>>;
  return commit.schema_version === binding.schemaVersion &&
    commit.operation_id === binding.operationId &&
    commit.action_kind === binding.actionKind &&
    commit.prepared_action_sha256 === binding.preparedActionSha256 &&
    commit.principal_id === binding.principalId &&
    commit.authorization_decision_sha256 === binding.authorizationDecisionSha256;
}

export function sessionEventReference(
  writer: V2SessionWriter,
  event: DecodedStoredEvent,
): DurableRecordReferenceV1 {
  const identity = writer.readDurableEventIdentity(event.eventId);
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session",
    recordId: event.eventId,
    recordSha256: identity.rawEventSha256,
    sequence: event.sessionSeq,
  });
}

function sameHead(left: SessionLedgerHeadV1, right: SessionLedgerHeadV1): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function boundedTrailingEvents(
  events: readonly DecodedStoredEvent[],
  lastOwnedSequence: number,
  allowedTypes: readonly string[],
): readonly DecodedStoredEvent[] {
  const trailing: DecodedStoredEvent[] = [];
  for (const event of events.slice(lastOwnedSequence)) {
    if (!allowedTypes.includes(event.type)) break;
    trailing.push(event);
  }
  return Object.freeze(trailing);
}

async function entryFor(
  dependencies: SessionDomainActionDependenciesV1,
  repositoryId: string,
  sessionId: string,
): Promise<SessionCatalogEntryV1> {
  const catalog = await dependencies.sessions.project(repositoryId);
  const entry = catalog.entries.find((candidate) => candidate.sessionId === sessionId);
  if (entry === undefined) {
    throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
  }
  return entry;
}

export async function resolveExistingSessionActionTarget(
  dependencies: SessionDomainActionDependenciesV1,
  target: ApplicationActionTargetV1,
): Promise<ResolvedApplicationTargetV1> {
  if (
    target.kind !== "existing_resource" ||
    target.resourceScope.kind !== "session" ||
    target.expectedVersion.kind !== "session_ledger_head"
  ) {
    throw new ApplicationControlError("control_target_invalid", "session action target is invalid");
  }
  const snapshot = await dependencies.sessionProjection.read({
    repositoryId: target.resourceScope.repositoryId,
    requestedHead: target.expectedVersion.head,
    sessionId: target.resourceScope.sessionId,
  });
  const targetIdentity = Object.freeze({
    projection_identity: snapshot.projection.identity,
    session_id: target.resourceScope.sessionId,
  });
  return Object.freeze({
    resourceScope: snapshot.resourceScope,
    resourceVersion: Object.freeze({ head: snapshot.head.publicHead, kind: "session_ledger_head" as const }),
    targetIdentity,
    targetIdentitySha256: sha256Canonical(targetIdentity),
  });
}

/**
 * PHASE21: application actions borrow the existing session owner; they never
 * become a second domain authority. The raw writer stays behind this adapter.
 */
interface SessionDomainActionInputV1<TResult> {
  readonly context: ApplicationActionExecutionContextV1;
  readonly dependencies: SessionDomainActionDependenciesV1;
  readonly execute: (input: Readonly<{
    readonly mutationContext: TaskMutationContext;
    readonly writerFactory: TaskMutationWriterFactory;
  }>) => Promise<TResult>;
  readonly allowedTrailingEventTypes?: readonly string[];
  readonly expectedEventTypes: readonly string[];
  readonly prepared: PreparedActionV1;
  readonly recover: (
    session: ReconstructedMultiRunSession,
    ownedEvents: readonly DecodedStoredEvent[],
  ) => TResult;
  readonly reconcileOnly?: boolean;
}

export function executeSessionDomainAction<TResult>(
  input: SessionDomainActionInputV1<TResult> & Readonly<{ readonly reconcileOnly: true }>,
): Promise<ApplicationActionExecutionResultV1<TResult> | null>;
export function executeSessionDomainAction<TResult>(
  input: SessionDomainActionInputV1<TResult> & Readonly<{ readonly reconcileOnly?: false }>,
): Promise<ApplicationActionExecutionResultV1<TResult>>;
export async function executeSessionDomainAction<TResult>(
  input: SessionDomainActionInputV1<TResult>,
): Promise<ApplicationActionExecutionResultV1<TResult> | null> {
  const scope = input.context.resolvedTarget.resourceScope;
  const version = input.context.resolvedTarget.resourceVersion;
  if (scope.kind !== "session" || version.kind !== "session_ledger_head" || version.head.sequence === 0) {
    throw new ApplicationControlError("control_session_not_started", "session domain mutation requires a materialized session");
  }
  try {
    return await input.dependencies.broker.serialize(scope.sessionId, async () => {
    if (input.dependencies.broker.activePort(scope.sessionId) !== null) {
      throw new ApplicationControlError("control_operation_busy", "session already has an active in-process owner");
    }
    const entry = await entryFor(input.dependencies, scope.repositoryId, scope.sessionId);
    const repository = await input.dependencies.repositories.get(scope.repositoryId);
    if (repository === null || repository.status !== "active") {
      throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
    }
    const repositoryRoot = await input.dependencies.repositories.readRoot(repository);
    const writer = await openSessionWriter(input.dependencies, repositoryRoot, scope.sessionId);
    const readPort = input.dependencies.sessionProjection.activeReadPort({ entry, writer });
    const release = input.dependencies.broker.register(scope.sessionId, readPort);
    try {
      const before = await readPort.readStableSnapshot();
      const existingOperationEvents = writer.events.filter(
        (event) => applicationOperationId(event) === input.context.operationId,
      );
      if (existingOperationEvents.some((event) =>
        !exactApplicationCommit(event, input.context.applicationCommit)
      )) {
        throw new ApplicationControlError(
          "control_operation_busy",
          "operation-owned session facts have a mismatched application commit binding",
        );
      }
      const existingOwned = existingOperationEvents;
      if (existingOwned.length === 0 && !sameHead(before.head.publicHead, version.head)) {
        throw new ApplicationControlError("control_stale_projection", "session changed before domain mutation");
      }
      const existingTrailing = existingOwned.length === 0
        ? []
        : boundedTrailingEvents(
            writer.events,
            existingOwned.at(-1)!.sessionSeq,
            input.allowedTrailingEventTypes ?? [],
          );
      if (existingOwned.some((event) => !input.expectedEventTypes.includes(event.type))) {
        throw new ApplicationControlError(
          "control_operation_busy",
          "operation-owned session facts cannot be reconciled exactly",
        );
      }
      if (existingOwned.length === 0 && input.reconcileOnly === true) return null;
      const mutationContext: TaskMutationContext = Object.freeze({
        authenticatedApplication: Object.freeze({
          actionIdentitySha256: sha256Canonical({
            application_commit: input.context.applicationCommit,
            resource_scope: scope,
            schema_version: 1,
          }),
          applicationCommit: input.context.applicationCommit,
          authenticationId: input.context.call.principal.authenticationId,
          requestId: input.context.requestId,
          surface: input.context.call.surface,
        }),
        expectedSessionSeq: existingOwned.length === 0 ? version.head.sequence : writer.events.length,
        inputSurface: input.context.call.surface.surface === "tui" ? "tui" : "cli",
        now: input.dependencies.timestamp,
        randomUuid: input.dependencies.createEventId,
        sessionId: scope.sessionId,
        workspace: repositoryRoot,
      });
      const existingEnd = existingTrailing.at(-1) ?? existingOwned.at(-1);
      const result = existingOwned.length === 0
        ? await input.execute({
            mutationContext,
            writerFactory: borrowedTaskMutationWriterFactory(writer),
          })
        : input.recover(
            reconstructMultiRunSession(writer.events.slice(0, existingEnd!.sessionSeq)),
            existingOwned,
          );
      const operationEvents = writer.events.filter(
        (event) => applicationOperationId(event) === input.context.operationId,
      );
      if (operationEvents.some((event) =>
        !exactApplicationCommit(event, input.context.applicationCommit)
      )) {
        throw new ApplicationControlError(
          "control_operation_busy",
          "domain owner returned a mismatched application commit binding",
        );
      }
      const owned = operationEvents;
      if (owned.length === 0 || owned.some((event) => !input.expectedEventTypes.includes(event.type))) {
        throw new ApplicationControlError("control_operation_busy", "domain owner returned without an exact application fact");
      }
      const references = Object.freeze(owned.map((event) => sessionEventReference(writer, event)));
      const allAfterOwned = writer.events.filter((event) => event.sessionSeq > owned.at(-1)!.sessionSeq);
      const trailing = boundedTrailingEvents(
        writer.events,
        owned.at(-1)!.sessionSeq,
        input.allowedTrailingEventTypes ?? [],
      );
      if (
        existingOwned.length === 0 &&
        allAfterOwned.some((event) => !(input.allowedTrailingEventTypes ?? []).includes(event.type))
      ) {
        throw new ApplicationControlError("control_operation_busy", "domain owner appended an unregistered trailing fact");
      }
      const underlying = Object.freeze(trailing.map((event) => sessionEventReference(writer, event)));
      const operationTail = underlying.at(-1) ?? references.at(-1)!;
      if (operationTail.sequence === null) {
        throw new ApplicationControlError("control_operation_corrupt", "session operation reference has no sequence");
      }
      // A linked operation owns this exact bounded prefix, not whatever tail
      // a later independent application operation has since appended.
      const operationHead = input.dependencies.sessionProjection.hostHeadForExactWriterEvent({
        eventId: operationTail.recordId,
        rawEventSha256: operationTail.recordSha256,
        sequence: operationTail.sequence,
        sessionId: scope.sessionId,
        writer,
      });
      return Object.freeze({
        domainRecordRefs: references,
        primaryDomainRecord: references[0]!,
        resolvedResourceScope: scope,
        resolvedResourceVersion: Object.freeze({ head: operationHead, kind: "session_ledger_head" as const }),
        result,
        underlyingOperationRefs: underlying,
      });
    } finally {
      release();
      await writer.close().catch(() => undefined);
    }
    });
  } catch (error) {
    if (error instanceof ApplicationControlError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    const message = error instanceof Error ? error.message : "domain action failed";
    if (/busy|reconciliation|required|parallel_limit/u.test(code)) {
      throw new ApplicationControlError("control_operation_busy", message, { cause: error });
    }
    if (/stale|conflict|not_found|revision|binding|goal_|plan_/u.test(code)) {
      throw new ApplicationControlError("control_stale_projection", message, { cause: error });
    }
    if (/invalid|unsupported|authority|schema/u.test(code)) {
      throw new ApplicationControlError("control_target_invalid", message, { cause: error });
    }
    throw error;
  }
}

export function reconcileSessionDomainAction<TResult>(
  input: Omit<SessionDomainActionInputV1<TResult>, "execute" | "reconcileOnly">,
): Promise<ApplicationActionExecutionResultV1<TResult> | null> {
  return executeSessionDomainAction({
    ...input,
    execute: async () => {
      throw new ApplicationControlError(
        "control_operation_busy",
        "reconciliation attempted to dispatch a new domain mutation",
      );
    },
    reconcileOnly: true,
  });
}
