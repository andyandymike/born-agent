import type {
  DecodedRunEvent,
  DecodedSessionEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import type { PlanMutationControl } from "./agent-plan-store.js";
import {
  appliedPlanObservation,
  renderPlanToolObservation,
  type PlanToolObservation,
} from "./plan-tool-observation.js";
import {
  updatePlanInputSchema,
  type UpdatePlanInput,
} from "./update-plan-input-schema.js";

type RequestedEvent = Extract<
  DecodedRunEvent,
  { type: "tool.call.requested" }
>;
type ResultEvent = Extract<
  DecodedRunEvent,
  { type: "tool.call.completed" | "tool.call.recovered" }
>;
export type AppliedPlanMutationEvent = Extract<
  DecodedSessionEvent,
  {
    type: "plan.item.status_changed" | "plan.proposed" | "plan.revised";
  }
>;

export interface PlanMutationLedgerEntry {
  readonly appliedEvent: AppliedPlanMutationEvent | null;
  readonly control: PlanMutationControl | null;
  readonly input: UpdatePlanInput;
  readonly observation: PlanToolObservation | null;
  readonly request: RequestedEvent;
  readonly resultEvent: ResultEvent | null;
  readonly sourceRunId: string;
  readonly state: "requested" | "applied_without_result" | "closed";
}

export class PlanMutationLedgerError extends Error {
  override readonly name = "PlanMutationLedgerError";
}

interface MutableEntry {
  appliedEvent: AppliedPlanMutationEvent | null;
  input: UpdatePlanInput;
  request: RequestedEvent;
  resultEvent: ResultEvent | null;
}

function key(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

function operationMatchesEvent(
  input: UpdatePlanInput,
  event: AppliedPlanMutationEvent,
): boolean {
  return (
    (input.operation === "propose" && event.type === "plan.proposed") ||
    (input.operation === "revise" && event.type === "plan.revised") ||
    (input.operation === "set_item_status" &&
      event.type === "plan.item.status_changed")
  );
}

function sourceRunMode(
  events: readonly DecodedStoredEvent[],
  runId: string,
): "plan" | "build" | null {
  const started = events.find(
    (event) =>
      event.scope === "run" &&
      event.runId === runId &&
      event.type === "run.started",
  );
  if (started?.type !== "run.started") return null;
  const mode = (started.data as Readonly<Record<string, unknown>>).agent_mode;
  return mode === "plan" || mode === "build" ? mode : null;
}

function deriveControl(
  events: readonly DecodedStoredEvent[],
  entry: MutableEntry,
): PlanMutationControl | null {
  if (
    entry.input.operation !== "revise" ||
    entry.appliedEvent?.type !== "plan.revised" ||
    sourceRunMode(events, entry.request.runId) !== "build"
  ) {
    return null;
  }
  return Object.freeze({
    kind: "plan_revision_proposed",
    planId: entry.appliedEvent.data.content.planId,
    reason: "plan_approval_required",
    revision: entry.appliedEvent.data.content.revision,
    sha256: entry.appliedEvent.data.plan_sha256,
  });
}

function parseRequest(event: RequestedEvent): UpdatePlanInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data.arguments_json) as unknown;
  } catch (error) {
    throw new PlanMutationLedgerError(
      "durable update_plan request arguments are not JSON",
      { cause: error },
    );
  }
  const validated = updatePlanInputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new PlanMutationLedgerError(
      "durable update_plan request arguments violate the strict schema",
      { cause: validated.error },
    );
  }
  return validated.data;
}

function validateRejectedResult(
  input: UpdatePlanInput,
  result: ResultEvent,
): PlanToolObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data.output) as unknown;
  } catch (error) {
    throw new PlanMutationLedgerError(
      "rejected update_plan result is not JSON",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new PlanMutationLedgerError(
      "rejected update_plan result must be an object",
    );
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.operation !== input.operation ||
    value.status !== "rejected" ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    value.plan_id !== null ||
    value.revision !== null ||
    value.plan_sha256 !== null ||
    value.item_id !== null ||
    value.item_status !== null ||
    value.requires_user_approval !== false
  ) {
    throw new PlanMutationLedgerError(
      "rejected update_plan result violates the observation contract",
    );
  }
  const observation = value as unknown as PlanToolObservation;
  if (renderPlanToolObservation(observation) !== result.data.output) {
    throw new PlanMutationLedgerError(
      "rejected update_plan result is not canonical",
    );
  }
  return observation;
}

function validateEntry(
  events: readonly DecodedStoredEvent[],
  entry: MutableEntry,
): PlanMutationLedgerEntry {
  if (
    entry.appliedEvent !== null &&
    (!operationMatchesEvent(entry.input, entry.appliedEvent) ||
      entry.request.sessionSeq >= entry.appliedEvent.sessionSeq)
  ) {
    throw new PlanMutationLedgerError(
      "update_plan request and applied event do not match",
    );
  }
  let observation: PlanToolObservation | null = null;
  if (entry.appliedEvent !== null) {
    observation = appliedPlanObservation(
      entry.input.operation,
      entry.appliedEvent,
    );
  }
  if (entry.resultEvent !== null) {
    if (
      entry.appliedEvent !== null &&
      entry.resultEvent.sessionSeq <= entry.appliedEvent.sessionSeq
    ) {
      throw new PlanMutationLedgerError(
        "update_plan result precedes its applied event",
      );
    }
    if (entry.appliedEvent === null) {
      if (entry.resultEvent.data.status !== "error") {
        throw new PlanMutationLedgerError(
          "successful update_plan result has no applied event",
        );
      }
      observation = validateRejectedResult(entry.input, entry.resultEvent);
    } else if (
      entry.resultEvent.data.status !== "success" ||
      entry.resultEvent.data.output !== renderPlanToolObservation(observation!)
    ) {
      throw new PlanMutationLedgerError(
        "applied update_plan result does not match its durable observation",
      );
    }
  }
  return Object.freeze({
    appliedEvent: entry.appliedEvent,
    control: deriveControl(events, entry),
    input: entry.input,
    observation,
    request: entry.request,
    resultEvent: entry.resultEvent,
    sourceRunId: entry.request.runId,
    state:
      entry.resultEvent !== null
        ? "closed"
        : entry.appliedEvent === null
          ? "requested"
          : "applied_without_result",
  });
}

export function reconstructPlanMutationLedger(
  events: readonly DecodedStoredEvent[],
): readonly PlanMutationLedgerEntry[] {
  const entries = new Map<string, MutableEntry>();
  const adoptedToSource = new Map<string, string>();

  for (const event of events) {
    if (
      event.scope === "run" &&
      event.type === "tool.call.requested" &&
      event.data.tool_name === "update_plan"
    ) {
      const requestKey = key(event.runId, event.data.call_id);
      if (entries.has(requestKey)) {
        throw new PlanMutationLedgerError(
          "duplicate update_plan request identity",
        );
      }
      entries.set(requestKey, {
        appliedEvent: null,
        input: parseRequest(event),
        request: event,
        resultEvent: null,
      });
      continue;
    }
    if (
      event.scope === "run" &&
      event.type === "resume.pending_call.adopted" &&
      event.data.tool_name === "update_plan"
    ) {
      const sourceKey = key(
        event.data.source_run_id,
        event.data.source_call_id,
      );
      if (!entries.has(sourceKey)) {
        throw new PlanMutationLedgerError(
          "adopted update_plan call has no source request",
        );
      }
      adoptedToSource.set(key(event.runId, event.data.call_id), sourceKey);
      continue;
    }
    if (
      event.scope === "session" &&
      (event.type === "plan.proposed" ||
        event.type === "plan.revised" ||
        event.type === "plan.item.status_changed") &&
      event.data.origin.kind === "agent"
    ) {
      const sourceKey = key(
        event.data.origin.run_id,
        event.data.origin.call_id,
      );
      const entry = entries.get(sourceKey);
      if (entry === undefined) {
        throw new PlanMutationLedgerError(
          "agent Plan mutation has no matching update_plan request",
        );
      }
      if (entry.appliedEvent !== null) {
        throw new PlanMutationLedgerError(
          "one update_plan call has multiple applied events",
        );
      }
      entry.appliedEvent = event;
      continue;
    }
    if (
      event.scope === "run" &&
      (event.type === "tool.call.completed" ||
        event.type === "tool.call.recovered") &&
      event.data.tool_name === "update_plan"
    ) {
      const localKey = key(event.runId, event.data.call_id);
      const sourceKey = adoptedToSource.get(localKey) ?? localKey;
      const entry = entries.get(sourceKey);
      if (entry === undefined) {
        throw new PlanMutationLedgerError(
          "update_plan result has no matching request",
        );
      }
      if (entry.resultEvent !== null) {
        throw new PlanMutationLedgerError(
          "one update_plan call has multiple results",
        );
      }
      entry.resultEvent = event;
    }
  }

  return Object.freeze(
    [...entries.values()].map((entry) => validateEntry(events, entry)),
  );
}
