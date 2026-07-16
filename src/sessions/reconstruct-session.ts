import type {
  RunEvent,
  TerminalRunEvent,
} from "../events/run-event.js";
import { isTerminalRunEvent } from "../events/run-event.js";

type StartedEvent = Extract<RunEvent, { type: "run.started" }>;
type UsageEvent = Extract<RunEvent, { type: "usage" }>;

export interface ReconstructedRun {
  readonly output: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly started: StartedEvent["data"];
  readonly terminal: TerminalRunEvent;
  readonly usage?: UsageEvent["data"];
}

export function reconstructSession(events: readonly RunEvent[]): ReconstructedRun {
  if (events.length === 0) {
    throw new Error("session is empty");
  }

  const first = events[0];
  if (first?.type !== "run.started") {
    throw new Error("run.started must be first");
  }

  const eventIds = new Set<string>();
  let output = "";
  let usage: UsageEvent["data"] | undefined;
  let terminal: TerminalRunEvent | undefined;

  events.forEach((event, index) => {
    if (event.session_id !== first.session_id || event.run_id !== first.run_id) {
      throw new Error("session or run id changed within event log");
    }
    if (event.seq !== index + 1) {
      throw new Error(`expected seq ${index + 1}, received ${event.seq}`);
    }
    if (eventIds.has(event.event_id)) {
      throw new Error("duplicate event id");
    }
    eventIds.add(event.event_id);

    if (index > 0 && event.type === "run.started") {
      throw new Error("run.started can only appear once");
    }
    if (terminal !== undefined) {
      throw new Error("event appears after terminal event");
    }
    if (event.type === "text.delta") {
      output += event.data.delta;
    } else if (event.type === "usage") {
      if (usage !== undefined) {
        throw new Error("usage can only appear once");
      }
      usage = event.data;
    } else if (isTerminalRunEvent(event)) {
      terminal = event;
      if (index !== events.length - 1) {
        throw new Error("terminal event must be last");
      }
    }
  });

  if (terminal === undefined) {
    throw new Error("session is missing a terminal event");
  }
  if (
    terminal.type === "run.completed" &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error("run.completed output_chars does not match reconstructed text");
  }

  return {
    output,
    runId: first.run_id,
    sessionId: first.session_id,
    started: first.data,
    terminal,
    ...(usage === undefined ? {} : { usage }),
  };
}
