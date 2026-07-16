import type { z } from "zod";

import type { runEventSchema } from "./run-event-schema.js";

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
export type TerminalRunEvent = Extract<
  RunEvent,
  { type: "run.cancelled" | "run.completed" | "run.failed" }
>;

export type RunEventDraft = {
  [TType in RunEventType]: {
    readonly data: Extract<RunEvent, { type: TType }>["data"];
    readonly type: TType;
  };
}[RunEventType];

export function isTerminalRunEvent(event: RunEvent): event is TerminalRunEvent {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}
