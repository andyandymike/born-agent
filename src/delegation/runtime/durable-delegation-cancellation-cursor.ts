import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import {
  SessionEventTailReader,
  type SessionEventTailObservationV1,
} from "../../sessions/session-event-tail-reader.js";

export type DurableDelegationCancelRequestEventV1 = Extract<
  DecodedStoredEvent,
  { readonly scope: "session"; readonly type: "delegation.cancel.requested" }
>;

/**
 * AS5.2: one cursor follows a child from its pre-start fence through active
 * execution. Only an exact typed durable request is returned to the launcher;
 * AbortSignal remains a wake-up/emergency channel, not cancellation authority.
 */
export class DurableDelegationCancellationCursor {
  private pending: Promise<DurableDelegationCancelRequestEventV1 | null> | null = null;

  constructor(private readonly input: Readonly<{
    readonly observation?: SessionEventTailObservationV1;
    readonly sessionId: string;
    readonly target: Readonly<{
      readonly delegationId: string;
      readonly delegationRevision: number;
      readonly delegationSha256: string;
      readonly parentActorId: string;
      readonly parentRunId: string;
    }>;
    readonly workspace: string;
  }>, private readonly reader = new SessionEventTailReader({
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    sessionId: input.sessionId,
    workspace: input.workspace,
  })) {}

  poll(): Promise<DurableDelegationCancelRequestEventV1 | null> {
    if (this.pending !== null) return this.pending;
    const operation = this.readOnce();
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending === operation) this.pending = null;
    }).catch(() => undefined);
    return operation;
  }

  private async readOnce(): Promise<DurableDelegationCancelRequestEventV1 | null> {
    const result = await this.reader.read();
    for (let index = result.events.length - 1; index >= 0; index -= 1) {
      const event = result.events[index]!;
      if (
        event.scope === "session" &&
        event.type === "delegation.cancel.requested" &&
        event.data.delegation_id === this.input.target.delegationId &&
        event.data.delegation_revision === this.input.target.delegationRevision &&
        event.data.delegation_sha256 === this.input.target.delegationSha256 &&
        event.data.parent_actor_id === this.input.target.parentActorId &&
        event.data.parent_run_id === this.input.target.parentRunId
      ) {
        return event;
      }
    }
    return null;
  }
}
