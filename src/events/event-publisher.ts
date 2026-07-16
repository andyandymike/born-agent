import type { RunEvent, RunEventDraft } from "./run-event.js";
import { isTerminalRunEvent } from "./run-event.js";
import { runEventSchema } from "./run-event-schema.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";

export interface RunEventRenderer {
  render(event: RunEvent): Promise<void> | void;
}

export interface EventPublisherOptions {
  readonly randomUUID: () => string;
  readonly renderer: RunEventRenderer;
  readonly runId: string;
  readonly sessionId: string;
  readonly timestamp: () => string;
  readonly writer: SessionWriter;
}

export class EventPersistenceError extends Error {
  constructor(cause: unknown) {
    super("session persistence failed", { cause });
    this.name = "EventPersistenceError";
  }
}

interface AgentStepState {
  // PHASE4: Publisher 维护写入时状态机，防止 step、usage、tool pair 和 terminal 顺序矛盾。
  completed: boolean;
  modelUsage?: Extract<RunEvent, { type: "model.usage" }>["data"];
  outcome?: "final" | "tool_call";
  textChars: number;
  toolCallId?: string;
}

interface ToolCallState {
  completed: boolean;
  readonly name: string;
  readonly step: number;
}

export class EventPublisher {
  private activeAgentStep: number | undefined;
  private readonly agentSteps = new Map<number, AgentStepState>();
  private command: "agent" | "chat" | undefined;
  private outputChars = 0;
  private seq = 0;
  private started = false;
  private terminal = false;
  private readonly toolCalls = new Map<string, ToolCallState>();
  private usagePublished = false;

  constructor(private readonly options: EventPublisherOptions) {}

  get outputLength(): number {
    return this.outputChars;
  }

  get completedToolCalls(): number {
    return [...this.toolCalls.values()].filter((call) => call.completed).length;
  }

  get startedAgentSteps(): number {
    return this.agentSteps.size;
  }

  async publish(draft: RunEventDraft): Promise<RunEvent> {
    // PHASE4: 持久化是 render、下一次 model observation 和真实 tool action 的审计边界；
    // writer 失败时内存状态不前进，调用方也不得继续产生未记录的副作用。
    // Persist-before-render is also the AgentLoop's audit boundary: no model/tool
    // action may depend on an event that failed to reach the session log.
    this.validateTransition(draft);
    const event = runEventSchema.parse({
      ...draft,
      event_id: this.options.randomUUID(),
      run_id: this.options.runId,
      schema_version: 1,
      seq: this.seq + 1,
      session_id: this.options.sessionId,
      timestamp: this.options.timestamp(),
    });
    try {
      await this.options.writer.write(event);
    } catch (error) {
      throw new EventPersistenceError(error);
    }
    this.applyTransition(event);
    await this.options.renderer.render(event);
    return event;
  }

  private validateTransition(draft: RunEventDraft): void {
    if (this.terminal) {
      throw new Error("cannot publish after terminal event");
    }
    if (!this.started && draft.type !== "run.started") {
      throw new Error("run.started must be the first event");
    }
    if (this.started && draft.type === "run.started") {
      throw new Error("run.started can only be published once");
    }
    if (draft.type === "usage" && this.usagePublished) {
      throw new Error("usage can only be published once");
    }

    if (this.command === "agent") {
      this.validateAgentTransition(draft);
    } else if (
      this.command === "chat" &&
      (draft.type === "agent.step.started" ||
        draft.type === "agent.step.completed" ||
        draft.type === "model.usage" ||
        draft.type === "run.budget_exceeded")
    ) {
      throw new Error("chat run cannot publish agent events");
    }

    if (draft.type === "tool.call.requested") {
      if (this.toolCalls.has(draft.data.call_id)) {
        throw new Error("tool call id must be unique");
      }
    }
    if (draft.type === "tool.call.completed") {
      const requested = this.toolCalls.get(draft.data.call_id);
      if (
        requested === undefined ||
        requested.completed ||
        requested.name !== draft.data.tool_name ||
        requested.step !== draft.data.step
      ) {
        throw new Error("tool result must match one pending tool call");
      }
    }
    if (
      draft.type === "run.completed" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.completed output_chars does not match text deltas");
    }
    if (
      (draft.type === "run.failed" || draft.type === "run.cancelled") &&
      draft.data.output_chars !== undefined &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error(`${draft.type} output_chars does not match text deltas`);
    }
    if (
      draft.type === "run.budget_exceeded" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.budget_exceeded output_chars does not match text deltas");
    }
    if (draft.type === "run.completed") {
      if ([...this.toolCalls.values()].some((call) => !call.completed)) {
        throw new Error("completed run cannot contain an interrupted tool call");
      }
      if (
        draft.data.tool_calls !== undefined &&
        draft.data.tool_calls !== this.completedToolCalls
      ) {
        throw new Error("run.completed tool_calls does not match tool events");
      }
    }
  }

  private validateAgentTransition(draft: RunEventDraft): void {
    // PHASE4: 这些检查发生在写盘前；任何非法 transition 都不会进入 session 或 renderer。
    if (draft.type === "agent.step.started") {
      const expected = this.agentSteps.size + 1;
      if (this.activeAgentStep !== undefined || draft.data.step !== expected) {
        throw new Error(`agent step must start at ${expected}`);
      }
      if (draft.data.step === 1 && draft.data.input_kind !== "user_task") {
        throw new Error("first agent step must consume the user task");
      }
      if (draft.data.step > 1) {
        // PHASE4: 后续 step 必须消费前一步已持久化完成的工具 observation。
        if (draft.data.input_kind !== "tool_result") {
          throw new Error("later agent steps must consume a tool result");
        }
        const previous = this.agentSteps.get(draft.data.step - 1);
        const call =
          previous?.toolCallId === undefined
            ? undefined
            : this.toolCalls.get(previous.toolCallId);
        if (
          previous?.completed !== true ||
          previous.outcome !== "tool_call" ||
          call?.completed !== true
        ) {
          throw new Error("tool_result step requires a completed previous tool call");
        }
      }
      return;
    }
    if (draft.type === "text.delta") {
      if (this.activeAgentStep === undefined) {
        throw new Error("agent text delta requires an active step");
      }
      return;
    }
    if (draft.type === "model.usage") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        this.activeAgentStep !== draft.data.step ||
        step === undefined ||
        step.modelUsage !== undefined
      ) {
        throw new Error("model usage must appear once in its active step");
      }
      return;
    }
    if (draft.type === "agent.step.completed") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        this.activeAgentStep !== draft.data.step ||
        step === undefined ||
        step.completed
      ) {
        throw new Error("agent step completion must match one active step");
      }
      if (draft.data.text_chars !== step.textChars) {
        throw new Error("agent step text_chars does not match text deltas");
      }
      return;
    }
    if (draft.type === "tool.call.requested") {
      const step = this.agentSteps.get(draft.data.step);
      if (
        step?.completed !== true ||
        step.outcome !== "tool_call" ||
        step.toolCallId !== draft.data.call_id
      ) {
        throw new Error("agent tool request must match a tool_call step");
      }
      return;
    }
    if (draft.type === "usage") {
      // PHASE4: run usage 只能在 step 外发布，且必须逐字段等于全部 model.usage 的和。
      if (this.activeAgentStep !== undefined) {
        throw new Error("run usage cannot appear inside an agent step");
      }
      const usages = [...this.agentSteps.values()].map((step) => step.modelUsage);
      if (usages.some((usage) => usage === undefined)) {
        throw new Error("agent run usage requires usage for every step");
      }
      const known = usages.filter((usage) => usage !== undefined);
      const cached = known
        .map((usage) => usage.cached_input_tokens)
        .filter((value) => value !== undefined);
      if (
        draft.data.input_tokens !==
          known.reduce((sum, usage) => sum + usage.input_tokens, 0) ||
        draft.data.output_tokens !==
          known.reduce((sum, usage) => sum + usage.output_tokens, 0) ||
        draft.data.total_tokens !==
          known.reduce((sum, usage) => sum + usage.total_tokens, 0) ||
        draft.data.model_turns !== known.length ||
        (cached.length === 0
          ? draft.data.cached_input_tokens !== undefined
          : draft.data.cached_input_tokens !==
            cached.reduce((sum, value) => sum + value, 0)) ||
        draft.data.usage_incomplete === true
      ) {
        throw new Error("run usage does not match model usage events");
      }
      return;
    }
    if (draft.type === "run.completed") {
      // PHASE4: completed 要求最后一步 outcome=final、无 active step、usage 已聚合且计数一致。
      const finalStep = this.agentSteps.get(this.agentSteps.size);
      if (
        this.activeAgentStep !== undefined ||
        finalStep?.completed !== true ||
        finalStep.outcome !== "final" ||
        draft.data.steps !== this.agentSteps.size ||
        draft.data.model_turns !== this.agentSteps.size ||
        !this.usagePublished
      ) {
        throw new Error("agent completion does not match completed final step");
      }
      return;
    }
    if (draft.type === "run.budget_exceeded") {
      // PHASE4: budget terminal 的 step/tool 计数必须与已落盘事件一致，不能相信调用方自报。
      if (
        draft.data.steps !== this.agentSteps.size ||
        draft.data.tool_calls !== this.completedToolCalls
      ) {
        throw new Error("budget terminal counts do not match agent events");
      }
      return;
    }
    if (draft.type === "run.failed" || draft.type === "run.cancelled") {
      if (
        (draft.data.steps !== undefined &&
          draft.data.steps !== this.agentSteps.size) ||
        (draft.data.tool_calls !== undefined &&
          draft.data.tool_calls !== this.completedToolCalls)
      ) {
        throw new Error("agent terminal counts do not match agent events");
      }
    }
  }

  private applyTransition(event: RunEvent): void {
    this.seq = event.seq;
    if (event.type === "run.started") {
      this.started = true;
      this.command = event.data.command;
    } else if (event.type === "text.delta") {
      this.outputChars += event.data.delta.length;
      if (this.activeAgentStep !== undefined) {
        const step = this.agentSteps.get(this.activeAgentStep);
        if (step !== undefined) step.textChars += event.data.delta.length;
      }
    } else if (event.type === "agent.step.started") {
      this.agentSteps.set(event.data.step, {
        completed: false,
        textChars: 0,
      });
      this.activeAgentStep = event.data.step;
    } else if (event.type === "model.usage") {
      const step = this.agentSteps.get(event.data.step);
      if (step !== undefined) step.modelUsage = event.data;
    } else if (event.type === "agent.step.completed") {
      const step = this.agentSteps.get(event.data.step);
      if (step !== undefined) {
        step.completed = true;
        step.outcome = event.data.outcome;
        if (event.data.tool_call_id !== undefined) {
          step.toolCallId = event.data.tool_call_id;
        }
      }
      this.activeAgentStep = undefined;
    } else if (event.type === "usage") {
      this.usagePublished = true;
    } else if (event.type === "tool.call.requested") {
      this.toolCalls.set(event.data.call_id, {
        completed: false,
        name: event.data.tool_name,
        step: event.data.step,
      });
    } else if (event.type === "tool.call.completed") {
      const requested = this.toolCalls.get(event.data.call_id);
      if (requested !== undefined) requested.completed = true;
    }
    if (isTerminalRunEvent(event)) this.terminal = true;
  }
}
