import { randomUUID } from "node:crypto";

import { ApplicationControlError } from "./application-errors.js";
import type {
  AuthenticatedCallContextV1,
  DeliveryCursorV1,
  SessionLedgerHeadV1,
} from "./application-protocol.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_INTEGRITY_TOKEN = /^slh_v1_[A-Za-z0-9_-]{43}$/u;
const DELIVERY_GENERATION_MAXIMUM_BYTES = 128;

export type DeliveryResyncReasonV1 =
  | "delivery_generation_changed"
  | "event_identity_invalid"
  | "event_identity_mismatch"
  | "sequence_gap"
  | "sequence_rewind"
  | "session_changed";

export interface DeliveredSessionEventIdentityV1 {
  readonly deliveryGeneration: string;
  readonly eventId: string;
  readonly eventIntegrityToken: string;
  /** Host-only raw envelope identity. It must never be copied into a wire cursor. */
  readonly rawEventSha256: string;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly sessionId: string;
}

/** Host-only event identity carried beside, never inside, a public projection. */
export type SessionDeliveryEventCheckpointV1 = Readonly<
  Omit<DeliveredSessionEventIdentityV1, "deliveryGeneration">
>;

export type SessionDeliveryQueryDescriptorV1 = Readonly<
  | {
      readonly head: SessionLedgerHeadV1;
      readonly kind: "full_snapshot";
      readonly rawEventSha256: string | null;
    }
  | {
      readonly events: readonly SessionDeliveryEventCheckpointV1[];
      readonly kind: "event_page";
      readonly sessionId: string;
    }
>;

export interface SessionDeliveryStateV1 {
  readonly cursor: DeliveryCursorV1;
  /** Host-only identity for detecting same-sequence different-raw-byte delivery. */
  readonly rawEventSha256: string | null;
  readonly resyncReason: DeliveryResyncReasonV1 | null;
  readonly status: "ready" | "resync_required";
}

export type SessionDeliveryTransitionV1 = Readonly<
  | {
      readonly disposition: "accepted" | "duplicate";
      readonly state: SessionDeliveryStateV1;
    }
  | {
      readonly disposition: "resync_required";
      readonly state: SessionDeliveryStateV1;
    }
>;

function validGeneration(generation: string): boolean {
  return generation.length > 0 && Buffer.byteLength(generation, "utf8") <= DELIVERY_GENERATION_MAXIMUM_BYTES;
}

function validPositiveIdentity(identity: DeliveredSessionEventIdentityV1): boolean {
  return identity.schemaVersion === 1 &&
    Number.isSafeInteger(identity.sequence) &&
    identity.sequence > 0 &&
    UUID.test(identity.sessionId) &&
    UUID.test(identity.eventId) &&
    SESSION_INTEGRITY_TOKEN.test(identity.eventIntegrityToken) &&
    SHA256.test(identity.rawEventSha256) &&
    validGeneration(identity.deliveryGeneration);
}

function copyCursor(cursor: DeliveryCursorV1): DeliveryCursorV1 {
  return Object.freeze({ ...cursor });
}

function freezeForResync(
  state: SessionDeliveryStateV1,
  reason: DeliveryResyncReasonV1,
): SessionDeliveryStateV1 {
  if (state.status === "resync_required") return state;
  return Object.freeze({
    cursor: state.cursor,
    rawEventSha256: state.rawEventSha256,
    resyncReason: reason,
    status: "resync_required" as const,
  });
}

function resync(
  state: SessionDeliveryStateV1,
  reason: DeliveryResyncReasonV1,
): SessionDeliveryTransitionV1 {
  return Object.freeze({ disposition: "resync_required" as const, state: freezeForResync(state, reason) });
}

/**
 * Build the trusted delivery checkpoint obtained from one full stable snapshot.
 * A positive cursor additionally retains the Host-only raw tail hash so a later
 * duplicate cannot substitute different raw bytes behind the same public token.
 */
export function createSessionDeliveryState(input: Readonly<{
  readonly cursor: DeliveryCursorV1;
  readonly rawEventSha256: string | null;
}>): SessionDeliveryStateV1 {
  const cursor = copyCursor(input.cursor);
  const completePublicIdentity = cursor.afterEventId !== null && cursor.afterEventIntegrityToken !== null;
  const valid = cursor.schemaVersion === 1 &&
    validGeneration(cursor.deliveryGeneration) &&
    UUID.test(cursor.sessionId) &&
    Number.isSafeInteger(cursor.afterSequence) &&
    cursor.afterSequence >= 0 &&
    (
      cursor.afterSequence === 0
        ? cursor.afterEventId === null && cursor.afterEventIntegrityToken === null && input.rawEventSha256 === null
        : completePublicIdentity &&
          UUID.test(cursor.afterEventId!) &&
          SESSION_INTEGRITY_TOKEN.test(cursor.afterEventIntegrityToken!) &&
          input.rawEventSha256 !== null &&
          SHA256.test(input.rawEventSha256)
    );
  if (!valid) {
    throw new ApplicationControlError(
      "control_resync_required",
      "delivery checkpoint has an invalid zero/null or raw identity",
    );
  }
  return Object.freeze({
    cursor,
    rawEventSha256: input.rawEventSha256,
    resyncReason: null,
    status: "ready" as const,
  });
}

/**
 * Pure at-least-once delivery transition. Only an exact duplicate of the
 * current checkpoint is accepted as a duplicate. A gap, rewind, generation
 * change, or same-sequence identity disagreement freezes the state until a
 * caller installs a new full-snapshot checkpoint with createSessionDeliveryState.
 */
export function advanceSessionDelivery(
  state: SessionDeliveryStateV1,
  identity: DeliveredSessionEventIdentityV1,
): SessionDeliveryTransitionV1 {
  if (state.status === "resync_required") {
    return Object.freeze({ disposition: "resync_required", state });
  }
  if (!validPositiveIdentity(identity)) return resync(state, "event_identity_invalid");
  if (identity.deliveryGeneration !== state.cursor.deliveryGeneration) {
    return resync(state, "delivery_generation_changed");
  }
  if (identity.sessionId !== state.cursor.sessionId) return resync(state, "session_changed");

  if (identity.sequence === state.cursor.afterSequence) {
    const exactDuplicate = identity.eventId === state.cursor.afterEventId &&
      identity.eventIntegrityToken === state.cursor.afterEventIntegrityToken &&
      identity.rawEventSha256 === state.rawEventSha256;
    return exactDuplicate
      ? Object.freeze({ disposition: "duplicate" as const, state })
      : resync(state, "event_identity_mismatch");
  }
  if (identity.sequence < state.cursor.afterSequence) return resync(state, "sequence_rewind");
  if (identity.sequence !== state.cursor.afterSequence + 1) return resync(state, "sequence_gap");

  const next = Object.freeze({
    cursor: Object.freeze({
      afterEventId: identity.eventId,
      afterEventIntegrityToken: identity.eventIntegrityToken,
      afterSequence: identity.sequence,
      deliveryGeneration: identity.deliveryGeneration,
      schemaVersion: 1 as const,
      sessionId: identity.sessionId,
    }),
    rawEventSha256: identity.rawEventSha256,
    resyncReason: null,
    status: "ready" as const,
  });
  return Object.freeze({ disposition: "accepted" as const, state: next });
}

/** PHASE21: a delivery gap freezes mutation; only a full resync may thaw it. */
export function assertDeliveryMutationAllowed(state: SessionDeliveryStateV1): void {
  if (state.status === "resync_required") {
    throw new ApplicationControlError(
      "control_resync_required",
      "delivery is frozen until a full projection resync completes",
    );
  }
}

export class SessionDeliveryCursorFactory {
  readonly deliveryGeneration: string;

  constructor(generation: string = randomUUID()) {
    if (!validGeneration(generation)) throw new TypeError("delivery generation is empty or too large");
    this.deliveryGeneration = generation;
  }

  fromHead(head: SessionLedgerHeadV1): DeliveryCursorV1 {
    return Object.freeze({
      afterEventId: head.eventId,
      afterEventIntegrityToken: head.eventIntegrityToken,
      afterSequence: head.sequence,
      deliveryGeneration: this.deliveryGeneration,
      schemaVersion: 1,
      sessionId: head.sessionId,
    });
  }

  assertCanContinue(cursor: DeliveryCursorV1, headAtCursor: SessionLedgerHeadV1): void {
    if (
      cursor.deliveryGeneration !== this.deliveryGeneration ||
      cursor.sessionId !== headAtCursor.sessionId ||
      cursor.afterSequence !== headAtCursor.sequence ||
      cursor.afterEventId !== headAtCursor.eventId ||
      cursor.afterEventIntegrityToken !== headAtCursor.eventIntegrityToken
    ) {
      throw new ApplicationControlError("control_resync_required", "delivery cursor has a gap or belongs to another generation");
    }
  }
}

function initialCursor(sessionId: string, generation: string): DeliveryCursorV1 {
  return Object.freeze({
    afterEventId: null,
    afterEventIntegrityToken: null,
    afterSequence: 0,
    deliveryGeneration: generation,
    schemaVersion: 1,
    sessionId,
  });
}

function cursorHasValidPublicIdentity(cursor: DeliveryCursorV1): boolean {
  if (
    cursor.schemaVersion !== 1 ||
    !UUID.test(cursor.sessionId) ||
    !validGeneration(cursor.deliveryGeneration) ||
    !Number.isSafeInteger(cursor.afterSequence) ||
    cursor.afterSequence < 0
  ) {
    return false;
  }
  if (cursor.afterSequence === 0) {
    return cursor.afterEventId === null && cursor.afterEventIntegrityToken === null;
  }
  return cursor.afterEventId !== null && UUID.test(cursor.afterEventId) &&
    cursor.afterEventIntegrityToken !== null && SESSION_INTEGRITY_TOKEN.test(cursor.afterEventIntegrityToken);
}

/**
 * Process-generation delivery registry shared by query and mutation services.
 * State is deliberately per client/session and ephemeral: after restart, a
 * continuation from an old generation must full-resync before it can mutate.
 */
export class SessionDeliveryCoordinator {
  private readonly factory: SessionDeliveryCursorFactory;
  private readonly states = new Map<string, Map<string, SessionDeliveryStateV1>>();

  constructor(generation?: string) {
    this.factory = new SessionDeliveryCursorFactory(generation);
  }

  get deliveryGeneration(): string {
    return this.factory.deliveryGeneration;
  }

  get trackedClientCount(): number {
    return this.states.size;
  }

  dispose(): void {
    this.states.clear();
  }

  installFullSnapshot(
    call: AuthenticatedCallContextV1,
    input: Readonly<{
      readonly head: SessionLedgerHeadV1;
      readonly rawEventSha256: string | null;
    }>,
  ): DeliveryCursorV1 {
    const state = createSessionDeliveryState({
      cursor: this.factory.fromHead(input.head),
      rawEventSha256: input.rawEventSha256,
    });
    this.set(call.surface.clientId, input.head.sessionId, state);
    return state.cursor;
  }

  deliverEventPage(
    call: AuthenticatedCallContextV1,
    input: Readonly<{
      readonly continuationCursor: DeliveryCursorV1 | null;
      readonly events: readonly SessionDeliveryEventCheckpointV1[];
      readonly sessionId: string;
    }>,
  ): DeliveryCursorV1 {
    if (input.events.length > 500) {
      throw new ApplicationControlError("control_payload_invalid", "delivery page exceeds its hard event bound");
    }
    let state = this.get(call.surface.clientId, input.sessionId) ?? createSessionDeliveryState({
      cursor: initialCursor(input.sessionId, this.deliveryGeneration),
      rawEventSha256: null,
    });
    if (state.status === "resync_required") {
      throw new ApplicationControlError("control_resync_required", "delivery requires a full session snapshot");
    }
    if (input.continuationCursor !== null) {
      state = this.requireContinuation(call.surface.clientId, input.sessionId, state, input.continuationCursor);
    }
    for (const event of input.events) {
      const transition = advanceSessionDelivery(state, {
        ...event,
        deliveryGeneration: this.deliveryGeneration,
      });
      state = transition.state;
      this.set(call.surface.clientId, input.sessionId, state);
      if (transition.disposition === "resync_required") {
        throw new ApplicationControlError("control_resync_required", "session event delivery is not contiguous");
      }
    }
    this.set(call.surface.clientId, input.sessionId, state);
    return state.cursor;
  }

  assertMutationAllowed(call: AuthenticatedCallContextV1, sessionId: string): void {
    const state = this.get(call.surface.clientId, sessionId);
    if (state !== null) assertDeliveryMutationAllowed(state);
  }

  /**
   * Host-only fail-closed bridge for a typed presentation consumer that finds
   * a gap while validating an exact named-query snapshot. Only a subsequent
   * full-snapshot query may replace this sticky state.
   */
  requireFullResync(
    call: AuthenticatedCallContextV1,
    sessionId: string,
    reason: DeliveryResyncReasonV1 = "event_identity_mismatch",
  ): void {
    const current = this.get(call.surface.clientId, sessionId) ?? createSessionDeliveryState({
      cursor: initialCursor(sessionId, this.deliveryGeneration),
      rawEventSha256: null,
    });
    this.set(call.surface.clientId, sessionId, freezeForResync(current, reason));
  }

  stateFor(call: AuthenticatedCallContextV1, sessionId: string): SessionDeliveryStateV1 | null {
    return this.get(call.surface.clientId, sessionId);
  }

  private requireContinuation(
    clientId: string,
    sessionId: string,
    state: SessionDeliveryStateV1,
    cursor: DeliveryCursorV1,
  ): SessionDeliveryStateV1 {
    let reason: DeliveryResyncReasonV1 | null = null;
    if (!cursorHasValidPublicIdentity(cursor)) reason = "event_identity_invalid";
    else if (cursor.deliveryGeneration !== this.deliveryGeneration) reason = "delivery_generation_changed";
    else if (cursor.sessionId !== sessionId) reason = "session_changed";
    else if (cursor.afterSequence > state.cursor.afterSequence) reason = "sequence_gap";
    else if (cursor.afterSequence < state.cursor.afterSequence) reason = "sequence_rewind";
    else if (
      cursor.afterEventId !== state.cursor.afterEventId ||
      cursor.afterEventIntegrityToken !== state.cursor.afterEventIntegrityToken
    ) {
      reason = "event_identity_mismatch";
    }
    if (reason === null) return state;
    const frozen = freezeForResync(state, reason);
    this.set(clientId, sessionId, frozen);
    throw new ApplicationControlError("control_resync_required", "delivery continuation does not match the client checkpoint");
  }

  private get(clientId: string, sessionId: string): SessionDeliveryStateV1 | null {
    return this.states.get(clientId)?.get(sessionId) ?? null;
  }

  private set(clientId: string, sessionId: string, state: SessionDeliveryStateV1): void {
    let sessions = this.states.get(clientId);
    if (sessions === undefined) {
      sessions = new Map<string, SessionDeliveryStateV1>();
      this.states.set(clientId, sessions);
    }
    sessions.set(sessionId, state);
  }
}
