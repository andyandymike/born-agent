import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";

const READ_TOOL_ALLOWLIST = new Set([
  "list_files",
  "read_artifact",
  "read_file",
  "search",
]);

export interface EvidenceRunBinding {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly mode: "build" | "unknown";
}

export interface PlanItemEvidenceContext {
  readonly eventsById: ReadonlyMap<string, DecodedStoredEvent>;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly runBindings: ReadonlyMap<string, EvidenceRunBinding>;
}

export interface PlanItemEvidenceClassification {
  readonly eligibleForBlocked: boolean;
  readonly eligibleForCompleted: boolean;
}

const INELIGIBLE: PlanItemEvidenceClassification = Object.freeze({
  eligibleForBlocked: false,
  eligibleForCompleted: false,
});

function matchingRunBinding(
  runId: string,
  context: PlanItemEvidenceContext,
): EvidenceRunBinding | undefined {
  const binding = context.runBindings.get(runId);
  if (
    binding?.goalId !== context.goalId ||
    binding.goalRevision !== context.goalRevision
  ) {
    return undefined;
  }
  return binding;
}

function authorizedReadArtifact(
  event: Extract<DecodedRunEvent, { type: "artifact.stored" }>,
  context: PlanItemEvidenceContext,
): boolean {
  const origin = context.eventsById.get(event.data.origin_event_id);
  if (
    origin === undefined ||
    origin.scope !== "run" ||
    origin.runId !== event.runId ||
    origin.sessionSeq >= event.sessionSeq
  ) {
    return false;
  }
  if (
    origin.type !== "tool.call.requested" &&
    origin.type !== "resume.pending_call.adopted"
  ) {
    return false;
  }
  return READ_TOOL_ALLOWLIST.has(origin.data.tool_name);
}

export function classifyPlanItemEvidence(
  event: DecodedStoredEvent,
  context: PlanItemEvidenceContext,
): PlanItemEvidenceClassification {
  // PHASE16: this switch is deliberately closed. Prose, approvals, update_plan
  // receipts, and future event types cannot recursively prove Todo progress.
  if (event.type === "side_effect.reconciled") {
    if (
      event.data.observed !== "applied" ||
      matchingRunBinding(event.data.source_run_id, context) === undefined
    ) {
      return INELIGIBLE;
    }
    return Object.freeze({
      eligibleForBlocked: true,
      eligibleForCompleted: true,
    });
  }

  if (event.scope === "session" && event.type === "task_node.attempt.terminal") {
    if (event.data.terminal !== "succeeded") return INELIGIBLE;
    const revision = [...context.eventsById.values()].find((candidate) =>
      candidate.scope === "session" &&
      (candidate.type === "task_graph.proposed" || candidate.type === "task_graph.replaced") &&
      candidate.data.graph_id === event.data.graph_id &&
      candidate.data.graph_revision === event.data.graph_revision &&
      candidate.data.graph_sha256 === event.data.graph_sha256
    );
    if (
      revision === undefined || revision.scope !== "session" ||
      (revision.type !== "task_graph.proposed" && revision.type !== "task_graph.replaced") ||
      revision.data.binding.goal_id !== context.goalId || revision.data.binding.goal_revision !== context.goalRevision
    ) return INELIGIBLE;
    return Object.freeze({ eligibleForBlocked: true, eligibleForCompleted: true });
  }

  if (event.scope !== "run") return INELIGIBLE;
  const binding = matchingRunBinding(event.runId, context);
  if (binding === undefined) return INELIGIBLE;

  switch (event.type) {
    case "tool.call.completed": {
      if (!READ_TOOL_ALLOWLIST.has(event.data.tool_name)) return INELIGIBLE;
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted: event.data.status === "success",
      });
    }
    case "tool.call.recovered": {
      if (
        event.runId === event.data.source_run_id ||
        !READ_TOOL_ALLOWLIST.has(event.data.tool_name) ||
        matchingRunBinding(event.data.source_run_id, context) === undefined
      ) {
        return INELIGIBLE;
      }
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted: event.data.status === "success",
      });
    }
    case "patch.apply.completed":
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted: true,
      });
    case "command.completed":
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted:
          event.data.cleanup_verified &&
          event.data.exit_code === 0 &&
          event.data.termination === "exit",
      });
    case "verification.completed":
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted:
          event.data.status === "passed" && !event.data.stale,
      });
    case "artifact.stored": {
      const eligible = authorizedReadArtifact(event, context);
      return Object.freeze({
        eligibleForBlocked: eligible,
        eligibleForCompleted: eligible,
      });
    }
    case "mcp.tool.call.completed":
      if (binding.mode !== "build") return INELIGIBLE;
      return Object.freeze({
        eligibleForBlocked: true,
        eligibleForCompleted: event.data.status === "success",
      });
    case "mcp.tool.call.effect_unknown":
      return Object.freeze({
        eligibleForBlocked: binding.mode === "build",
        eligibleForCompleted: false,
      });
    default:
      return INELIGIBLE;
  }
}
