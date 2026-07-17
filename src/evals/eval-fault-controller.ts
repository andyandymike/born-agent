import { EvalCoreError, evalHarnessInvariant } from "./eval-errors.js";
import type { EvalFaultHook } from "./eval-scenario-schema.js";

export interface EvalFaultPlan {
  readonly runId: string;
  readonly hook: EvalFaultHook;
  readonly action: "terminate_once";
}

export type EvalFaultDecision = "ignore" | "terminate_now";

export class EvalFaultController {
  #triggered = false;

  private constructor(private readonly plan: EvalFaultPlan) {}

  public observe(input: {
    readonly runId: string;
    readonly hook: EvalFaultHook;
    readonly persisted: boolean;
    readonly synced: boolean;
  }): EvalFaultDecision {
    if (input.runId !== this.plan.runId || input.hook !== this.plan.hook) return "ignore";
    if (!input.persisted || !input.synced) {
      throw evalHarnessInvariant("eval fault attempted before its RunEvent was durably synced");
    }
    if (this.#triggered) {
      throw evalHarnessInvariant("eval terminate_once hook triggered more than once");
    }
    this.#triggered = true;
    return "terminate_now";
  }

  public finishRun(): "observed" | "hook_not_observed" {
    return this.#triggered ? "observed" : "hook_not_observed";
  }

  public static createForAttemptHarness(plan: EvalFaultPlan): EvalFaultController {
    if (plan.action !== "terminate_once") {
      throw new EvalCoreError("eval_scenario_invalid", "unsupported eval fault action", 1);
    }
    return new EvalFaultController(Object.freeze({ ...plan }));
  }
}
