import type { CliIO, CliRuntime } from "../../cli/types.js";
import type {
  ApplicationEnvelopeV1,
  ApplicationPaginationCursorV1,
  DeliveryCursorV1,
  ExpectedResourceVersionV1,
  ProjectionIdentityV1,
  SessionLedgerHeadV1,
} from "../application-protocol.js";
import type { ApplicationQueryPageV1 } from "../application-query-registry.js";
import type {
  ProductSessionProjectionBodyV1,
  SessionDisplayProjectionV1,
  SessionTuiDisplayEventV1,
} from "../session-projection-service.js";
import type { PublicSessionCatalogEntry } from "../../sessions/session-catalog.js";
import {
  adoptLegacySessionThroughApplicationService,
  contextForRuntime,
  planeForRuntime,
  registerCurrentRepository,
} from "./agent-cli-adapter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLI_EVENT_PAGE_LIMIT = 25;
const CLI_EVENT_OUTPUT_LIMIT = 200;
const CLI_EVENT_PAGE_MAXIMUM = Math.ceil(CLI_EVENT_OUTPUT_LIMIT / CLI_EVENT_PAGE_LIMIT);
const FORBIDDEN_PRESENTATION_KEYS = new Set([
  "application_cancel_request",
  "application_commit",
  "first_raw_event_sha256",
  "raw_event_sha256",
  "request_event_sha256",
  "session_file_path",
]);

export type SessionCliCatalogEntryV1 = PublicSessionCatalogEntry & Readonly<{
  readonly catalogState: "legacy_unadopted" | "registered";
  readonly materialization: "materialized" | "not_started" | "pending_or_unknown";
}>;

export interface SessionCliListResultV1 {
  readonly diagnostics: Readonly<{
    readonly bytes: number;
    readonly filesDiscovered: number;
    readonly filesScanned: number;
    readonly truncated: boolean;
  }>;
  readonly entries: readonly SessionCliCatalogEntryV1[];
}

export interface SessionCliShowResultV1 {
  readonly events: readonly SessionTuiDisplayEventV1[] | null;
  readonly eventsTruncated: boolean;
  readonly ledgerHead: SessionLedgerHeadV1;
  readonly projection: ProductSessionProjectionBodyV1 & Readonly<{ readonly display: SessionDisplayProjectionV1 }>;
  readonly projectionIdentity: ProjectionIdentityV1;
  readonly resourceVersion: Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }>;
}

export type SessionCliQueryResultV1<TResult> = Readonly<{
  readonly exitCode: 0 | 1 | 2 | 8;
  readonly value: TResult | null;
}>;

function failureExit(envelope: ApplicationEnvelopeV1<unknown>): 1 | 2 | 8 {
  const code = envelope.error?.code ?? "control_operation_corrupt";
  if ([
    "control_catalog_conflict",
    "control_operation_busy",
    "control_resync_required",
    "control_session_not_started",
    "control_stale_projection",
  ].includes(code)) return 8;
  return [
    "control_authentication_failed",
    "control_authorization_denied",
    "control_payload_invalid",
    "control_target_invalid",
    "control_unknown_query",
  ].includes(code) ? 2 : 1;
}

function failure<TResult>(
  envelope: ApplicationEnvelopeV1<unknown>,
  io: CliIO,
): SessionCliQueryResultV1<TResult> {
  io.stderr.write(`${envelope.error?.code ?? "control_operation_corrupt"}: ${envelope.error?.message ?? "application query failed"}\n`);
  return Object.freeze({ exitCode: failureExit(envelope), value: null });
}

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, depth + 1));
  return Object.entries(value as Readonly<Record<string, unknown>>).some(
    ([key, entry]) => FORBIDDEN_PRESENTATION_KEYS.has(key) || containsForbiddenKey(entry, depth + 1),
  );
}

function isCatalogEntry(value: unknown): value is SessionCliCatalogEntryV1 {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<SessionCliCatalogEntryV1>;
  return UUID.test(entry.sessionId ?? "") &&
    Number.isSafeInteger(entry.changedCount) && (entry.changedCount ?? -1) >= 0 &&
    (entry.lastTimestamp === null || typeof entry.lastTimestamp === "string") &&
    (entry.model === null || typeof entry.model === "string") &&
    (entry.provider === null || typeof entry.provider === "string") &&
    typeof entry.resumeStatus === "string" &&
    typeof entry.status === "string" &&
    typeof entry.taskSummary === "string" &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.catalogState === "legacy_unadopted" || entry.catalogState === "registered") &&
    (entry.materialization === "materialized" || entry.materialization === "not_started" || entry.materialization === "pending_or_unknown");
}

function isDiagnostics(value: unknown): value is SessionCliListResultV1["diagnostics"] {
  if (typeof value !== "object" || value === null) return false;
  const diagnostics = value as Partial<SessionCliListResultV1["diagnostics"]>;
  return Number.isSafeInteger(diagnostics.bytes) && (diagnostics.bytes ?? -1) >= 0 &&
    Number.isSafeInteger(diagnostics.filesDiscovered) && (diagnostics.filesDiscovered ?? -1) >= 0 &&
    Number.isSafeInteger(diagnostics.filesScanned) && (diagnostics.filesScanned ?? -1) >= 0 &&
    typeof diagnostics.truncated === "boolean";
}

function isProjection(
  value: unknown,
  repositoryId: string,
  sessionId: string,
): value is ProductSessionProjectionBodyV1 & Readonly<{ readonly display: SessionDisplayProjectionV1 }> {
  if (typeof value !== "object" || value === null) return false;
  const projection = value as Partial<ProductSessionProjectionBodyV1>;
  return projection.schemaVersion === 1 &&
    projection.repositoryId === repositoryId &&
    projection.sessionId === sessionId &&
    typeof projection.display === "object" && projection.display !== null &&
    !containsForbiddenKey(projection);
}

function isDisplayEvent(
  value: unknown,
  sessionId: string,
  expectedSequence: number,
): value is SessionTuiDisplayEventV1 {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<SessionTuiDisplayEventV1>;
  return UUID.test(event.eventId ?? "") &&
    event.sessionId === sessionId &&
    event.sessionSeq === expectedSequence &&
    (event.scope === "run" || event.scope === "session") &&
    typeof event.timestamp === "string" &&
    typeof event.type === "string" && event.type.length > 0 &&
    Number.isSafeInteger(event.sourceSchemaVersion) &&
    !containsForbiddenKey(event.data) &&
    (event.scope === "session"
      ? event.runId === undefined && event.runSeq === undefined
      : UUID.test(event.runId ?? "") && Number.isSafeInteger(event.runSeq) && (event.runSeq ?? 0) > 0);
}

function sessionVersion(
  envelope: ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>,
  repositoryId: string,
  sessionId: string,
): Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }> | null {
  return envelope.resourceScope?.kind === "session" &&
      envelope.resourceScope.repositoryId === repositoryId &&
      envelope.resourceScope.sessionId === sessionId &&
      envelope.resourceVersion?.kind === "session_ledger_head"
    ? envelope.resourceVersion
    : null;
}

export async function querySessionsListThroughApplicationService(input: Readonly<{
  readonly io: CliIO;
  readonly limit: number;
  readonly runtime: CliRuntime;
}>): Promise<SessionCliQueryResultV1<SessionCliListResultV1>> {
  if (input.runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("application control state root is unavailable");
  }
  const plane = await planeForRuntime(input.runtime, input.io);
  const context = contextForRuntime(plane, input.runtime, "cli");
  const repository = await registerCurrentRepository(plane, context, input.runtime, input.io);
  if (!("repositoryId" in repository)) return failure(repository, input.io);
  const response = await plane.queries.query(context, {
    atVersion: null,
    pageCursor: null,
    payload: { limit: 200 },
    queryKind: "session.list",
    requestId: input.runtime.randomUUID(),
    resourceScope: plane.sessions.resourceScope(repository.repositoryId),
    schemaVersion: 1,
  });
  if (response.status !== "ok" || response.result === null) return failure(response, input.io);
  const raw = response.result.value;
  if (typeof raw !== "object" || raw === null) return failure(Object.freeze({
    ...response,
    error: Object.freeze({ code: "control_operation_corrupt", message: "session list query returned an invalid projection" }),
    result: null,
    status: "rejected" as const,
  }), input.io);
  const value = raw as Readonly<{ readonly diagnostics?: unknown; readonly sessions?: unknown }>;
  if (!isDiagnostics(value.diagnostics) || !Array.isArray(value.sessions) || !value.sessions.every(isCatalogEntry)) {
    return failure(Object.freeze({
      ...response,
      error: Object.freeze({ code: "control_operation_corrupt", message: "session list query failed its typed result contract" }),
      result: null,
      status: "rejected" as const,
    }), input.io);
  }
  const entries = Object.freeze(value.sessions.slice(0, input.limit));
  return Object.freeze({
    exitCode: 0,
    value: Object.freeze({
      diagnostics: Object.freeze({
        ...value.diagnostics,
        truncated: value.diagnostics.truncated || response.result.nextPageCursor !== null || value.sessions.length > input.limit,
      }),
      entries,
    }),
  });
}

async function queryEventPages(input: Readonly<{
  readonly context: ReturnType<typeof contextForRuntime>;
  readonly io: CliIO;
  readonly plane: Awaited<ReturnType<typeof planeForRuntime>>;
  readonly repositoryId: string;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<SessionCliQueryResultV1<Readonly<{
  readonly events: readonly SessionTuiDisplayEventV1[];
  readonly eventsTruncated: boolean;
  readonly ledgerHead: SessionLedgerHeadV1;
  readonly projectionIdentity: ProjectionIdentityV1;
  readonly version: Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }>;
}>>> {
  const scope = Object.freeze({
    kind: "session" as const,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    teamId: null,
  });
  const events: SessionTuiDisplayEventV1[] = [];
  let atVersion: ExpectedResourceVersionV1 | null = null;
  let deliveryCursor: DeliveryCursorV1 | null = null;
  let ledgerHead: SessionLedgerHeadV1 | null = null;
  let pageCursor: ApplicationPaginationCursorV1 | null = null;
  let projectionIdentity: ProjectionIdentityV1 | null = null;
  for (let pageNumber = 0; pageNumber < CLI_EVENT_PAGE_MAXIMUM; pageNumber += 1) {
    const response = await input.plane.queries.query(input.context, {
      atVersion,
      deliveryCursor,
      pageCursor,
      payload: { limit: CLI_EVENT_PAGE_LIMIT },
      queryKind: "session.events_page",
      requestId: input.runtime.randomUUID(),
      resourceScope: scope,
      schemaVersion: 1,
    });
    if (response.status !== "ok" || response.result === null) return failure(response, input.io);
    const version = sessionVersion(response, input.repositoryId, input.sessionId);
    const raw = response.result.value;
    if (
      version === null || response.ledgerHead === null || response.projectionIdentity === null ||
      response.deliveryCursor === null || typeof raw !== "object" || raw === null ||
      !Array.isArray((raw as { readonly displayEvents?: unknown }).displayEvents)
    ) {
      return failure(Object.freeze({
        ...response,
        error: Object.freeze({ code: "control_operation_corrupt", message: "session events query returned incomplete authorities" }),
        result: null,
        status: "rejected" as const,
      }), input.io);
    }
    if (atVersion !== null && JSON.stringify(atVersion) !== JSON.stringify(version)) {
      return failure(Object.freeze({
        ...response,
        error: Object.freeze({ code: "control_resync_required", message: "session events changed exact resource version" }),
        result: null,
        status: "resync_required" as const,
      }), input.io);
    }
    const candidates = (raw as { readonly displayEvents: readonly unknown[] }).displayEvents;
    if (candidates.length > CLI_EVENT_PAGE_LIMIT || candidates.some((event, index) =>
      !isDisplayEvent(event, input.sessionId, events.length + index + 1))) {
      return failure(Object.freeze({
        ...response,
        error: Object.freeze({ code: "control_operation_corrupt", message: "session events query failed its typed display contract" }),
        result: null,
        status: "rejected" as const,
      }), input.io);
    }
    events.push(...candidates as readonly SessionTuiDisplayEventV1[]);
    atVersion = version;
    deliveryCursor = response.deliveryCursor;
    ledgerHead = response.ledgerHead;
    pageCursor = response.result.nextPageCursor;
    projectionIdentity = response.projectionIdentity;
    if (pageCursor === null) break;
  }
  if (atVersion?.kind !== "session_ledger_head" || ledgerHead === null || projectionIdentity === null) {
    throw new TypeError("session events query did not establish an exact version");
  }
  return Object.freeze({
    exitCode: 0,
    value: Object.freeze({
      events: Object.freeze(events),
      eventsTruncated: pageCursor !== null,
      ledgerHead,
      projectionIdentity,
      version: atVersion,
    }),
  });
}

export async function querySessionShowThroughApplicationService(input: Readonly<{
  readonly includeEvents: boolean;
  readonly io: CliIO;
  readonly runtime: CliRuntime;
  readonly sessionId: string;
}>): Promise<SessionCliQueryResultV1<SessionCliShowResultV1>> {
  if (input.runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("application control state root is unavailable");
  }
  const plane = await planeForRuntime(input.runtime, input.io);
  const context = contextForRuntime(plane, input.runtime, "cli");
  const repository = await registerCurrentRepository(plane, context, input.runtime, input.io);
  if (!("repositoryId" in repository)) return failure(repository, input.io);
  const adopted = await adoptLegacySessionThroughApplicationService(
    plane,
    context,
    input.runtime,
    repository.repositoryId,
    input.sessionId,
    input.io,
  );
  if ("status" in adopted) return failure(adopted, input.io);
  const eventProjection = input.includeEvents
    ? await queryEventPages({
        context,
        io: input.io,
        plane,
        repositoryId: repository.repositoryId,
        runtime: input.runtime,
        sessionId: input.sessionId,
      })
    : null;
  if (eventProjection !== null && eventProjection.value === null) {
    return Object.freeze({ exitCode: eventProjection.exitCode, value: null });
  }
  const requestedVersion = eventProjection?.value?.version ?? null;
  const response = await plane.queries.query(context, {
    atVersion: requestedVersion,
    pageCursor: null,
    payload: {},
    queryKind: "session.view",
    requestId: input.runtime.randomUUID(),
    resourceScope: {
      kind: "session",
      repositoryId: repository.repositoryId,
      sessionId: input.sessionId,
      teamId: null,
    },
    schemaVersion: 1,
  });
  if (response.status !== "ok" || response.result === null) return failure(response, input.io);
  const version = sessionVersion(response, repository.repositoryId, input.sessionId);
  if (
    version === null || response.ledgerHead === null || response.projectionIdentity === null ||
    !isProjection(response.result.value, repository.repositoryId, input.sessionId)
  ) {
    return failure(Object.freeze({
      ...response,
      error: Object.freeze({ code: "control_operation_corrupt", message: "session view query failed its typed result contract" }),
      result: null,
      status: "rejected" as const,
    }), input.io);
  }
  return Object.freeze({
    exitCode: 0,
    value: Object.freeze({
      events: eventProjection?.value?.events ?? null,
      eventsTruncated: eventProjection?.value?.eventsTruncated ?? false,
      ledgerHead: response.ledgerHead,
      projection: response.result.value,
      projectionIdentity: response.projectionIdentity,
      resourceVersion: version,
    }),
  });
}
