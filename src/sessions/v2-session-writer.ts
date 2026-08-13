import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { phase10ArtifactRunEventDataSchemas } from "../artifacts/artifact-event-schema.js";
import type { Phase10ArtifactEvent } from "../artifacts/artifact-types.js";
import { TaskStateMachine } from "../coordination/task-state-machine.js";
import { assertGoalChangeLedgerSemantics } from "../coordination/goal-change-ledger.js";
import {
  phase16TaskSessionEventDataSchemas,
  type Phase16TaskSessionEventData,
  type Phase16TaskSessionEventType,
} from "../coordination/task-event-schema.js";
import {
  phase16GoalChangeRunEventDataSchemas,
  type Phase16GoalChangeRunEventData,
  type Phase16GoalChangeRunEventType,
} from "../coordination/goal-change-event-schema.js";
import {
  decodeStoredEvents,
  type DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import { assertPhase9RunEventSemantics } from "../events/phase9-run-event-semantics.js";
import type { RunEvent } from "../events/run-event.js";
import type { Phase16RunBinding } from "../events/phase16-run-event-extension.js";
import {
  phase9RunEventDataSchemas,
  phase9SessionEventDataSchemas,
  storedEventEnvelopeV2Schema,
  type Phase9RunEventData,
  type Phase9RunEventType,
  type Phase9SessionEventData,
  type Phase9SessionEventType,
} from "../events/stored-event-v2.js";
import type { SessionWriter } from "./jsonl-session-writer.js";
import type { SessionLock } from "./session-lock.js";
import {
  DurableSessionStore,
  type DurableSessionStoreOpenOptions,
} from "./durable-session-store.js";
import type { StoredLineDecoder } from "./tail-recovery.js";
import {
  phase19TaskGraphSessionEventDataSchemas,
  type Phase19TaskGraphSessionEventData,
  type Phase19TaskGraphSessionEventType,
} from "../task-graph/task-graph-event-schema.js";
import { TaskGraphProjector } from "../task-graph/task-graph-projector.js";
import { TaskExecutionProjector } from "../scheduling/task-execution-projector.js";
import { WorktreeProjector } from "../worktrees/worktree-projector.js";
import { BackgroundProjector } from "../background/background-projector.js";
import {
  phase20DelegationSessionEventDataSchemas,
  type Phase20DelegationSessionEventData,
  type Phase20DelegationSessionEventType,
} from "../delegation/delegation-event-schema.js";
import { DelegationProjector } from "../delegation/delegation-projector.js";
import type { DelegatedChildRunBindingV1 } from "../events/phase20-run-event-extension.js";
import {
  phase21RunControlEventDataSchemas,
  type Phase21RunControlEventData,
  type Phase21RunControlEventType,
} from "../events/phase21-run-control-event-schema.js";

export interface V2SessionWriterOptions {
  readonly afterDurableEvent?: (event: DecodedStoredEvent) => void;
  readonly createEventId?: () => string;
  readonly timestamp?: () => string;
}

class AccumulatingStoredEventDecoder
  implements StoredLineDecoder<DecodedStoredEvent>
{
  readonly rawLineSha256s: string[] = [];
  readonly values: unknown[] = [];

  decode(value: unknown, _physicalLine?: number, rawLineBytes?: Uint8Array): DecodedStoredEvent {
    const candidate = [...this.values, value];
    const decoded = decodeStoredEvents(candidate);
    const event = decoded.at(-1);
    if (event === undefined) throw new Error("stored event decoder returned no event");
    this.values.push(value);
    this.rawLineSha256s.push(sha256(rawLineBytes ?? Buffer.from(JSON.stringify(value), "utf8")));
    return event;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

function assertPhase21CancelRawBindings(
  events: readonly DecodedStoredEvent[],
  rawLineSha256s: readonly string[],
): void {
  for (const event of events) {
    if (
      event.scope !== "run" ||
      event.type !== "run.cancelled" ||
      !("application_cancel_request" in event.data)
    ) continue;
    const binding = event.data.application_cancel_request;
    const requestIndex = events.findIndex((candidate) =>
      candidate.scope === "run" &&
      candidate.runId === event.runId &&
      candidate.type === "run.cancel.requested" &&
      candidate.eventId === binding.request_event_id
    );
    if (
      requestIndex < 0 ||
      rawLineSha256s[requestIndex] !== binding.request_event_sha256
    ) {
      throw new Error("run.cancelled application request raw identity mismatch");
    }
  }
}

export class V2SessionWriter implements SessionWriter {
  readonly lockNonceSha256: string;
  readonly path: string;
  readonly persistenceProfile = "phase10_full" as const;
  readonly workspace: string;
  private closed = false;
  private readonly createEventId: () => string;
  private readonly afterDurableEvent:
    | ((event: DecodedStoredEvent) => void)
    | undefined;
  private decoded: readonly DecodedStoredEvent[];
  private readonly durableEventListeners = new Set<
    (event: DecodedStoredEvent) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private fatalAfterDurableHookCause: unknown;
  private fatalAfterDurableHookObserved = false;
  private readonly nextRunSequence = new Map<string, number>();
  private appendGate: Promise<void> = Promise.resolve();
  private readonly rawValues: unknown[];
  private readonly rawLineSha256s: string[];
  private readonly timestamp: () => string;

  private constructor(
    private readonly store: DurableSessionStore<DecodedStoredEvent>,
    private readonly sessionId: string,
    decoder: AccumulatingStoredEventDecoder,
    options: V2SessionWriterOptions,
    workspace: string,
  ) {
    this.lockNonceSha256 = store.lockNonceSha256;
    this.path = store.path;
    this.workspace = workspace;
    this.rawValues = decoder.values;
    this.rawLineSha256s = decoder.rawLineSha256s;
    this.decoded = decodeStoredEvents(this.rawValues);
    assertPhase9RunEventSemantics(this.decoded);
    assertPhase21CancelRawBindings(this.decoded, this.rawLineSha256s);
    this.afterDurableEvent = options.afterDurableEvent;
    this.createEventId = options.createEventId ?? randomUUID;
    this.timestamp = options.timestamp ?? (() => new Date().toISOString());
    for (const event of this.decoded) {
      if (event.scope === "run") {
        this.nextRunSequence.set(event.runId, event.runSeq + 1);
      }
    }
  }

  static async create(
    workspace: string,
    sessionId: string,
  ): Promise<V2SessionWriter> {
    return V2SessionWriter.createNew(workspace, sessionId);
  }

  static async createNew(
    workspace: string,
    sessionId: string,
    options: V2SessionWriterOptions = {},
  ): Promise<V2SessionWriter> {
    const writer = await V2SessionWriter.open(workspace, sessionId, options);
    if (writer.rawValues.length !== 0 || writer.store.tailRecovery.kind !== "none") {
      await writer.close().catch(() => undefined);
      throw new Error("new session id already has persisted state");
    }
    await writer.persistRecoveryFacts();
    return writer;
  }

  static async openExisting(
    workspace: string,
    sessionId: string,
    options: V2SessionWriterOptions = {},
  ): Promise<V2SessionWriter> {
    const writer = await V2SessionWriter.open(workspace, sessionId, options);
    if (writer.rawValues.length === 0) {
      await writer.close().catch(() => undefined);
      throw new Error("cannot resume an empty session");
    }
    await writer.persistRecoveryFacts();
    return writer;
  }

  /**
   * PHASE21: only the materialization reconciler may adopt an empty file that
   * was created after a durable catalog intent but before the first event.
   */
  static async openMaterializationResidue(
    workspace: string,
    sessionId: string,
    options: V2SessionWriterOptions = {},
  ): Promise<V2SessionWriter> {
    const writer = await V2SessionWriter.open(workspace, sessionId, options);
    if (writer.rawValues.length !== 0 || writer.store.tailRecovery.kind !== "none") {
      await writer.close().catch(() => undefined);
      throw new Error("materialization residue is not an exact empty session file");
    }
    return writer;
  }

  get events(): readonly DecodedStoredEvent[] {
    return [...this.decoded];
  }

  readDecodedEvents(): readonly DecodedStoredEvent[] {
    return this.events;
  }

  /**
   * PHASE21: this owner-only port exposes the exact durable raw-tail identity;
   * application surfaces receive only a keyed, resource-scoped token.
   */
  readDurableTailIdentity(): Readonly<{
    eventId: string | null;
    rawEventSha256: string | null;
    sequence: number;
    sessionId: string;
  }> {
    const last = this.decoded.at(-1);
    const rawEventSha256 = this.rawLineSha256s.at(-1) ?? null;
    if (last === undefined) {
      if (rawEventSha256 !== null) throw new Error("empty session has a raw tail identity");
      return Object.freeze({ eventId: null, rawEventSha256: null, sequence: 0, sessionId: this.sessionId });
    }
    if (rawEventSha256 === null || this.rawLineSha256s.length !== this.rawValues.length) {
      throw new Error("session raw-tail identity is incomplete");
    }
    return Object.freeze({
      eventId: last.eventId,
      rawEventSha256,
      sequence: last.sessionSeq,
      sessionId: this.sessionId,
    });
  }

  /** PHASE21: owner-only first-event identity for catalog materialization. */
  readDurableFirstIdentity(): Readonly<{
    eventId: string | null;
    rawEventSha256: string | null;
    sequence: number;
    sessionId: string;
  }> {
    const first = this.decoded[0];
    const rawEventSha256 = this.rawLineSha256s[0] ?? null;
    if (first === undefined) {
      if (rawEventSha256 !== null) throw new Error("empty session has a first raw identity");
      return Object.freeze({ eventId: null, rawEventSha256: null, sequence: 0, sessionId: this.sessionId });
    }
    if (first.sessionSeq !== 1 || rawEventSha256 === null) {
      throw new Error("session first-event identity is incomplete");
    }
    return Object.freeze({
      eventId: first.eventId,
      rawEventSha256,
      sequence: first.sessionSeq,
      sessionId: this.sessionId,
    });
  }

  /** PHASE21: exact owner-only raw identity for operation reconciliation. */
  readDurableEventIdentity(eventId: string): Readonly<{
    eventId: string;
    rawEventSha256: string;
    sequence: number;
    sessionId: string;
  }> {
    const index = this.decoded.findIndex((event) => event.eventId === eventId);
    const event = index < 0 ? undefined : this.decoded[index];
    const rawEventSha256 = index < 0 ? undefined : this.rawLineSha256s[index];
    if (event === undefined || rawEventSha256 === undefined) {
      throw new Error("session event raw identity is unavailable");
    }
    return Object.freeze({
      eventId: event.eventId,
      rawEventSha256,
      sequence: event.sessionSeq,
      sessionId: this.sessionId,
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  subscribeDurableEvents(
    listener: (event: DecodedStoredEvent) => void,
  ): () => void {
    if (this.closed) throw new Error("session writer is closed");
    this.durableEventListeners.add(listener);
    return () => this.durableEventListeners.delete(listener);
  }

  /**
   * PHASE21: Host composition may bind an active projection port to this
   * exact writer. The binding lives until the durable store has actually
   * released its lock; surfaces still receive only broker invalidations.
   */
  subscribeClose(listener: () => void): () => void {
    if (this.closed) throw new Error("session writer is closed");
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async write(event: RunEvent): Promise<void> {
    if (event.session_id !== this.sessionId) {
      throw new Error("run event belongs to a different session");
    }
    await this.appendRunEnvelope({
      data: event.data,
      eventId: event.event_id,
      runId: event.run_id,
      timestamp: event.timestamp,
      type: event.type,
    });
  }

  async appendSessionEvent<TType extends Phase9SessionEventType>(
    type: TType,
    data: Phase9SessionEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase9SessionEventDataSchemas[type].parse(data);
    const eventId = this.createEventId();
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    const envelope = storedEventEnvelopeV2Schema.parse({
      data,
      event_id: eventId,
      schema_version: 2,
      scope: "session",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: this.timestamp(),
      type,
    });
    return this.appendEnvelope(envelope);
  }

  /**
   * PHASE21: authenticated resume authority has a dedicated append port. The
   * application operation ID is also the event ID, making the pre-launch
   * crash prefix exactly discoverable without opening a generic event writer.
   */
  async appendPhase21SessionResumeRequested(
    eventId: string,
    data: Phase9SessionEventData<"session.resume.requested"> & Readonly<{
      readonly application_commit: NonNullable<Phase9SessionEventData<"session.resume.requested">["application_commit"]>;
      readonly approval_request_ids: readonly string[];
      readonly new_run_id: string;
    }>,
  ): Promise<DecodedStoredEvent> {
    phase9SessionEventDataSchemas["session.resume.requested"].parse(data);
    if (!isCanonicalUuid(eventId) || data.application_commit.operation_id !== eventId) {
      throw new Error("application resume event must be owned by its exact operation ID");
    }
    const envelope = storedEventEnvelopeV2Schema.parse({
      data,
      event_id: eventId,
      schema_version: 2,
      scope: "session",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: this.timestamp(),
      type: "session.resume.requested",
    });
    return this.appendEnvelope(envelope);
  }

  /**
   * Phase 16 task facts are intentionally exposed as a distinct writer method.
   * Trusted user and agent PlanStore ports own construction of their origin;
   * callers cannot accidentally pass a task event through the Phase 9 API.
   */
  async appendTaskEvent<TType extends Phase16TaskSessionEventType>(
    type: TType,
    data: Phase16TaskSessionEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase16TaskSessionEventDataSchemas[type].parse(data);
    const eventId = this.createEventId();
    if (!isCanonicalUuid(eventId)) {
      throw new Error("event id must be a canonical UUID");
    }
    const envelope = storedEventEnvelopeV2Schema.parse({
      data,
      event_id: eventId,
      schema_version: 2,
      scope: "session",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: this.timestamp(),
      type,
    });
    return this.appendEnvelope(envelope);
  }

  /**
   * Phase 19 Graph events use a dedicated append port so Graph approval can
   * never be confused with Goal/Plan authority or the generic Phase 9 port.
   */
  async appendTaskGraphEvent<TType extends Phase19TaskGraphSessionEventType>(
    type: TType,
    data: Phase19TaskGraphSessionEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase19TaskGraphSessionEventDataSchemas[type].parse(data);
    const eventId = this.createEventId();
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    const envelope = storedEventEnvelopeV2Schema.parse({
      data,
      event_id: eventId,
      schema_version: 2,
      scope: "session",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: this.timestamp(),
      type,
    });
    return this.appendEnvelope(envelope);
  }

  /** Phase 20 delegation facts retain a distinct authority/write port. */
  async appendDelegationEvent<TType extends Phase20DelegationSessionEventType>(
    type: TType,
    data: Phase20DelegationSessionEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase20DelegationSessionEventDataSchemas[type].parse(data);
    const eventId = this.createEventId();
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    const envelope = storedEventEnvelopeV2Schema.parse({
      data,
      event_id: eventId,
      schema_version: 2,
      scope: "session",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: this.timestamp(),
      type,
    });
    return this.appendEnvelope(envelope);
  }

  async appendArtifactEvent(
    runId: string,
    event: Phase10ArtifactEvent,
  ): Promise<DecodedStoredEvent> {
    phase10ArtifactRunEventDataSchemas[event.type].parse(event.data);
    const eventId = this.createEventId();
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    return this.appendRunEnvelope({
      data: event.data,
      eventId,
      runId,
      timestamp: this.timestamp(),
      type: event.type,
    });
  }

  async appendGoalChangeEvent<TType extends Phase16GoalChangeRunEventType>(
    runId: string,
    eventId: string,
    type: TType,
    data: Phase16GoalChangeRunEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase16GoalChangeRunEventDataSchemas[type].parse(data);
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    return this.appendRunEnvelope({
      data,
      eventId,
      runId,
      timestamp: this.timestamp(),
      type,
    });
  }

  async appendRunEvent<TType extends Phase9RunEventType>(
    runId: string,
    type: TType,
    data: Phase9RunEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    const eventId = this.createEventId();
    return this.appendRunEventWithId(runId, eventId, type, data);
  }

  async appendRunEventWithId<TType extends Phase9RunEventType>(
    runId: string,
    eventId: string,
    type: TType,
    data: Phase9RunEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase9RunEventDataSchemas[type].parse(data);
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    return this.appendRunEnvelope({
      data,
      eventId,
      runId,
      timestamp: this.timestamp(),
      type,
    });
  }

  /**
   * PHASE21: application run-control facts have a distinct Host-only append
   * port. They cannot be emitted through model/tool or generic Phase 9 APIs.
   */
  async appendPhase21RunControlEvent<TType extends Phase21RunControlEventType>(
    runId: string,
    eventId: string,
    type: TType,
    data: Phase21RunControlEventData<TType>,
  ): Promise<DecodedStoredEvent> {
    phase21RunControlEventDataSchemas[type].parse(data);
    if (!isCanonicalUuid(eventId)) throw new Error("event id must be a canonical UUID");
    return this.appendRunEnvelope({
      data,
      eventId,
      runId,
      timestamp: this.timestamp(),
      type,
    });
  }

  async appendPhase16RunStarted(
    runId: string,
    eventId: string,
    data: Extract<RunEvent, { type: "run.started" }>["data"] &
      Phase16RunBinding & { readonly delegated_child_binding?: DelegatedChildRunBindingV1 },
    timestamp: string,
  ): Promise<DecodedStoredEvent> {
    if (!isCanonicalUuid(eventId)) {
      throw new Error("event id must be a canonical UUID");
    }
    return this.appendRunEnvelope({
      data,
      eventId,
      runId,
      timestamp,
      type: "run.started",
    });
  }

  async appendDelegatedChildRunStarted(
    runId: string,
    eventId: string,
    data: Extract<RunEvent, { type: "run.started" }>["data"] & {
      readonly delegated_child_binding: DelegatedChildRunBindingV1;
    },
    timestamp: string,
  ): Promise<DecodedStoredEvent> {
    if (!isCanonicalUuid(eventId)) {
      throw new Error("event id must be a canonical UUID");
    }
    return this.appendRunEnvelope({
      data,
      eventId,
      runId,
      timestamp,
      type: "run.started",
    });
  }

  /**
   * Import one already-validated v2 fact into a Host-owned session while
   * preserving its event/run identity and assigning only a new session_seq.
   * Phase 20 uses this to merge a completed minimal child session shard; it is
   * deliberately not part of the general SessionWriter port.
   */
  async appendImportedEvent(event: DecodedStoredEvent): Promise<DecodedStoredEvent> {
    if (event.sessionId !== this.sessionId || event.sourceSchemaVersion !== 2) {
      throw new Error("imported event must be a schema v2 fact for this exact session");
    }
    if (!isCanonicalUuid(event.eventId)) {
      throw new Error("imported event id must be a canonical UUID");
    }
    if (this.decoded.some((candidate) => candidate.eventId === event.eventId)) {
      throw new Error("imported event id already exists in the destination session");
    }
    if (event.scope === "session") {
      const envelope = storedEventEnvelopeV2Schema.parse({
        data: event.data,
        event_id: event.eventId,
        schema_version: 2,
        scope: "session",
        session_id: this.sessionId,
        session_seq: this.rawValues.length + 1,
        timestamp: event.timestamp,
        type: event.type,
      });
      return this.appendEnvelope(envelope);
    }
    const next = this.nextRunSequence.get(event.runId) ?? 1;
    if (event.runSeq !== next) {
      throw new Error(
        `imported run sequence is not contiguous (expected ${String(next)}, received ${String(event.runSeq)})`,
      );
    }
    const imported = await this.appendRunEnvelope({
      data: event.data,
      eventId: event.eventId,
      runId: event.runId,
      timestamp: event.timestamp,
      type: event.type,
    });
    return imported;
  }

  async withOwnedLock<T>(
    operation: (lock: SessionLock) => Promise<T>,
  ): Promise<T> {
    return this.store.withOwnedLock(operation);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.appendGate;
    if (this.closed) return;
    this.closed = true;
    this.durableEventListeners.clear();
    try {
      await this.store.close();
    } finally {
      const listeners = [...this.closeListeners];
      this.closeListeners.clear();
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A Host observation binding cannot keep a durable writer open.
        }
      }
    }
  }

  private static async open(
    workspace: string,
    sessionId: string,
    options: V2SessionWriterOptions,
  ): Promise<V2SessionWriter> {
    const decoder = new AccumulatingStoredEventDecoder();
    const storeOptions: DurableSessionStoreOpenOptions<DecodedStoredEvent> = {
      decoder,
      sessionId,
      workspace,
    };
    const store = await DurableSessionStore.open(storeOptions);
    return new V2SessionWriter(store, sessionId, decoder, options, workspace);
  }

  private async appendRunEnvelope(input: {
    readonly data: unknown;
    readonly eventId: string;
    readonly runId: string;
    readonly timestamp: string;
    readonly type: string;
  }): Promise<DecodedStoredEvent> {
    if (!isCanonicalUuid(input.runId)) throw new Error("run id must be a canonical UUID");
    const envelope = storedEventEnvelopeV2Schema.parse({
      data: input.data,
      event_id: input.eventId,
      run_id: input.runId,
      run_seq: this.nextRunSequence.get(input.runId) ?? 1,
      schema_version: 2,
      scope: "run",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: input.timestamp,
      type: input.type,
    });
    return this.appendEnvelope(envelope);
  }

  private async appendEnvelope(envelope: unknown): Promise<DecodedStoredEvent> {
    let release: (() => void) | undefined;
    const previous = this.appendGate;
    this.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.appendEnvelopeOwned(envelope);
    } finally {
      release?.();
    }
  }

  private async appendEnvelopeOwned(input: unknown): Promise<DecodedStoredEvent> {
    if (this.closed) throw new Error("session writer is closed");
    if (this.fatalAfterDurableHookObserved) {
      throw new Error(
        "session writer is poisoned after a post-durable fatal hook",
        { cause: this.fatalAfterDurableHookCause },
      );
    }
    const parsed = storedEventEnvelopeV2Schema.parse(input);
    // Every append is sequenced only after the per-writer gate is held. This
    // keeps a durable application cancel request from racing model/tool facts
    // into duplicate session_seq or run_seq values.
    const envelope = storedEventEnvelopeV2Schema.parse(
      parsed.scope === "run"
        ? {
            ...parsed,
            run_seq: this.nextRunSequence.get(parsed.run_id) ?? 1,
            session_seq: this.rawValues.length + 1,
          }
        : { ...parsed, session_seq: this.rawValues.length + 1 },
    );
    const prospective = [...this.rawValues, envelope];
    const decoded = decodeStoredEvents(prospective);
    // PHASE9: schema and sequence validation alone cannot authorize a
    // checkpoint/adoption fact. Run the same semantic state machine used by
    // replay before any prospective Phase 9 event reaches durable storage.
    assertPhase9RunEventSemantics(decoded);
    // PHASE16: schema-valid Goal/Plan events can still be stale or violate a
    // cross-event authority invariant. Reject the prospective state before
    // bytes reach the append+sync commit point.
    TaskStateMachine.project(decoded);
    TaskGraphProjector.project(decoded);
    TaskExecutionProjector.project(decoded);
    WorktreeProjector.project(decoded);
    BackgroundProjector.project(decoded);
    DelegationProjector.project(decoded);
    assertGoalChangeLedgerSemantics(decoded);
    const event = decoded.at(-1);
    if (event === undefined) throw new Error("stored envelope produced no event");
    const encoded = JSON.stringify(envelope);
    assertPhase21CancelRawBindings(decoded, this.rawLineSha256s);
    await this.store.appendEncodedLine(encoded);
    // PHASE9: only advance the in-memory session sequence after append+sync.
    // Renderer, model input, and side effects therefore cannot observe a fact
    // that exists only in a process buffer.
    this.rawValues.push(envelope);
    this.rawLineSha256s.push(sha256(Buffer.from(encoded, "utf8")));
    this.decoded = decoded;
    if (event.scope === "run") {
      this.nextRunSequence.set(event.runId, event.runSeq + 1);
    }
    // PHASE11: observers run only after append+sync and in-memory commit. Their
    // failure cannot retroactively turn a durable fact into a storage failure.
    for (const listener of this.durableEventListeners) {
      try {
        listener(event);
      } catch {
        // PersistedEventSource converts listener faults into its fatal channel.
      }
    }
    // PHASE14: the eval-only crash harness may terminate only here, after the
    // JSONL append has been synced and committed to the decoded ledger. Normal
    // CLI writers never configure this hook, so prompts/config cannot expose a
    // process-termination control or manufacture a pre-durable side effect.
    try {
      this.afterDurableEvent?.(event);
    } catch (error) {
      // PHASE14/21: this hook models process death immediately after fsync.
      // Once it fires, the old owner must never append a compensating terminal
      // or any later fact; only a newly opened writer may reconcile the prefix.
      this.fatalAfterDurableHookCause = error;
      this.fatalAfterDurableHookObserved = true;
      throw error;
    }
    return event;
  }

  private async persistRecoveryFacts(): Promise<void> {
    const recovery = this.store.lockRecovery;
    if (recovery !== undefined) {
      await this.appendSessionEvent("session.lock.recovered", {
        previous_nonce_sha256: sha256(Buffer.from(recovery.previousNonce, "utf8")),
        reason: "owner_confirmed_dead",
      });
    }
    const tail = this.store.tailRecovery;
    if (tail.kind === "none" || tail.backupFileName === undefined) return;
    const backupPath = `${dirname(this.path)}/${tail.backupFileName}`;
    const [original, repaired] = await Promise.all([
      readFile(backupPath),
      readFile(this.path),
    ]);
    await this.appendSessionEvent("session.tail.recovered", {
      backup_ref: `sessions/${basename(backupPath)}`,
      discarded_bytes: tail.removedBytes,
      original_sha256: sha256(original),
      repair:
        tail.kind === "newline_added"
          ? "added_newline"
          : "removed_incomplete_tail",
      repaired_sha256: sha256(repaired),
    });
  }
}
