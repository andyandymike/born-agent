import { ApplicationControlError } from "./application-errors.js";
import type {
  ApplicationCommitBindingV1,
  SessionLedgerHeadV1,
  SessionProjectionSnapshotV1,
} from "./application-protocol.js";
import type { SessionStorageHeadV1 } from "./session-ledger-head.js";
import type { DurableRecordReferenceV1 } from "./control-operation-schema.js";
import type { ApplicationCancelRequestBindingV1 } from "../events/phase21-run-control-event-schema.js";

export interface ActiveSessionSnapshotV1<TProjection = unknown> {
  /** Host-only raw/token checkpoints aligned with `events`; never wire-visible. */
  readonly deliveryEvents?: readonly unknown[];
  readonly events: readonly unknown[];
  readonly head: SessionStorageHeadV1;
  /** Host-only decoded domain events for fixed projection-owner queries. */
  readonly internalEvents?: readonly unknown[];
  readonly projection: SessionProjectionSnapshotV1<TProjection>;
  /** Strictly redacted presentation DTOs; never raw stored envelopes. */
  readonly tuiDisplayEvents?: readonly unknown[];
}

export interface ActiveSessionReadPortV1<TProjection = unknown> {
  readonly readStableSnapshot: () => Promise<ActiveSessionSnapshotV1<TProjection>>;
  /** Host-only exact-prefix read used by stable paginated projections. */
  readonly readStablePrefix?: (
    head: SessionLedgerHeadV1,
  ) => Promise<ActiveSessionSnapshotV1<TProjection>>;
  readonly runControl?: ActiveRunControlPortV1;
  /** Emits invalidation only; no writer or durable event crosses this port. */
  readonly subscribeInvalidations?: (listener: () => void) => () => void;
}

export interface ActiveRunControlPortV1 {
  readonly acceptsObservedHead: (head: SessionLedgerHeadV1) => boolean;
  /** Exact ApplicationService operation whose owner activated this run. */
  readonly ownerApplicationOperationId: string;
  readonly ownerGenerationSha256: string;
  readonly runId: string;
  readonly requestCancel: (input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly reason: "user";
  }>) => Promise<Readonly<{
    readonly head: SessionStorageHeadV1;
    readonly recordReference: DurableRecordReferenceV1;
    readonly terminalBinding: ApplicationCancelRequestBindingV1;
  }>>;
  /**
   * Host-lifecycle failure is neither a user decision nor an ApplicationService
   * cancellation operation. This narrow signal is exact-bound by registration
   * to the currently executing owner and must result in a failed terminal.
   */
  readonly requestHostEmergencyStop: (input: Readonly<{
    readonly reason: "tui_surface_fatal";
  }>) => void;
}

export class SessionOwnerBroker {
  private readonly gates = new Map<string, Promise<void>>();
  private readonly ports = new Map<string, ActiveSessionReadPortV1>();
  private readonly invalidationListeners = new Set<(sessionId: string) => void>();
  private readonly invalidationStops = new Map<string, () => void>();

  register(sessionId: string, port: ActiveSessionReadPortV1): () => void {
    if (this.ports.has(sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "session already has an in-process owner");
    }
    this.ports.set(sessionId, port);
    const stopInvalidations = port.subscribeInvalidations?.(() => this.invalidate(sessionId)) ?? null;
    if (stopInvalidations !== null) this.invalidationStops.set(sessionId, stopInvalidations);
    this.invalidate(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ports.get(sessionId) === port) {
        this.ports.delete(sessionId);
        this.invalidationStops.get(sessionId)?.();
        this.invalidationStops.delete(sessionId);
        this.invalidate(sessionId);
      }
    };
  }

  activePort(sessionId: string): ActiveSessionReadPortV1 | null {
    return this.ports.get(sessionId) ?? null;
  }

  /**
   * PHASE21: surfaces may subscribe to typed session invalidations, never to a
   * mutable writer. The session id is only a routing key; the subsequent named
   * query remains the authority for every displayed fact and delivery cursor.
   */
  subscribeInvalidations(listener: (sessionId: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  async serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(sessionId, next);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.gates.get(sessionId) === next) this.gates.delete(sessionId);
    }
  }

  /**
   * PHASE21: a safety-reducing run cancellation must be able to enter while
   * the exact session action owns the long-running serialization gate. The
   * callback receives only the already-registered run-control port; it cannot
   * acquire a writer, mutate another session, or create fresh effect
   * authority. The typed run.cancel operation still owns authentication,
   * durable request creation, and the exact owner-generation checks.
   */
  activeRunControl(sessionId: string): ActiveRunControlPortV1 | null {
    return this.ports.get(sessionId)?.runControl ?? null;
  }

  /**
   * Signals only the run owner registered for this exact session. A missing
   * registration is deliberately indistinguishable from an unknown outcome:
   * callers must not fall back to a raw process cancellation or another
   * ApplicationService operation.
   */
  requestHostEmergencyStop(
    sessionId: string,
    input: Readonly<{ readonly reason: "tui_surface_fatal" }>,
  ): ActiveRunControlPortV1 | null {
    const active = this.ports.get(sessionId)?.runControl ?? null;
    if (active === null) return null;
    active.requestHostEmergencyStop(input);
    return active;
  }

  private invalidate(sessionId: string): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(sessionId);
      } catch {
        // An observation callback cannot affect the active session owner.
      }
    }
  }
}
