import {
  assertDecodedStoredEventInvariants,
  isDecodedTerminalRunEvent,
} from "../events/event-decoder-registry.js";
import {
  reconstructArtifactSessionLedger,
  type ArtifactSessionLedgerProjection,
} from "../artifacts/artifact-session-ledger.js";
import { assertPhase9RunEventSemantics } from "../events/phase9-run-event-semantics.js";
import { runEventSchema } from "../events/run-event-schema.js";
import type {
  CurrentRunStartedData,
  DecodedRunEvent,
  DecodedRunStartedEvent,
  DecodedSessionEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import type { RunEvent } from "../events/run-event.js";
import {
  PHASE16_RUN_BINDING_KEYS,
  phase16RunBindingSchema,
  stripPhase16RunBinding,
} from "../events/phase16-run-event-extension.js";
import { stripPhase20RunBinding } from "../events/phase20-run-event-extension.js";
import { TaskStateMachine } from "../coordination/task-state-machine.js";
import { TaskStateProjectionError } from "../coordination/task-state-error.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import { reconstructSession } from "./reconstruct-session.js";
import { projectGoalChangeLedger } from "../coordination/goal-change-ledger.js";
import { goalChangeAttributionScope } from "../coordination/goal-change-seed.js";
import {
  TaskGraphProjector,
  type TaskGraphProjectionV1,
} from "../task-graph/task-graph-projector.js";
import { TaskGraphError } from "../task-graph/task-graph-errors.js";
import {
  TaskExecutionProjector,
  type TaskExecutionProjectionV1,
} from "../scheduling/task-execution-projector.js";
import { WorktreeProjector, type WorktreeProjectionV1 } from "../worktrees/worktree-projector.js";
import { WorktreeError } from "../worktrees/worktree-errors.js";
import { BackgroundProjector, type BackgroundProjectionV1 } from "../background/background-projector.js";
import { BackgroundError } from "../background/background-errors.js";
import {
  DelegationProjector,
  type DelegationProjectionV1,
} from "../delegation/delegation-projector.js";
import { DelegationError } from "../delegation/delegation-errors.js";

export type ReconstructedRunStatus =
  | "budget_exceeded"
  | "cancelled"
  | "completed"
  | "failed"
  | "incomplete"
  | "interrupted";

export type DecodedTerminalRunEvent = Extract<
  DecodedRunEvent,
  {
    type:
      | "run.budget_exceeded"
      | "run.cancelled"
      | "run.completed"
      | "run.failed"
      | "run.incomplete";
  }
>;

export interface ReconstructedRunProjection {
  readonly endSessionSeq: number;
  readonly events: readonly DecodedRunEvent[];
  readonly resumeMode?: "canonical_degraded" | "exact";
  readonly resumeOfRunId?: string;
  readonly runId: string;
  readonly startSessionSeq: number;
  readonly started: DecodedRunStartedEvent;
  readonly status: ReconstructedRunStatus;
  readonly terminal?: DecodedTerminalRunEvent;
}

export interface ReconstructedMultiRunSession {
  readonly artifacts: ArtifactSessionLedgerProjection;
  readonly events: readonly DecodedStoredEvent[];
  readonly lastRun: ReconstructedRunProjection | null;
  readonly runs: readonly ReconstructedRunProjection[];
  readonly sessionEvents: readonly DecodedSessionEvent[];
  readonly sessionId: string;
  readonly status: ReconstructedRunStatus | "idle";
  readonly taskState: TaskStateProjection;
  readonly taskGraph: TaskGraphProjectionV1;
  readonly taskExecution: TaskExecutionProjectionV1 | null;
  readonly worktrees: WorktreeProjectionV1;
  readonly background: BackgroundProjectionV1;
  readonly delegations: DelegationProjectionV1;
}

interface MutableRunProjection {
  events: DecodedRunEvent[];
  started: DecodedRunStartedEvent;
  terminal?: DecodedTerminalRunEvent;
}

export class SessionProjectionError extends Error {
  public readonly code: string | undefined;

  public constructor(
    message: string,
    options: ErrorOptions & { readonly code?: string } = {},
  ) {
    super(message, options);
    this.name = "SessionProjectionError";
    this.code = options.code;
  }
}

const NON_LEGACY_RUN_EVENT_TYPES = new Set<string>([
  "goal.change.recorded",
  "goal.execution.baseline.captured",
  "hook.invocation.completed",
  "hook.invocation.decided",
  "hook.invocation.failed",
  "hook.invocation.requested",
  "hook.invocation.started",
  "hook.matched",
  "hook.permission.evaluated",
  "hook.approval.requested",
  "hook.approval.decided",
  "mcp.prompt.catalog.stale",
  "mcp.prompt.cataloged",
  "mcp.prompt.get.completed",
  "mcp.prompt.get.failed",
  "mcp.prompt.get.requested",
  "mcp.prompt.user.invoked",
  "mcp.resource.catalog.stale",
  "mcp.resource.cataloged",
  "mcp.resource.read.completed",
  "mcp.resource.read.failed",
  "mcp.resource.read.requested",
  "mcp.server.negotiated",
  "skill.activation.failed",
  "skill.activation.requested",
  "skill.activated",
  "skill.resource.read",
  "sandbox.container.cleaned",
  "sandbox.container.create.requested",
  "sandbox.container.created",
  "sandbox.container.exited",
  "sandbox.container.inspected",
  "sandbox.container.start.requested",
  "sandbox.container.started",
  "sandbox.container.stopping",
  "sandbox.snapshot.changed",
  "sandbox.snapshot.cleaned",
  "sandbox.snapshot.created",
  "artifact.capture.truncated",
  "artifact.stored",
  "backend.canonical_boundary.created",
  "backend.checkpoint.created",
  "context.compaction.failed",
  "context.compaction.started",
  "context.estimate.created",
  "context.plan.created",
  "model.request.encoded",
  "mcp.approval.decided",
  "mcp.approval.requested",
  "mcp.catalog.changed",
  "mcp.catalog.discovered",
  "mcp.permission.evaluated",
  "mcp.server.start.effect_unknown",
  "mcp.server.start.failed",
  "mcp.server.start.requested",
  "mcp.server.started",
  "mcp.server.stderr",
  "mcp.server.stopped",
  "mcp.server.stopping",
  "mcp.tool.call.completed",
  "mcp.tool.call.effect_unknown",
  "mcp.tool.call.started",
  "repository.rules.changed",
  "repository.rules.loaded",
  "repository.rules.manifest.loaded",
  "repository.source.snapshot.captured",
  "repository.index.invalidated",
  "repository.index.selected",
  "resume.pending_call.adopted",
  "tool.call.recovered",
]);

function syntheticEventId(events: readonly RunEvent[]): string {
  const existing = new Set(events.map((event) => event.event_id));
  for (let suffix = 0; suffix < 1_000_000; suffix += 1) {
    const candidate = `ffffffff-ffff-4fff-8fff-${String(suffix).padStart(12, "0")}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new SessionProjectionError("could not allocate an in-memory validation event id");
}

function toLegacyDomainEvent(
  event: DecodedRunEvent,
  seq: number,
  runs: ReadonlyMap<string, MutableRunProjection>,
): RunEvent | undefined {
  if (event.type === "resume.pending_call.adopted") {
    const source = runs.get(event.data.source_run_id);
    const requested = source?.events.find(
      (candidate) =>
        candidate.type === "tool.call.requested" &&
        candidate.data.call_id === event.data.source_call_id,
    );
    if (requested?.type !== "tool.call.requested") {
      throw new SessionProjectionError(
        "adopted call has no recoverable source request",
      );
    }
    return runEventSchema.parse({
      data: {
        ...requested.data,
        call_id: event.data.call_id,
      },
      event_id: event.eventId,
      run_id: event.runId,
      schema_version: 1,
      seq,
      session_id: event.sessionId,
      timestamp: event.timestamp,
      type: "tool.call.requested",
    });
  }
  if (NON_LEGACY_RUN_EVENT_TYPES.has(event.type)) return undefined;
  return runEventSchema.parse({
    data:
      event.type === "run.started"
        ? stripPhase16RunBinding(stripPhase20RunBinding(event.data))
        : event.type === "run.completed" &&
            event.data.completion_mode === "plan_ready"
          ? { ...event.data, completion_mode: "model_final" }
        : event.data,
    event_id: event.eventId,
    run_id: event.runId,
    schema_version: 1,
    seq,
    session_id: event.sessionId,
    timestamp: event.timestamp,
    type: event.type,
  });
}

function assertV2BackendBoundary(events: readonly DecodedRunEvent[]): void {
  const started = events[0];
  if (started?.type !== "run.started" || started.sourceSchemaVersion !== 2) {
    return;
  }
  const next = events[1];
  // A process can die after durably writing run.started but before selection.
  // Once any later fact exists, however, v2 cannot masquerade as a legacy run
  // whose missing backend.selected was tolerated only for Phase 0-7 history.
  if (next !== undefined && next.type !== "backend.selected") {
    throw new SessionProjectionError(
      "schema v2 backend.selected must immediately follow run.started",
    );
  }
}

function validateRunDomainSemantics(
  runId: string,
  events: readonly DecodedRunEvent[],
  terminal: DecodedTerminalRunEvent | undefined,
  runs: ReadonlyMap<string, MutableRunProjection>,
  allEvents: readonly DecodedStoredEvent[],
): void {
  assertV2BackendBoundary(events);
  const domainEvents: RunEvent[] = [];
  for (const event of events) {
    const converted = toLegacyDomainEvent(
      event,
      domainEvents.length + 1,
      runs,
    );
    if (converted !== undefined) domainEvents.push(converted);
  }
  if (domainEvents.length === 0) {
    throw new SessionProjectionError(`run ${runId} contains no domain events`);
  }
  if (terminal === undefined) {
    const first = domainEvents[0];
    const last = domainEvents.at(-1);
    if (first === undefined || last === undefined) {
      throw new SessionProjectionError(`run ${runId} contains no domain events`);
    }
    domainEvents.push({
      data: {
        category: "internal",
        code: "interrupted_prefix_validation",
        duration_ms: 0,
        message: "in-memory interrupted prefix validation",
        retryable: false,
      },
      event_id: syntheticEventId(domainEvents),
      run_id: first.run_id,
      schema_version: 1,
      seq: domainEvents.length + 1,
      session_id: first.session_id,
      timestamp: last.timestamp,
      type: "run.failed",
    });
  }
  try {
    const started = events[0];
    const bindingCandidate = Object.fromEntries(
      PHASE16_RUN_BINDING_KEYS.flatMap((key) =>
        started?.type === "run.started" && Object.hasOwn(started.data, key)
          ? [[key, started.data[key]]]
          : [],
      ),
    );
    const binding = phase16RunBindingSchema.safeParse(bindingCandidate);
    const lastSessionSeq = events.at(-1)?.sessionSeq ?? 0;
    const completionAttribution =
      binding.success && binding.data.agent_mode === "build"
        ? (() => {
            const ledger = projectGoalChangeLedger(
              allEvents.filter((event) => event.sessionSeq <= lastSessionSeq),
              binding.data.goal_id,
              binding.data.goal_revision,
            );
            if (ledger === null) {
              const isPreBaselineCrashPrefix =
                terminal === undefined &&
                events.every(
                  (event) =>
                    event.type === "run.started" ||
                    event.type === "backend.selected",
                );
              if (isPreBaselineCrashPrefix) return undefined;
              throw new SessionProjectionError(
                `run ${runId} has no durable Goal execution baseline`,
              );
            }
            return {
              changedPaths: ledger.netChangedPaths,
              scope: goalChangeAttributionScope(ledger),
            };
          })()
        : undefined;
    // PHASE9: envelope continuity is insufficient for resume. Reusing the
    // original reconstructor proves command/patch/tool/approval pairings for
    // every run. The synthetic failure exists only in memory so a legal crash
    // tail can be checked without inventing a persisted terminal fact.
    reconstructSession(domainEvents, {
      ...(binding.success ? { agentMode: binding.data.agent_mode } : {}),
      ...(completionAttribution === undefined
        ? {}
        : { completionAttribution }),
      inheritedCallIds: new Set(
        events
          .filter(
            (event): event is Extract<
              DecodedRunEvent,
              { type: "resume.pending_call.adopted" }
            > => event.type === "resume.pending_call.adopted",
          )
          .map((event) => event.data.call_id),
      ),
      recoveredCallIds: new Set(
        events
          .filter(
            (event): event is Extract<
              DecodedRunEvent,
              { type: "tool.call.recovered" }
            > => event.type === "tool.call.recovered",
          )
          .map((event) => event.data.call_id),
      ),
    });
  } catch (error) {
    throw new SessionProjectionError(
      `run ${runId} violates domain semantics: ${
        error instanceof Error ? error.message : "unknown reconstruction error"
      }`,
      { cause: error },
    );
  }
}

function terminalStatus(
  event: DecodedTerminalRunEvent,
): Exclude<ReconstructedRunStatus, "interrupted"> {
  switch (event.type) {
    case "run.budget_exceeded":
      return "budget_exceeded";
    case "run.cancelled":
      return "cancelled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.incomplete":
      return "incomplete";
  }
}

function resumeMetadata(data: CurrentRunStartedData):
  | {
      readonly resumeMode: "canonical_degraded" | "exact";
      readonly resumeOfRunId: string;
    }
  | undefined {
  if (data.resume_of_run_id === undefined || data.resume_mode === undefined) {
    return undefined;
  }
  return {
    resumeMode: data.resume_mode,
    resumeOfRunId: data.resume_of_run_id,
  };
}

function delegatedChildParentRunId(data: CurrentRunStartedData): string | undefined {
  const binding = (data as Readonly<Record<string, unknown>>).delegated_child_binding;
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return undefined;
  const parentRunId = (binding as Readonly<Record<string, unknown>>).parent_run_id;
  return typeof parentRunId === "string" ? parentRunId : undefined;
}

function sourceRunId(event: DecodedStoredEvent): string | undefined {
  switch (event.type) {
    case "approval.expired":
    case "resume.pending_call.adopted":
    case "session.resume.requested":
    case "side_effect.reconciled":
    case "tool.call.recovered":
      return event.data.source_run_id;
    default:
      return undefined;
  }
}

function assertPriorRunReference(
  event: DecodedStoredEvent,
  knownRunIds: ReadonlySet<string>,
): void {
  const source = sourceRunId(event);
  if (source === undefined) return;
  if (!knownRunIds.has(source)) {
    throw new SessionProjectionError(
      `${event.type} references unknown source run ${source}`,
    );
  }
  if (event.scope === "run" && event.runId === source) {
    throw new SessionProjectionError(
      `${event.type} cannot adopt facts from its own run`,
    );
  }
}

export function reconstructMultiRunSession(
  events: readonly DecodedStoredEvent[],
): ReconstructedMultiRunSession {
  if (events.length === 0) {
    throw new SessionProjectionError("cannot reconstruct an empty session");
  }
  assertDecodedStoredEventInvariants(events);
  // PHASE9: replay must enforce the identical checkpoint/adoption semantics
  // used before append; otherwise a hand-edited but schema-valid log could
  // acquire resume authority that the online writer would have rejected.
  assertPhase9RunEventSemantics(events);
  const sessionId = events[0]?.sessionId ?? "";
  const artifacts = reconstructArtifactSessionLedger(events, sessionId);

  const mutableRuns = new Map<string, MutableRunProjection>();
  const runOrder: string[] = [];
  const sessionEvents: DecodedSessionEvent[] = [];
  const knownRunIds = new Set<string>();

  for (const event of events) {
    assertPriorRunReference(event, knownRunIds);
    if (event.scope === "session") {
      sessionEvents.push(event);
      continue;
    }

    if (event.type === "run.started") {
      const metadata = resumeMetadata(event.data);
      const delegatedParentRunId = delegatedChildParentRunId(event.data);
      if (delegatedParentRunId !== undefined && metadata !== undefined) {
        throw new SessionProjectionError(
          "delegated child run cannot also claim ordinary resume authority",
        );
      }
      if (delegatedParentRunId !== undefined) {
        const durableStart = sessionEvents.find((candidate) =>
          candidate.type === "delegation.child.started" &&
          candidate.data.child_run_id === event.runId &&
          candidate.data.parent_run_id === delegatedParentRunId);
        if (durableStart === undefined || delegatedParentRunId === event.runId) {
          throw new SessionProjectionError(
            "delegated child run has no exact prior Host child-start fact",
          );
        }
      }
      if (runOrder.length === 0 && metadata !== undefined) {
        throw new SessionProjectionError(
          "the first run in a session cannot resume an unseen run",
        );
      }
      if (runOrder.length > 0) {
        if (metadata === undefined && delegatedParentRunId === undefined) {
          throw new SessionProjectionError(
            "every later run must declare resume_of_run_id and resume_mode",
          );
        }
        if (metadata !== undefined && !knownRunIds.has(metadata.resumeOfRunId)) {
          throw new SessionProjectionError(
            `run.started references unknown resume source ${metadata.resumeOfRunId}`,
          );
        }
      }
      mutableRuns.set(event.runId, { events: [event], started: event });
      runOrder.push(event.runId);
      knownRunIds.add(event.runId);
      continue;
    }

    const run = mutableRuns.get(event.runId);
    if (run === undefined) {
      throw new SessionProjectionError(
        `run ${event.runId} has no run.started event`,
      );
    }
    run.events.push(event);
    if (isDecodedTerminalRunEvent(event)) run.terminal = event;
  }

  for (const [runId, run] of mutableRuns) {
    validateRunDomainSemantics(
      runId,
      run.events,
      run.terminal,
      mutableRuns,
      events,
    );
  }

  const runs = runOrder.map((runId): ReconstructedRunProjection => {
    const run = mutableRuns.get(runId);
    if (run === undefined) {
      throw new SessionProjectionError(`missing projection for run ${runId}`);
    }
    const lastEvent = run.events.at(-1);
    if (lastEvent === undefined) {
      throw new SessionProjectionError(`run ${runId} contains no events`);
    }
    const metadata = resumeMetadata(run.started.data);
    return {
      endSessionSeq: lastEvent.sessionSeq,
      events: run.events,
      ...(metadata === undefined
        ? {}
        : {
            resumeMode: metadata.resumeMode,
            resumeOfRunId: metadata.resumeOfRunId,
          }),
      runId,
      startSessionSeq: run.started.sessionSeq,
      started: run.started,
      // PHASE9: a crash is a fact about the old process boundary. Projection
      // marks an unterminated run interrupted; it never appends a fake terminal.
      status:
        run.terminal === undefined
          ? "interrupted"
          : terminalStatus(run.terminal),
      ...(run.terminal === undefined ? {} : { terminal: run.terminal }),
    };
  });
  const lastRun = runs.at(-1) ?? null;

  let taskState: TaskStateProjection;
  try {
    taskState = TaskStateMachine.project(events);
  } catch (error) {
    if (error instanceof TaskStateProjectionError) {
      throw new SessionProjectionError(
        `task state projection failed at session_seq ${error.sessionSeq} (${error.eventType}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  let taskGraph: TaskGraphProjectionV1;
  try {
    taskGraph = TaskGraphProjector.project(events);
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw new SessionProjectionError(
        `task Graph projection failed (${error.code}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  let taskExecution: TaskExecutionProjectionV1 | null;
  try {
    taskExecution = TaskExecutionProjector.project(events);
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw new SessionProjectionError(
        `task execution projection failed (${error.code}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  let worktrees: WorktreeProjectionV1;
  try {
    worktrees = WorktreeProjector.project(events);
  } catch (error) {
    if (error instanceof WorktreeError) {
      throw new SessionProjectionError(
        `worktree projection failed (${error.code}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  let background: BackgroundProjectionV1;
  try {
    background = BackgroundProjector.project(events);
  } catch (error) {
    if (error instanceof BackgroundError) {
      throw new SessionProjectionError(
        `background worker projection failed (${error.code}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  let delegations: DelegationProjectionV1;
  try {
    delegations = DelegationProjector.project(events);
  } catch (error) {
    if (error instanceof DelegationError) {
      throw new SessionProjectionError(
        `delegation projection failed (${error.code}): ${error.message}`,
        { cause: error, code: error.code },
      );
    }
    throw error;
  }

  if (
    lastRun === null &&
    (taskState.trackingMode !== "phase16" || taskState.goals.length === 0)
  ) {
    throw new SessionProjectionError(
      "runless session must contain a durable Phase 16 Goal",
    );
  }

  return {
    background,
    delegations,
    artifacts,
    events,
    lastRun,
    runs,
    sessionEvents,
    sessionId,
    status: lastRun?.status ?? "idle",
    taskGraph,
    taskExecution,
    taskState,
    worktrees,
  };
}
