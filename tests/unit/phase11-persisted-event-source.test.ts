import { describe, expect, it, vi } from "vitest";

import {
  PersistedEventSource,
  type PersistedEventWriter,
} from "../../src/tui/persisted-event-source.js";
import type { TuiPersistedEvent } from "../../src/tui/tui-event-reducer.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

function event(
  sessionSeq: number,
  options: {
    readonly data?: unknown;
    readonly eventId?: string;
    readonly sessionId?: string;
  } = {},
): TuiPersistedEvent {
  return {
    data: options.data ?? { delta: `event-${String(sessionSeq)}` },
    eventId: options.eventId ?? `event-${String(sessionSeq)}`,
    runId: RUN_ID,
    runSeq: sessionSeq,
    scope: "run",
    sessionId: options.sessionId ?? SESSION_A,
    sessionSeq,
    sourceSchemaVersion: 2,
    timestamp: "2026-07-17T00:00:00.000Z",
    type: "text.delta",
  } as unknown as TuiPersistedEvent;
}

class FakeSubscribableWriter implements PersistedEventWriter {
  readonly events: TuiPersistedEvent[];
  listener: ((event: TuiPersistedEvent) => void) | null = null;

  public constructor(events: readonly TuiPersistedEvent[] = []) {
    this.events = [...events];
  }

  public readDecodedEvents(): readonly TuiPersistedEvent[] {
    return [...this.events];
  }

  public subscribeDurableEvents(
    listener: (event: TuiPersistedEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  public emit(next: TuiPersistedEvent): void {
    this.events.push(next);
    this.listener?.(next);
  }
}

function createSource(
  onEvent: (value: TuiPersistedEvent) => void,
  onFatal = vi.fn(),
  maxPreSubscriptionBuffer?: number,
): PersistedEventSource {
  return new PersistedEventSource({
    onEvent,
    onFatal,
    ...(maxPreSubscriptionBuffer === undefined
      ? {}
      : { maxPreSubscriptionBuffer }),
  });
}

describe("Phase 11 PersistedEventSource", () => {
  it("uses one synchronous delivery path for snapshot, catch-up, and live events", () => {
    const delivered: number[] = [];
    const first = event(1);
    const second = event(2);
    const third = event(3);
    let listener: ((value: TuiPersistedEvent) => void) | null = null;
    let reads = 0;
    const stored: TuiPersistedEvent[] = [first];
    const writer: PersistedEventWriter = {
      readDecodedEvents() {
        reads += 1;
        if (reads === 2) {
          stored.push(second);
          listener?.(second);
        }
        return [...stored];
      },
      subscribeDurableEvents(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };
    const source = createSource((value) => delivered.push(value.sessionSeq));

    source.observe(writer);
    expect(delivered).toEqual([1, 2]);
    stored.push(third);
    (listener as ((value: TuiPersistedEvent) => void) | null)?.(third);
    expect(delivered).toEqual([1, 2, 3]);
    expect(source.status).toMatchObject({
      lastSessionSeq: 3,
      phase: "observing",
      sessionId: SESSION_A,
    });
  });

  it("makes repeated observe of the same non-subscribing writer an idempotent catch-up", () => {
    const delivered: number[] = [];
    const stored = [event(1)];
    const writer: PersistedEventWriter = {
      readDecodedEvents: () => [...stored],
    };
    const source = createSource((value) => delivered.push(value.sessionSeq));

    source.observe(writer);
    source.observe(writer);
    stored.push(event(2));
    source.observe(writer);
    source.observe(writer);

    expect(delivered).toEqual([1, 2]);
    expect(source.status.fatal).toBeNull();
  });

  it("fails closed on gaps, duplicates, session mismatch, and changed known prefix", () => {
    const gapFatal = vi.fn();
    const gapWriter = new FakeSubscribableWriter();
    const gapSource = createSource(() => undefined, gapFatal);
    gapSource.observe(gapWriter);
    gapWriter.emit(event(2));
    expect(gapFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_sequence" }),
    );

    const duplicateFatal = vi.fn();
    const duplicateWriter = new FakeSubscribableWriter([event(1)]);
    const duplicateSource = createSource(() => undefined, duplicateFatal);
    duplicateSource.observe(duplicateWriter);
    duplicateWriter.emit(event(1));
    expect(duplicateFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_sequence" }),
    );

    const mismatchFatal = vi.fn();
    const mismatchWriter = new FakeSubscribableWriter([event(1)]);
    const mismatchSource = createSource(() => undefined, mismatchFatal);
    mismatchSource.observe(mismatchWriter);
    mismatchWriter.emit(event(2, { sessionId: SESSION_B }));
    expect(mismatchFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_mismatch" }),
    );

    const prefixFatal = vi.fn();
    const prefixWriter = new FakeSubscribableWriter([event(1)]);
    const prefixSource = createSource(() => undefined, prefixFatal);
    prefixSource.observe(prefixWriter);
    prefixWriter.events[0] = event(1, { data: { delta: "changed" } });
    prefixSource.observe(prefixWriter);
    expect(prefixFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "known_prefix_mismatch" }),
    );
  });

  it("turns pre-subscription buffer overflow fatal instead of dropping durable facts", () => {
    const fatal = vi.fn();
    const writer: PersistedEventWriter = {
      readDecodedEvents: () => [],
      subscribeDurableEvents(listener) {
        listener(event(1));
        listener(event(2));
        return () => undefined;
      },
    };
    const source = createSource(() => undefined, fatal, 1);

    source.observe(writer);

    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "buffer_overflow" }),
    );
    expect(source.status).toMatchObject({
      lastSessionSeq: 0,
      phase: "fatal",
    });
  });

  it("converts consumer and fatal-renderer exceptions without throwing into the writer", () => {
    const fatal = vi.fn(() => {
      throw new Error("fatal renderer failed");
    });
    const writer = new FakeSubscribableWriter();
    const source = createSource(() => {
      throw new Error("view reducer failed");
    }, fatal);
    source.observe(writer);

    expect(() => writer.emit(event(1))).not.toThrow();
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "listener_failed" }),
    );
    expect(source.status.phase).toBe("fatal");
  });

  it("requires explicit idle reset to switch writers and clears the old session sequence", () => {
    const delivered: Array<readonly [string, number]> = [];
    const fatal = vi.fn();
    const firstWriter = new FakeSubscribableWriter([event(1)]);
    const secondSnapshot = [event(1, { sessionId: SESSION_B })];
    const secondWriter = new FakeSubscribableWriter(secondSnapshot);
    const source = createSource(
      (value) => delivered.push([value.sessionId, value.sessionSeq]),
      fatal,
    );

    source.observe(firstWriter);
    source.observe(secondWriter);
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "writer_switch_requires_idle" }),
    );

    source.resetWhileIdle({ snapshot: secondSnapshot, writer: secondWriter });

    expect(delivered).toEqual([
      [SESSION_A, 1],
      [SESSION_B, 1],
    ]);
    expect(source.status).toMatchObject({
      fatal: null,
      lastSessionSeq: 1,
      phase: "observing",
      sessionId: SESSION_B,
    });
    expect(firstWriter.listener).toBeNull();
  });

  it("rejects malformed session identity and keeps close idempotent", () => {
    const fatal = vi.fn();
    const source = createSource(() => undefined, fatal);
    source.resetWhileIdle({
      snapshot: [event(1, { sessionId: "not-a-session" })],
    });
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "event_invalid" }),
    );

    source.close();
    source.close();
    expect(source.status.phase).toBe("closed");
  });
});
