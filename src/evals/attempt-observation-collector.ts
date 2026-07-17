import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";

const ALLOWED_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  run_started: ["runId", "stepId"],
  approval_decided: ["runId", "stepId", "callId", "decision", "decisionSource", "reasonCode"],
  tool_terminal: ["runId", "stepId", "callId", "toolOrigin", "toolName", "terminalKind", "reasonCode"],
  command_terminal: ["runId", "stepId", "callId", "terminalKind", "exitCode", "timedOut", "reasonCode"],
  mcp_terminal: ["runId", "stepId", "callId", "toolName", "terminalKind", "timedOut", "reasonCode"],
  context_plan_created: ["runId", "stepId", "inputCount", "keptCount", "digest", "overflowReason"],
  resume_adopted: ["runId", "stepId", "adoptedRunId", "recoveryStatus", "reasonCode"],
  run_terminal: ["runId", "stepId", "terminalKind", "reasonCode"],
});

export interface PersistedEvalEvent {
  readonly sequence: number;
  readonly durable: boolean;
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface EvalObservationProjection {
  readonly observationSchemaVersion: 1;
  readonly observations: readonly Readonly<Record<string, unknown>>[];
  readonly observationsSha256: string;
}

function isAllowedScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function collectTerminalEvalObservations(
  scenarioTerminal: boolean,
  events: readonly PersistedEvalEvent[],
): EvalObservationProjection {
  if (!scenarioTerminal) {
    throw new EvalCoreError("eval_observation_invalid", "observations cannot be projected before scenario terminal", 1);
  }
  const sequences = new Set<number>();
  const observations: Readonly<Record<string, unknown>>[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.durable || sequences.has(event.sequence)) {
      throw new EvalCoreError("eval_observation_invalid", "observation input must be unique durable events", 1);
    }
    sequences.add(event.sequence);
    const allowlist = ALLOWED_EVENT_FIELDS[event.type];
    if (allowlist === undefined) continue;
    const projected: Record<string, unknown> = { eventType: event.type, order: event.sequence };
    for (const field of allowlist) {
      const value = event.fields[field];
      if (value !== undefined) {
        if (!isAllowedScalar(value)) {
          throw new EvalCoreError("eval_observation_invalid", `non-scalar allowlisted field: ${field}`, 1);
        }
        projected[field] = value;
      }
    }
    observations.push(Object.freeze(projected));
  }
  const body = { observationSchemaVersion: 1 as const, observations: Object.freeze(observations) };
  // PHASE14: projection happens only after the scenario ends, keeps an explicit event-field allowlist, and is never returned to the model or later steps.
  return Object.freeze({ ...body, observationsSha256: sha256Canonical(body) });
}
