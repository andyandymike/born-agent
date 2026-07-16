import type { z } from "zod";

import type { runEventSchema } from "./run-event-schema.js";

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
export type ModelUsageData = Extract<
  RunEvent,
  { type: "model.usage" }
>["data"];
export type Phase8ModelUsageData = Extract<
  ModelUsageData,
  { completeness: "complete" | "partial" }
>;
export type LegacyModelUsageData = Exclude<
  ModelUsageData,
  Phase8ModelUsageData
>;
export type TerminalRunEvent = Extract<
  RunEvent,
  {
    type:
      | "run.budget_exceeded"
      | "run.cancelled"
      | "run.completed"
      | "run.incomplete"
      | "run.failed";
  }
>;

export type RunEventDraft = {
  [TType in RunEventType]: {
    readonly data: Extract<RunEvent, { type: TType }>["data"];
    readonly type: TType;
  };
}[RunEventType];

export function isPhase8ModelUsageData(
  data: ModelUsageData,
): data is Phase8ModelUsageData {
  return "completeness" in data;
}

export function isLegacyModelUsageData(
  data: ModelUsageData,
): data is LegacyModelUsageData {
  return !isPhase8ModelUsageData(data);
}

export function isTerminalRunEvent(event: RunEvent): event is TerminalRunEvent {
  return (
    event.type === "run.completed" ||
    event.type === "run.incomplete" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.budget_exceeded"
  );
}
