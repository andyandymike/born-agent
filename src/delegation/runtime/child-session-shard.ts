import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { SessionCatalog } from "../../sessions/session-catalog.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import type { TaskMutationContext, TaskMutationWriterFactory } from "../../coordination/task-control-plane.js";
import type { ApprovalDecision, ApprovalPreview, ApprovalPrompt } from "../../approvals/approval-types.js";
import type { DelegationChildOperationV1 } from "../delegation-operation-schema.js";
import { DelegationError } from "../delegation-errors.js";

function eventRecord(event: DecodedStoredEvent): Readonly<Record<string, unknown>> {
  return event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Readonly<Record<string, unknown>>
    : {};
}

export function childSessionShardWorkspace(
  operation: Pick<DelegationChildOperationV1, "envelopePath">,
): string {
  return join(dirname(operation.envelopePath), "session-shard");
}

export async function seedChildSessionShard(input: {
  readonly operation: DelegationChildOperationV1;
  readonly parentEvents: readonly DecodedStoredEvent[];
  readonly randomUuid: () => string;
  readonly timestamp: () => string;
}): Promise<string> {
  const selected = input.parentEvents.filter((event) => {
    if (event.scope !== "session" || !event.type.startsWith("delegation.")) return false;
    return eventRecord(event).delegation_id === input.operation.delegationId;
  });
  const started = selected.find((event) =>
    event.type === "delegation.child.started" &&
    eventRecord(event).child_attempt_id === input.operation.childAttemptId);
  if (started === undefined) {
    throw new DelegationError(
      "delegation_child_protocol_invalid",
      "minimal child session shard has no exact durable child start fact",
    );
  }
  const workspace = childSessionShardWorkspace(input.operation);
  await mkdir(workspace, { recursive: true });
  const writer = await V2SessionWriter.createNew(workspace, input.operation.sessionId, {
    createEventId: input.randomUuid,
    timestamp: input.timestamp,
  });
  try {
    for (const event of selected) await writer.appendImportedEvent(event);
  } finally {
    await writer.close();
  }
  return workspace;
}

export async function importChildSessionShard(input: {
  readonly context: TaskMutationContext;
  readonly operation: DelegationChildOperationV1;
  readonly writerFactory: TaskMutationWriterFactory;
}): Promise<void> {
  const shard = await new SessionCatalog(
    childSessionShardWorkspace(input.operation),
  ).read(input.operation.sessionId);
  const imported = shard.events.filter((event) =>
    (event.scope === "run" && event.runId === input.operation.childRunId) ||
    (
      event.scope === "session" &&
      event.type === "delegation.child.approval_waiting" &&
      eventRecord(event).child_attempt_id === input.operation.childAttemptId
    ));
  const writer = await input.writerFactory(input.context);
  try {
    const existingIds = new Set(writer.events.map((event) => event.eventId));
    for (const event of imported) {
      if (!existingIds.has(event.eventId)) {
        await writer.appendImportedEvent(event);
        existingIds.add(event.eventId);
      }
    }
  } finally {
    await writer.close();
  }
}

export class DelegationSessionWriterQueue {
  #tail: Promise<void> = Promise.resolve();

  wrap(base: TaskMutationWriterFactory): TaskMutationWriterFactory {
    return async (context) => {
      const previous = this.#tail;
      let release!: () => void;
      this.#tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      let writer: V2SessionWriter;
      try {
        writer = await base(context);
      } catch (error) {
        release();
        throw error;
      }
      let released = false;
      return new Proxy(writer, {
        get(target, property, receiver) {
          if (property === "close") {
            return async () => {
              if (released) return;
              released = true;
              try {
                await target.close();
              } finally {
                release();
              }
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  }
}

export class DelegationApprovalPromptQueue {
  #tail: Promise<void> = Promise.resolve();

  async request(
    prompt: ApprovalPrompt,
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) return "cancelled";
      // PHASE20: only one Host prompt may own the terminal/modal at a time.
      // The child/attempt/action digest was verified before entering this queue.
      return await prompt.request(preview, signal);
    } finally {
      release();
    }
  }
}
