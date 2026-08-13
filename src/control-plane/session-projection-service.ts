import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { taskMutationBlocker, type TaskMutationBlocker } from "../coordination/task-control-plane.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import { OutcomeReportBuilder, type OutcomeReport } from "../coordination/outcome-report.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { readStoredSession } from "../sessions/read-stored-session.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import {
  buildCanonicalTranscript,
  type CanonicalTranscriptItem,
} from "../sessions/canonical-transcript.js";
import {
  projectPublicSessionCatalogEntry,
  type PublicSessionCatalogEntry,
} from "../sessions/session-catalog.js";
import { SessionLock, SessionLockError } from "../sessions/session-lock.js";
import { SessionPathPolicy } from "../sessions/session-path-policy.js";
import type { TaskGraphProjectionV1 } from "../task-graph/task-graph-projector.js";
import { redactSensitiveText } from "../security/redact.js";
import type { PersistedRuntimePolicyEvidenceV1 } from "../policy/policy-evidence.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
} from "../events/phase16-run-event-extension.js";
import { ApplicationControlError } from "./application-errors.js";
import type { SessionDeliveryEventCheckpointV1 } from "./delivery-cursor.js";
import type {
  PersistedUserActionOriginV2,
  ProjectedUserActionOriginV2,
  ResourceScopeV1,
  SessionLedgerHeadV1,
  SessionProjectionSnapshotV1,
} from "./application-protocol.js";
import { projectUserActionOrigin } from "./application-protocol.js";
import { createSessionProjectionSnapshot } from "./projection-identity.js";
import type { RepositoryRegistry } from "./repository-registry.js";
import type { SessionLedgerHeadSigner} from "./session-ledger-head.js";
import { type SessionStorageHeadV1 } from "./session-ledger-head.js";
import type { SessionOwnerBroker } from "./session-owner-broker.js";
import type { ActiveSessionReadPortV1 } from "./session-owner-broker.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type {
  CatalogHeadV1,
} from "./catalog-journal.js";
import type {
  SessionCatalogEntryV1,
  SessionMaterializationRecordV1,
  SessionRegistry,
} from "./session-registry.js";

export interface ProductSessionProjectionBodyV1 {
  readonly background: unknown;
  readonly blockers: readonly string[];
  readonly delegations: unknown;
  /** Present on every Host-built v1 projection; optional only for pre-21A typed test fixtures. */
  readonly display?: SessionDisplayProjectionV1;
  readonly graphs: readonly unknown[];
  readonly goals: readonly unknown[];
  readonly outcome: "not_started" | "materialization_pending_or_unknown" | "idle" | "running" |
    "budget_exceeded" | "cancelled" | "completed" | "failed" | "incomplete" | "interrupted";
  readonly plans: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly repositoryId: string;
  readonly runs: readonly Readonly<{
    readonly endSessionSeq: number;
    readonly goalId: string | null;
    readonly goalRevision: number | null;
    readonly runId: string;
    readonly startSessionSeq: number;
    readonly status: string;
  }>[];
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly taskExecution: unknown;
  readonly taskGraph: TaskGraphProjectionV1 | null;
  readonly taskMutationBlocker: TaskMutationBlocker | null;
  readonly taskState: TaskStateProjection | null;
  readonly worktrees: unknown;
}

export interface SessionArtifactDisplaySummaryV1 {
  readonly capturedBytes: number;
  readonly objects: readonly Readonly<{
    readonly artifactId: string;
    readonly bytes: number;
    readonly mediaTypes: readonly string[];
    readonly referenceCount: number;
    readonly sha256: string;
    readonly wasCaptureTruncated: boolean;
  }>[];
  readonly objectsTruncated: boolean;
  readonly storedReferences: number;
  readonly truncatedCaptures: number;
  readonly uniqueObjectBytes: number;
  readonly uniqueObjects: number;
}

export interface SessionContextPlanDisplayV1 {
  readonly adapter: string | null;
  readonly adapterEncodingVersion: string | null;
  readonly archivedItemCount: number;
  readonly canonicalContextSha256: string;
  readonly compacted: boolean;
  readonly compactionThreshold: number | null;
  readonly contextWindowTokens: number | null;
  readonly encodedRequestSha256: string | null;
  readonly epoch: number;
  readonly estimatedInputTokens: number;
  readonly includedItemCount: number;
  readonly plannerVersion: string;
  readonly protectedCategories: readonly string[];
  readonly protectedEstimatedTokens: number;
  readonly protectedFactCount: number;
  readonly runId: string;
  readonly step: number;
}

export interface SessionContextDisplaySummaryV1 {
  readonly plans: readonly SessionContextPlanDisplayV1[];
  readonly plansTruncated: boolean;
}

export interface SessionDisplayProjectionV1 {
  readonly artifacts: SessionArtifactDisplaySummaryV1;
  readonly backgroundSummary: Readonly<{
    readonly currentStatus: string | null;
    readonly workerHistoryCount: number;
  }>;
  readonly catalog: PublicSessionCatalogEntry;
  readonly context: SessionContextDisplaySummaryV1;
  readonly outcomeReport: OutcomeReport | null;
  readonly runtimePolicy: PersistedRuntimePolicyEvidenceV1 | "legacy_unrecorded" | null;
  readonly taskExecutionSummary: Readonly<{
    readonly graphId: string;
    readonly graphRevision: number;
    readonly status: string;
    readonly succeededNodes: number;
    readonly totalNodes: number;
  }> | null;
  readonly transcript: readonly CanonicalTranscriptItem[];
  readonly transcriptTruncated: boolean;
}

export interface SessionEventMetadataV1 {
  readonly eventId: string;
  readonly runId: string | null;
  readonly runSequence: number | null;
  readonly scope: "run" | "session";
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly userActionOrigin: ProjectedUserActionOriginV2 | null;
}

/**
 * Local-owner presentation data. This is deliberately a decoded/redacted DTO,
 * not a stored event envelope: raw line hashes, storage paths, and application
 * authorization bindings are never part of the named-query result.
 */
export interface SessionTuiDisplayEventV1 {
  readonly data: unknown;
  readonly eventId: string;
  readonly runId?: string;
  readonly runSeq?: number;
  readonly scope: "run" | "session";
  readonly sessionId: string;
  readonly sessionSeq: number;
  readonly sourceSchemaVersion: number;
  readonly timestamp: string;
  readonly type: string;
}

export interface StableSessionApplicationSnapshotV1 {
  readonly deliveryEvents: readonly SessionDeliveryEventCheckpointV1[];
  readonly eventMetadata: readonly SessionEventMetadataV1[];
  readonly head: SessionStorageHeadV1;
  /** Host-only stable decoded events; never serialized by a query definition. */
  readonly internalEvents?: readonly DecodedStoredEvent[];
  readonly projection: SessionProjectionSnapshotV1<ProductSessionProjectionBodyV1>;
  readonly resourceScope: Extract<ResourceScopeV1, { readonly kind: "session" }>;
  readonly tuiDisplayEvents: readonly SessionTuiDisplayEventV1[];
}

const TUI_DISPLAY_STRING_MAXIMUM = 16 * 1024;
const TUI_DISPLAY_ARRAY_MAXIMUM = 256;
const TUI_DISPLAY_OBJECT_KEYS_MAXIMUM = 256;
const TUI_DISPLAY_DEPTH_MAXIMUM = 16;
const SESSION_DISPLAY_ITEM_MAXIMUM = 200;
const SESSION_DISPLAY_TRANSCRIPT_MAXIMUM_BYTES = 128 * 1024;
const TUI_HIDDEN_AUTHORITY_KEYS = new Set([
  "application_cancel_request",
  "application_commit",
  "first_raw_event_sha256",
  "raw_event_sha256",
  "request_event_sha256",
  "session_file_path",
]);

function displayValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    return redacted.length <= TUI_DISPLAY_STRING_MAXIMUM
      ? redacted
      : `${redacted.slice(0, TUI_DISPLAY_STRING_MAXIMUM)}[display truncated]`;
  }
  if (depth >= TUI_DISPLAY_DEPTH_MAXIMUM) return "[display depth truncated]";
  if (Array.isArray(value)) {
    const selected = value.slice(0, TUI_DISPLAY_ARRAY_MAXIMUM).map((entry) => displayValue(entry, depth + 1));
    if (value.length > selected.length) selected.push("[display array truncated]");
    return Object.freeze(selected);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([key]) => !TUI_HIDDEN_AUTHORITY_KEYS.has(key))
      .slice(0, TUI_DISPLAY_OBJECT_KEYS_MAXIMUM)
      .map(([key, entry]) => [key, displayValue(entry, depth + 1)] as const);
    return Object.freeze(Object.fromEntries(entries));
  }
  return null;
}

function tuiDisplayEvents(events: readonly DecodedStoredEvent[]): readonly SessionTuiDisplayEventV1[] {
  return Object.freeze(events.map((event) => Object.freeze({
    data: displayValue(event.data),
    eventId: event.eventId,
    ...(event.scope === "run" ? { runId: event.runId, runSeq: event.runSeq } : {}),
    scope: event.scope,
    sessionId: event.sessionId,
    sessionSeq: event.sessionSeq,
    sourceSchemaVersion: event.sourceSchemaVersion,
    timestamp: event.timestamp,
    type: event.type,
  })));
}

function emptySessionDisplay(
  entry: SessionCatalogEntryV1,
  status: "not_started" | "materialization_pending_or_unknown",
): SessionDisplayProjectionV1 {
  return Object.freeze({
    artifacts: Object.freeze({
      capturedBytes: 0,
      objects: Object.freeze([]),
      objectsTruncated: false,
      storedReferences: 0,
      truncatedCaptures: 0,
      uniqueObjectBytes: 0,
      uniqueObjects: 0,
    }),
    backgroundSummary: Object.freeze({ currentStatus: null, workerHistoryCount: 0 }),
    catalog: Object.freeze({
      changedCount: 0,
      lastTimestamp: null,
      model: null,
      provider: null,
      resumeStatus: "not_resumable" as const,
      sessionId: entry.sessionId,
      status,
      taskSummary: "",
    }),
    context: Object.freeze({ plans: Object.freeze([]), plansTruncated: false }),
    outcomeReport: null,
    runtimePolicy: null,
    taskExecutionSummary: null,
    transcript: Object.freeze([]),
    transcriptTruncated: false,
  });
}

function artifactDisplay(
  session: ReturnType<typeof reconstructMultiRunSession>,
): SessionArtifactDisplaySummaryV1 {
  return Object.freeze({
    capturedBytes: session.artifacts.budgetUsage.sessionBytes ?? 0,
    objects: Object.freeze(session.artifacts.objects.slice(0, SESSION_DISPLAY_ITEM_MAXIMUM).map((artifact) => Object.freeze({
      artifactId: artifact.artifactId,
      bytes: artifact.bytes,
      mediaTypes: Object.freeze([...artifact.mediaTypes]),
      referenceCount: artifact.referenceCount,
      sha256: artifact.sha256,
      wasCaptureTruncated: artifact.wasCaptureTruncated,
    }))),
    objectsTruncated: session.artifacts.objects.length > SESSION_DISPLAY_ITEM_MAXIMUM,
    storedReferences: session.artifacts.storedReferenceCount,
    truncatedCaptures: session.artifacts.truncatedCaptureEventCount,
    uniqueObjectBytes: session.artifacts.uniqueObjectBytes,
    uniqueObjects: session.artifacts.objects.length,
  });
}

function contextDisplay(events: readonly DecodedStoredEvent[]): SessionContextDisplaySummaryV1 {
  const estimates = new Map<string, Extract<DecodedStoredEvent, { readonly type: "context.estimate.created" }>>();
  const encoded = new Map<string, Extract<DecodedStoredEvent, { readonly type: "model.request.encoded" }>>();
  const key = (runId: string, step: number): string => `${runId}:${String(step)}`;
  for (const event of events) {
    if (event.scope !== "run") continue;
    if (event.type === "context.estimate.created") {
      estimates.set(key(event.runId, event.data.step), event);
    } else if (event.type === "model.request.encoded") {
      encoded.set(key(event.runId, event.data.step), event);
    }
  }
  const plans = events.filter(
    (event): event is Extract<DecodedStoredEvent, { readonly type: "context.plan.created" }> =>
      event.scope === "run" && event.type === "context.plan.created",
  );
  return Object.freeze({
    plans: Object.freeze(plans.slice(0, SESSION_DISPLAY_ITEM_MAXIMUM).map((plan) => {
      const requestKey = key(plan.runId, plan.data.step);
      const estimate = estimates.get(requestKey);
      const request = encoded.get(requestKey);
      return Object.freeze({
        adapter: request?.data.adapter ?? null,
        adapterEncodingVersion: request?.data.adapter_encoding_version ?? null,
        archivedItemCount: plan.data.archived_item_ids.length,
        canonicalContextSha256: plan.data.canonical_context_sha256,
        compacted: plan.data.compacted,
        compactionThreshold: estimate?.data.compaction_threshold ?? null,
        contextWindowTokens: estimate?.data.context_window_tokens ?? null,
        encodedRequestSha256: request?.data.encoded_request_sha256 ?? null,
        epoch: plan.data.epoch,
        estimatedInputTokens: plan.data.estimated_input_tokens,
        includedItemCount: plan.data.included_item_ids.length,
        plannerVersion: plan.data.planner_version,
        protectedCategories: Object.freeze([...(plan.data.protected_categories ?? [])]),
        protectedEstimatedTokens: plan.data.protected_estimated_tokens,
        protectedFactCount: plan.data.protected_fact_ids.length,
        runId: plan.runId,
        step: plan.data.step,
      });
    })),
    plansTruncated: plans.length > SESSION_DISPLAY_ITEM_MAXIMUM,
  });
}

function transcriptDisplay(events: readonly DecodedStoredEvent[]): Readonly<{
  readonly transcript: readonly CanonicalTranscriptItem[];
  readonly truncated: boolean;
}> {
  const publicItems = buildCanonicalTranscript(events).filter(
    (item) => item.kind !== "assistant_text" || item.visibility === "user_visible",
  );
  const transcript: CanonicalTranscriptItem[] = [];
  let bytes = 2;
  let truncated = publicItems.length > SESSION_DISPLAY_ITEM_MAXIMUM;
  for (const item of publicItems.slice(0, SESSION_DISPLAY_ITEM_MAXIMUM)) {
    const projected = displayValue(item) as CanonicalTranscriptItem;
    const itemBytes = Buffer.byteLength(JSON.stringify(projected), "utf8") + 1;
    if (bytes + itemBytes > SESSION_DISPLAY_TRANSCRIPT_MAXIMUM_BYTES) {
      truncated = true;
      break;
    }
    transcript.push(Object.freeze(projected));
    bytes += itemBytes;
  }
  return Object.freeze({ transcript: Object.freeze(transcript), truncated });
}

function materializedSessionDisplay(
  session: ReturnType<typeof reconstructMultiRunSession>,
): SessionDisplayProjectionV1 {
  const transcript = transcriptDisplay(session.events);
  return Object.freeze({
    artifacts: artifactDisplay(session),
    backgroundSummary: Object.freeze({
      currentStatus: session.background.current?.status ?? null,
      workerHistoryCount: session.background.workers.length,
    }),
    catalog: Object.freeze(
      displayValue(projectPublicSessionCatalogEntry(session)) as PublicSessionCatalogEntry,
    ),
    context: contextDisplay(session.events),
    outcomeReport: Object.freeze(displayValue(new OutcomeReportBuilder().build(session)) as OutcomeReport),
    runtimePolicy: session.lastRun === null
      ? null
      : session.lastRun.started.data.runtime_policy ?? "legacy_unrecorded",
    taskExecutionSummary: session.taskExecution === null
      ? null
      : Object.freeze({
          graphId: session.taskExecution.graph.graphId,
          graphRevision: session.taskExecution.graph.revision,
          status: session.taskExecution.status,
          succeededNodes: session.taskExecution.nodes.filter((node) => node.status === "succeeded").length,
          totalNodes: session.taskExecution.nodes.length,
        }),
    transcript: transcript.transcript,
    transcriptTruncated: transcript.truncated,
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function persistedApplicationCommit(event: DecodedStoredEvent): Readonly<Record<string, unknown>> | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const data = event.data as Readonly<Record<string, unknown>>;
  const direct = data.application_commit;
  if (typeof direct === "object" && direct !== null) return direct as Readonly<Record<string, unknown>>;
  const origin = data.origin;
  if (typeof origin !== "object" || origin === null) return null;
  const nested = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof nested === "object" && nested !== null ? nested as Readonly<Record<string, unknown>> : null;
}

function isApplicationMaterializationFirstEvent(
  event: DecodedStoredEvent,
  operationId: string | null,
): boolean {
  if (event.scope === "run") {
    return event.type === "run.started" && operationId !== null && event.runId === operationId;
  }
  // A Phase16 fresh session durably creates its authenticated Goal before the
  // run start; this is still the exact first application-owned raw envelope.
  return event.type === "goal.created";
}

function eventMetadata(events: readonly DecodedStoredEvent[]): readonly SessionEventMetadataV1[] {
  return Object.freeze(events.map((event) => Object.freeze({
    eventId: event.eventId,
    runId: event.scope === "run" ? event.runId : null,
    runSequence: event.scope === "run" ? event.runSeq : null,
    scope: event.scope,
    sequence: event.sessionSeq,
    timestamp: event.timestamp,
    type: event.type,
    userActionOrigin: projectedUserActionOrigin(event),
  })));
}

function projectedUserActionOrigin(event: DecodedStoredEvent): ProjectedUserActionOriginV2 | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const origin = (event.data as Readonly<Record<string, unknown>>).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const kind = (origin as Readonly<Record<string, unknown>>).kind;
  if (kind !== "user" && kind !== "authenticated_surface") return null;
  return projectUserActionOrigin(origin as PersistedUserActionOriginV2);
}

export class SessionProjectionService {
  static readonly PROJECTOR_ID = "bornagent.phase21a.session-projection";
  static readonly PROJECTOR_VERSION = 1;

  constructor(private readonly options: {
    readonly broker: SessionOwnerBroker;
    readonly disclosureProfileSha256: string;
    readonly repositories: RepositoryRegistry;
    readonly sessions: SessionRegistry;
    readonly signer: SessionLedgerHeadSigner;
  }) {}

  /**
   * PHASE21: an in-process owner publishes stable snapshots through the broker;
   * surfaces never inspect the writer or its mutable JSONL directly.
   */
  activeReadPort(input: {
    readonly entry: SessionCatalogEntryV1;
    readonly writer: V2SessionWriter;
  }): ActiveSessionReadPortV1<ProductSessionProjectionBodyV1> {
    const stableForEvents = (events: readonly DecodedStoredEvent[]) => {
      const tail = events.at(-1);
      const head = tail === undefined
        ? this.options.signer.create({
            eventId: null,
            rawEventSha256: null,
            sequence: 0,
            sessionId: input.entry.sessionId,
          })
        : this.options.signer.create(input.writer.readDurableEventIdentity(tail.eventId));
      const scope = Object.freeze({
        kind: "session" as const,
        repositoryId: input.entry.repositoryId,
        sessionId: input.entry.sessionId,
        teamId: null,
      });
      const body = events.length === 0
        ? this.emptyBody(input.entry, "materialization_pending_or_unknown")
        : this.materializedBody(input.entry, events);
      return this.snapshot(
        scope,
        head,
        body,
        events,
        eventMetadata(events),
        events.map((event) => this.deliveryCheckpoint(input.writer.readDurableEventIdentity(event.eventId))),
        tuiDisplayEvents(events),
      );
    };
    return Object.freeze({
      readStableSnapshot: async () => {
        const events = input.writer.readDecodedEvents();
        const stable = stableForEvents(events);
        return Object.freeze({
          deliveryEvents: stable.deliveryEvents,
          events: stable.eventMetadata,
          head: stable.head,
          ...(stable.internalEvents === undefined ? {} : { internalEvents: stable.internalEvents }),
          projection: stable.projection,
          tuiDisplayEvents: stable.tuiDisplayEvents,
        });
      },
      readStablePrefix: async (requested: SessionLedgerHeadV1) => {
        const all = input.writer.readDecodedEvents();
        if (
          requested.sessionId !== input.entry.sessionId ||
          requested.sequence < 0 ||
          requested.sequence > all.length
        ) {
          throw new ApplicationControlError("control_stale_projection", "requested active session prefix is unavailable");
        }
        const prefix = all.slice(0, requested.sequence);
        const expected = stableForEvents(prefix);
        if (sha256Canonical(expected.head.publicHead) !== sha256Canonical(requested)) {
          throw new ApplicationControlError("control_stale_projection", "requested active session prefix identity changed");
        }
        return Object.freeze({
          deliveryEvents: expected.deliveryEvents,
          events: expected.eventMetadata,
          head: expected.head,
          ...(expected.internalEvents === undefined ? {} : { internalEvents: expected.internalEvents }),
          projection: expected.projection,
          tuiDisplayEvents: expected.tuiDisplayEvents,
        });
      },
      subscribeInvalidations: (listener: () => void) => input.writer.subscribeDurableEvents(() => listener()),
    });
  }

  /** Verify an earlier opaque head only inside the exact active owner. */
  verifyOwnerObservedHead(writer: V2SessionWriter, head: SessionLedgerHeadV1): boolean {
    if (head.sessionId !== writer.readDurableTailIdentity().sessionId || head.sequence <= 0) return false;
    const event = writer.events[head.sequence - 1];
    if (event === undefined || event.sessionSeq !== head.sequence || event.eventId !== head.eventId) return false;
    try {
      const identity = writer.readDurableEventIdentity(event.eventId);
      return this.options.signer.verify(head, identity.rawEventSha256);
    } catch {
      return false;
    }
  }

  /**
   * PHASE21: response-loss reconciliation may need the opaque head for an
   * exact durable prefix after a newer owner has appended unrelated facts.
   * This Host-only port signs the writer's raw identity only after every
   * caller-supplied field matches that exact durable event; surfaces never
   * receive the raw hash and cannot ask the signer to bless a candidate.
   */
  hostHeadForExactWriterEvent(input: Readonly<{
    readonly eventId: string;
    readonly rawEventSha256: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly writer: V2SessionWriter;
  }>): SessionLedgerHeadV1 {
    if (input.writer.isClosed()) {
      throw new ApplicationControlError("control_operation_busy", "session writer is unavailable for exact prefix recovery");
    }
    const observed = input.writer.readDurableEventIdentity(input.eventId);
    if (
      observed.eventId !== input.eventId ||
      observed.rawEventSha256 !== input.rawEventSha256 ||
      observed.sequence !== input.sequence ||
      observed.sessionId !== input.sessionId ||
      !/^[a-f0-9]{64}$/u.test(observed.rawEventSha256)
    ) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "exact session prefix identity does not match durable storage",
      );
    }
    return this.options.signer.create(observed).publicHead;
  }

  async read(input: {
    readonly repositoryId: string;
    readonly requestedHead: SessionLedgerHeadV1 | null;
    readonly sessionId: string;
  }): Promise<StableSessionApplicationSnapshotV1> {
    const scope = Object.freeze({
      kind: "session" as const,
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      teamId: null,
    });
    const active = this.options.broker.activePort(input.sessionId);
    if (active !== null) {
      // PHASE21: an active writer is the only authority for its current
      // snapshot. If that port is busy or invalid we fail closed; falling back
      // to the inactive JSONL reader would mislabel an in-flight head as a
      // merely stale projection and could authorize a concurrent mutation.
      let snapshot = await active.readStableSnapshot();
      if (
        input.requestedHead !== null &&
        sha256Canonical(snapshot.head.publicHead) !== sha256Canonical(input.requestedHead)
      ) {
        if (active.readStablePrefix === undefined) {
          throw new ApplicationControlError("control_stale_projection", "active owner cannot reproduce the requested prefix");
        }
        snapshot = await active.readStablePrefix(input.requestedHead);
      }
      if (
        snapshot.head.publicHead.sessionId !== input.sessionId ||
        !this.options.signer.verify(snapshot.head.publicHead, snapshot.head.rawEventSha256)
      ) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "active owner returned an invalid durable head");
      }
      const deliveryEvents = (snapshot.deliveryEvents ?? []) as readonly SessionDeliveryEventCheckpointV1[];
      const displayEvents = (snapshot.tuiDisplayEvents ?? []) as readonly SessionTuiDisplayEventV1[];
      const internalEvents = snapshot.internalEvents as readonly DecodedStoredEvent[] | undefined;
      if (deliveryEvents.length !== snapshot.events.length) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "active owner returned incomplete delivery identities",
        );
      }
      if (displayEvents.length !== snapshot.events.length) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "active owner returned incomplete TUI presentation data",
        );
      }
      this.assertRequested(input.requestedHead, snapshot.head.publicHead);
      return Object.freeze({
        deliveryEvents,
        eventMetadata: snapshot.events as readonly SessionEventMetadataV1[],
        head: snapshot.head,
        ...(internalEvents === undefined ? {} : { internalEvents: Object.freeze([...internalEvents]) }),
        projection: snapshot.projection as SessionProjectionSnapshotV1<ProductSessionProjectionBodyV1>,
        resourceScope: scope,
        tuiDisplayEvents: displayEvents,
      });
    }

    const catalog = await this.options.sessions.project(input.repositoryId);
    const entry = catalog.entries.find((candidate) => candidate.sessionId === input.sessionId);
    if (entry === undefined) {
      throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
    }
    const intent = catalog.intents.find((candidate) => candidate.sessionId === input.sessionId);
    let materialization = catalog.materializations.find((candidate) => candidate.sessionId === input.sessionId);
    const repository = await this.options.repositories.get(input.repositoryId);
    if (repository === null || repository.status !== "active") {
      throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
    }
    const root = await this.options.repositories.readRoot(repository);

    if (materialization === undefined && intent !== undefined) {
      const head = this.options.signer.create({
        eventId: null,
        rawEventSha256: null,
        sequence: 0,
        sessionId: entry.sessionId,
      });
      this.assertRequested(input.requestedHead, head.publicHead);
      return this.snapshot(scope, head, this.emptyBody(entry, "materialization_pending_or_unknown"), [], [], [], []);
    }

    const storage = await this.storagePresence(root, entry.sessionId);
    if (materialization === undefined && !storage.present) {
      const head = this.options.signer.create({ eventId: null, rawEventSha256: null, sequence: 0, sessionId: entry.sessionId });
      this.assertRequested(input.requestedHead, head.publicHead);
      return this.snapshot(scope, head, this.emptyBody(entry, "not_started"), [], [], [], []);
    }
    if (materialization === undefined && storage.present) {
      materialization = await this.migrateLegacy(root, entry, catalog.head);
    }
    if (materialization === undefined || !storage.present) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "materialized session storage is missing",
      );
    }
    const stable = await this.readMaterialized(root, entry, materialization);
    this.assertRequested(input.requestedHead, stable.head.publicHead);
    return this.snapshot(
      scope,
      stable.head,
      this.materializedBody(entry, stable.events),
      stable.events,
      eventMetadata(stable.events),
      stable.deliveryEvents,
      tuiDisplayEvents(stable.events),
    );
  }

  private snapshot(
    scope: Extract<ResourceScopeV1, { readonly kind: "session" }>,
    head: SessionStorageHeadV1,
    body: ProductSessionProjectionBodyV1,
    internalEvents: readonly DecodedStoredEvent[],
    events: readonly SessionEventMetadataV1[],
    deliveryEvents: readonly SessionDeliveryEventCheckpointV1[],
    displayEvents: readonly SessionTuiDisplayEventV1[],
  ): StableSessionApplicationSnapshotV1 {
    const deliveryTail = deliveryEvents.at(-1) ?? null;
    if (
      events.length !== deliveryEvents.length ||
      events.length !== displayEvents.length ||
      head.publicHead.sequence !== events.length ||
      (head.publicHead.sequence === 0
        ? deliveryTail !== null || head.rawEventSha256 !== null
        : deliveryTail === null ||
          deliveryTail.sequence !== head.publicHead.sequence ||
          deliveryTail.eventId !== head.publicHead.eventId ||
          deliveryTail.eventIntegrityToken !== head.publicHead.eventIntegrityToken ||
          deliveryTail.rawEventSha256 !== head.rawEventSha256) ||
      deliveryEvents.some((event, index) =>
        event.sessionId !== scope.sessionId || event.sequence !== events[index]?.sequence
      )
    ) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "session delivery identities do not align with the stable projection",
      );
    }
    return Object.freeze({
      deliveryEvents: Object.freeze([...deliveryEvents]),
      eventMetadata: events,
      head,
      internalEvents: Object.freeze([...internalEvents]),
      projection: createSessionProjectionSnapshot({
        disclosureProfileSha256: this.options.disclosureProfileSha256,
        ledgerHead: head.publicHead,
        projection: body,
        projectorId: SessionProjectionService.PROJECTOR_ID,
        projectorVersion: SessionProjectionService.PROJECTOR_VERSION,
      }),
      resourceScope: scope,
      tuiDisplayEvents: Object.freeze([...displayEvents]),
    });
  }

  private emptyBody(
    entry: SessionCatalogEntryV1,
    outcome: "not_started" | "materialization_pending_or_unknown",
  ): ProductSessionProjectionBodyV1 {
    return Object.freeze({
      background: null,
      blockers: Object.freeze(outcome === "not_started" ? [] : ["materialization_pending_or_unknown"]),
      delegations: Object.freeze([]),
      display: emptySessionDisplay(entry, outcome),
      graphs: Object.freeze([]),
      goals: Object.freeze([]),
      outcome,
      plans: Object.freeze([]),
      receipts: Object.freeze([]),
      repositoryId: entry.repositoryId,
      runs: Object.freeze([]),
      schemaVersion: 1,
      sessionId: entry.sessionId,
      taskExecution: null,
      taskGraph: null,
      taskMutationBlocker: null,
      taskState: null,
      worktrees: Object.freeze([]),
    });
  }

  private materializedBody(
    entry: SessionCatalogEntryV1,
    events: readonly DecodedStoredEvent[],
  ): ProductSessionProjectionBodyV1 {
    const session = reconstructMultiRunSession(events);
    return Object.freeze({
      background: session.background,
      blockers: Object.freeze([]),
      delegations: session.delegations,
      display: materializedSessionDisplay(session),
      graphs: Object.freeze(session.taskGraph.revisions),
      goals: Object.freeze(session.taskState.goals),
      outcome: session.status,
      plans: Object.freeze(session.taskState.plans),
      receipts: Object.freeze([]),
      repositoryId: entry.repositoryId,
      runs: Object.freeze(session.runs.map((run) => Object.freeze({
        endSessionSeq: run.endSessionSeq,
        ...(() => {
          const binding = phase16RunBindingSchema.safeParse(Object.fromEntries(
            PHASE16_RUN_BINDING_KEYS.map((key) => [key, run.started.data[key]]),
          ));
          return binding.success
            ? { goalId: binding.data.goal_id, goalRevision: binding.data.goal_revision }
            : { goalId: null, goalRevision: null };
        })(),
        runId: run.runId,
        startSessionSeq: run.startSessionSeq,
        status: run.status,
      }))),
      schemaVersion: 1,
      sessionId: entry.sessionId,
      taskExecution: session.taskExecution,
      taskGraph: session.taskGraph,
      taskMutationBlocker: taskMutationBlocker(session),
      taskState: session.taskState,
      worktrees: session.worktrees,
    });
  }

  private async storagePresence(root: string, sessionId: string): Promise<{ readonly path: string; readonly present: boolean }> {
    const agent = join(root, ".bornagent");
    const sessions = join(agent, "sessions");
    const path = join(sessions, `${sessionId}.jsonl`);
    for (const directory of [agent, sessions]) {
      try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session storage directory is unsafe");
        }
      } catch (error) {
        if (isCode(error, "ENOENT")) return { path, present: false };
        throw error;
      }
    }
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session storage file is invalid");
      }
      return { path, present: true };
    } catch (error) {
      if (isCode(error, "ENOENT")) return { path, present: false };
      throw error;
    }
  }

  private async readMaterialized(
    root: string,
    entry: SessionCatalogEntryV1,
    marker: SessionMaterializationRecordV1,
  ): Promise<{
    readonly deliveryEvents: readonly SessionDeliveryEventCheckpointV1[];
    readonly events: readonly DecodedStoredEvent[];
    readonly head: SessionStorageHeadV1;
  }> {
    const policy = await SessionPathPolicy.create(root);
    const paths = await policy.inspectExistingSession(entry.sessionId);
    let lock: SessionLock;
    try {
      lock = await SessionLock.acquire(policy, entry.sessionId, { allowStaleRecovery: false });
    } catch (error) {
      if (error instanceof SessionLockError) {
        throw new ApplicationControlError("control_operation_busy", "session has another active or unresolved writer", { cause: error });
      }
      throw error;
    }
    try {
      const before = await readFile(paths.sessionFilePath);
      const events = await readStoredSession(paths.sessionFilePath);
      const after = await readFile(paths.sessionFilePath);
      if (!before.equals(after) || events.length === 0 || before.at(-1) !== 0x0a) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session changed during stable read");
      }
      const lines = before.subarray(0, before.byteLength - 1).toString("utf8").split("\n");
      if (lines.length !== events.length) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session raw event count is inconsistent");
      }
      const first = Buffer.from(lines[0] ?? "", "utf8");
      const last = Buffer.from(lines.at(-1) ?? "", "utf8");
      const metadata = await lstat(paths.sessionFilePath);
      const storageIdentitySha256 = sha256Canonical({
        dev: metadata.dev,
        ino: metadata.ino,
        real_path: await realpath(paths.sessionFilePath),
        repository_id: entry.repositoryId,
        schema_version: 1,
        session_id: entry.sessionId,
      });
      if (
        createHash("sha256").update(first).digest("hex") !== marker.firstRawEventSha256 ||
        events[0]?.eventId !== marker.firstEventId ||
        storageIdentitySha256 !== marker.sessionStorageIdentitySha256
      ) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session materialization marker does not match storage");
      }
      const firstEvent = events[0]!;
      const applicationCommit = persistedApplicationCommit(firstEvent);
      if (marker.origin === "phase21_application") {
        if (
          !isApplicationMaterializationFirstEvent(firstEvent, marker.firstEventOperationId) ||
          applicationCommit === null ||
          applicationCommit.action_kind !== marker.firstEventActionKind ||
          applicationCommit.authorization_decision_sha256 !== marker.firstEventAuthorizationDecisionSha256 ||
          applicationCommit.operation_id !== marker.firstEventOperationId ||
          applicationCommit.prepared_action_sha256 !== marker.firstEventPreparedActionSha256 ||
          applicationCommit.principal_id !== marker.firstEventPrincipalId ||
          applicationCommit.schema_version !== 1
        ) {
          throw new ApplicationControlError("control_session_history_missing_or_corrupt", "application first event does not match its materialization binding");
        }
      } else if (applicationCommit !== null) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "authenticated application history cannot be projected as legacy materialization");
      }
      const tail = events.at(-1)!;
      return Object.freeze({
        deliveryEvents: Object.freeze(events.map((event, index) => this.deliveryCheckpoint({
          eventId: event.eventId,
          rawEventSha256: createHash("sha256").update(Buffer.from(lines[index]!, "utf8")).digest("hex"),
          sequence: event.sessionSeq,
          sessionId: entry.sessionId,
        }))),
        events,
        head: this.options.signer.create({
          eventId: tail.eventId,
          rawEventSha256: createHash("sha256").update(last).digest("hex"),
          sequence: tail.sessionSeq,
          sessionId: entry.sessionId,
        }),
      });
    } finally {
      await lock.release();
    }
  }

  private deliveryCheckpoint(input: Readonly<{
    readonly eventId: string;
    readonly rawEventSha256: string;
    readonly sequence: number;
    readonly sessionId: string;
  }>): SessionDeliveryEventCheckpointV1 {
    const signed = this.options.signer.create(input);
    if (signed.publicHead.eventId === null || signed.publicHead.eventIntegrityToken === null) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "positive session event has no public delivery identity",
      );
    }
    return Object.freeze({
      eventId: signed.publicHead.eventId,
      eventIntegrityToken: signed.publicHead.eventIntegrityToken,
      rawEventSha256: input.rawEventSha256,
      schemaVersion: 1,
      sequence: input.sequence,
      sessionId: input.sessionId,
    });
  }

  private async migrateLegacy(
    root: string,
    entry: SessionCatalogEntryV1,
    expectedHead: CatalogHeadV1,
  ): Promise<SessionMaterializationRecordV1> {
    if (entry.legacyAdoption === undefined) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "uncataloged session storage requires an authenticated legacy-adoption operation",
      );
    }
    const policy = await SessionPathPolicy.create(root);
    const paths = await policy.inspectExistingSession(entry.sessionId);
    let lock: SessionLock;
    try {
      lock = await SessionLock.acquire(policy, entry.sessionId, { allowStaleRecovery: false });
    } catch (error) {
      throw new ApplicationControlError("control_operation_busy", "legacy session cannot be migrated while active", { cause: error });
    }
    let materialization: Omit<SessionMaterializationRecordV1, "materializationSha256">;
    try {
      const bytes = await readFile(paths.sessionFilePath);
      const events = await readStoredSession(paths.sessionFilePath);
      const after = await readFile(paths.sessionFilePath);
      if (!bytes.equals(after) || events.length === 0 || bytes.byteLength < 2 || bytes.at(-1) !== 0x0a) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy session is empty or incomplete");
      }
      if (events.some((event) => persistedApplicationCommit(event) !== null)) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "authenticated application first event is missing its durable materialization intent",
        );
      }
      const firstLineEnd = bytes.indexOf(0x0a);
      const metadata = await lstat(paths.sessionFilePath);
      const firstRawEventSha256 = createHash("sha256").update(bytes.subarray(0, firstLineEnd)).digest("hex");
      const sessionStorageIdentitySha256 = sha256Canonical({
        dev: metadata.dev,
        ino: metadata.ino,
        real_path: await realpath(paths.sessionFilePath),
        repository_id: entry.repositoryId,
        schema_version: 1,
        session_id: entry.sessionId,
      });
      if (
        events[0]!.eventId !== entry.legacyAdoption.firstEventId ||
        firstRawEventSha256 !== entry.legacyAdoption.firstRawEventSha256 ||
        sessionStorageIdentitySha256 !== entry.legacyAdoption.sessionStorageIdentitySha256
      ) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "legacy session changed after its authenticated adoption operation");
      }
      materialization = {
        firstEventActionKind: null,
        firstEventAuthorizationDecisionSha256: null,
        firstEventId: events[0]!.eventId,
        firstEventOperationId: null,
        firstEventPreparedActionSha256: null,
        firstEventPrincipalId: null,
        firstRawEventSha256,
        materializationIntentId: null,
        materializationIntentSha256: null,
        origin: "legacy_migration",
        repositoryId: entry.repositoryId,
        sessionId: entry.sessionId,
        sessionStorageIdentitySha256,
      };
    } finally {
      await lock.release();
    }
    try {
      return (await this.options.sessions.appendMaterialization({ expectedHead, materialization })).materialization;
    } catch (error) {
      if (error instanceof ApplicationControlError && error.code === "control_catalog_conflict") {
        const current = await this.options.sessions.project(entry.repositoryId);
        const recovered = current.materializations.find((candidate) => candidate.sessionId === entry.sessionId);
        if (recovered !== undefined) return recovered;
      }
      throw error;
    }
  }

  private assertRequested(requested: SessionLedgerHeadV1 | null, current: SessionLedgerHeadV1): void {
    if (requested !== null && sha256Canonical(requested) !== sha256Canonical(current)) {
      throw new ApplicationControlError("control_stale_projection", "session ledger head changed");
    }
  }
}
