import { decodeStoredEvents } from "../../src/events/event-decoder-registry.js";
import { canonicalPlanIdentity } from "../../src/plans/plan-identity.js";
import type { PlanRevisionContent } from "../../src/plans/plan-schema.js";

export const SESSION = "00000000-0000-4000-8000-000000016001";
export const RUN = "00000000-0000-4000-8000-000000016101";
export const RUN_2 = "00000000-0000-4000-8000-000000016102";
export const GOAL = "00000000-0000-4000-8000-000000016201";
export const GOAL_2 = "00000000-0000-4000-8000-000000016202";
export const PLAN = "00000000-0000-4000-8000-000000016301";
export const PLAN_2 = "00000000-0000-4000-8000-000000016302";
export const TIME = "2026-07-31T00:00:00.000Z";

export function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

export const userOrigin = Object.freeze({
  input_surface: "cli" as const,
  kind: "user" as const,
});

export function agentOrigin(callId: string, runId = RUN) {
  return {
    call_id: callId,
    kind: "agent" as const,
    mutation_id: callId,
    run_id: runId,
  };
}

export const hostOrigin = Object.freeze({ kind: "host_completion" as const });

export function planContent(
  overrides: Partial<PlanRevisionContent> = {},
): PlanRevisionContent {
  return {
    goalId: GOAL,
    goalRevision: 1,
    items: [
      {
        acceptance: "The implementation is covered by a durable passing check.",
        id: "implement",
        required: true,
        title: "Implement the state kernel",
      },
    ],
    planId: PLAN,
    revision: 1,
    schemaVersion: 1,
    title: "Phase 16A",
    ...overrides,
  };
}

export function planIdentity(content = planContent()) {
  return canonicalPlanIdentity(content);
}

export function chatStartData(extra: Record<string, unknown> = {}) {
  return {
    command: "chat",
    input: { role: "user", text: "continue" },
    model: "fake-model",
    provider: "fake",
    timeout_ms: 1_000,
    workspace: "D:\\Code\\bornagent",
    ...extra,
  };
}

export function backendSelectedData() {
  return {
    adapter: "fake-adapter",
    adapter_version: "1.0.0",
    capabilities: {
      cancellation: "abort_signal",
      reasoning: "none",
      streaming: true,
      tools: "strict",
      usage: "complete",
    },
    config_fingerprint: "a".repeat(64),
    model: "fake-model",
    provider: "fake",
    resume_capability: "canonical_only",
  };
}

export function toolRequestData(callId: string, toolName: string) {
  return {
    arguments_json: "{}",
    call_id: callId,
    step: 1,
    tool_name: toolName,
  };
}

export function toolCompletedData(
  callId: string,
  toolName: string,
  status: "error" | "success" = "success",
) {
  return {
    call_id: callId,
    duration_ms: 1,
    ...(status === "error"
      ? {
          error_category: "tool" as const,
          error_code: "fixture_error",
          retryable: false,
        }
      : {}),
    output: status === "success" ? "ok" : "failed",
    status,
    step: 1,
    tool_name: toolName,
    truncated: false,
  };
}

export function acceptedCompletionData(callId: string) {
  return {
    call_id: callId,
    candidate_sha256: "b".repeat(64),
    changed_paths: ["src/coordination/task-state-machine.ts"],
    diff_stat: { added_lines: 1, removed_lines: 0 },
    effect: "accept",
    evidence_sha256: "c".repeat(64),
    reasons: [],
    report_sha256: "d".repeat(64),
    step: 1,
    verification_ids: [uuid(16_990)],
  };
}

export function eventIdOf(event: Record<string, unknown>): string {
  return event.event_id as string;
}

export class Phase16EventBuilder {
  public readonly values: Record<string, unknown>[] = [];
  private readonly runSequences = new Map<string, number>();

  public session(type: string, data: unknown): Record<string, unknown> {
    const sessionSeq = this.values.length + 1;
    const event = {
      data,
      event_id: uuid(17_000 + sessionSeq),
      schema_version: 2,
      scope: "session",
      session_id: SESSION,
      session_seq: sessionSeq,
      timestamp: TIME,
      type,
    };
    this.values.push(event);
    return event;
  }

  public run(
    type: string,
    data: unknown,
    runId = RUN,
  ): Record<string, unknown> {
    const sessionSeq = this.values.length + 1;
    const runSeq = (this.runSequences.get(runId) ?? 0) + 1;
    this.runSequences.set(runId, runSeq);
    const event = {
      data,
      event_id: uuid(17_000 + sessionSeq),
      run_id: runId,
      run_seq: runSeq,
      schema_version: 2,
      scope: "run",
      session_id: SESSION,
      session_seq: sessionSeq,
      timestamp: TIME,
      type,
    };
    this.values.push(event);
    return event;
  }

  public decode() {
    return decodeStoredEvents(this.values);
  }
}
