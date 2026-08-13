import { EventPersistenceError, type EventPublisher } from "../events/event-publisher.js";
import type { RunEventDraft } from "../events/run-event.js";
import { HookError } from "../hooks/hook-errors.js";
import { McpCoreError } from "../mcp/mcp-errors.js";
import { FatalToolExecutionError } from "../tools/tool-types.js";
import type { AgentTerminal } from "./agent-types.js";

export type TerminalRunEventDraftV1 = Extract<
  RunEventDraft,
  {
    readonly type:
      | "run.budget_exceeded"
      | "run.cancelled"
      | "run.completed"
      | "run.failed"
      | "run.incomplete";
  }
>;

export type RunTerminationStateV1 =
  | "open"
  | "publishing"
  | "published"
  | "persistence_failed";

export type RunExecutionErrorClassificationV1 =
  | { readonly kind: "persistence" }
  | {
      readonly kind: "storage";
      readonly workspaceMayHaveChanged: boolean;
    }
  | { readonly kind: "host_surface_fatal" }
  | { readonly kind: "user_cancelled" }
  | {
      readonly effect:
        | "ambiguous_command_state"
        | "ambiguous_mcp_state"
        | "ambiguous_patch_state";
      readonly kind: "ambiguous_effect";
    }
  | { readonly error: HookError; readonly kind: "hook" }
  | { readonly error: McpCoreError; readonly kind: "mcp" }
  | { readonly kind: "internal" };

/**
 * Pure classification for errors that escape the Agent loop. It deliberately
 * does not publish, render, abort, or inspect ambient process state.
 */
export function classifyRunExecutionError(
  error: unknown,
  context: {
    readonly hostEmergencyReason?: "tui_surface_fatal" | undefined;
    readonly wasUserCancelled: boolean;
  },
): RunExecutionErrorClassificationV1 {
  if (error instanceof EventPersistenceError) return { kind: "persistence" };
  if (error instanceof FatalToolExecutionError && error.kind === "storage") {
    return {
      kind: "storage",
      workspaceMayHaveChanged: error.workspaceMayHaveChanged,
    };
  }
  if (context.hostEmergencyReason === "tui_surface_fatal") {
    return { kind: "host_surface_fatal" };
  }
  if (error instanceof FatalToolExecutionError && error.kind === "user_cancelled") {
    return { kind: "user_cancelled" };
  }
  if (error instanceof FatalToolExecutionError) {
    if (
      error.kind === "ambiguous_command_state" ||
      error.kind === "ambiguous_mcp_state" ||
      error.kind === "ambiguous_patch_state"
    ) {
      return { effect: error.kind, kind: "ambiguous_effect" };
    }
  }
  if (error instanceof HookError) return { error, kind: "hook" };
  if (error instanceof McpCoreError) return { error, kind: "mcp" };
  if (context.wasUserCancelled) return { kind: "user_cancelled" };
  return { kind: "internal" };
}

export class RunTerminationStateError extends Error {
  constructor(readonly state: RunTerminationStateV1) {
    super(`run terminal publication is not available from state ${state}`);
    this.name = "RunTerminationStateError";
  }
}

/**
 * The sole in-process owner of before-terminal hooks and terminal publication.
 * Once persistence becomes ambiguous or fails, it permanently refuses a
 * compensating terminal write.
 */
export class RunTerminator {
  private currentState: RunTerminationStateV1 = "open";
  private skipBeforeTerminalOnce = false;

  constructor(
    private readonly options: {
      readonly beforeTerminal?: (terminal: AgentTerminal) => Promise<void>;
      readonly publisher: EventPublisher;
    },
  ) {}

  get state(): RunTerminationStateV1 {
    return this.currentState;
  }

  markPersistenceFailed(): void {
    if (this.currentState === "published") return;
    this.currentState = "persistence_failed";
  }

  async terminate(
    terminal: AgentTerminal,
    event: TerminalRunEventDraftV1,
  ): Promise<AgentTerminal> {
    if (this.currentState !== "open") {
      throw new RunTerminationStateError(this.currentState);
    }
    this.currentState = "publishing";
    if (!this.skipBeforeTerminalOnce) {
      try {
        await this.options.beforeTerminal?.(terminal);
      } catch (error) {
        // The canonical fallback terminal for a failed terminal Hook must not
        // recursively invoke the same failed Hook.
        this.skipBeforeTerminalOnce = true;
        this.currentState = "open";
        throw error;
      }
    } else {
      this.skipBeforeTerminalOnce = false;
    }
    try {
      await this.options.publisher.publish(event);
      this.currentState = "published";
      return terminal;
    } catch (error) {
      // EventPublisher advances its durable state before rendering. A renderer
      // failure after persistence must therefore never permit a second terminal.
      if (this.options.publisher.terminalPublished) {
        this.currentState = "published";
      } else if (error instanceof EventPersistenceError) {
        this.currentState = "persistence_failed";
      } else {
        // A pre-terminal Hook rejection has not crossed the durable boundary;
        // the outer owner may map it to its canonical blocked terminal.
        this.currentState = "open";
      }
      throw error;
    }
  }
}
