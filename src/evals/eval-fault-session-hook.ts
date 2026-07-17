import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { EvalFaultController } from "./eval-fault-controller.js";
import type { EvalFaultHook } from "./eval-scenario-schema.js";

const EVENT_TO_HOOK: Readonly<Record<string, EvalFaultHook | undefined>> =
  Object.freeze({
    "backend.checkpoint.created": "after_checkpoint_created",
    "command.started": "after_command_started",
    "context.plan.created": "after_context_plan_created",
    "mcp.tool.call.started": "after_mcp_call_started",
    "patch.apply.started": "after_patch_apply_started",
  });

export class EvalInjectedTerminationError extends Error {
  override readonly name = "EvalInjectedTerminationError";

  public constructor(readonly hook: EvalFaultHook, readonly runId: string) {
    super(`eval terminate_once injected after durable ${hook}`);
  }
}
export class EvalFaultSessionHook {
  #armed:
    | {
        readonly action: "terminate_once";
        readonly hook: EvalFaultHook;
      }
    | undefined;
  #controller: EvalFaultController | undefined;
  #observed:
    | { readonly eventType: string; readonly hook: EvalFaultHook; readonly runId: string }
    | undefined;

  public arm(input: {
    readonly action: "terminate_once";
    readonly hook: EvalFaultHook;
  }): void {
    if (this.#armed !== undefined || this.#controller !== undefined) {
      throw new TypeError("eval fault hook is already armed");
    }
    this.#armed = Object.freeze({ ...input });
    this.#observed = undefined;
  }

  public disarm(): void {
    this.#armed = undefined;
    this.#controller = undefined;
  }

  public get observation():
    | { readonly eventType: string; readonly hook: EvalFaultHook; readonly runId: string }
    | undefined {
    return this.#observed;
  }

  public finish(): "hook_not_observed" | "observed" | "unarmed" {
    if (this.#armed === undefined) return "unarmed";
    return this.#controller?.finishRun() ?? "hook_not_observed";
  }

  public afterDurableEvent(event: DecodedStoredEvent): void {
    if (event.scope !== "run" || this.#armed === undefined) return;
    const hook = EVENT_TO_HOOK[event.type];
    if (hook !== this.#armed.hook) return;
    this.#controller ??= EvalFaultController.createForAttemptHarness({
      action: this.#armed.action,
      hook,
      runId: event.runId,
    });
    // PHASE14: V2SessionWriter invokes this callback only after append+fsync and
    // decoded-ledger commit. The controller receives no prompt, grader answer,
    // delay, signal name, or arbitrary event selector.
    const decision = this.#controller.observe({
      hook,
      persisted: true,
      runId: event.runId,
      synced: true,
    });
    if (decision === "terminate_now") {
      this.#observed = Object.freeze({ eventType: event.type, hook, runId: event.runId });
      throw new EvalInjectedTerminationError(hook, event.runId);
    }
  }
}
