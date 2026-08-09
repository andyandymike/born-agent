import { setTimeout as delay } from "node:timers/promises";

import type { TaskMutationContext, TaskMutationWriterFactory } from "../coordination/task-control-plane.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";

const RETRYABLE_LOCK_CODES = new Set<SessionLockError["code"]>([
  "active_session_lock",
  "lock_identity_changed",
  "lock_too_young",
  "unknown_session_lock_owner",
]);

/**
 * Status/show owns the same short-lived snapshot lock as a writer. A bounded
 * worker must tolerate that read-side lock without losing durable ownership,
 * while still failing closed on corrupt locks or sustained contention.
 */
export const openBackgroundSessionWriter: TaskMutationWriterFactory = async (
  context: TaskMutationContext,
): Promise<V2SessionWriter> => {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  for (;;) {
    try {
      return await V2SessionWriter.openExisting(context.workspace, context.sessionId, {
        createEventId: context.randomUuid,
        timestamp: context.now,
      });
    } catch (error) {
      if (!(error instanceof SessionLockError) || !RETRYABLE_LOCK_CODES.has(error.code) || Date.now() >= deadline) {
        throw error;
      }
      // The relatively-prime cadence avoids repeatedly colliding with a status
      // poll running on a fixed interval. The delay is bounded and carries no
      // authority to recover or remove another process's lock.
      const delayMs = 11 + ((attempt * 17) % 29);
      attempt += 1;
      await delay(delayMs);
    }
  }
};
