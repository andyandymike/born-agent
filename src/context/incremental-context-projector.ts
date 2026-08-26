import { sha256Canonical } from "../completion/canonical-json.js";
import type { ContextArtifactReference, ContextItem } from "./context-item.js";
import {
  ContextProjectionError,
  ContextProjector,
  type ContextProjectionInput,
  type ProjectableContextEvent,
  type ProjectedContextState,
} from "./context-projector.js";
import type { TokenEstimator } from "./token-estimator.js";

export const WORKING_CONTEXT_PROJECTION_VERSION_V1 =
  "agent-memory-working-context-v1";

export interface IncrementalContextProjectionObservationV1 {
  readonly onProjection?: (input: Readonly<{
    readonly mode: "cold" | "incremental";
    readonly projectionVersion: typeof WORKING_CONTEXT_PROJECTION_VERSION_V1;
    readonly sourceEventCount: number;
    readonly sourceEventsApplied: number;
  }>) => void;
}

interface ProjectionCursor {
  readonly activeEffectIds: Set<string>;
  readonly artifactsByEventId: Map<string, readonly ContextArtifactReference[]>;
  readonly baseItemIds: Set<string>;
  readonly configSha256: string;
  readonly eventById: Map<string, ProjectableContextEvent>;
  readonly eventIds: Set<string>;
  readonly eventItemIds: Map<string, Set<string>>;
  readonly eventSha256s: string[];
  readonly firstEvent: ProjectableContextEvent | null;
  readonly firstEventSha256: string | null;
  readonly inputWasCanonical: boolean;
  readonly itemsById: Map<string, ContextItem>;
  latestRepositoryIndexEventId: string | null;
  latestRepositorySourceEventId: string | null;
  readonly repositoryInvalidationEventIds: Set<string>;
  readonly sequences: Set<number>;
  readonly sourceEventIds: string[];
  lastState: ProjectedContextState;
  lastStateEpoch: number;
  lastStateSourceEventCount: number;
  tailEvent: ProjectableContextEvent | null;
  tailEventSha256: string | null;
  readonly toolMembersByPair: Map<string, Set<string>>;
  readonly toolRequestByPair: Map<string, string>;
}

function eventOrder(
  left: ProjectableContextEvent,
  right: ProjectableContextEvent,
): number {
  return (
    left.sessionSeq - right.sessionSeq ||
    left.eventId.localeCompare(right.eventId)
  );
}

function itemLayer(item: ContextItem): number {
  switch (item.kind) {
    case "system_instruction":
      return 0;
    case "user_message":
      return 1;
    case "repository_rules":
      return 2;
    case "skill_arguments":
    case "skill_entry":
      return 3;
    case "mcp_prompt":
      return 4;
    case "skill_resource":
    case "mcp_resource":
      return 5;
    case "approval_history":
    case "historical_memory":
    case "mutation_fact":
    case "state_fact":
      return 6;
    default:
      return 7;
  }
}

function itemOrder(left: ContextItem, right: ContextItem): number {
  return (
    itemLayer(left) - itemLayer(right) ||
    left.recency - right.recency ||
    left.id.localeCompare(right.id)
  );
}

function pairId(
  prefix: string,
  identity: string,
  event: ProjectableContextEvent,
): string {
  return `${prefix}:${event.runId ?? "session"}:${identity}`;
}

function eventRecord(event: ProjectableContextEvent): Record<string, unknown> {
  if (
    event.data === null ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  ) {
    throw new ContextProjectionError(
      "invalid_event_data",
      `${event.type} data must be an object`,
    );
  }
  return event.data as Record<string, unknown>;
}

function stringField(
  event: ProjectableContextEvent,
  key: string,
): string {
  const value = eventRecord(event)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ContextProjectionError(
      "invalid_event_data",
      `${event.type}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function contextConfigSha256(input: ContextProjectionInput): string {
  return sha256Canonical({
    additionalItems: input.additionalItems ?? [],
    artifactRefsByEventId: input.artifactRefsByEventId ?? {},
    repositoryRules: input.repositoryRules ?? null,
    systemInstructions: input.systemInstructions,
  });
}

function artifactsFromInput(
  input: ContextProjectionInput,
): Map<string, readonly ContextArtifactReference[]> {
  const result = new Map<string, readonly ContextArtifactReference[]>();
  for (const [eventId, references] of Object.entries(
    input.artifactRefsByEventId ?? {},
  )) {
    result.set(eventId, Object.freeze([...references]));
  }
  return result;
}

function storedArtifact(
  event: ProjectableContextEvent,
): Readonly<{
  readonly originEventId: string;
  readonly reference: ContextArtifactReference;
}> | null {
  if (event.type !== "artifact.stored") return null;
  const data = eventRecord(event);
  const originEventId = stringField(event, "origin_event_id");
  const artifactId = stringField(event, "artifact_id");
  const sha256 = stringField(event, "sha256");
  const bytes = data.bytes;
  if (
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0 ||
    artifactId !== `sha256:${sha256}`
  ) {
    throw new ContextProjectionError(
      "invalid_event_data",
      "artifact.stored identity is invalid",
    );
  }
  return Object.freeze({
    originEventId,
    reference: Object.freeze({
      artifactId,
      bytes: bytes as number,
      mediaType: stringField(event, "media_type"),
      relativeRef: stringField(event, "object_ref"),
      sha256,
    }),
  });
}

function uniqueArtifacts(
  values: readonly ContextArtifactReference[],
): readonly ContextArtifactReference[] {
  return Object.freeze(
    [...new Map(values.map((value) => [value.artifactId, value])).values()]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  );
}

function addPairMember(
  cursor: ProjectionCursor,
  id: string,
  eventId: string,
): void {
  const members = cursor.toolMembersByPair.get(id) ?? new Set<string>();
  members.add(eventId);
  cursor.toolMembersByPair.set(id, members);
}

function registerPair(cursor: ProjectionCursor, event: ProjectableContextEvent): void {
  switch (event.type) {
    case "tool.call.requested": {
      const id = pairId("tool", stringField(event, "call_id"), event);
      cursor.toolRequestByPair.set(id, event.eventId);
      addPairMember(cursor, id, event.eventId);
      break;
    }
    case "tool.call.completed":
    case "tool.call.recovered": {
      addPairMember(
        cursor,
        pairId("tool", stringField(event, "call_id"), event),
        event.eventId,
      );
      break;
    }
    case "resume.pending_call.adopted": {
      const sourceRunId = stringField(event, "source_run_id");
      const sourceCallId = stringField(event, "source_call_id");
      const adopted = pairId("tool", stringField(event, "call_id"), event);
      const source = `tool:${sourceRunId}:${sourceCallId}`;
      cursor.toolRequestByPair.set(adopted, event.eventId);
      addPairMember(cursor, adopted, event.eventId);
      addPairMember(cursor, source, event.eventId);
      break;
    }
    default:
      break;
  }
}

function transitionEffects(
  active: Set<string>,
  event: ProjectableContextEvent,
): void {
  switch (event.type) {
    case "session.resume.requested": {
      const sourceRunId = stringField(event, "source_run_id");
      for (const id of [...active]) {
        if (id.startsWith(`model:${sourceRunId}:`)) active.delete(id);
      }
      break;
    }
    case "side_effect.reconciled":
      active.delete(
        `mutation:${stringField(event, "source_run_id")}:${stringField(event, "effect_id")}`,
      );
      break;
    case "resume.pending_call.adopted": {
      active.delete(
        `tool:${stringField(event, "source_run_id")}:${stringField(event, "source_call_id")}`,
      );
      active.add(pairId("tool", stringField(event, "call_id"), event));
      break;
    }
    case "tool.call.requested":
      active.add(pairId("tool", stringField(event, "call_id"), event));
      break;
    case "tool.call.completed":
    case "tool.call.recovered":
      active.delete(pairId("tool", stringField(event, "call_id"), event));
      break;
    case "patch.plan.created":
      active.add(pairId("mutation", stringField(event, "plan_id"), event));
      break;
    case "approval.requested": {
      const data = eventRecord(event);
      const identity = typeof data.plan_id === "string"
        ? data.plan_id
        : stringField(event, "call_id");
      active.add(pairId("mutation", identity, event));
      break;
    }
    case "approval.decided": {
      const data = eventRecord(event);
      const identity = typeof data.plan_id === "string"
        ? data.plan_id
        : stringField(event, "call_id");
      if (data.decision !== "approved") {
        active.delete(pairId("mutation", identity, event));
      }
      break;
    }
    case "patch.apply.started":
      active.add(pairId("mutation", stringField(event, "plan_id"), event));
      break;
    case "patch.apply.completed":
      active.delete(pairId("mutation", stringField(event, "plan_id"), event));
      break;
    case "command.execution.requested":
      active.add(pairId("command", stringField(event, "execution_id"), event));
      break;
    case "command.completed":
      active.delete(pairId("command", stringField(event, "execution_id"), event));
      break;
    case "verification.started":
      active.add(pairId("verification", stringField(event, "verification_id"), event));
      break;
    case "verification.completed":
      active.delete(pairId("verification", stringField(event, "verification_id"), event));
      break;
    case "completion.candidate":
      active.add(pairId("completion", stringField(event, "candidate_sha256"), event));
      break;
    case "completion.evaluated":
      active.delete(pairId("completion", stringField(event, "candidate_sha256"), event));
      break;
    case "agent.step.started":
      active.add(pairId("model", String(eventRecord(event).step ?? event.runSeq ?? 0), event));
      break;
    case "agent.step.completed":
      active.delete(pairId("model", String(eventRecord(event).step ?? event.runSeq ?? 0), event));
      break;
    default:
      break;
  }
}

function eventIsCanonicalPrefix(
  cursor: ProjectionCursor,
  events: readonly ProjectableContextEvent[],
): boolean {
  if (!cursor.inputWasCanonical || events.length < cursor.sourceEventIds.length) {
    return false;
  }
  if (cursor.sourceEventIds.length === 0) return true;
  for (let index = 0; index < cursor.sourceEventIds.length; index += 1) {
    const event = events[index];
    if (
      event === undefined ||
      event.eventId !== cursor.sourceEventIds[index] ||
      sha256Canonical(event) !== cursor.eventSha256s[index]
    ) {
      return false;
    }
  }
  const first = events[0];
  const tail = events[cursor.sourceEventIds.length - 1];
  return first !== undefined && tail !== undefined &&
    first.eventId === cursor.firstEvent?.eventId &&
    first.sessionSeq === cursor.firstEvent?.sessionSeq &&
    sha256Canonical(first) === cursor.firstEventSha256 &&
    tail.eventId === cursor.tailEvent?.eventId &&
    tail.sessionSeq === cursor.tailEvent?.sessionSeq &&
    sha256Canonical(tail) === cursor.tailEventSha256;
}

/**
 * AM1 projection owner. The current ContextProjector remains the cold oracle;
 * this owner only accepts a suffix when the caller still exposes the exact
 * append-only prefix anchor and the non-event projection configuration is
 * unchanged. Any ambiguity returns to the oracle instead of merging histories.
 */
export class IncrementalContextProjector {
  private cursor: ProjectionCursor | null = null;
  private readonly oracle: ContextProjector;

  public constructor(
    private readonly estimator: TokenEstimator,
    private readonly observation: IncrementalContextProjectionObservationV1 = {},
  ) {
    this.oracle = new ContextProjector(estimator);
  }

  public project(input: ContextProjectionInput): ProjectedContextState {
    const configSha256 = contextConfigSha256(input);
    if (
      this.cursor === null ||
      this.cursor.configSha256 !== configSha256 ||
      !eventIsCanonicalPrefix(this.cursor, input.events)
    ) {
      return this.projectCold(input, configSha256);
    }
    return this.projectSuffix(input, this.cursor);
  }

  public reset(): void {
    this.cursor = null;
  }

  private projectCold(
    input: ContextProjectionInput,
    configSha256: string,
  ): ProjectedContextState {
    const state = this.oracle.project(input);
    const orderedEvents = [...input.events].sort(eventOrder);
    const base = this.oracle.project({
      ...(input.additionalItems === undefined ? {} : { additionalItems: input.additionalItems }),
      ...(input.repositoryRules === undefined ? {} : { repositoryRules: input.repositoryRules }),
      epoch: input.epoch,
      events: [],
      systemInstructions: input.systemInstructions,
    });
    const baseItemIds = new Set(base.items.map(({ id }) => id));
    const itemsById = new Map(state.items.map((item) => [item.id, item]));
    const orderedEventIds = new Set(orderedEvents.map(({ eventId }) => eventId));
    const eventItemIds = new Map<string, Set<string>>();
    for (const item of state.items) {
      if (baseItemIds.has(item.id) || item.sourceEventIds.length !== 1) continue;
      const sourceEventId = item.sourceEventIds[0]!;
      if (!orderedEventIds.has(sourceEventId)) continue;
      const ids = eventItemIds.get(sourceEventId) ?? new Set<string>();
      ids.add(item.id);
      eventItemIds.set(sourceEventId, ids);
    }
    const cursor: ProjectionCursor = {
      activeEffectIds: new Set(state.activeEffectIds),
      artifactsByEventId: artifactsFromInput(input),
      baseItemIds,
      configSha256,
      eventById: new Map(orderedEvents.map((event) => [event.eventId, event])),
      eventIds: orderedEventIds,
      eventItemIds,
      eventSha256s: orderedEvents.map((event) => sha256Canonical(event)),
      firstEvent: orderedEvents[0] ?? null,
      firstEventSha256: orderedEvents[0] === undefined
        ? null
        : sha256Canonical(orderedEvents[0]),
      inputWasCanonical: orderedEvents.every(
        (event, index) => event === input.events[index],
      ),
      itemsById,
      lastState: state,
      lastStateEpoch: input.epoch,
      lastStateSourceEventCount: orderedEvents.length,
      latestRepositoryIndexEventId:
        [...orderedEvents].reverse().find(
          ({ type }) => type === "repository.index.selected",
        )?.eventId ?? null,
      latestRepositorySourceEventId:
        [...orderedEvents].reverse().find(
          ({ type }) => type === "repository.source.snapshot.captured",
        )?.eventId ?? null,
      repositoryInvalidationEventIds: new Set(
        orderedEvents
          .filter(({ type }) => type === "repository.index.invalidated")
          .map(({ eventId }) => eventId),
      ),
      sequences: new Set(orderedEvents.map(({ sessionSeq }) => sessionSeq)),
      sourceEventIds: [...state.sourceEventIds],
      tailEvent: orderedEvents.at(-1) ?? null,
      tailEventSha256: orderedEvents.at(-1) === undefined
        ? null
        : sha256Canonical(orderedEvents.at(-1)!),
      toolMembersByPair: new Map(),
      toolRequestByPair: new Map(),
    };
    for (const event of orderedEvents) {
      registerPair(cursor, event);
      const stored = storedArtifact(event);
      if (stored === null) continue;
      const current = cursor.artifactsByEventId.get(stored.originEventId) ?? [];
      cursor.artifactsByEventId.set(
        stored.originEventId,
        uniqueArtifacts([...current, stored.reference]),
      );
    }
    this.cursor = cursor;
    this.observation.onProjection?.({
      mode: "cold",
      projectionVersion: WORKING_CONTEXT_PROJECTION_VERSION_V1,
      sourceEventCount: orderedEvents.length,
      sourceEventsApplied: orderedEvents.length,
    });
    return state;
  }

  private projectSuffix(
    input: ContextProjectionInput,
    cursor: ProjectionCursor,
  ): ProjectedContextState {
    const suffix = input.events.slice(cursor.sourceEventIds.length);
    if (suffix.length === 0) {
      const state = this.state(cursor, input.epoch);
      this.observation.onProjection?.({
        mode: "incremental",
        projectionVersion: WORKING_CONTEXT_PROJECTION_VERSION_V1,
        sourceEventCount: cursor.sourceEventIds.length,
        sourceEventsApplied: 0,
      });
      return state;
    }
    try {
      let priorSequence = cursor.tailEvent?.sessionSeq ?? -1;
      for (const event of suffix) {
        if (cursor.eventIds.has(event.eventId)) {
          throw new ContextProjectionError(
            "duplicate_event_id",
            `duplicate event id ${event.eventId}`,
          );
        }
        if (
          cursor.sequences.has(event.sessionSeq) ||
          event.sessionSeq <= priorSequence
        ) {
          throw new ContextProjectionError(
            "duplicate_event_sequence",
            `duplicate or non-append event sequence ${String(event.sessionSeq)}`,
          );
        }
        priorSequence = event.sessionSeq;
        cursor.eventIds.add(event.eventId);
        cursor.sequences.add(event.sessionSeq);
        cursor.eventById.set(event.eventId, event);
        cursor.eventSha256s.push(sha256Canonical(event));
        cursor.sourceEventIds.push(event.eventId);
        registerPair(cursor, event);
      }

      const artifactImpacts = new Set<string>();
      for (const event of suffix) {
        const stored = storedArtifact(event);
        if (stored === null) continue;
        const current = cursor.artifactsByEventId.get(stored.originEventId) ?? [];
        cursor.artifactsByEventId.set(
          stored.originEventId,
          uniqueArtifacts([...current, stored.reference]),
        );
        artifactImpacts.add(stored.originEventId);
      }
      for (const eventId of artifactImpacts) {
        if (cursor.eventItemIds.has(eventId)) this.reprojectPair(cursor, eventId);
      }

      for (const event of suffix) {
        this.applyEvent(cursor, event);
        transitionEffects(cursor.activeEffectIds, event);
      }
      const last = suffix.at(-1)!;
      cursor.tailEvent = last;
      cursor.tailEventSha256 = sha256Canonical(last);
      const state = this.state(cursor, input.epoch);
      this.observation.onProjection?.({
        mode: "incremental",
        projectionVersion: WORKING_CONTEXT_PROJECTION_VERSION_V1,
        sourceEventCount: cursor.sourceEventIds.length,
        sourceEventsApplied: suffix.length,
      });
      return state;
    } catch (error) {
      this.cursor = null;
      throw error;
    }
  }

  private applyEvent(cursor: ProjectionCursor, event: ProjectableContextEvent): void {
    if (event.type === "repository.source.snapshot.captured") {
      if (cursor.latestRepositorySourceEventId !== null) {
        this.removeEventItems(cursor, cursor.latestRepositorySourceEventId);
      }
      cursor.latestRepositorySourceEventId = event.eventId;
    } else if (event.type === "repository.index.selected") {
      if (cursor.latestRepositoryIndexEventId !== null) {
        this.removeEventItems(cursor, cursor.latestRepositoryIndexEventId);
      }
      for (const invalidated of cursor.repositoryInvalidationEventIds) {
        this.removeEventItems(cursor, invalidated);
      }
      cursor.repositoryInvalidationEventIds.clear();
      cursor.latestRepositoryIndexEventId = event.eventId;
    } else if (event.type === "repository.index.invalidated") {
      cursor.repositoryInvalidationEventIds.add(event.eventId);
    }
    this.replaceEventItems(cursor, event.eventId, this.itemsForEvent(cursor, event));
  }

  private itemsForEvent(
    cursor: ProjectionCursor,
    event: ProjectableContextEvent,
  ): readonly ContextItem[] {
    const selected = new Map<string, ProjectableContextEvent>();
    selected.set(event.eventId, event);
    if (event.type === "tool.call.completed" || event.type === "tool.call.recovered") {
      const requestId = cursor.toolRequestByPair.get(
        pairId("tool", stringField(event, "call_id"), event),
      );
      const request = requestId === undefined
        ? undefined
        : cursor.eventById.get(requestId);
      if (request !== undefined) selected.set(request.eventId, request);
    }
    const events = [...selected.values()].sort(eventOrder);
    const artifactRefsByEventId = Object.fromEntries(
      events.flatMap((candidate) => {
        const references = cursor.artifactsByEventId.get(candidate.eventId);
        return references === undefined ? [] : [[candidate.eventId, references] as const];
      }),
    );
    const projection = this.oracle.project({
      ...(Object.keys(artifactRefsByEventId).length === 0
        ? {}
        : { artifactRefsByEventId }),
      epoch: 0,
      events,
      systemInstructions: [],
    });
    return Object.freeze(
      projection.items.filter(
        (item) =>
          item.sourceEventIds.length === 1 &&
          item.sourceEventIds[0] === event.eventId,
      ),
    );
  }

  private reprojectPair(cursor: ProjectionCursor, eventId: string): void {
    const event = cursor.eventById.get(eventId);
    if (event === undefined) return;
    const affected = new Set<string>([eventId]);
    for (const members of cursor.toolMembersByPair.values()) {
      if (!members.has(eventId)) continue;
      for (const member of members) affected.add(member);
    }
    for (const affectedId of affected) {
      const affectedEvent = cursor.eventById.get(affectedId);
      if (affectedEvent === undefined) continue;
      this.replaceEventItems(
        cursor,
        affectedId,
        this.itemsForEvent(cursor, affectedEvent),
      );
    }
  }

  private removeEventItems(cursor: ProjectionCursor, eventId: string): void {
    for (const itemId of cursor.eventItemIds.get(eventId) ?? []) {
      cursor.itemsById.delete(itemId);
    }
    cursor.eventItemIds.delete(eventId);
  }

  private replaceEventItems(
    cursor: ProjectionCursor,
    eventId: string,
    items: readonly ContextItem[],
  ): void {
    this.removeEventItems(cursor, eventId);
    const ids = new Set<string>();
    for (const item of items) {
      if (cursor.itemsById.has(item.id)) {
        throw new ContextProjectionError(
          "duplicate_event_id",
          `duplicate projected context item ${item.id}`,
        );
      }
      cursor.itemsById.set(item.id, item);
      ids.add(item.id);
    }
    if (ids.size > 0) cursor.eventItemIds.set(eventId, ids);
  }

  private state(cursor: ProjectionCursor, epoch: number): ProjectedContextState {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new ContextProjectionError(
        "invalid_epoch",
        "context epoch must be a nonnegative safe integer",
      );
    }
    if (
      cursor.lastStateEpoch === epoch &&
      cursor.lastStateSourceEventCount === cursor.sourceEventIds.length
    ) {
      return cursor.lastState;
    }
    const activeEffectIds = Object.freeze(
      [...cursor.activeEffectIds].sort((left, right) => left.localeCompare(right)),
    );
    const state = Object.freeze({
      activeEffectIds,
      epoch,
      estimatorId: this.estimator.estimatorId,
      items: Object.freeze([...cursor.itemsById.values()].sort(itemOrder)),
      safePoint: activeEffectIds.length === 0,
      sourceEventIds: Object.freeze([...cursor.sourceEventIds]),
    });
    cursor.lastState = state;
    cursor.lastStateEpoch = epoch;
    cursor.lastStateSourceEventCount = cursor.sourceEventIds.length;
    return state;
  }
}
