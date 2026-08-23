import { z } from "zod";

import { runEventSchema } from "./run-event-schema.js";
import type { RunEvent } from "./run-event.js";
import {
  storedEventEnvelopeV2Schema,
  v2RunEventDataSchemas,
  v2SessionEventDataSchemas,
} from "./stored-event-v2.js";
import type {
  Phase9RunEventData,
  Phase9RunEventType,
  Phase9SessionEventData,
  Phase9SessionEventType,
  RunScopedEnvelopeV2,
  V2RunEventData,
  V2RunEventType,
  V2SessionEventData,
  V2SessionEventType,
} from "./stored-event-v2.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
  type Phase16RunBinding,
} from "./phase16-run-event-extension.js";
import {
  delegatedChildRunBindingSchema,
  type DelegatedChildRunBindingV1,
} from "./phase20-run-event-extension.js";

const LEGACY_RUN_EVENT_TYPES = [
  "run.started",
  "backend.selected",
  "text.delta",
  "agent.step.started",
  "model.usage",
  "agent.step.completed",
  "usage",
  "tool.call.requested",
  "tool.call.completed",
  "patch.plan.created",
  "approval.requested",
  "approval.decided",
  "patch.apply.started",
  "patch.apply.completed",
  "permission.evaluated",
  "command.execution.requested",
  "command.started",
  "command.output",
  "command.completed",
  "verification.started",
  "verification.completed",
  "completion.evidence",
  "completion.candidate",
  "completion.evaluated",
  "run.completed",
  "run.incomplete",
  "run.failed",
  "run.cancelled",
  "run.budget_exceeded",
] as const satisfies readonly RunEvent["type"][];

const TERMINAL_EVENT_TYPES = new Set<RunEvent["type"]>([
  "run.budget_exceeded",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.incomplete",
]);

type LegacyRunStartedData = Extract<
  RunEvent,
  { type: "run.started" }
>["data"];

type ResumeRunExtension =
  (
    | {
        readonly resume_mode?: never;
        readonly resume_of_run_id?: never;
      }
    | {
        readonly resume_mode: "canonical_degraded" | "exact";
        readonly resume_of_run_id: string;
      }
  );

export type CurrentRunStartedData = LegacyRunStartedData &
  ResumeRunExtension &
  (Phase16RunBinding | Record<string, never>) & {
    readonly delegated_child_binding?: DelegatedChildRunBindingV1;
  };

interface DecodedEventBase<TType extends string, TData> {
  readonly data: TData;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sessionSeq: number;
  readonly sourceSchemaVersion: 1 | 2;
  readonly timestamp: string;
  readonly type: TType;
}

interface DecodedRunEventBase<TType extends string, TData>
  extends DecodedEventBase<TType, TData> {
  readonly runId: string;
  readonly runSeq: number;
  readonly scope: "run";
}

interface DecodedSessionEventBase<TType extends string, TData>
  extends DecodedEventBase<TType, TData> {
  readonly scope: "session";
}

type LegacyCompatibleRunEvent = Exclude<
  RunEvent,
  { type: "run.started" }
>;

type DecodedLegacyCompatibleRunEvent<TEvent extends RunEvent> =
  TEvent extends RunEvent
    ? DecodedRunEventBase<TEvent["type"], TEvent["data"]>
    : never;

export type DecodedRunStartedEvent = DecodedRunEventBase<
  "run.started",
  CurrentRunStartedData
>;

export type DecodedPhase9SessionEvent = {
  [TType in Phase9SessionEventType]: DecodedSessionEventBase<
    TType,
    Phase9SessionEventData<TType>
  >;
}[Phase9SessionEventType];

export type DecodedV2SessionEvent = {
  [TType in V2SessionEventType]: DecodedSessionEventBase<
    TType,
    V2SessionEventData<TType>
  >;
}[V2SessionEventType];

export type DecodedPhase9RunEvent = {
  [TType in Phase9RunEventType]: DecodedRunEventBase<
    TType,
    Phase9RunEventData<TType>
  >;
}[Phase9RunEventType];

export type DecodedV2RunEvent = {
  [TType in V2RunEventType]: DecodedRunEventBase<
    TType,
    V2RunEventData<TType>
  >;
}[V2RunEventType];

export type DecodedRunEvent =
  | DecodedRunStartedEvent
  | DecodedLegacyCompatibleRunEvent<LegacyCompatibleRunEvent>
  | DecodedV2RunEvent;

export type DecodedSessionEvent = DecodedV2SessionEvent;
export type DecodedStoredEvent = DecodedRunEvent | DecodedSessionEvent;

export type StoredEventDecodeErrorCode =
  | "duplicate_event_id"
  | "event_after_terminal"
  | "invalid_event"
  | "invalid_scope"
  | "run_reopened"
  | "run_sequence"
  | "run_started_required"
  | "session_mismatch"
  | "session_sequence"
  | "unknown_event_type"
  | "unsupported_schema"
  | "v1_after_v2";

export class StoredEventDecodeError extends Error {
  public readonly code: StoredEventDecodeErrorCode;
  public readonly eventNumber: number;

  public constructor(
    code: StoredEventDecodeErrorCode,
    eventNumber: number,
    message: string,
  ) {
    super(`${message} at event ${eventNumber}`);
    this.name = "StoredEventDecodeError";
    this.code = code;
    this.eventNumber = eventNumber;
  }
}

interface RegistryEntry {
  readonly dataSchema?: z.ZodType;
  readonly legacyCompatible: boolean;
  readonly scope: "run" | "session";
}

interface RoutingFields {
  readonly schemaVersion: number;
  readonly scope: "run" | "session";
  readonly type: string;
}

interface MutableRunInvariantState {
  cancelRequest: Extract<DecodedV2RunEvent, { readonly type: "run.cancel.requested" }> | null;
  nextRunSeq: number;
  terminal: boolean;
}

function registryKey(schemaVersion: number, scope: "run" | "session", type: string): string {
  return `${schemaVersion}:${scope}:${type}`;
}

function routingFields(value: unknown, eventNumber: number): RoutingFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoredEventDecodeError(
      "invalid_event",
      eventNumber,
      "stored event must be a JSON object",
    );
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = record.schema_version;
  if (!Number.isInteger(schemaVersion)) {
    throw new StoredEventDecodeError(
      "invalid_event",
      eventNumber,
      "stored event schema_version must be an integer",
    );
  }
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new StoredEventDecodeError(
      "unsupported_schema",
      eventNumber,
      `unsupported schema_version ${String(schemaVersion)}`,
    );
  }
  if (typeof record.type !== "string") {
    throw new StoredEventDecodeError(
      "invalid_event",
      eventNumber,
      "stored event type must be a string",
    );
  }
  const scope = schemaVersion === 1 ? "run" : record.scope;
  if (scope !== "run" && scope !== "session") {
    throw new StoredEventDecodeError(
      "invalid_scope",
      eventNumber,
      "stored v2 event scope must be run or session",
    );
  }
  return { schemaVersion, scope, type: record.type };
}

function zodFailureMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "stored event failed strict decoding";
  const path = issue.path.length === 0 ? "event" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}

function resumeExtensionFromData(
  data: unknown,
):
  | Record<string, never>
  | { readonly resume_mode: "canonical_degraded" | "exact"; readonly resume_of_run_id: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {};
  }
  const record = data as Record<string, unknown>;
  const extension: Record<string, unknown> = {};
  if (Object.hasOwn(record, "resume_of_run_id")) {
    extension.resume_of_run_id = record.resume_of_run_id;
  }
  if (Object.hasOwn(record, "resume_mode")) {
    extension.resume_mode = record.resume_mode;
  }
  return z
    .union([
      z.object({}).strict(),
      z
        .object({
          resume_mode: z.enum(["exact", "canonical_degraded"]),
          resume_of_run_id: z.string().uuid(),
        })
        .strict(),
    ])
    .parse(extension);
}

function phase16ExtensionFromData(
  data: unknown,
): Phase16RunBinding | Record<string, never> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {};
  }
  const record = data as Readonly<Record<string, unknown>>;
  const extension: Record<string, unknown> = {};
  for (const field of PHASE16_RUN_BINDING_KEYS) {
    if (Object.hasOwn(record, field)) extension[field] = record[field];
  }
  if (Object.keys(extension).length === 0) return {};
  return phase16RunBindingSchema.parse(extension);
}

function phase20ExtensionFromData(
  data: unknown,
): { readonly delegated_child_binding?: DelegatedChildRunBindingV1 } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const record = data as Readonly<Record<string, unknown>>;
  if (!Object.hasOwn(record, "delegated_child_binding")) return {};
  return { delegated_child_binding: delegatedChildRunBindingSchema.parse(record.delegated_child_binding) };
}

function withoutRunStartExtensions(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  const copy = { ...(data as Record<string, unknown>) };
  delete copy.resume_mode;
  delete copy.resume_of_run_id;
  for (const field of PHASE16_RUN_BINDING_KEYS) delete copy[field];
  delete copy.delegated_child_binding;
  return copy;
}

function parseLegacyCompatibleV2Data(
  envelope: RunScopedEnvelopeV2,
): RunEvent["data"] | CurrentRunStartedData {
  const extension =
    envelope.type === "run.started"
      ? resumeExtensionFromData(envelope.data)
      : ({} as const);
  const phase16Extension =
    envelope.type === "run.started"
      ? phase16ExtensionFromData(envelope.data)
      : ({} as const);
  const phase20Extension =
    envelope.type === "run.started"
      ? phase20ExtensionFromData(envelope.data)
      : ({} as const);
  const parsed = runEventSchema.parse({
    data:
      envelope.type === "run.started"
        ? withoutRunStartExtensions(envelope.data)
        : envelope.data,
    event_id: envelope.event_id,
    run_id: envelope.run_id,
    schema_version: 1,
    seq: envelope.run_seq,
    session_id: envelope.session_id,
    timestamp: envelope.timestamp,
    type: envelope.type,
  });
  if (parsed.type !== "run.started") return parsed.data;
  return {
    ...parsed.data,
    ...extension,
    ...phase16Extension,
    ...phase20Extension,
  } as CurrentRunStartedData;
}

function isTerminalType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type as RunEvent["type"]);
}

export function isDecodedTerminalRunEvent(
  event: DecodedStoredEvent,
): event is Extract<
  DecodedRunEvent,
  {
    type:
      | "run.budget_exceeded"
      | "run.cancelled"
      | "run.completed"
      | "run.failed"
      | "run.incomplete";
  }
> {
  return event.scope === "run" && isTerminalType(event.type);
}

export function assertDecodedStoredEventInvariants(
  events: readonly DecodedStoredEvent[],
): void {
  const eventIds = new Set<string>();
  const runs = new Map<string, MutableRunInvariantState>();
  let sessionId: string | undefined;
  let currentRunId: string | undefined;
  let sawV2 = false;

  for (const [index, event] of events.entries()) {
    const eventNumber = index + 1;
    if (event.sourceSchemaVersion === 1 && sawV2) {
      throw new StoredEventDecodeError(
        "v1_after_v2",
        eventNumber,
        "schema v1 cannot appear after schema v2 begins",
      );
    }
    sawV2 ||= event.sourceSchemaVersion === 2;

    if (event.sessionSeq !== eventNumber) {
      throw new StoredEventDecodeError(
        "session_sequence",
        eventNumber,
        `expected session_seq ${eventNumber}, received ${event.sessionSeq}`,
      );
    }
    if (sessionId === undefined) sessionId = event.sessionId;
    if (event.sessionId !== sessionId) {
      throw new StoredEventDecodeError(
        "session_mismatch",
        eventNumber,
        "all stored events must belong to one session",
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new StoredEventDecodeError(
        "duplicate_event_id",
        eventNumber,
        "event_id must be unique within a session",
      );
    }
    eventIds.add(event.eventId);

    if (event.scope === "session") continue;
    const state = runs.get(event.runId);
    if (state === undefined) {
      if (event.type !== "run.started") {
        throw new StoredEventDecodeError(
          "run_started_required",
          eventNumber,
          "the first event for a run must be run.started",
        );
      }
      if (event.runSeq !== 1) {
        throw new StoredEventDecodeError(
          "run_sequence",
          eventNumber,
          `expected run_seq 1, received ${event.runSeq}`,
        );
      }
      runs.set(event.runId, {
        cancelRequest: null,
        nextRunSeq: 2,
        terminal: isTerminalType(event.type),
      });
      currentRunId = event.runId;
      continue;
    }
    if (event.runId !== currentRunId) {
      throw new StoredEventDecodeError(
        "run_reopened",
        eventNumber,
        "a previous run cannot receive events after a newer run begins",
      );
    }
    if (state.terminal) {
      throw new StoredEventDecodeError(
        "event_after_terminal",
        eventNumber,
        "a terminal run cannot receive more run-scoped events",
      );
    }
    if (event.runSeq !== state.nextRunSeq) {
      throw new StoredEventDecodeError(
        "run_sequence",
        eventNumber,
        `expected run_seq ${state.nextRunSeq}, received ${event.runSeq}`,
      );
    }
    if (event.type === "run.cancel.requested") {
      if (
        event.data.target_run_id !== event.runId ||
        event.data.application_commit.operation_id !== event.eventId ||
        state.cancelRequest !== null
      ) {
        throw new StoredEventDecodeError(
          "invalid_event",
          eventNumber,
          "run cancel request does not bind one exact run/operation",
        );
      }
      state.cancelRequest = event;
    }
    if (event.type === "run.cancelled") {
      const binding = "application_cancel_request" in event.data
        ? event.data.application_cancel_request
        : null;
      if (
        (binding === null) !== (state.cancelRequest === null) ||
        (binding !== null && state.cancelRequest !== null && (
          binding.request_event_id !== state.cancelRequest.eventId ||
          binding.target_owner_generation_sha256 !== state.cancelRequest.data.target_owner_generation_sha256
        ))
      ) {
        throw new StoredEventDecodeError(
          "invalid_event",
          eventNumber,
          "run.cancelled does not reference its exact application cancel request",
        );
      }
    }
    state.nextRunSeq += 1;
    state.terminal = isTerminalType(event.type);
  }
}

export class EventDecoderRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  public constructor() {
    for (const type of LEGACY_RUN_EVENT_TYPES) {
      this.entries.set(registryKey(1, "run", type), {
        legacyCompatible: true,
        scope: "run",
      });
      this.entries.set(registryKey(2, "run", type), {
        legacyCompatible: true,
        scope: "run",
      });
    }
    for (const [type, dataSchema] of Object.entries(
      v2SessionEventDataSchemas,
    )) {
      this.entries.set(registryKey(2, "session", type), {
        dataSchema,
        legacyCompatible: false,
        scope: "session",
      });
    }
    for (const [type, dataSchema] of Object.entries(v2RunEventDataSchemas)) {
      this.entries.set(registryKey(2, "run", type), {
        dataSchema,
        legacyCompatible: false,
        scope: "run",
      });
    }
  }

  public decodeAll(values: readonly unknown[]): readonly DecodedStoredEvent[] {
    const decoded = values.map((value, index) =>
      this.decodeAt(value, index + 1),
    );
    assertDecodedStoredEventInvariants(decoded);
    return decoded;
  }

  /** Decode one physical record at its global one-based session position. */
  public decodeAt(value: unknown, eventNumber: number): DecodedStoredEvent {
    const routing = routingFields(value, eventNumber);
    const entry = this.entries.get(
      registryKey(routing.schemaVersion, routing.scope, routing.type),
    );
    if (entry === undefined) {
      const alternateScope = routing.scope === "run" ? "session" : "run";
      const alternate = this.entries.get(registryKey(routing.schemaVersion, alternateScope, routing.type));
      if (alternate !== undefined) {
        throw new StoredEventDecodeError(
          "invalid_scope",
          eventNumber,
          `${routing.type} must use ${alternate.scope} scope`,
        );
      }
      throw new StoredEventDecodeError(
        "unknown_event_type",
        eventNumber,
        `unknown event type ${routing.type} for schema_version ${routing.schemaVersion}`,
      );
    }

    try {
      if (routing.schemaVersion === 1) {
        const parsed = runEventSchema.parse(value);
        return {
          data: parsed.data,
          eventId: parsed.event_id,
          runId: parsed.run_id,
          runSeq: parsed.seq,
          scope: "run",
          sessionId: parsed.session_id,
          // PHASE9: v1 seq is run-local, so physical valid-event order supplies
          // a synthetic session sequence without mutating the historical file.
          sessionSeq: eventNumber,
          sourceSchemaVersion: 1,
          timestamp: parsed.timestamp,
          type: parsed.type,
        } as DecodedStoredEvent;
      }

      const envelope = storedEventEnvelopeV2Schema.parse(value);
      if (envelope.scope !== entry.scope) {
        throw new StoredEventDecodeError(
          "invalid_scope",
          eventNumber,
          `${routing.type} must use ${entry.scope} scope`,
        );
      }
      const data = entry.legacyCompatible
        ? parseLegacyCompatibleV2Data(envelope as RunScopedEnvelopeV2)
        : entry.dataSchema?.parse(envelope.data);
      if (data === undefined) {
        throw new StoredEventDecodeError(
          "invalid_event",
          eventNumber,
          "event decoder did not produce data",
        );
      }

      // PHASE9: upcast creates the current in-memory shape only. Rewriting old
      // bytes would destroy audit evidence and make recovery non-deterministic.
      if (envelope.scope === "session") {
        return {
          data,
          eventId: envelope.event_id,
          scope: "session",
          sessionId: envelope.session_id,
          sessionSeq: envelope.session_seq,
          sourceSchemaVersion: 2,
          timestamp: envelope.timestamp,
          type: envelope.type,
        } as DecodedStoredEvent;
      }
      return {
        data,
        eventId: envelope.event_id,
        runId: envelope.run_id,
        runSeq: envelope.run_seq,
        scope: "run",
        sessionId: envelope.session_id,
        sessionSeq: envelope.session_seq,
        sourceSchemaVersion: 2,
        timestamp: envelope.timestamp,
        type: envelope.type,
      } as DecodedStoredEvent;
    } catch (error) {
      if (error instanceof StoredEventDecodeError) throw error;
      if (error instanceof z.ZodError) {
        throw new StoredEventDecodeError(
          "invalid_event",
          eventNumber,
          zodFailureMessage(error),
        );
      }
      throw error;
    }
  }
}

const defaultEventDecoderRegistry = new EventDecoderRegistry();

export function decodeStoredEvents(
  values: readonly unknown[],
): readonly DecodedStoredEvent[] {
  return defaultEventDecoderRegistry.decodeAll(values);
}
