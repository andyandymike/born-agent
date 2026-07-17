import { canonicalJson } from "../completion/canonical-json.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";

const CANONICAL_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PersistedEventWriter {
  readDecodedEvents?(): readonly TuiPersistedEvent[];
  subscribeDurableEvents?(
    listener: (event: TuiPersistedEvent) => void,
  ): () => void;
}

export type PersistedEventSourceFatalCode =
  | "buffer_overflow"
  | "event_invalid"
  | "known_prefix_mismatch"
  | "listener_failed"
  | "session_mismatch"
  | "session_sequence"
  | "source_closed"
  | "subscription_failed"
  | "writer_read_failed"
  | "writer_switch_requires_idle";

export class PersistedEventSourceFatalError extends Error {
  public constructor(
    public readonly code: PersistedEventSourceFatalCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PersistedEventSourceFatalError";
  }
}

export interface PersistedEventSourceOptions {
  readonly maxPreSubscriptionBuffer?: number;
  readonly onEvent: (event: TuiPersistedEvent) => void;
  readonly onFatal: (error: PersistedEventSourceFatalError) => void;
}

export interface PersistedEventSourceReset {
  readonly snapshot: readonly TuiPersistedEvent[];
  readonly writer?: PersistedEventWriter;
}

export interface PersistedEventSourceStatus {
  readonly fatal: PersistedEventSourceFatalError | null;
  readonly lastSessionSeq: number;
  readonly phase: "closed" | "fatal" | "idle" | "observing";
  readonly sessionId: string | null;
}

const DEFAULT_MAX_PRE_SUBSCRIPTION_BUFFER = 1_024;

function eventFingerprint(event: TuiPersistedEvent): string {
  return canonicalJson(event);
}

export class PersistedEventSource {
  readonly #maxPreSubscriptionBuffer: number;
  readonly #onEvent: (event: TuiPersistedEvent) => void;
  readonly #onFatal: (error: PersistedEventSourceFatalError) => void;
  readonly #knownFingerprints: string[] = [];
  readonly #knownEventIds = new Set<string>();

  #closed = false;
  #fatal: PersistedEventSourceFatalError | null = null;
  #lastSessionSeq = 0;
  #sessionId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #writer: PersistedEventWriter | null = null;

  public constructor(options: PersistedEventSourceOptions) {
    const maximum =
      options.maxPreSubscriptionBuffer ??
      DEFAULT_MAX_PRE_SUBSCRIPTION_BUFFER;
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new TypeError("maxPreSubscriptionBuffer must be a positive integer");
    }
    this.#maxPreSubscriptionBuffer = maximum;
    this.#onEvent = options.onEvent;
    this.#onFatal = options.onFatal;
  }

  public get status(): PersistedEventSourceStatus {
    return Object.freeze({
      fatal: this.#fatal,
      lastSessionSeq: this.#lastSessionSeq,
      phase: this.#closed
        ? "closed"
        : this.#fatal !== null
          ? "fatal"
          : this.#writer === null
            ? "idle"
            : "observing",
      sessionId: this.#sessionId,
    });
  }

  public observe(writer: PersistedEventWriter): void {
    if (this.#closed) {
      this.#fail("source_closed", "cannot observe with a closed persisted event source");
      return;
    }
    if (this.#fatal !== null) return;
    if (this.#writer === writer) {
      this.#readAndReconcile(writer);
      if (this.#fatal !== null) this.#detachSubscription();
      return;
    }
    if (this.#writer !== null) {
      this.#fail(
        "writer_switch_requires_idle",
        "switching a persisted writer requires resetWhileIdle",
      );
      return;
    }

    this.#writer = writer;
    const preSubscriptionBuffer: TuiPersistedEvent[] = [];
    let bootstrapping = true;
    const listener = (event: TuiPersistedEvent): void => {
      try {
        if (this.#fatal !== null || this.#closed) return;
        if (bootstrapping) {
          if (
            preSubscriptionBuffer.length >=
            this.#maxPreSubscriptionBuffer
          ) {
            this.#fail(
              "buffer_overflow",
              "durable events exceeded the bounded pre-subscription buffer",
            );
            return;
          }
          preSubscriptionBuffer.push(event);
          return;
        }
        this.#deliverStrict(event);
        if (this.#fatal !== null) this.#detachSubscription();
      } catch (error) {
        this.#fail(
          "event_invalid",
          "durable event listener failed closed",
          error,
        );
      }
    };

    if (writer.subscribeDurableEvents !== undefined) {
      try {
        const unsubscribe = writer.subscribeDurableEvents(listener);
        if (typeof unsubscribe !== "function") {
          this.#fail(
            "subscription_failed",
            "durable event subscription returned no unsubscribe function",
          );
        } else {
          this.#unsubscribe = unsubscribe;
        }
      } catch (error) {
        this.#fail(
          "subscription_failed",
          "durable event subscription failed",
          error,
        );
      }
    }

    if (this.#fatal === null) this.#readAndReconcile(writer);
    if (this.#fatal === null) this.#readAndReconcile(writer);
    if (this.#fatal === null) {
      for (const event of preSubscriptionBuffer) {
        this.#reconcileBufferedEvent(event);
        if (this.#fatal !== null) break;
      }
    }
    bootstrapping = false;
    if (this.#fatal !== null) this.#detachSubscription();
  }

  public resetWhileIdle(input: PersistedEventSourceReset): void {
    if (this.#closed) {
      this.#fail("source_closed", "cannot reset a closed persisted event source");
      return;
    }
    this.#fatal = null;
    this.#detachSubscription();
    if (this.#fatal !== null) return;
    this.#writer = null;
    this.#lastSessionSeq = 0;
    this.#sessionId = null;
    this.#knownFingerprints.length = 0;
    this.#knownEventIds.clear();
    // PHASE11: session switching is an explicit idle operation; clearing the old
    // sequence first prevents a new snapshot from inheriting stale authority.
    this.#reconcileSnapshot(input.snapshot);
    if (this.#fatal === null && input.writer !== undefined) {
      this.observe(input.writer);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#detachSubscription();
    this.#writer = null;
    this.#closed = true;
  }

  #readAndReconcile(writer: PersistedEventWriter): void {
    if (this.#fatal !== null) return;
    const readDecodedEvents = writer.readDecodedEvents;
    if (readDecodedEvents === undefined) {
      this.#fail(
        "writer_read_failed",
        "session writer does not expose decoded durable events",
      );
      return;
    }
    let snapshot: readonly TuiPersistedEvent[];
    try {
      snapshot = [...readDecodedEvents.call(writer)];
    } catch (error) {
      this.#fail(
        "writer_read_failed",
        "failed to read the durable event snapshot",
        error,
      );
      return;
    }
    this.#reconcileSnapshot(snapshot);
  }

  #reconcileSnapshot(snapshot: readonly TuiPersistedEvent[]): void {
    if (this.#fatal !== null) return;
    if (snapshot.length < this.#lastSessionSeq) {
      this.#fail(
        "known_prefix_mismatch",
        "durable snapshot is shorter than the already delivered prefix",
      );
      return;
    }
    for (let index = 0; index < snapshot.length; index += 1) {
      const event = snapshot[index];
      if (event === undefined) {
        this.#fail("event_invalid", "durable snapshot contains a missing event");
        return;
      }
      const expectedSequence = index + 1;
      if (!this.#validateEnvelope(event, expectedSequence)) return;
      if (expectedSequence <= this.#lastSessionSeq) {
        let fingerprint: string;
        try {
          fingerprint = eventFingerprint(event);
        } catch (error) {
          this.#fail(
            "event_invalid",
            "durable event cannot be fingerprinted",
            error,
          );
          return;
        }
        if (this.#knownFingerprints[index] !== fingerprint) {
          this.#fail(
            "known_prefix_mismatch",
            `durable snapshot changed known event ${String(expectedSequence)}`,
          );
          return;
        }
        continue;
      }
      this.#deliverStrict(event);
      if (this.#fatal !== null) return;
    }
  }

  #reconcileBufferedEvent(event: TuiPersistedEvent): void {
    if (event.sessionSeq <= this.#lastSessionSeq) {
      if (!this.#validateEnvelope(event, event.sessionSeq)) return;
      let fingerprint: string;
      try {
        fingerprint = eventFingerprint(event);
      } catch (error) {
        this.#fail(
          "event_invalid",
          "buffered durable event cannot be fingerprinted",
          error,
        );
        return;
      }
      if (this.#knownFingerprints[event.sessionSeq - 1] !== fingerprint) {
        this.#fail(
          "known_prefix_mismatch",
          `buffered event changed known event ${String(event.sessionSeq)}`,
        );
      }
      return;
    }
    this.#deliverStrict(event);
  }

  #deliverStrict(event: TuiPersistedEvent): void {
    if (this.#fatal !== null || this.#closed) return;
    const expectedSequence = this.#lastSessionSeq + 1;
    if (!this.#validateEnvelope(event, expectedSequence)) return;
    if (this.#knownEventIds.has(event.eventId)) {
      this.#fail(
        "event_invalid",
        `durable event id was reused at session_seq ${String(event.sessionSeq)}`,
      );
      return;
    }
    let fingerprint: string;
    try {
      fingerprint = eventFingerprint(event);
    } catch (error) {
      this.#fail(
        "event_invalid",
        "durable event cannot be fingerprinted",
        error,
      );
      return;
    }

    this.#sessionId = event.sessionId;
    this.#lastSessionSeq = event.sessionSeq;
    this.#knownFingerprints.push(fingerprint);
    this.#knownEventIds.add(event.eventId);
    // PHASE11: replay, catch-up, and live facts all use this synchronous
    // delivery path; no second live mapping can diverge from durable replay.
    try {
      this.#onEvent(event);
    } catch (error) {
      this.#fail(
        "listener_failed",
        "persisted event consumer failed",
        error,
      );
    }
  }

  #validateEnvelope(
    event: TuiPersistedEvent,
    expectedSequence: number,
  ): boolean {
    if (
      typeof event !== "object" ||
      event === null ||
      !CANONICAL_SESSION_ID.test(event.sessionId) ||
      typeof event.eventId !== "string" ||
      event.eventId.length === 0 ||
      !Number.isSafeInteger(event.sessionSeq) ||
      event.sessionSeq < 1
    ) {
      this.#fail("event_invalid", "durable event envelope is invalid");
      return false;
    }
    if (event.sessionSeq !== expectedSequence) {
      this.#fail(
        "session_sequence",
        `durable event sequence mismatch: expected ${String(expectedSequence)}, received ${String(event.sessionSeq)}`,
      );
      return false;
    }
    if (this.#sessionId !== null && event.sessionId !== this.#sessionId) {
      this.#fail(
        "session_mismatch",
        "durable event belongs to another session",
      );
      return false;
    }
    return true;
  }

  #fail(
    code: PersistedEventSourceFatalCode,
    message: string,
    cause?: unknown,
  ): void {
    if (this.#fatal !== null) return;
    const error = new PersistedEventSourceFatalError(
      code,
      message,
      cause === undefined ? {} : { cause },
    );
    this.#fatal = error;
    try {
      this.#onFatal(error);
    } catch {
      // A UI fatal renderer cannot be allowed to escape into the durable writer.
    }
  }

  #detachSubscription(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe === null) return;
    try {
      unsubscribe();
    } catch (error) {
      this.#fail(
        "subscription_failed",
        "durable event unsubscribe failed",
        error,
      );
    }
  }
}
