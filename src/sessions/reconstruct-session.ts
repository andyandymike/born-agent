import type { RunEvent, TerminalRunEvent } from "../events/run-event.js";
import { isTerminalRunEvent } from "../events/run-event.js";

type StartedEvent = Extract<RunEvent, { type: "run.started" }>;
type UsageEvent = Extract<RunEvent, { type: "usage" }>;
type ToolRequestedEvent = Extract<RunEvent, { type: "tool.call.requested" }>;
type ToolCompletedEvent = Extract<RunEvent, { type: "tool.call.completed" }>;
type AgentStepStartedEvent = Extract<RunEvent, { type: "agent.step.started" }>;
type AgentStepCompletedEvent = Extract<RunEvent, { type: "agent.step.completed" }>;
type ModelUsageEvent = Extract<RunEvent, { type: "model.usage" }>;

export interface ReconstructedToolCall {
  readonly completed?: ToolCompletedEvent["data"];
  readonly consumedByModel: boolean;
  readonly interrupted: boolean;
  readonly requested: ToolRequestedEvent["data"];
}

export interface ReconstructedAgentStep {
  readonly completed?: AgentStepCompletedEvent["data"];
  readonly interrupted: boolean;
  readonly modelUsage?: ModelUsageEvent["data"];
  readonly started: AgentStepStartedEvent["data"];
}

export interface ReconstructedRun {
  readonly agentSteps: readonly ReconstructedAgentStep[];
  readonly output: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly started: StartedEvent["data"];
  readonly terminal: TerminalRunEvent;
  readonly toolCalls: readonly ReconstructedToolCall[];
  readonly usage?: UsageEvent["data"];
}

interface MutableToolCall {
  completed?: ToolCompletedEvent["data"];
  consumedByModel: boolean;
  requested: ToolRequestedEvent["data"];
}

interface MutableAgentStep {
  completed?: AgentStepCompletedEvent["data"];
  modelUsage?: ModelUsageEvent["data"];
  started: AgentStepStartedEvent["data"];
  textChars: number;
}

function validateRunUsage(
  usage: UsageEvent["data"],
  steps: readonly MutableAgentStep[],
): void {
  const modelUsages = steps.map((step) => step.modelUsage);
  if (modelUsages.some((value) => value === undefined)) {
    throw new Error("agent run usage exists without usage for every step");
  }
  const known = modelUsages.filter((value) => value !== undefined);
  const cached = known
    .map((value) => value.cached_input_tokens)
    .filter((value) => value !== undefined);
  if (
    usage.input_tokens !==
      known.reduce((sum, value) => sum + value.input_tokens, 0) ||
    usage.output_tokens !==
      known.reduce((sum, value) => sum + value.output_tokens, 0) ||
    usage.total_tokens !==
      known.reduce((sum, value) => sum + value.total_tokens, 0) ||
    usage.model_turns !== known.length ||
    (cached.length === 0
      ? usage.cached_input_tokens !== undefined
      : usage.cached_input_tokens !== cached.reduce((sum, value) => sum + value, 0)) ||
    usage.usage_incomplete === true
  ) {
    throw new Error("run usage does not equal model usage aggregation");
  }
}

function validateBudgetTerminal(
  started: Extract<StartedEvent["data"], { command: "agent" }>,
  terminal: Extract<TerminalRunEvent, { type: "run.budget_exceeded" }>,
  steps: readonly MutableAgentStep[],
  tools: readonly MutableToolCall[],
): void {
  // PHASE4: 用 run.started 的原始预算和重放出的 step/tool/usage 重新证明 terminal 数值，
  // 防止仅凭最后一行就相信 reason、limit 或 observed。
  const data = terminal.data;
  if (data.steps !== steps.length) {
    throw new Error("budget terminal steps do not match agent trace");
  }
  if (data.tool_calls !== tools.filter((call) => call.completed !== undefined).length) {
    throw new Error("budget terminal tool_calls do not match agent trace");
  }
  if (data.reason === "max_steps") {
    if (data.limit !== started.max_steps || data.observed !== steps.length) {
      throw new Error("max_steps terminal does not match event history");
    }
  } else if (data.reason === "max_duration") {
    if (
      data.limit !== started.max_duration_ms ||
      data.observed !== data.duration_ms ||
      data.observed < data.limit
    ) {
      throw new Error("max_duration terminal does not match event history");
    }
  } else if (data.reason === "max_tokens") {
    const total = steps.reduce(
      (sum, step) => sum + (step.modelUsage?.total_tokens ?? 0),
      0,
    );
    if (
      data.limit !== started.max_tokens ||
      data.observed !== total ||
      data.observed < data.limit
    ) {
      throw new Error("max_tokens terminal does not match event history");
    }
  } else if (data.reason === "max_tool_output") {
    const bytes = tools.reduce(
      (sum, call) =>
        sum +
        (call.completed === undefined
          ? 0
          : Buffer.byteLength(call.completed.output, "utf8")),
      0,
    );
    if (
      data.limit !== started.max_tool_output_bytes ||
      data.observed !== bytes ||
      data.observed < data.limit
    ) {
      throw new Error("max_tool_output terminal does not match event history");
    }
  } else if (data.limit !== 3 || data.observed !== 3) {
    throw new Error("repeated_tool_call terminal must report 3 of 3");
  }
}

export function reconstructSession(events: readonly RunEvent[]): ReconstructedRun {
  // PHASE4: 重建器是独立于在线 Publisher 的第二道验证；它只根据 JSONL 重建 step DAG、
  // 工具 observation 是否被消费、usage 聚合和最终停止原因。
  if (events.length === 0) throw new Error("session is empty");
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("run.started must be first");

  const eventIds = new Set<string>();
  const tools = new Map<string, MutableToolCall>();
  const steps: MutableAgentStep[] = [];
  let activeStep: MutableAgentStep | undefined;
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
    if (eventIds.has(event.event_id)) throw new Error("duplicate event id");
    eventIds.add(event.event_id);
    if (index > 0 && event.type === "run.started") {
      throw new Error("run.started can only appear once");
    }
    if (terminal !== undefined) throw new Error("event appears after terminal event");

    if (event.type === "agent.step.started") {
      // PHASE4: step 必须连续且不重叠；第一步消费 user_task，后续步骤消费上一步 tool_result。
      if (first.data.command !== "agent") {
        throw new Error("chat session contains agent step events");
      }
      if (
        event.data.max_steps !== first.data.max_steps ||
        event.data.step > first.data.max_steps
      ) {
        throw new Error("agent step exceeds the configured max_steps");
      }
      if (activeStep !== undefined || event.data.step !== steps.length + 1) {
        throw new Error("agent steps must be continuous and non-overlapping");
      }
      if (event.data.step === 1) {
        if (event.data.input_kind !== "user_task") {
          throw new Error("first agent step must consume user_task");
        }
      } else {
        const previous = steps.at(-1);
        const call =
          previous?.completed?.tool_call_id === undefined
            ? undefined
            : tools.get(previous.completed.tool_call_id);
        if (
          event.data.input_kind !== "tool_result" ||
          previous?.completed?.outcome !== "tool_call" ||
          call?.completed === undefined
        ) {
          throw new Error("tool_result step lacks a completed previous tool call");
        }
        // PHASE4: completed 事件写入时无法预言 observation 会不会被消费；只有下一条
        // tool_result step 的存在，才能在重放时把前一工具结果确定为 consumedByModel。
        call.consumedByModel = true;
      }
      activeStep = { started: event.data, textChars: 0 };
      steps.push(activeStep);
    } else if (event.type === "text.delta") {
      if (first.data.command === "agent" && activeStep === undefined) {
        throw new Error("agent text delta appears outside a step");
      }
      output += event.data.delta;
      if (activeStep !== undefined) activeStep.textChars += event.data.delta.length;
    } else if (event.type === "model.usage") {
      // PHASE4: 每个 active step 最多一个 usage，供最终 run usage 和 token budget 交叉核对。
      if (
        first.data.command !== "agent" ||
        activeStep?.started.step !== event.data.step ||
        activeStep.modelUsage !== undefined
      ) {
        throw new Error("model usage does not match one active step");
      }
      activeStep.modelUsage = event.data;
    } else if (event.type === "agent.step.completed") {
      // PHASE4: completion 必须闭合当前 step，并核对该 step 中实际出现的 text delta 字符数。
      if (
        first.data.command !== "agent" ||
        activeStep?.started.step !== event.data.step ||
        activeStep.completed !== undefined ||
        activeStep.textChars !== event.data.text_chars
      ) {
        throw new Error("agent step completion does not match active step");
      }
      activeStep.completed = event.data;
      activeStep = undefined;
    } else if (event.type === "usage") {
      if (usage !== undefined) throw new Error("usage can only appear once");
      usage = event.data;
    } else if (event.type === "tool.call.requested") {
      if (tools.has(event.data.call_id)) throw new Error("duplicate tool call id");
      if (first.data.command === "agent") {
        const step = steps[event.data.step - 1];
        if (
          step?.completed?.outcome !== "tool_call" ||
          step.completed.tool_call_id !== event.data.call_id
        ) {
          throw new Error("tool request does not match a tool_call step");
        }
      }
      tools.set(event.data.call_id, {
        consumedByModel: false,
        requested: event.data,
      });
    } else if (event.type === "tool.call.completed") {
      const call = tools.get(event.data.call_id);
      if (
        call === undefined ||
        call.completed !== undefined ||
        call.requested.tool_name !== event.data.tool_name ||
        call.requested.step !== event.data.step
      ) {
        throw new Error("tool result does not match one pending tool call");
      }
      call.completed = event.data;
    } else if (isTerminalRunEvent(event)) {
      terminal = event;
      if (index !== events.length - 1) throw new Error("terminal event must be last");
    }
  });

  if (terminal === undefined) throw new Error("session is missing a terminal event");
  if (
    terminal.type === "run.completed" &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error("run.completed output_chars does not match reconstructed text");
  }
  if (
    terminal.type === "run.budget_exceeded" &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error("run.budget_exceeded output_chars does not match reconstructed text");
  }
  if (
    (terminal.type === "run.failed" || terminal.type === "run.cancelled") &&
    terminal.data.output_chars !== undefined &&
    terminal.data.output_chars !== output.length
  ) {
    throw new Error(`${terminal.type} output_chars does not match reconstructed text`);
  }

  const toolValues = [...tools.values()];
  if (
    terminal.type === "run.completed" &&
    toolValues.some((call) => call.completed === undefined)
  ) {
    throw new Error("completed run contains an interrupted tool call");
  }
  if (
    terminal.type === "run.completed" &&
    terminal.data.tool_calls !== undefined &&
    terminal.data.tool_calls !==
      toolValues.filter((call) => call.completed !== undefined).length
  ) {
    throw new Error("run.completed tool_calls does not match reconstructed tools");
  }

  if (first.data.command === "agent") {
    // PHASE4: 不同 terminal 有不同完成证明；成功要求 final step+aggregate usage，
    // budget terminal 则要求对应 limit/observed 能从事件历史重新计算。
    if (usage !== undefined) validateRunUsage(usage, steps);
    if (terminal.type === "run.completed") {
      const final = steps.at(-1)?.completed;
      if (
        activeStep !== undefined ||
        final?.outcome !== "final" ||
        final.text_chars === 0 ||
        terminal.data.steps !== steps.length ||
        terminal.data.model_turns !== steps.length ||
        usage === undefined
      ) {
        throw new Error("completed agent run lacks a final step or aggregate usage");
      }
    } else if (terminal.type === "run.budget_exceeded") {
      validateBudgetTerminal(first.data, terminal, steps, toolValues);
      if (terminal.data.reason === "repeated_tool_call") {
        const lastThree = toolValues.slice(-3);
        const fingerprints = lastThree.map(
          (call) => call.requested.fingerprint,
        );
        if (
          lastThree.length !== 3 ||
          fingerprints[0] === undefined ||
          !fingerprints.every((value) => value === fingerprints[0]) ||
          lastThree[2]?.completed?.error_code !== "repeated_call_blocked"
        ) {
          throw new Error("repeated_tool_call terminal lacks three matching calls");
        }
      }
    } else if (terminal.type === "run.failed" || terminal.type === "run.cancelled") {
      if (
        (terminal.data.steps !== undefined &&
          terminal.data.steps !== steps.length) ||
        (terminal.data.tool_calls !== undefined &&
          terminal.data.tool_calls !==
            toolValues.filter((call) => call.completed !== undefined).length)
      ) {
        throw new Error("agent terminal counts do not match event history");
      }
    }
  } else if (steps.length > 0) {
    throw new Error("chat session contains agent steps");
  }

  return {
    // PHASE4: interrupted 表示 step/tool 没有正常闭合；consumedByModel 只由后续 step 证实。
    agentSteps: steps.map((step) => ({
      ...(step.completed === undefined ? {} : { completed: step.completed }),
      interrupted: step.completed === undefined,
      ...(step.modelUsage === undefined ? {} : { modelUsage: step.modelUsage }),
      started: step.started,
    })),
    output,
    runId: first.run_id,
    sessionId: first.session_id,
    started: first.data,
    terminal,
    toolCalls: toolValues.map((call) => ({
      ...(call.completed === undefined ? {} : { completed: call.completed }),
      consumedByModel: call.consumedByModel,
      interrupted: call.completed === undefined,
      requested: call.requested,
    })),
    ...(usage === undefined ? {} : { usage }),
  };
}
