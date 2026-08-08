import type { Session as CoreSession } from "../../core/src/session.js";

export class Session {
  render(value: CoreSession): string {
    return `Session ${value.identity.value}`;
  }
}
