import type { Session } from "./session.js";

export class SessionStore {
  readonly sessions = new Map<string, Session>();

  add(session: Session): void {
    this.sessions.set(session.identity.value, session);
  }
}
