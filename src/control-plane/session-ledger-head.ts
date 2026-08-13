import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";
import { storedEventEnvelopeV2Schema } from "../events/stored-event-v2.js";
import { parseStrictJson } from "../system/strict-json.js";
import { SessionLock, SessionLockError } from "../sessions/session-lock.js";
import { assertCanonicalSessionId, SessionPathPolicy } from "../sessions/session-path-policy.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  sessionLedgerHeadV1Schema,
  type SessionLedgerHeadV1,
} from "./application-protocol.js";

export interface SessionStorageHeadV1 {
  readonly publicHead: SessionLedgerHeadV1;
  readonly rawEventSha256: string | null;
  readonly schemaVersion: 1;
}

export interface SessionLedgerHeadReadPortV1 {
  readonly readStorageHead: (sessionId: string) => Promise<SessionStorageHeadV1>;
}

function tokenPayload(input: {
  readonly eventId: string;
  readonly rawEventSha256: string;
  readonly sequence: number;
  readonly sessionId: string;
}): string {
  return canonicalJson({
    event_id: input.eventId,
    raw_event_sha256: input.rawEventSha256,
    schema_version: 1,
    sequence: input.sequence,
    session_id: input.sessionId,
  });
}

export class SessionLedgerHeadSigner {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new TypeError("session ledger head key must be 32 bytes");
  }

  create(input: {
    readonly eventId: string | null;
    readonly rawEventSha256: string | null;
    readonly sequence: number;
    readonly sessionId: string;
  }): SessionStorageHeadV1 {
    assertCanonicalSessionId(input.sessionId);
    if (input.sequence === 0) {
      if (input.eventId !== null || input.rawEventSha256 !== null) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "zero head has a raw identity");
      }
      return Object.freeze({
        publicHead: sessionLedgerHeadV1Schema.parse({
          eventId: null,
          eventIntegrityToken: null,
          schemaVersion: 1,
          sequence: 0,
          sessionId: input.sessionId,
        }),
        rawEventSha256: null,
        schemaVersion: 1,
      });
    }
    if (input.eventId === null || input.rawEventSha256 === null || !/^[a-f0-9]{64}$/u.test(input.rawEventSha256)) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "positive head has an incomplete raw identity");
    }
    const token = `slh_v1_${createHmac("sha256", this.key).update(tokenPayload({
      eventId: input.eventId,
      rawEventSha256: input.rawEventSha256,
      sequence: input.sequence,
      sessionId: input.sessionId,
    }), "utf8").digest("base64url")}`;
    return Object.freeze({
      publicHead: sessionLedgerHeadV1Schema.parse({
        eventId: input.eventId,
        eventIntegrityToken: token,
        schemaVersion: 1,
        sequence: input.sequence,
        sessionId: input.sessionId,
      }),
      rawEventSha256: input.rawEventSha256,
      schemaVersion: 1,
    });
  }

  verify(publicHead: SessionLedgerHeadV1, rawEventSha256: string | null): boolean {
    let expected: SessionStorageHeadV1;
    try {
      expected = this.create({
        eventId: publicHead.eventId,
        rawEventSha256,
        sequence: publicHead.sequence,
        sessionId: publicHead.sessionId,
      });
    } catch {
      return false;
    }
    const left = Buffer.from(expected.publicHead.eventIntegrityToken ?? "");
    const right = Buffer.from(publicHead.eventIntegrityToken ?? "");
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }
}

export class ActiveWriterSessionLedgerHeadPort implements SessionLedgerHeadReadPortV1 {
  constructor(
    private readonly signer: SessionLedgerHeadSigner,
    private readonly writer: V2SessionWriter,
  ) {}

  async readStorageHead(sessionId: string): Promise<SessionStorageHeadV1> {
    const identity = this.writer.readDurableTailIdentity();
    if (identity.sessionId !== sessionId || this.writer.isClosed()) {
      throw new ApplicationControlError("control_operation_busy", "active writer head port is unavailable");
    }
    return this.signer.create(identity);
  }
}

export class InactiveSessionLedgerHeadPort implements SessionLedgerHeadReadPortV1 {
  constructor(
    private readonly signer: SessionLedgerHeadSigner,
    private readonly workspace: string,
  ) {}

  async readStorageHead(sessionId: string): Promise<SessionStorageHeadV1> {
    assertCanonicalSessionId(sessionId);
    const policy = await SessionPathPolicy.create(this.workspace);
    const paths = await policy.inspectExistingSession(sessionId);
    let lock: SessionLock;
    try {
      lock = await SessionLock.acquire(policy, sessionId, { allowStaleRecovery: false });
    } catch (error) {
      if (error instanceof SessionLockError) {
        throw new ApplicationControlError("control_operation_busy", "session has another active or unresolved writer", { cause: error });
      }
      throw error;
    }
    try {
      const bytes = await readFile(paths.sessionFilePath);
      if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "materialized session has no complete durable tail",
        );
      }
      const lastNewline = bytes.lastIndexOf(0x0a, bytes.byteLength - 2);
      const rawLine = bytes.subarray(lastNewline + 1, bytes.byteLength - 1);
      if (rawLine.byteLength === 0) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session tail is empty");
      }
      let envelope: z.infer<typeof storedEventEnvelopeV2Schema>;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(rawLine);
        envelope = storedEventEnvelopeV2Schema.parse(parseStrictJson(text));
      } catch (error) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session tail is invalid", { cause: error });
      }
      if (envelope.session_id !== sessionId || envelope.session_seq < 1) {
        throw new ApplicationControlError("control_session_history_missing_or_corrupt", "session tail identity is inconsistent");
      }
      return this.signer.create({
        eventId: envelope.event_id,
        rawEventSha256: createHash("sha256").update(rawLine).digest("hex"),
        sequence: envelope.session_seq,
        sessionId,
      });
    } finally {
      await lock.release();
    }
  }
}
