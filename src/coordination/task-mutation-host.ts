import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type {
  TaskMutationContext,
  TaskMutationWriterFactory,
} from "./task-control-plane.js";

/** Minimal Host capabilities required to open and observe one task writer. */
export interface TaskMutationHostPortV1 {
  readonly cwd: string;
  readonly observeSessionWriter?: (writer: SessionWriter) => void;
  readonly randomUUID: () => string;
  readonly timestamp: () => string;
}

export function taskMutationContext(
  host: TaskMutationHostPortV1,
  sessionId: string,
  inputSurface: "cli" | "tui" = "cli",
  expectedSessionSeq?: number,
): TaskMutationContext {
  return Object.freeze({
    ...(expectedSessionSeq === undefined ? {} : { expectedSessionSeq }),
    inputSurface,
    now: host.timestamp,
    randomUuid: host.randomUUID,
    sessionId,
    workspace: host.cwd,
  });
}

export function taskWriterFactory(host: TaskMutationHostPortV1): TaskMutationWriterFactory {
  return async (context) => {
    const writer = await V2SessionWriter.openExisting(
      context.workspace,
      context.sessionId,
      {
        createEventId: context.randomUuid,
        timestamp: context.now,
      },
    );
    host.observeSessionWriter?.(writer);
    return writer;
  };
}
