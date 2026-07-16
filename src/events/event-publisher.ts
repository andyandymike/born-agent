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

export class EventPublisher {
  // PHASE2: 这些字段组成一个很小的运行状态机，用来守住跨事件不变量。
  private outputChars = 0;
  private seq = 0;
  private started = false;
  private terminal = false;
  private readonly toolCalls = new Map<
    string,
    { readonly name: string; completed: boolean }
  >();
  private usagePublished = false;

  constructor(private readonly options: EventPublisherOptions) {}

  get outputLength(): number {
    return this.outputChars;
  }

  get completedToolCalls(): number {
    return [...this.toolCalls.values()].filter((call) => call.completed).length;
  }

  async publish(draft: RunEventDraft): Promise<RunEvent> {
    // PHASE2: 发布顺序固定为：检查状态 -> 补全 envelope/Zod 校验 -> 持久化
    // -> 更新内存状态 -> 渲染。尤其不要把 writer 和 renderer 的顺序交换。
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
      // PHASE2: persist-before-render。用户只能看到已经成功进入 session 的 delta；
      // 否则磁盘失败时，屏幕文本会比可重建文本更多。
      await this.options.writer.write(event);
    } catch (error) {
      throw new EventPersistenceError(error);
    }

    this.applyTransition(event);
    await this.options.renderer.render(event);
    return event;
  }

  private validateTransition(draft: RunEventDraft): void {
    // PHASE2: 合法生命周期是 started -> 若干 delta -> 可选 usage -> 唯一 terminal。
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
        requested.name !== draft.data.tool_name
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

  private applyTransition(event: RunEvent): void {
    // PHASE2: 只有持久化成功后才推进状态，写盘失败不会“假装”事件已经发生。
    this.seq = event.seq;
    if (event.type === "run.started") {
      this.started = true;
    } else if (event.type === "text.delta") {
      this.outputChars += event.data.delta.length;
    } else if (event.type === "usage") {
      this.usagePublished = true;
    } else if (event.type === "tool.call.requested") {
      this.toolCalls.set(event.data.call_id, {
        completed: false,
        name: event.data.tool_name,
      });
    } else if (event.type === "tool.call.completed") {
      const requested = this.toolCalls.get(event.data.call_id);
      if (requested !== undefined) {
        requested.completed = true;
      }
    }
    if (isTerminalRunEvent(event)) {
      this.terminal = true;
    }
  }
}
