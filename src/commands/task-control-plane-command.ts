import { z } from "zod";

import type { CliIO } from "../cli/types.js";
import {
  TaskControlPlaneError,
} from "../coordination/task-control-plane.js";
export { taskMutationContext, taskWriterFactory } from "../coordination/task-mutation-host.js";
import { PlanFileLoaderError } from "../plans/plan-file-loader.js";
import { SessionCatalogError } from "../sessions/session-catalog.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { SessionProjectionError } from "../sessions/reconstruct-multi-run-session.js";

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
