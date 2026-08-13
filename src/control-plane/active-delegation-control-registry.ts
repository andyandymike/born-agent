import { ApplicationControlError } from "./application-errors.js";
import type {
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
} from "./application-action-registry.js";
import type { DelegationRevisionProjectionV1 } from "../delegation/delegation-projector.js";
import type { DurableDelegationCancelSignalV1 } from "../delegation/delegation-cancellation-signal.js";

export interface ActiveDelegationControlPortV1 {
  readonly delegationId: string;
  readonly ownerApplicationOperationId: string;
  readonly ownerPreparedActionSha256: string;
  /**
   * Append through the exact active owner's writer. Reconciliation observes
   * only; it never signals the owner or creates a second writer authority.
   */
  requestCancel(input: Readonly<{
    readonly context: ApplicationActionExecutionContextV1;
    readonly delegationId: string;
    readonly reason: string;
    readonly reconcileOnly: boolean;
  }>): Promise<ApplicationActionExecutionResultV1<DelegationRevisionProjectionV1> | null>;
  /** Signal only with the exact delegation.cancel fact already made durable. */
  requestPreEffectAbort(input: DurableDelegationCancelSignalV1): void;
  /** Exact Host emergency signal; it is not a delegation.cancel request. */
  requestHostEmergencyStop(input: Readonly<{ readonly reason: "tui_surface_fatal" }>): void;
}

/** Routing only: cancellation authority is always the durable typed action. */
export class ActiveDelegationControlRegistry {
  private readonly ports = new Map<string, ActiveDelegationControlPortV1>();

  register(sessionId: string, port: ActiveDelegationControlPortV1): () => void {
    if (this.ports.has(sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "session already has an active Delegation owner");
    }
    this.ports.set(sessionId, port);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ports.get(sessionId) === port) this.ports.delete(sessionId);
    };
  }

  active(sessionId: string): ActiveDelegationControlPortV1 | null {
    return this.ports.get(sessionId) ?? null;
  }
}
