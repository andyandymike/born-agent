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
  private outputChars = 0;
  private seq = 0;
  private started = false;
  private terminal = false;
  private usagePublished = false;

  constructor(private readonly options: EventPublisherOptions) {}

  get outputLength(): number {
    return this.outputChars;
  }

  async publish(draft: RunEventDraft): Promise<RunEvent> {
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
    if (
      draft.type === "run.completed" &&
      draft.data.output_chars !== this.outputChars
    ) {
      throw new Error("run.completed output_chars does not match text deltas");
    }
  }

  private applyTransition(event: RunEvent): void {
    this.seq = event.seq;
    if (event.type === "run.started") {
      this.started = true;
    } else if (event.type === "text.delta") {
      this.outputChars += event.data.delta.length;
    } else if (event.type === "usage") {
      this.usagePublished = true;
    }
    if (isTerminalRunEvent(event)) {
      this.terminal = true;
    }
  }
}
