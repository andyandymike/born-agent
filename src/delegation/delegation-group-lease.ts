import { sha256Canonical } from "../completion/canonical-json.js";
import { DelegationError } from "./delegation-errors.js";

export interface DelegationGroupLeaseV1 {
  readonly schemaVersion: 1;
  readonly groupId: string;
  readonly repositoryId: string;
  readonly sessionId: string;
  readonly parentActorId: string;
  readonly parentRunId: string;
  readonly ownerPid: number;
  readonly ownerProcessStartIdentity: string;
  readonly nonceSha256: string;
  readonly revision: number;
  readonly leaseSha256: string;
}

export interface DelegationLeaseOwnerProbeV1 {
  observe(pid: number, processStartIdentity: string): "alive_exact" | "dead" | "ambiguous";
}

function lease(content: Omit<DelegationGroupLeaseV1, "leaseSha256">): DelegationGroupLeaseV1 {
  return Object.freeze({ ...content, leaseSha256: sha256Canonical(content) });
}

export class DelegationGroupLeaseCoordinator {
  #current: DelegationGroupLeaseV1 | null = null;

  acquire(input: Omit<DelegationGroupLeaseV1, "schemaVersion" | "revision" | "leaseSha256">): DelegationGroupLeaseV1 {
    if (this.#current !== null) {
      throw new DelegationError("delegation_lease_busy", "repository delegation group already has an owner");
    }
    // PHASE20: the repository group lease cannot be relaxed into a generic
    // concurrent-session lock; every actor must share one exact parent lineage.
    this.#current = lease({ ...input, schemaVersion: 1, revision: 1 });
    return this.#current;
  }

  takeover(input: {
    readonly expectedLeaseSha256: string;
    readonly newOwnerPid: number;
    readonly newOwnerProcessStartIdentity: string;
    readonly newNonceSha256: string;
    readonly probe: DelegationLeaseOwnerProbeV1;
    readonly effectsReconciled: boolean;
  }): DelegationGroupLeaseV1 {
    const current = this.#current;
    if (current === null || current.leaseSha256 !== input.expectedLeaseSha256) {
      throw new DelegationError("delegation_lease_busy", "delegation group takeover lost its exact lease CAS");
    }
    if (input.probe.observe(current.ownerPid, current.ownerProcessStartIdentity) !== "dead" || !input.effectsReconciled) {
      throw new DelegationError("delegation_effect_reconciliation_required", "owner death and child effects must be proven before takeover");
    }
    this.#current = lease({
      ...current,
      ownerPid: input.newOwnerPid,
      ownerProcessStartIdentity: input.newOwnerProcessStartIdentity,
      nonceSha256: input.newNonceSha256,
      revision: current.revision + 1,
    });
    return this.#current;
  }

  get current(): DelegationGroupLeaseV1 | null {
    return this.#current;
  }
}
