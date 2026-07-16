import type {
  RunEvent,
  TerminalRunEvent,
} from "../events/run-event.js";
import { isTerminalRunEvent } from "../events/run-event.js";

type StartedEvent = Extract<RunEvent, { type: "run.started" }>;
type UsageEvent = Extract<RunEvent, { type: "usage" }>;
type ToolRequestedEvent = Extract<
  RunEvent,
  { type: "tool.call.requested" }
>;
type ToolCompletedEvent = Extract<
  RunEvent,
  { type: "tool.call.completed" }
>;

export interface ReconstructedToolCall {
  readonly completed?: ToolCompletedEvent["data"];
  readonly interrupted: boolean;
  readonly requested: ToolRequestedEvent["data"];
}

export interface ReconstructedRun {
  readonly output: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly started: StartedEvent["data"];
  readonly terminal: TerminalRunEvent;
  readonly toolCalls: readonly ReconstructedToolCall[];
  readonly usage?: UsageEvent["data"];
}

export function reconstructSession(events: readonly RunEvent[]): ReconstructedRun {
  // PHASE2: reconstructor 把 event log 折叠成最终状态，同时验证跨事件不变量。
  // 它不是简单 join delta：还检查 ID、seq、唯一 usage、唯一 terminal 和输出长度。
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
  const toolCalls = new Map<
    string,
    { completed?: ToolCompletedEvent["data"]; requested: ToolRequestedEvent["data"] }
  >();

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
      // PHASE2: 最终回答是历史 delta 的确定性重放结果，不需要再次请求 provider。
      output += event.data.delta;
    } else if (event.type === "usage") {
      if (usage !== undefined) {
        throw new Error("usage can only appear once");
      }
      usage = event.data;
    } else if (event.type === "tool.call.requested") {
      if (toolCalls.has(event.data.call_id)) {
        throw new Error("duplicate tool call id");
      }
      toolCalls.set(event.data.call_id, { requested: event.data });
    } else if (event.type === "tool.call.completed") {
      const call = toolCalls.get(event.data.call_id);
      if (
        call === undefined ||
        call.completed !== undefined ||
        call.requested.tool_name !== event.data.tool_name
      ) {
        throw new Error("tool result does not match one pending tool call");
      }
      call.completed = event.data;
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
  const reconstructedToolCalls = [...toolCalls.values()].map((call) => ({
    ...(call.completed === undefined ? {} : { completed: call.completed }),
    interrupted: call.completed === undefined,
    requested: call.requested,
  }));
  if (
    terminal.type === "run.completed" &&
    reconstructedToolCalls.some((call) => call.interrupted)
  ) {
    throw new Error("completed run contains an interrupted tool call");
  }
  if (
    terminal.type === "run.completed" &&
    terminal.data.tool_calls !== undefined &&
    terminal.data.tool_calls !==
      reconstructedToolCalls.filter((call) => !call.interrupted).length
  ) {
    throw new Error("run.completed tool_calls does not match reconstructed tools");
  }

  return {
    output,
    runId: first.run_id,
    sessionId: first.session_id,
    started: first.data,
    terminal,
    toolCalls: reconstructedToolCalls,
    ...(usage === undefined ? {} : { usage }),
  };
}
