export type HookEventV1 =
  | "session.started"
  | "run.started"
  | "tool.before_effect"
  | "tool.after_result"
  | "completion.before_commit"
  | "run.terminal"
  | "session.ended";

export interface HookActionProjection {
  readonly actionKind?: string;
  readonly capabilityIds?: readonly string[];
  readonly originalActionSha256?: string;
  readonly paths?: readonly string[];
  readonly terminalState?: "blocked" | "cancelled" | "completed" | "failed";
  readonly toolName?: string;
}

export interface HookPipelineInput {
  readonly action?: HookActionProjection;
  readonly completion?: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
  /** Rechecks the original action after any command Hook process returns. */
  readonly revalidateOriginalAction?: () => Promise<boolean>;
}

export interface HookPipelineDecision {
  readonly decision: "deny" | "no_objection";
  readonly code?: string;
  readonly evidence?: readonly string[];
  readonly invocationId?: string;
  readonly message?: string;
}

export interface EffectHookPipeline {
  run(
    event: HookEventV1,
    input: HookPipelineInput,
    signal: AbortSignal,
  ): Promise<HookPipelineDecision>;
}
