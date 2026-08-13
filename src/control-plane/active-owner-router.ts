import { ApplicationControlError } from "./application-errors.js";
import type { ActiveDelegationControlPortV1 } from "./active-delegation-control-registry.js";
import type { ActiveOwnerCompositeControlPortV1 } from "./active-owner-composite-control-registry.js";
import type { ActiveForegroundGraphControlPortV1 } from "./foreground-graph-control-registry.js";

export type ActiveOwnerKindV1 = "delegation" | "foreground_graph" | "owner_composite";

export interface ActiveOwnerRouteV1 {
  readonly ownerKind: ActiveOwnerKindV1;
  readonly parentOperationId: string;
  readonly sessionId: string;
  readonly stateRoot: string;
}

export interface ActiveForegroundGraphRegistryPortV1 {
  active(sessionId: string): ActiveForegroundGraphControlPortV1 | null;
  register(sessionId: string, port: ActiveForegroundGraphControlPortV1): () => void;
}

export interface ActiveDelegationRegistryPortV1 {
  active(sessionId: string): ActiveDelegationControlPortV1 | null;
  register(sessionId: string, port: ActiveDelegationControlPortV1): () => void;
}

export interface ActiveOwnerCompositeRegistryPortV1 {
  active(sessionId: string): ActiveOwnerCompositeControlPortV1 | null;
  register(sessionId: string, port: ActiveOwnerCompositeControlPortV1): () => void;
}

type ActiveOwnerPortV1 =
  | ActiveDelegationControlPortV1
  | ActiveForegroundGraphControlPortV1
  | ActiveOwnerCompositeControlPortV1;

interface StoredRouteV1 {
  readonly identity: ActiveOwnerRouteV1;
  readonly port: ActiveOwnerPortV1;
}

function key(sessionId: string, ownerKind: ActiveOwnerKindV1): string {
  return `${sessionId}\u0000${ownerKind}`;
}

/**
 * Process-local owner routing for one exact Host/state root.
 *
 * Durable cancellation and effect authority remain in their domain journals.
 * This router only selects the already-registered exact owner and can neither
 * reconstruct a missing owner nor manufacture a terminal fact.
 */
export class ActiveOwnerRouter {
  private disposed = false;
  private readonly routes = new Map<string, StoredRouteV1>();

  readonly foregroundGraphs: ActiveForegroundGraphRegistryPortV1;
  readonly delegations: ActiveDelegationRegistryPortV1;
  readonly ownerComposites: ActiveOwnerCompositeRegistryPortV1;

  constructor(readonly stateRoot: string) {
    this.foregroundGraphs = Object.freeze({
      active: (sessionId: string) => this.active<ActiveForegroundGraphControlPortV1>(sessionId, "foreground_graph"),
      register: (sessionId: string, port: ActiveForegroundGraphControlPortV1) =>
        this.register(sessionId, "foreground_graph", port),
    });
    this.delegations = Object.freeze({
      active: (sessionId: string) => this.active<ActiveDelegationControlPortV1>(sessionId, "delegation"),
      register: (sessionId: string, port: ActiveDelegationControlPortV1) =>
        this.register(sessionId, "delegation", port),
    });
    this.ownerComposites = Object.freeze({
      active: (sessionId: string) => this.active<ActiveOwnerCompositeControlPortV1>(sessionId, "owner_composite"),
      register: (sessionId: string, port: ActiveOwnerCompositeControlPortV1) =>
        this.register(sessionId, "owner_composite", port),
    });
  }

  get activeRouteCount(): number {
    return this.routes.size;
  }

  list(sessionId?: string): readonly ActiveOwnerRouteV1[] {
    return Object.freeze([...this.routes.values()]
      .map((entry) => entry.identity)
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.routes.clear();
  }

  private active<TPort extends ActiveOwnerPortV1>(
    sessionId: string,
    ownerKind: ActiveOwnerKindV1,
  ): TPort | null {
    if (this.disposed) return null;
    return (this.routes.get(key(sessionId, ownerKind))?.port as TPort | undefined) ?? null;
  }

  private register<TPort extends ActiveOwnerPortV1>(
    sessionId: string,
    ownerKind: ActiveOwnerKindV1,
    port: TPort,
  ): () => void {
    if (this.disposed) {
      throw new ApplicationControlError("control_operation_busy", "application Host owner router is disposed");
    }
    const routeKey = key(sessionId, ownerKind);
    if (this.routes.has(routeKey)) {
      throw new ApplicationControlError("control_operation_busy", `session already has an active ${ownerKind} owner`);
    }
    const identity = Object.freeze({
      ownerKind,
      parentOperationId: port.ownerApplicationOperationId,
      sessionId,
      stateRoot: this.stateRoot,
    });
    const stored = Object.freeze({ identity, port });
    this.routes.set(routeKey, stored);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.routes.get(routeKey) === stored) this.routes.delete(routeKey);
    };
  }
}
