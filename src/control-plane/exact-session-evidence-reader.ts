import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { decodeStoredEvents, type DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { SessionPathPolicy } from "../sessions/session-path-policy.js";
import { parseStrictJson } from "../system/strict-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type { SessionLedgerHeadV1 } from "./application-protocol.js";
import type { DurableRecordReferenceV1 } from "./control-operation-schema.js";
import type { SessionLedgerHeadSigner } from "./session-ledger-head.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function decodeLines(bytes: Uint8Array): readonly string[] {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "session ledger is not strict UTF-8",
      { cause: error },
    );
  }
  const withoutTerminalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (withoutTerminalNewline.length === 0) return Object.freeze([]);
  const lines = withoutTerminalNewline.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.some((line) => line.length === 0)) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "session ledger contains an empty record",
    );
  }
  return Object.freeze(lines);
}

export class ExactSessionEvidenceV1 {
  constructor(
    readonly events: readonly DecodedStoredEvent[],
    readonly rawSha256: ReadonlyMap<string, string>,
    readonly sessionId: string,
  ) {}

  reference(event: DecodedStoredEvent): DurableRecordReferenceV1 {
    const recordSha256 = this.rawSha256.get(event.eventId);
    if (recordSha256 === undefined) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "session evidence has no exact raw record hash",
      );
    }
    return Object.freeze({
      ledgerId: `session:${event.sessionId}`,
      ownerKind: "session",
      recordId: event.eventId,
      recordSha256,
      sequence: event.sessionSeq,
    });
  }

  verifyHead(head: SessionLedgerHeadV1, signer: SessionLedgerHeadSigner): boolean {
    if (head.sessionId !== this.sessionId) return false;
    if (head.sequence === 0) {
      return this.events.length === 0 && signer.verify(head, null);
    }
    const event = this.events[head.sequence - 1];
    return event !== undefined &&
      event.sessionSeq === head.sequence &&
      event.eventId === head.eventId &&
      signer.verify(head, this.rawSha256.get(event.eventId) ?? null);
  }

  headAt(events: readonly DecodedStoredEvent[], signer: SessionLedgerHeadSigner): SessionLedgerHeadV1 {
    const tail = events.at(-1);
    if (tail === undefined || tail.sessionId !== this.sessionId) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "cannot sign an empty or foreign evidence prefix",
      );
    }
    const rawEventSha256 = this.rawSha256.get(tail.eventId);
    if (rawEventSha256 === undefined) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "cannot sign a prefix without its exact raw record hash",
      );
    }
    return signer.create(Object.freeze({
      eventId: tail.eventId,
      rawEventSha256,
      sequence: tail.sessionSeq,
      sessionId: this.sessionId,
    })).publicHead;
  }
}

/**
 * The only control-plane reader allowed to turn JSONL bytes into exact domain
 * evidence. It performs a stable two-read observation, strict UTF-8/JSON
 * decoding, contiguous session validation, and raw-line hashing.
 */
export class ExactSessionEvidenceReader {
  constructor(private readonly options: Readonly<{
    readonly afterFirstRead?: (input: Readonly<{ readonly path: string }>) => Promise<void> | void;
  }> = {}) {}

  async read(input: Readonly<{ readonly sessionId: string; readonly workspace: string }>): Promise<ExactSessionEvidenceV1> {
    const path = (await (await SessionPathPolicy.create(input.workspace))
      .inspectExistingSession(input.sessionId)).sessionFilePath;
    const before = await readFile(path);
    if (before.byteLength === 0 || before.at(-1) !== 0x0a) {
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        "session ledger has no complete durable tail",
      );
    }
    await this.options.afterFirstRead?.({ path });
    const after = await readFile(path);
    if (!sameBytes(before, after)) {
      throw new ApplicationControlError(
        "control_operation_busy",
        "session ledger changed during exact evidence observation",
      );
    }
    const lines = decodeLines(before);
    let events: readonly DecodedStoredEvent[];
    try {
      events = Object.freeze(decodeStoredEvents(lines.map((line) => parseStrictJson(line))));
    } catch (error) {
      if (error instanceof ApplicationControlError) throw error;
      const message = error instanceof Error && /duplicate object key/u.test(error.message)
        ? error.message
        : "session ledger contains an invalid event";
      throw new ApplicationControlError(
        "control_session_history_missing_or_corrupt",
        message,
        { cause: error },
      );
    }
    const rawSha256 = new Map<string, string>();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.sessionId !== input.sessionId || event.sessionSeq !== index + 1 || rawSha256.has(event.eventId)) {
        throw new ApplicationControlError(
          "control_session_history_missing_or_corrupt",
          "session ledger identity or sequence is not contiguous",
        );
      }
      rawSha256.set(event.eventId, createHash("sha256").update(lines[index]!, "utf8").digest("hex"));
    }
    return new ExactSessionEvidenceV1(events, rawSha256, input.sessionId);
  }
}
