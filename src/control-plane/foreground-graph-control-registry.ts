import { ApplicationControlError } from "./application-errors.js";
import type { DurableRecordReferenceV1 } from "./control-operation-schema.js";

export interface ActiveForegroundGraphControlPortV1 {
  readonly graphRevision: number;
  readonly graphSha256: string;
  readonly ownerApplicationOperationId: string;
  readonly ownerPreparedActionSha256: string;
  readonly requestCancel: (input: Readonly<{
    /** Exact durable task_graph.cancel.requested record; signalling never precedes it. */
    readonly requestReference: DurableRecordReferenceV1;
  }>) => Promise<void>;
  /** Exact Host emergency signal; it is not a graph.cancel request. */
  readonly requestHostEmergencyStop: (input: Readonly<{
    readonly reason: "tui_surface_fatal";
  }>) => void;
}

/**
 * Process-local signalling only. Durable authority remains in the session
 * ledger and ApplicationService journal; this registry cannot manufacture a
 * cancellation request or recover one after a crash.
 */
export class ForegroundGraphControlRegistry {
  private readonly ports = new Map<string, ActiveForegroundGraphControlPortV1>();

  register(sessionId: string, port: ActiveForegroundGraphControlPortV1): () => void {
    if (this.ports.has(sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "session already has an active foreground Graph owner");
    }
    this.ports.set(sessionId, port);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ports.get(sessionId) === port) this.ports.delete(sessionId);
    };
  }

  active(sessionId: string): ActiveForegroundGraphControlPortV1 | null {
    return this.ports.get(sessionId) ?? null;
  }
}
