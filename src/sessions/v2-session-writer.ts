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

export interface V2SessionWriterOptions {
  readonly afterDurableEvent?: (event: DecodedStoredEvent) => void;
  readonly createEventId?: () => string;
  readonly timestamp?: () => string;
}

class AccumulatingStoredEventDecoder
  implements StoredLineDecoder<DecodedStoredEvent>
{
  readonly values: unknown[] = [];

  decode(value: unknown): DecodedStoredEvent {
    const candidate = [...this.values, value];
    const decoded = decodeStoredEvents(candidate);
    const event = decoded.at(-1);
    if (event === undefined) throw new Error("stored event decoder returned no event");
    this.values.push(value);
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

export class V2SessionWriter implements SessionWriter {
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
  private readonly nextRunSequence = new Map<string, number>();
  private readonly rawValues: unknown[];
  private readonly timestamp: () => string;

  private constructor(
    private readonly store: DurableSessionStore<DecodedStoredEvent>,
    private readonly sessionId: string,
    decoder: AccumulatingStoredEventDecoder,
    options: V2SessionWriterOptions,
    workspace: string,
  ) {
    this.path = store.path;
    this.workspace = workspace;
    this.rawValues = decoder.values;
    this.decoded = decodeStoredEvents(this.rawValues);
    assertPhase9RunEventSemantics(this.decoded);
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

  get events(): readonly DecodedStoredEvent[] {
    return [...this.decoded];
  }

  readDecodedEvents(): readonly DecodedStoredEvent[] {
    return this.events;
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

  async appendPhase16RunStarted(
    runId: string,
    eventId: string,
    data: Extract<RunEvent, { type: "run.started" }>["data"] &
      Phase16RunBinding,
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

  async withOwnedLock<T>(
    operation: (lock: SessionLock) => Promise<T>,
  ): Promise<T> {
    return this.store.withOwnedLock(operation);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.durableEventListeners.clear();
    await this.store.close();
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
    const runSequence = this.nextRunSequence.get(input.runId) ?? 1;
    const envelope = storedEventEnvelopeV2Schema.parse({
      data: input.data,
      event_id: input.eventId,
      run_id: input.runId,
      run_seq: runSequence,
      schema_version: 2,
      scope: "run",
      session_id: this.sessionId,
      session_seq: this.rawValues.length + 1,
      timestamp: input.timestamp,
      type: input.type,
    });
    const event = await this.appendEnvelope(envelope);
    this.nextRunSequence.set(input.runId, runSequence + 1);
    return event;
  }

  private async appendEnvelope(envelope: unknown): Promise<DecodedStoredEvent> {
    if (this.closed) throw new Error("session writer is closed");
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
    assertGoalChangeLedgerSemantics(decoded);
    const event = decoded.at(-1);
    if (event === undefined) throw new Error("stored envelope produced no event");
    await this.store.appendEncodedLine(JSON.stringify(envelope));
    // PHASE9: only advance the in-memory session sequence after append+sync.
    // Renderer, model input, and side effects therefore cannot observe a fact
    // that exists only in a process buffer.
    this.rawValues.push(envelope);
    this.decoded = decoded;
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
    this.afterDurableEvent?.(event);
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
