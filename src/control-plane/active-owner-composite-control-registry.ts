import { ApplicationControlError } from "./application-errors.js";

export type OwnerInternalCompositeActionKindV1 =
  | "promotion.apply"
  | "promotion.verify_origin"
  | "worktree.allocate"
  | "worktree.cleanup";

export interface ActiveOwnerCompositeControlPortV1 {
  readonly actionKind: OwnerInternalCompositeActionKindV1;
  readonly ownerApplicationOperationId: string;
  readonly ownerPreparedActionSha256: string;
  requestAbort(): void;
  /** Exact Host emergency signal; it is not a user cancellation request. */
  requestHostEmergencyStop(input: Readonly<{ readonly reason: "tui_surface_fatal" }>): void;
}

/**
 * Process-local routing for owner-internal pre-effect cancellation only.
 *
 * These composite families have no public cancellation action in Phase 21A.
 * Registration binds the exact ApplicationService owner so a TUI may route a
 * Host interrupt to that owner without falling back to a generic/raw abort.
 * Each effect runtime still owns the final admission fence.
 */
export class ActiveOwnerCompositeControlRegistry {
  private readonly ports = new Map<string, ActiveOwnerCompositeControlPortV1>();

  register(sessionId: string, port: ActiveOwnerCompositeControlPortV1): () => void {
    if (this.ports.has(sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "session already has an active owner-internal composite");
    }
    this.ports.set(sessionId, port);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ports.get(sessionId) === port) this.ports.delete(sessionId);
    };
  }

  active(sessionId: string): ActiveOwnerCompositeControlPortV1 | null {
    return this.ports.get(sessionId) ?? null;
  }
}
