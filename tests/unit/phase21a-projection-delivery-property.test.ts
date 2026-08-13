import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ApplicationControlError } from "../../src/control-plane/application-errors.js";
import type { DeliveryCursorV1, SessionLedgerHeadV1 } from "../../src/control-plane/application-protocol.js";
import {
  advanceSessionDelivery,
  assertDeliveryMutationAllowed,
  createSessionDeliveryState,
  SessionDeliveryCursorFactory,
  type DeliveredSessionEventIdentityV1,
  type SessionDeliveryStateV1,
} from "../../src/control-plane/delivery-cursor.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const GENERATION = "00000000-0000-4000-8000-000000000003";

function event(sequence: number, overrides: Partial<DeliveredSessionEventIdentityV1> = {}): DeliveredSessionEventIdentityV1 {
  const suffix = sequence.toString(16).padStart(12, "0");
  const tokenCharacter = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[sequence % 64]!;
  const hashCharacter = "0123456789abcdef"[sequence % 16]!;
  return Object.freeze({
    deliveryGeneration: GENERATION,
    eventId: `00000000-0000-4000-8000-${suffix}`,
    eventIntegrityToken: `slh_v1_${tokenCharacter.repeat(43)}`,
    rawEventSha256: hashCharacter.repeat(64),
    schemaVersion: 1,
    sequence,
    sessionId: SESSION_ID,
    ...overrides,
  });
}

function zeroCursor(overrides: Partial<DeliveryCursorV1> = {}): DeliveryCursorV1 {
  return Object.freeze({
    afterEventId: null,
    afterEventIntegrityToken: null,
    afterSequence: 0,
    deliveryGeneration: GENERATION,
    schemaVersion: 1,
    sessionId: SESSION_ID,
    ...overrides,
  });
}

function initial(): SessionDeliveryStateV1 {
  return createSessionDeliveryState({ cursor: zeroCursor(), rawEventSha256: null });
}

function expectResyncRequired(run: () => unknown): void {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ApplicationControlError);
  expect((observed as ApplicationControlError).code).toBe("control_resync_required");
}

describe("Phase 21A projection delivery cursor properties", () => {
  it("accepts a contiguous prefix and treats only the exact current identity as a duplicate", () => {
    let state = initial();
    for (let sequence = 1; sequence <= 128; sequence += 1) {
      const accepted = advanceSessionDelivery(state, event(sequence));
      expect(accepted.disposition).toBe("accepted");
      state = accepted.state;
      const duplicate = advanceSessionDelivery(state, event(sequence));
      expect(duplicate).toEqual({ disposition: "duplicate", state });
      assertDeliveryMutationAllowed(state);
    }
    expect(state).toMatchObject({
      cursor: { afterEventId: event(128).eventId, afterSequence: 128 },
      rawEventSha256: event(128).rawEventSha256,
      resyncReason: null,
      status: "ready",
    });
    expect(JSON.stringify(state.cursor)).not.toContain(state.rawEventSha256);
  });

  it.each([
    ["delivery_generation_changed", () => event(1, { deliveryGeneration: randomUUID() })],
    ["session_changed", () => event(1, { sessionId: OTHER_SESSION_ID })],
    ["sequence_gap", () => event(2)],
    ["event_identity_invalid", () => event(1, { rawEventSha256: "not-a-hash" })],
    ["event_identity_invalid", () => event(1, { eventIntegrityToken: "caller-token" })],
    ["event_identity_invalid", () => event(1, { eventId: "caller-event" })],
  ] as const)("freezes on %s without advancing the trusted cursor", (reason, candidate) => {
    const state = initial();
    const transition = advanceSessionDelivery(state, candidate());
    expect(transition).toMatchObject({
      disposition: "resync_required",
      state: {
        cursor: state.cursor,
        rawEventSha256: null,
        resyncReason: reason,
        status: "resync_required",
      },
    });
    expectResyncRequired(() => assertDeliveryMutationAllowed(transition.state));
  });

  it.each([
    ["event id", (identity: DeliveredSessionEventIdentityV1) => ({ ...identity, eventId: randomUUID() })],
    ["public token", (identity: DeliveredSessionEventIdentityV1) => ({ ...identity, eventIntegrityToken: `slh_v1_${"Z".repeat(43)}` })],
    ["raw envelope hash", (identity: DeliveredSessionEventIdentityV1) => ({ ...identity, rawEventSha256: "f".repeat(64) })],
  ] as const)("requires resync for same-sequence different %s", (_label, tamper) => {
    const first = advanceSessionDelivery(initial(), event(1));
    expect(first.disposition).toBe("accepted");
    const mismatch = advanceSessionDelivery(first.state, tamper(event(1)));
    expect(mismatch).toMatchObject({
      disposition: "resync_required",
      state: { resyncReason: "event_identity_mismatch", status: "resync_required" },
    });
  });

  it("keeps a resync freeze sticky and thaws only from a new full-snapshot checkpoint", () => {
    const gap = advanceSessionDelivery(initial(), event(3));
    const attemptedRecovery = advanceSessionDelivery(gap.state, event(1));
    expect(attemptedRecovery.state).toBe(gap.state);
    expect(attemptedRecovery.disposition).toBe("resync_required");

    const snapshotHead = event(2);
    const freshFactory = new SessionDeliveryCursorFactory(randomUUID());
    const freshHead: SessionLedgerHeadV1 = Object.freeze({
      eventId: snapshotHead.eventId,
      eventIntegrityToken: snapshotHead.eventIntegrityToken,
      schemaVersion: 1,
      sequence: snapshotHead.sequence,
      sessionId: snapshotHead.sessionId,
    });
    const thawed = createSessionDeliveryState({
      cursor: freshFactory.fromHead(freshHead),
      rawEventSha256: snapshotHead.rawEventSha256,
    });
    expect(thawed.status).toBe("ready");
    expect(() => assertDeliveryMutationAllowed(thawed)).not.toThrow();
  });

  it("fails closed for a rewind and malformed zero/positive checkpoint identities", () => {
    const first = advanceSessionDelivery(initial(), event(1));
    const second = advanceSessionDelivery(first.state, event(2));
    expect(advanceSessionDelivery(second.state, event(1))).toMatchObject({
      disposition: "resync_required",
      state: { resyncReason: "sequence_rewind" },
    });

    expectResyncRequired(() => createSessionDeliveryState({
      cursor: zeroCursor(),
      rawEventSha256: "a".repeat(64),
    }));
    expectResyncRequired(() => createSessionDeliveryState({
      cursor: {
        afterEventId: event(1).eventId,
        afterEventIntegrityToken: event(1).eventIntegrityToken,
        afterSequence: 1,
        deliveryGeneration: GENERATION,
        schemaVersion: 1,
        sessionId: SESSION_ID,
      },
      rawEventSha256: null,
    }));
  });

  it("keeps the existing cursor factory exact across generation and public-head identity", () => {
    const factory = new SessionDeliveryCursorFactory(GENERATION);
    const identity = event(1);
    const head: SessionLedgerHeadV1 = {
      eventId: identity.eventId,
      eventIntegrityToken: identity.eventIntegrityToken,
      schemaVersion: 1,
      sequence: identity.sequence,
      sessionId: identity.sessionId,
    };
    const cursor = factory.fromHead(head);
    expect(() => factory.assertCanContinue(cursor, head)).not.toThrow();
    expectResyncRequired(() => new SessionDeliveryCursorFactory(randomUUID()).assertCanContinue(cursor, head));
    expectResyncRequired(() => factory.assertCanContinue(cursor, {
      ...head,
      eventIntegrityToken: `slh_v1_${"Q".repeat(43)}`,
    }));
  });
});
