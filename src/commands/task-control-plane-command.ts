import { z } from "zod";

import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  TaskControlPlaneError,
  type TaskMutationContext,
  type TaskMutationWriterFactory,
} from "../coordination/task-control-plane.js";
import { PlanFileLoaderError } from "../plans/plan-file-loader.js";
import { SessionCatalogError } from "../sessions/session-catalog.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { SessionProjectionError } from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";

export function taskMutationContext(
  runtime: CliRuntime,
  sessionId: string,
  inputSurface: "cli" | "tui" = "cli",
  expectedSessionSeq?: number,
): TaskMutationContext {
  return {
    ...(expectedSessionSeq === undefined ? {} : { expectedSessionSeq }),
    inputSurface,
    now: runtime.timestamp,
    randomUuid: runtime.randomUUID,
    sessionId,
    workspace: runtime.cwd,
  };
}

export function taskWriterFactory(runtime: CliRuntime): TaskMutationWriterFactory {
  return async (context) => {
    const writer = await V2SessionWriter.openExisting(
      context.workspace,
      context.sessionId,
      {
        createEventId: context.randomUuid,
        timestamp: context.now,
      },
    );
    runtime.observeSessionWriter?.(writer);
    return writer;
  };
}

export function positiveRevision(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TaskControlPlaneError(
      "plan_stale",
      `${label} must be a positive integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TaskControlPlaneError(
      "plan_stale",
      `${label} must be a safe positive integer`,
    );
  }
  return parsed;
}

export function renderTaskCommandFailure(error: unknown, io: CliIO): 1 | 2 {
  if (error instanceof TaskControlPlaneError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
  if (error instanceof PlanFileLoaderError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
  if (error instanceof SessionCatalogError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
  if (error instanceof SessionLockError) {
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    io.stderr.write(
      `invalid_task_command: ${
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? "invalid value")
          : error.message
      }\n`,
    );
    return 2;
  }
  if (error instanceof SessionProjectionError) {
    io.stderr.write(`task_state_corrupt: ${error.message}\n`);
    return 1;
  }
  io.stderr.write("task_control_plane_internal_error\n");
  return 1;
}
