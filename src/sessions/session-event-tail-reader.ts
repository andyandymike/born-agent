import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

import {
  decodeStoredEvents,
  EventDecoderRegistry,
  type DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import { parseStrictJson } from "../system/strict-json.js";
import { SessionPathPolicy } from "./session-path-policy.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type SessionTailFullSnapshotReasonV1 = "cursor_ambiguity" | "startup";

export interface SessionEventTailObservationV1 {
  readonly onFullSnapshot?: (input: Readonly<{
    readonly eventCount: number;
    readonly reason: SessionTailFullSnapshotReasonV1;
  }>) => void;
  readonly onIncrementalRead?: (input: Readonly<{
    readonly anchorSequence: number;
    readonly appendedEventCount: number;
  }>) => void;
}

export interface SessionEventTailCursorV1 {
  readonly ambiguityRecoveries: number;
  readonly anchorByteLength: number;
  readonly anchorByteOffset: number;
  readonly anchorEventId: string | null;
  readonly anchorRawSha256: string | null;
  readonly byteOffset: number;
  readonly fileIdentity: string;
  readonly lastSequence: number;
  readonly path: string;
  readonly sessionId: string;
}

export interface SessionEventTailReadV1 {
  readonly cursor: SessionEventTailCursorV1;
  readonly events: readonly DecodedStoredEvent[];
  readonly mode: "cursor_ambiguity" | "incremental" | "startup";
}

export class SessionEventTailError extends Error {
  override readonly name = "SessionEventTailError";

  constructor(
    readonly code: "session_tail_busy" | "session_tail_corrupt" | "session_tail_cursor_ambiguous",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ParsedLines {
  readonly lineRanges: readonly Readonly<{ readonly byteLength: number; readonly byteOffset: number }>[];
  readonly values: readonly unknown[];
}

interface StableFile {
  readonly bytes: Buffer;
  readonly identity: string;
  readonly path: string;
}

class CursorAmbiguity extends Error {}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileIdentity(stat: Readonly<{
  readonly birthtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}>): string {
  return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.birthtimeMs)}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new SessionEventTailError("session_tail_corrupt", "session tail is not strict UTF-8", { cause: error });
  }
}

function parseLines(bytes: Uint8Array, baseOffset = 0): ParsedLines {
  if (bytes.byteLength === 0) return Object.freeze({ lineRanges: Object.freeze([]), values: Object.freeze([]) });
  if (bytes.at(-1) !== 0x0a) {
    throw new SessionEventTailError("session_tail_busy", "session tail has no complete durable newline");
  }
  const ranges: Array<Readonly<{ readonly byteLength: number; readonly byteOffset: number }>> = [];
  const values: unknown[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index === start) {
      throw new SessionEventTailError("session_tail_corrupt", "session tail contains an empty record");
    }
    let end = index;
    if (bytes[index - 1] === 0x0d) end -= 1;
    const source = decodeUtf8(bytes.subarray(start, end));
    try {
      values.push(parseStrictJson(source));
    } catch (error) {
      throw new SessionEventTailError("session_tail_corrupt", "session tail contains invalid strict JSON", { cause: error });
    }
    ranges.push(Object.freeze({ byteLength: index - start, byteOffset: baseOffset + start }));
    start = index + 1;
  }
  return Object.freeze({ lineRanges: Object.freeze(ranges), values: Object.freeze(values) });
}

async function readExactly(handle: FileHandle, byteLength: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = await handle.read(bytes, offset, byteLength - offset, position + offset);
    if (read.bytesRead === 0) {
      throw new CursorAmbiguity("session file became shorter during a cursor read");
    }
    offset += read.bytesRead;
  }
  return bytes;
}

function assertCursor(cursor: SessionEventTailCursorV1, sessionId: string): void {
  if (
    cursor.sessionId !== sessionId ||
    !Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < 0 ||
    !Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0 ||
    !Number.isSafeInteger(cursor.anchorByteOffset) || cursor.anchorByteOffset < 0 ||
    !Number.isSafeInteger(cursor.anchorByteLength) || cursor.anchorByteLength < 0 ||
    !Number.isSafeInteger(cursor.ambiguityRecoveries) || cursor.ambiguityRecoveries < 0 || cursor.ambiguityRecoveries > 1 ||
    (cursor.lastSequence === 0) !== (cursor.anchorEventId === null) ||
    (cursor.lastSequence === 0) !== (cursor.anchorRawSha256 === null) ||
    cursor.anchorByteOffset + cursor.anchorByteLength >= cursor.byteOffset && cursor.lastSequence > 0
  ) {
    throw new SessionEventTailError("session_tail_cursor_ambiguous", "session tail cursor is structurally invalid");
  }
}

/**
 * AS5.2 append-only JSONL cursor. Startup and one cursor-ambiguity recovery may
 * read a stable full snapshot; ordinary polls verify one small anchor and read
 * only newly appended complete records. It never acquires the session writer
 * lock and never turns an in-memory AbortSignal into durable authority.
 */
export class SessionEventTailReader {
  private cursor: SessionEventTailCursorV1 | null;
  private readonly decoder = new EventDecoderRegistry();
  private readonly seenEventIds = new Set<string>();

  constructor(private readonly input: Readonly<{
    readonly cursor?: SessionEventTailCursorV1;
    readonly observation?: SessionEventTailObservationV1;
    readonly sessionId: string;
    readonly workspace: string;
  }>) {
    this.cursor = input.cursor ?? null;
    if (this.cursor !== null) assertCursor(this.cursor, input.sessionId);
  }

  checkpoint(): SessionEventTailCursorV1 | null {
    return this.cursor === null ? null : Object.freeze({ ...this.cursor });
  }

  async read(): Promise<SessionEventTailReadV1> {
    if (this.cursor === null) return this.readFull("startup", null);
    try {
      return await this.readIncremental(this.cursor);
    } catch (error) {
      if (!(error instanceof CursorAmbiguity)) throw error;
      if (this.cursor.ambiguityRecoveries >= 1) {
        throw new SessionEventTailError(
          "session_tail_cursor_ambiguous",
          "session tail cursor became ambiguous more than once",
          { cause: error },
        );
      }
      return this.readFull("cursor_ambiguity", this.cursor);
    }
  }

  private async path(): Promise<string> {
    return (await (await SessionPathPolicy.create(this.input.workspace))
      .inspectExistingSession(this.input.sessionId)).sessionFilePath;
  }

  private async readStableFile(): Promise<StableFile> {
    const path = await this.path();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await open(path, "r");
      try {
        const before = await handle.stat();
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          fileIdentity(before) === fileIdentity(after) &&
          before.size === after.size &&
          after.size === bytes.byteLength &&
          before.mtimeMs === after.mtimeMs
        ) {
          return Object.freeze({ bytes, identity: fileIdentity(after), path });
        }
      } finally {
        await handle.close();
      }
    }
    throw new SessionEventTailError("session_tail_busy", "session changed during a stable full-tail observation");
  }

  private async readFull(
    reason: SessionTailFullSnapshotReasonV1,
    previous: SessionEventTailCursorV1 | null,
  ): Promise<SessionEventTailReadV1> {
    const file = await this.readStableFile();
    const parsed = parseLines(file.bytes);
    let events: readonly DecodedStoredEvent[];
    try {
      events = Object.freeze(decodeStoredEvents(parsed.values));
    } catch (error) {
      throw new SessionEventTailError("session_tail_corrupt", "session full snapshot contains an invalid event ledger", { cause: error });
    }
    if (events.some((event) => event.sessionId !== this.input.sessionId)) {
      throw new SessionEventTailError("session_tail_corrupt", "session full snapshot belongs to another session");
    }
    if (previous !== null) {
      const anchor = events[previous.lastSequence - 1];
      const range = parsed.lineRanges[previous.lastSequence - 1];
      const rawHash = range === undefined
        ? null
        : sha256(file.bytes.subarray(range.byteOffset, range.byteOffset + range.byteLength));
      if (
        previous.lastSequence > events.length ||
        anchor?.eventId !== previous.anchorEventId ||
        rawHash !== previous.anchorRawSha256
      ) {
        throw new SessionEventTailError(
          "session_tail_cursor_ambiguous",
          "session history no longer contains the exact cursor anchor",
        );
      }
    }
    this.seenEventIds.clear();
    for (const event of events) this.seenEventIds.add(event.eventId);
    const last = events.at(-1);
    const lastRange = parsed.lineRanges.at(-1);
    const ambiguityRecoveries = previous?.ambiguityRecoveries ?? 0;
    this.cursor = Object.freeze({
      ambiguityRecoveries: reason === "cursor_ambiguity" ? ambiguityRecoveries + 1 : ambiguityRecoveries,
      anchorByteLength: lastRange?.byteLength ?? 0,
      anchorByteOffset: lastRange?.byteOffset ?? 0,
      anchorEventId: last?.eventId ?? null,
      anchorRawSha256: lastRange === undefined
        ? null
        : sha256(file.bytes.subarray(lastRange.byteOffset, lastRange.byteOffset + lastRange.byteLength)),
      byteOffset: file.bytes.byteLength,
      fileIdentity: file.identity,
      lastSequence: last?.sessionSeq ?? 0,
      path: file.path,
      sessionId: this.input.sessionId,
    });
    const suffix = previous === null ? events : events.slice(previous.lastSequence);
    this.input.observation?.onFullSnapshot?.({ eventCount: events.length, reason });
    return Object.freeze({
      cursor: this.cursor,
      events: Object.freeze(suffix),
      mode: reason,
    });
  }

  private async readIncremental(cursor: SessionEventTailCursorV1): Promise<SessionEventTailReadV1> {
    const path = await this.path();
    if (path !== cursor.path) throw new CursorAmbiguity("session path changed");
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (fileIdentity(before) !== cursor.fileIdentity || before.size < cursor.byteOffset) {
        throw new CursorAmbiguity("session file identity or size changed");
      }
      if (cursor.lastSequence > 0) {
        const anchor = await readExactly(handle, cursor.anchorByteLength, cursor.anchorByteOffset);
        if (sha256(anchor) !== cursor.anchorRawSha256) {
          throw new CursorAmbiguity("session cursor anchor changed");
        }
      }
      const suffixBytes = await readExactly(handle, before.size - cursor.byteOffset, cursor.byteOffset);
      const parsed = parseLines(suffixBytes, cursor.byteOffset);
      const events: DecodedStoredEvent[] = [];
      for (let index = 0; index < parsed.values.length; index += 1) {
        const expectedSequence = cursor.lastSequence + index + 1;
        let event: DecodedStoredEvent;
        try {
          event = this.decoder.decodeAt(parsed.values[index], expectedSequence);
        } catch (error) {
          throw new SessionEventTailError("session_tail_corrupt", "session suffix contains an invalid event", { cause: error });
        }
        if (
          event.sessionId !== this.input.sessionId ||
          event.sessionSeq !== expectedSequence ||
          this.seenEventIds.has(event.eventId) ||
          events.some((candidate) => candidate.eventId === event.eventId)
        ) {
          throw new SessionEventTailError("session_tail_corrupt", "session suffix identity or sequence is not contiguous");
        }
        events.push(event);
      }
      const after = await handle.stat();
      if (fileIdentity(after) !== cursor.fileIdentity || after.size < before.size) {
        throw new CursorAmbiguity("session file changed identity during the cursor read");
      }
      const last = events.at(-1);
      const lastRange = parsed.lineRanges.at(-1);
      this.cursor = Object.freeze({
        ...cursor,
        anchorByteLength: lastRange?.byteLength ?? cursor.anchorByteLength,
        anchorByteOffset: lastRange?.byteOffset ?? cursor.anchorByteOffset,
        anchorEventId: last?.eventId ?? cursor.anchorEventId,
        anchorRawSha256: lastRange === undefined
          ? cursor.anchorRawSha256
          : sha256(suffixBytes.subarray(
              lastRange.byteOffset - cursor.byteOffset,
              lastRange.byteOffset - cursor.byteOffset + lastRange.byteLength,
            )),
        byteOffset: before.size,
        lastSequence: last?.sessionSeq ?? cursor.lastSequence,
      });
      for (const event of events) this.seenEventIds.add(event.eventId);
      this.input.observation?.onIncrementalRead?.({
        anchorSequence: cursor.lastSequence,
        appendedEventCount: events.length,
      });
      return Object.freeze({
        cursor: this.cursor,
        events: Object.freeze(events),
        mode: "incremental",
      });
    } finally {
      await handle.close();
    }
  }
}
