import type { CliIO, CliRuntime } from "../cli/types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import {
  adoptLegacySessionThroughApplicationService,
  contextForRuntime,
  planeForRuntime,
  registerCurrentRepository,
} from "../control-plane/adapters/agent-cli-adapter.js";
import type {
  ApplicationEnvelopeV1,
  ApplicationPaginationCursorV1,
  ApplicationQueryRequestV1,
  AuthenticatedCallContextV1,
  DeliveryCursorV1,
  ExpectedResourceVersionV1,
  ProjectionIdentityV1,
  SessionLedgerHeadV1,
} from "../control-plane/application-protocol.js";
import type { ApplicationQueryPageV1 } from "../control-plane/application-query-registry.js";
import type { SessionDeliveryCoordinator } from "../control-plane/delivery-cursor.js";
import type {
  ProductSessionProjectionBodyV1,
  SessionTuiDisplayEventV1,
} from "../control-plane/session-projection-service.js";
import type { DefaultApplicationQueryService } from "../control-plane/application-query-service.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TUI_PAGE_LIMIT = 100;
const TUI_MAXIMUM_PAGES = 10_000;
const FORBIDDEN_PRESENTATION_KEYS = new Set([
  "application_cancel_request",
  "application_commit",
  "first_raw_event_sha256",
  "raw_event_sha256",
  "request_event_sha256",
  "session_file_path",
]);

type SessionScope = Readonly<{
  kind: "session";
  repositoryId: string;
  sessionId: string;
  teamId: null;
}>;

export interface TuiSessionProjectionSnapshotV1 {
  readonly deliveryCursor: DeliveryCursorV1;
  readonly events: readonly TuiPersistedEvent[];
  readonly ledgerHead: SessionLedgerHeadV1;
  readonly projection: ProductSessionProjectionBodyV1;
  readonly projectionIdentity: ProjectionIdentityV1;
  readonly resourceVersion: Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }>;
  readonly schemaVersion: 1;
}

export class TuiSessionProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TuiSessionProjectionError";
  }
}

export interface TuiSessionProjectionBackendV1 {
  readonly context: AuthenticatedCallContextV1;
  readonly createRequestId: () => string;
  readonly delivery: SessionDeliveryCoordinator;
  readonly ensureSession: (sessionId: string) => Promise<SessionScope>;
  readonly queries: Pick<DefaultApplicationQueryService, "query">;
  readonly subscribeInvalidations: (listener: (sessionId: string) => void) => () => void;
}

function same(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function queryFailure(
  envelope: ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>,
): TuiSessionProjectionError {
  return new TuiSessionProjectionError(
    envelope.error?.code ?? "control_operation_corrupt",
    envelope.error?.message ?? "typed TUI session query failed",
  );
}

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, depth + 1));
  return Object.entries(value as Readonly<Record<string, unknown>>).some(
    ([key, entry]) => FORBIDDEN_PRESENTATION_KEYS.has(key) || containsForbiddenKey(entry, depth + 1),
  );
}

function displayEvent(
  input: unknown,
  scope: SessionScope,
  expectedSequence: number,
): TuiPersistedEvent {
  if (typeof input !== "object" || input === null) {
    throw new TuiSessionProjectionError("control_resync_required", "TUI display page contains a non-object event");
  }
  const event = input as Partial<SessionTuiDisplayEventV1>;
  if (
    !UUID.test(event.eventId ?? "") ||
    event.sessionId !== scope.sessionId ||
    event.sessionSeq !== expectedSequence ||
    (event.scope !== "run" && event.scope !== "session") ||
    typeof event.timestamp !== "string" ||
    typeof event.type !== "string" ||
    event.type.length === 0 ||
    !Number.isSafeInteger(event.sourceSchemaVersion) ||
    containsForbiddenKey(event.data) ||
    (event.scope === "run" &&
      (!UUID.test(event.runId ?? "") || !Number.isSafeInteger(event.runSeq) || (event.runSeq ?? 0) < 1)) ||
    (event.scope === "session" && (event.runId !== undefined || event.runSeq !== undefined))
  ) {
    throw new TuiSessionProjectionError(
      "control_resync_required",
      `TUI display event ${String(expectedSequence)} failed its strict presentation contract`,
    );
  }
  return Object.freeze({ ...event }) as TuiPersistedEvent;
}

function projectionBody(value: unknown, scope: SessionScope): ProductSessionProjectionBodyV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<ProductSessionProjectionBodyV1>).schemaVersion !== 1 ||
    (value as Partial<ProductSessionProjectionBodyV1>).sessionId !== scope.sessionId ||
    (value as Partial<ProductSessionProjectionBodyV1>).repositoryId !== scope.repositoryId
  ) {
    throw new TuiSessionProjectionError("control_resync_required", "TUI projection body has the wrong session identity");
  }
  return value as ProductSessionProjectionBodyV1;
}

export class TuiSessionProjectionPort {
  constructor(private readonly backend: TuiSessionProjectionBackendV1) {}

  async load(sessionId: string): Promise<TuiSessionProjectionSnapshotV1> {
    let lastStale: TuiSessionProjectionError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.loadOnce(sessionId);
      } catch (error) {
        const normalized = error instanceof TuiSessionProjectionError
          ? error
          : new TuiSessionProjectionError("control_operation_corrupt", "typed TUI projection failed", { cause: error });
        if (normalized.code !== "control_stale_projection") throw normalized;
        lastStale = normalized;
      }
    }
    throw lastStale ?? new TuiSessionProjectionError("control_stale_projection", "typed TUI projection remained stale");
  }

  subscribeInvalidations(listener: (sessionId: string) => void): () => void {
    return this.backend.subscribeInvalidations(listener);
  }

  private async loadOnce(sessionId: string): Promise<TuiSessionProjectionSnapshotV1> {
    const scope = await this.backend.ensureSession(sessionId);
    const full = await this.backend.queries.query(this.backend.context, this.request({
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "session.view",
      scope,
    }));
    if (full.status !== "ok" || full.result === null) throw queryFailure(full);
    try {
      return await this.completeExactSnapshot(scope, full);
    } catch (error) {
      const normalized = error instanceof TuiSessionProjectionError
        ? error
        : new TuiSessionProjectionError("control_resync_required", "TUI exact snapshot validation failed", { cause: error });
      // A transient active-writer lock or an authorization/payload rejection
      // says nothing about the identity of the full snapshot that was just
      // installed. Freezing delivery for those failures can permanently block
      // the very typed safety action that is meant to stop the active owner.
      // Only an actual presentation/cursor integrity failure is sticky; a
      // later full view remains the sole thaw path for that class.
      if (
        normalized.code === "control_resync_required" ||
        normalized.code === "control_operation_corrupt" ||
        normalized.code === "control_session_history_missing_or_corrupt"
      ) {
        this.backend.delivery.requireFullResync(this.backend.context, scope.sessionId, "event_identity_mismatch");
      }
      throw normalized;
    }
  }

  private async completeExactSnapshot(
    scope: SessionScope,
    full: ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>,
  ): Promise<TuiSessionProjectionSnapshotV1> {
    if (
      full.resourceScope?.kind !== "session" ||
      !same(full.resourceScope, scope) ||
      full.resourceVersion?.kind !== "session_ledger_head" ||
      full.ledgerHead === null ||
      full.deliveryCursor === null ||
      full.projectionIdentity === null ||
      !same(full.resourceVersion.head, full.ledgerHead) ||
      !same(full.projectionIdentity.ledgerHead, full.ledgerHead) ||
      full.deliveryCursor.sessionId !== scope.sessionId ||
      full.deliveryCursor.afterSequence !== full.ledgerHead.sequence ||
      full.deliveryCursor.afterEventId !== full.ledgerHead.eventId ||
      full.deliveryCursor.afterEventIntegrityToken !== full.ledgerHead.eventIntegrityToken
    ) {
      throw new TuiSessionProjectionError("control_resync_required", "TUI full snapshot authorities disagree");
    }
    const projection = projectionBody(full.result!.value, scope);
    const version = full.resourceVersion as Extract<ExpectedResourceVersionV1, { readonly kind: "session_ledger_head" }>;
    const events: TuiPersistedEvent[] = [];
    let pageCursor: ApplicationPaginationCursorV1 | null = null;
    for (let pageNumber = 0; pageNumber < TUI_MAXIMUM_PAGES; pageNumber += 1) {
      const page = await this.backend.queries.query(this.backend.context, this.request({
        atVersion: version,
        pageCursor,
        payload: { limit: TUI_PAGE_LIMIT },
        queryKind: "session.tui_events_page",
        scope,
      }));
      if (page.status !== "ok" || page.result === null) throw queryFailure(page);
      if (
        !same(page.resourceScope, scope) ||
        !same(page.resourceVersion, version) ||
        !same(page.ledgerHead, full.ledgerHead) ||
        !same(page.projectionIdentity, full.projectionIdentity) ||
        page.deliveryCursor !== null ||
        typeof page.result.value !== "object" ||
        page.result.value === null ||
        !Array.isArray((page.result.value as { readonly events?: unknown }).events)
      ) {
        throw new TuiSessionProjectionError("control_resync_required", "TUI event page changed exact snapshot authority");
      }
      const candidates = (page.result.value as { readonly events: readonly unknown[] }).events;
      if (candidates.length > TUI_PAGE_LIMIT) {
        throw new TuiSessionProjectionError("control_resync_required", "TUI event page exceeded its item bound");
      }
      for (const candidate of candidates) {
        events.push(displayEvent(candidate, scope, events.length + 1));
      }
      const next = page.result.nextPageCursor;
      if (next === null) {
        if (events.length !== full.ledgerHead!.sequence) {
          throw new TuiSessionProjectionError("control_resync_required", "TUI event pages do not cover the exact ledger head");
        }
        return Object.freeze({
          deliveryCursor: full.deliveryCursor!,
          events: Object.freeze(events),
          ledgerHead: full.ledgerHead!,
          projection,
          projectionIdentity: full.projectionIdentity!,
          resourceVersion: version,
          schemaVersion: 1,
        });
      }
      if (candidates.length === 0 || (pageCursor !== null && same(pageCursor, next))) {
        throw new TuiSessionProjectionError("control_resync_required", "TUI event pagination made no progress");
      }
      pageCursor = next;
    }
    throw new TuiSessionProjectionError("control_resync_required", "TUI event pagination exceeded its hard page bound");
  }

  private request(input: Readonly<{
    readonly atVersion: ExpectedResourceVersionV1 | null;
    readonly pageCursor: ApplicationPaginationCursorV1 | null;
    readonly payload: unknown;
    readonly queryKind: string;
    readonly scope: SessionScope;
  }>): ApplicationQueryRequestV1 {
    return Object.freeze({
      atVersion: input.atVersion,
      pageCursor: input.pageCursor,
      payload: input.payload,
      queryKind: input.queryKind,
      requestId: this.backend.createRequestId(),
      resourceScope: input.scope,
      schemaVersion: 1,
    });
  }
}

export async function createTuiSessionProjectionPort(
  runtime: CliRuntime,
  io: CliIO,
): Promise<TuiSessionProjectionPort> {
  const plane = await planeForRuntime(runtime, io);
  const context = contextForRuntime(plane, runtime, "tui");
  let repositoryId: string | null = null;
  const ensureRepository = async (): Promise<string> => {
    if (repositoryId !== null) return repositoryId;
    const registered = await registerCurrentRepository(plane, context, runtime, io);
    if (!("repositoryId" in registered)) throw queryFailure(registered as ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>);
    repositoryId = registered.repositoryId;
    return repositoryId;
  };
  return new TuiSessionProjectionPort({
    context,
    createRequestId: runtime.randomUUID,
    delivery: plane.delivery,
    ensureSession: async (sessionId) => {
      const currentRepositoryId = await ensureRepository();
      const adopted = await adoptLegacySessionThroughApplicationService(
        plane,
        context,
        runtime,
        currentRepositoryId,
        sessionId,
        io,
      );
      if ("status" in adopted) {
        throw queryFailure(adopted as ApplicationEnvelopeV1<ApplicationQueryPageV1<unknown>>);
      }
      return Object.freeze({
        kind: "session" as const,
        repositoryId: currentRepositoryId,
        sessionId,
        teamId: null,
      });
    },
    queries: plane.queries,
    subscribeInvalidations: (listener) => plane.broker.subscribeInvalidations(listener),
  });
}
