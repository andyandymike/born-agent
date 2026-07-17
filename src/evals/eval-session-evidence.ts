import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import { isPhase8ModelUsageData } from "../events/run-event.js";
import { readStoredSession } from "../sessions/read-stored-session.js";
import type { PersistedEvalEvent } from "./attempt-observation-collector.js";
import type { AttemptFailureEvidence } from "./attempt-classifier.js";
import type { ReportedTokenUsage } from "./metrics-collector.js";

function terminalKind(event: DecodedRunEvent): string | null {
  switch (event.type) {
    case "run.completed":
      return "completed";
    case "run.incomplete":
      return "incomplete";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "run.budget_exceeded":
      return "budget_exceeded";
    default:
      return null;
  }
}

function terminalReason(event: DecodedRunEvent): string | undefined {
  switch (event.type) {
    case "run.incomplete":
    case "run.budget_exceeded":
      return event.data.reason;
    case "run.failed":
      return event.data.code;
    case "run.cancelled":
      return event.data.reason;
    default:
      return undefined;
  }
}

function safeRawFact(event: DecodedStoredEvent): {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly type: string;
} {
  return {
    fields: Object.freeze({
      ...(event.scope === "run" ? { runId: event.runId } : {}),
      sourceEventType: event.type,
    }),
    type: event.type,
  };
}

interface ProjectedEvent {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly type: string;
}

function projectEvent(
  event: DecodedStoredEvent,
): readonly ProjectedEvent[] {
  if (event.scope === "session") return Object.freeze([safeRawFact(event)]);
  const common = { runId: event.runId };
  switch (event.type) {
    case "run.started": {
      const projected: ProjectedEvent[] = [
        {
          fields: Object.freeze({ ...common, stepId: "run" }),
          type: "run_started",
        },
      ];
      if (event.data.resume_mode !== undefined) {
        projected.push({
          fields: Object.freeze({
            ...common,
            adoptedRunId: event.data.resume_of_run_id,
            recoveryStatus: event.data.resume_mode,
            stepId: "resume",
          }),
          type: "resume_adopted",
        });
      }
      return Object.freeze(projected);
    }
    case "approval.decided":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.call_id,
            decision: event.data.decision,
            decisionSource: "eval_policy",
            reasonCode: "eval_policy_decision",
            stepId: String(event.data.step),
          }),
          type: "approval_decided",
        },
      ]);
    case "mcp.approval.decided":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.approval_request_id,
            decision: event.data.decision,
            decisionSource: "eval_policy",
            reasonCode: "eval_policy_decision",
            stepId: event.data.action_kind,
          }),
          type: "approval_decided",
        },
      ]);
    case "tool.call.completed":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.call_id,
            ...(event.data.error_code === undefined
              ? {}
              : { reasonCode: event.data.error_code }),
            stepId: String(event.data.step),
            terminalKind: event.data.status,
            toolName: event.data.tool_name,
            toolOrigin: event.data.tool_name.startsWith("mcp__")
              ? "mcp"
              : "built_in",
          }),
          type: "tool_terminal",
        },
      ]);
    case "command.completed":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.call_id,
            exitCode: event.data.exit_code,
            ...(event.data.error_code === undefined
              ? {}
              : { reasonCode: event.data.error_code }),
            stepId: String(event.data.step),
            terminalKind: event.data.termination,
            timedOut: event.data.termination === "timeout",
          }),
          type: "command_terminal",
        },
      ]);
    case "mcp.tool.call.completed":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.call_id,
            stepId: String(event.data.step),
            terminalKind: event.data.status,
            timedOut: false,
            toolName: event.data.model_tool_name,
          }),
          type: "mcp_terminal",
        },
      ]);
    case "mcp.tool.call.effect_unknown":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            callId: event.data.call_id,
            reasonCode: event.data.code,
            stepId: String(event.data.step),
            terminalKind: "effect_unknown",
            timedOut: event.data.code.includes("cancelled"),
            toolName: event.data.model_tool_name,
          }),
          type: "mcp_terminal",
        },
      ]);
    case "context.plan.created":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            digest: event.data.canonical_context_sha256,
            inputCount: event.data.included_item_ids.length + event.data.archived_item_ids.length,
            keptCount: event.data.included_item_ids.length,
            stepId: String(event.data.step),
          }),
          type: "context_plan_created",
        },
      ]);
    case "context.compaction.failed":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            inputCount: 0,
            keptCount: 0,
            overflowReason: event.data.reason,
            stepId: String(event.data.step),
          }),
          type: "context_plan_created",
        },
      ]);
    case "resume.pending_call.adopted":
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            adoptedRunId: event.data.source_run_id,
            callId: event.data.call_id,
            recoveryStatus: "pending_call_adopted",
            stepId: String(event.data.step),
          }),
          type: "resume_adopted",
        },
      ]);
    default: {
      const kind = terminalKind(event);
      if (kind === null) return Object.freeze([safeRawFact(event)]);
      const reason = terminalReason(event);
      return Object.freeze([
        {
          fields: Object.freeze({
            ...common,
            ...(reason === undefined ? {} : { reasonCode: reason }),
            stepId: "run",
            terminalKind: kind,
          }),
          type: "run_terminal",
        },
      ]);
    }
  }
}

function reportedUsage(events: readonly DecodedStoredEvent[]): ReportedTokenUsage {
  const usages = events.filter(
    (event): event is Extract<DecodedRunEvent, { type: "model.usage" }> =>
      event.scope === "run" && event.type === "model.usage",
  );
  if (usages.length === 0) {
    return Object.freeze({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      completeness: "none",
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    });
  }
  const nullableSum = (
    select: (event: (typeof usages)[number]) => number | null,
  ): number | null => {
    const values = usages.map(select);
    return values.some((value) => value === null)
      ? null
      : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  };
  return Object.freeze({
    cacheReadTokens: nullableSum((event) =>
      isPhase8ModelUsageData(event.data)
        ? event.data.cache_read_tokens
        : (event.data.cached_input_tokens ?? 0),
    ),
    cacheWriteTokens: nullableSum((event) =>
      isPhase8ModelUsageData(event.data) ? event.data.cache_write_tokens : null,
    ),
    completeness: usages.every(
      (event) =>
        isPhase8ModelUsageData(event.data) &&
        event.data.completeness === "complete",
    )
      ? "complete"
      : "partial",
    inputTokens: nullableSum((event) => event.data.input_tokens),
    outputTokens: nullableSum((event) => event.data.output_tokens),
    reasoningTokens: null,
    totalTokens: nullableSum((event) => event.data.total_tokens),
  });
}

function failureEvidence(
  events: readonly DecodedStoredEvent[],
  secondaryCodes: readonly string[],
): AttemptFailureEvidence {
  const runEvents = events.filter(
    (event): event is DecodedRunEvent => event.scope === "run",
  );
  const context = runEvents.some(
    (event) =>
      (event.type === "run.budget_exceeded" &&
        event.data.reason.startsWith("context_")) ||
      event.type === "context.compaction.failed",
  );
  const permission = runEvents.some(
    (event) =>
      (event.type === "approval.decided" ||
        event.type === "mcp.approval.decided") &&
      event.data.decision !== "approved",
  );
  const completion = runEvents.some((event) => event.type === "run.incomplete");
  const tool = runEvents.some(
    (event) =>
      event.type === "mcp.tool.call.effect_unknown" ||
      (event.type === "run.failed" &&
        ["ambiguous_command_state", "ambiguous_mcp_state", "ambiguous_patch_state"].includes(
          event.data.code,
        )),
  );
  return Object.freeze({
    ...(completion ? { completion: true } : {}),
    ...(context ? { context: true } : {}),
    ...(permission ? { permission: true } : {}),
    ...(tool ? { tool: true } : {}),
    ...(secondaryCodes.length === 0
      ? {}
      : { secondaryCodes: Object.freeze([...new Set(secondaryCodes)]) }),
  });
}

export interface EvalSessionEvidence {
  readonly decoded: readonly DecodedStoredEvent[];
  readonly events: readonly PersistedEvalEvent[];
  readonly evidence: AttemptFailureEvidence;
  readonly usage: ReportedTokenUsage;
}

export async function collectEvalSessionEvidence(
  sessionPaths: readonly string[],
  secondaryCodes: readonly string[] = [],
): Promise<EvalSessionEvidence> {
  const decodedById = new Map<string, DecodedStoredEvent>();
  for (const sessionPath of [...new Set(sessionPaths)].sort()) {
    for (const event of await readStoredSession(sessionPath)) {
      decodedById.set(event.eventId, event);
    }
  }
  const decoded = Object.freeze(
    [...decodedById.values()].sort((left, right) =>
      `${left.sessionId}:${String(left.sessionSeq).padStart(12, "0")}`.localeCompare(
        `${right.sessionId}:${String(right.sessionSeq).padStart(12, "0")}`,
      ),
    ),
  );
  let sequence = 0;
  const events = Object.freeze(
    decoded.flatMap((event) =>
      projectEvent(event).map((projection): PersistedEvalEvent =>
        Object.freeze({
          durable: true,
          fields: projection.fields,
          sequence: (sequence += 1),
          type: projection.type,
        }),
      ),
    ),
  );
  return Object.freeze({
    decoded,
    events,
    evidence: failureEvidence(decoded, secondaryCodes),
    usage: reportedUsage(decoded),
  });
}
