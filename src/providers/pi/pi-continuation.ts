import { BackendContinuation } from "../../model/model-backend.js";

export type PiContinuationOwner = object;

class PiContinuation extends BackendContinuation {
  readonly #owner: PiContinuationOwner;
  readonly #runtimeValue: unknown;

  constructor(owner: PiContinuationOwner, runtimeValue: unknown) {
    super();
    this.#owner = owner;
    this.#runtimeValue = runtimeValue;
    Object.freeze(this);
  }

  unwrap(owner: PiContinuationOwner): unknown {
    if (owner !== this.#owner) {
      throw new TypeError("continuation belongs to a different backend instance");
    }
    return this.#runtimeValue;
  }
}

export function createPiContinuation(
  owner: PiContinuationOwner,
  runtimeValue: unknown,
): BackendContinuation {
  // PHASE8: pi may keep encrypted reasoning/signatures in this value. Only the
  // owning adapter can unwrap it; the core can merely pass it back unchanged.
  return new PiContinuation(owner, runtimeValue);
}

export function unwrapPiContinuation(
  continuation: BackendContinuation,
  owner: PiContinuationOwner,
): unknown {
  if (!(continuation instanceof PiContinuation)) {
    throw new TypeError("continuation was not created by the pi adapter");
  }
  return continuation.unwrap(owner);
}

