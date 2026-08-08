import type { SessionIdentity } from "../../shared/src/types.js";

export class Session {
  constructor(readonly identity: SessionIdentity) {}
}

export function createSession(value: string): Session {
  return new Session({ value });
}
