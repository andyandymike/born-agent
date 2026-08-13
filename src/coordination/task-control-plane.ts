import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type {
  Phase16TaskSessionEventData,
  Phase16TaskSessionEventType,
} from "./task-event-schema.js";
import type { TaskStateProjection } from "./task-state-types.js";
import {
  reconstructMultiRunSession,
  type ReconstructedMultiRunSession,
} from "../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type {
  ApplicationCommitBindingV1,
  PersistedUserActionOriginV2,
  SurfaceIdentityV1,
} from "../control-plane/application-protocol.js";

export interface AuthenticatedTaskMutationBindingV1 {
  readonly actionIdentitySha256: string;
  readonly applicationCommit: ApplicationCommitBindingV1;
  readonly authenticationId: string;
  readonly requestId: string;
  readonly surface: SurfaceIdentityV1;
}

export interface TaskMutationContext {
  /** PHASE21: Host-built application authority for new surface mutations. */
  readonly authenticatedApplication?: AuthenticatedTaskMutationBindingV1;
  /** TUI-only optimistic binding, rechecked after the writer lock is held. */
  readonly expectedSessionSeq?: number;
  readonly inputSurface: "cli" | "tui";
  readonly now: () => string;
  readonly randomUuid: () => string;
  readonly sessionId: string;
  readonly workspace: string;
}

export function persistedTaskUserOrigin(
  inputSurface: "cli" | "tui",
  binding?: AuthenticatedTaskMutationBindingV1,
): PersistedUserActionOriginV2 {
  if (binding === undefined) {
    return Object.freeze({ input_surface: inputSurface, kind: "user" });
  }
  if (binding.surface.surface !== inputSurface) {
    throw new TaskControlPlaneError("stale_snapshot", "authenticated application surface does not match mutation context");
  }
  return Object.freeze({
    action_identity_sha256: binding.actionIdentitySha256,
    application_commit: Object.freeze({
      action_kind: binding.applicationCommit.actionKind,
      authorization_decision_sha256: binding.applicationCommit.authorizationDecisionSha256,
      operation_id: binding.applicationCommit.operationId,
      prepared_action_sha256: binding.applicationCommit.preparedActionSha256,
      principal_id: binding.applicationCommit.principalId,
      schema_version: 1,
    }),
    authentication_id: binding.authenticationId,
    client_id: binding.surface.clientId,
    kind: "authenticated_surface",
    request_id: binding.requestId,
    surface: binding.surface.surface,
  });
}

export function taskUserOrigin(context: TaskMutationContext): PersistedUserActionOriginV2 {
  return persistedTaskUserOrigin(context.inputSurface, context.authenticatedApplication);
}

export type TaskControlPlaneErrorCode =
  | "active_goal_conflict"
  | "goal_not_found"
  | "goal_stale"
  | "goal_terminal"
  | "legacy_goal_required"
  | "parent_goal_invalid"
  | "plan_draft_conflict"
  | "plan_not_found"
  | "plan_stale"
  | "session_effect_reconciliation_required"
  | "stale_snapshot"
  | "task_identity_allocation_failed";

export class TaskControlPlaneError extends Error {
  override readonly name = "TaskControlPlaneError";

  constructor(
    readonly code: TaskControlPlaneErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TaskMutationBlocker {
  readonly code: "session_effect_reconciliation_required";
  readonly details: readonly string[];
}

function key(runId: string, localId: string): string {
  return `${runId}\u0000${localId}`;
}

/**
 * A control-plane mutation cannot cross an unresolved side-effect boundary.
 * The last run is authoritative because Phase 9 adoption re-expresses an
 * inherited call in that run before recovery continues.
 */
export function taskMutationBlocker(
  session: ReconstructedMultiRunSession,
  options: {
    readonly ignorePendingToolCall?: {
      readonly callId: string;
      readonly runId: string;
    };
  } = {},
): TaskMutationBlocker | null {
  if (session.lastRun === null) return null;

  const calls = new Set<string>();
  const commands = new Set<string>();
  const patches = new Set<string>();
  const mcpCalls = new Set<string>();
  const mcpServers = new Set<string>();
  const hookCommands = new Set<string>();
  let cancelBarrier = false;

  for (const event of session.lastRun.events) {
    switch (event.type) {
      case "run.cancel.requested":
        cancelBarrier = true;
        break;
      case "run.budget_exceeded":
      case "run.cancelled":
      case "run.completed":
      case "run.failed":
      case "run.incomplete":
        cancelBarrier = false;
        break;
      case "tool.call.requested":
      case "resume.pending_call.adopted":
        if (
          options.ignorePendingToolCall?.runId !== event.runId ||
          options.ignorePendingToolCall.callId !== event.data.call_id
        ) {
          calls.add(key(event.runId, event.data.call_id));
        }
        break;
      case "tool.call.completed":
      case "tool.call.recovered":
        calls.delete(key(event.runId, event.data.call_id));
        break;
      case "command.execution.requested":
      case "command.started":
        commands.add(key(event.runId, event.data.execution_id));
        break;
      case "command.completed":
        if (
          event.data.cleanup_verified &&
          event.data.termination !== "cleanup_failed"
        ) {
          commands.delete(key(event.runId, event.data.execution_id));
        }
        break;
      case "patch.apply.started":
        patches.add(key(event.runId, event.data.plan_id));
        break;
      case "patch.apply.completed":
        patches.delete(key(event.runId, event.data.plan_id));
        break;
      case "mcp.server.start.requested":
      case "mcp.server.start.effect_unknown":
      case "mcp.server.started":
        mcpServers.add(key(event.runId, event.data.server_id));
        break;
      case "mcp.server.start.failed":
      case "mcp.server.stopped":
        mcpServers.delete(key(event.runId, event.data.server_id));
        break;
      case "mcp.tool.call.started":
      case "mcp.tool.call.effect_unknown":
        mcpCalls.add(key(event.runId, event.data.call_id));
        break;
      case "mcp.tool.call.completed":
        mcpCalls.delete(key(event.runId, event.data.call_id));
        break;
      case "hook.invocation.requested":
        if (event.data.handler === "command") {
          hookCommands.add(key(event.runId, event.data.invocation_id));
        }
        break;
      case "hook.invocation.decided":
      case "hook.invocation.completed":
        hookCommands.delete(key(event.runId, event.data.invocation_id));
        break;
      case "hook.invocation.failed":
        if (event.data.effect_state === "none") {
          hookCommands.delete(key(event.runId, event.data.invocation_id));
        } else {
          hookCommands.add(key(event.runId, event.data.invocation_id));
        }
        break;
      default:
        break;
    }
  }

  const details = [
    ...(calls.size === 0 ? [] : [`pending_tool_calls=${String(calls.size)}`]),
    ...(commands.size === 0
      ? []
      : [`unknown_commands=${String(commands.size)}`]),
    ...(patches.size === 0
      ? []
      : [`pending_patches=${String(patches.size)}`]),
    ...(mcpCalls.size === 0
      ? []
      : [`unknown_mcp_calls=${String(mcpCalls.size)}`]),
    ...(mcpServers.size === 0
      ? []
      : [`unknown_mcp_servers=${String(mcpServers.size)}`]),
    ...(hookCommands.size === 0
      ? []
      : [`unknown_hook_commands=${String(hookCommands.size)}`]),
    ...(cancelBarrier ? ["pending_run_cancel=1"] : []),
  ];
  return details.length === 0
    ? null
    : Object.freeze({
        code: "session_effect_reconciliation_required",
        details: Object.freeze(details),
      });
}

export interface LockedTaskMutationSession {
  readonly session: ReconstructedMultiRunSession;
  readonly state: TaskStateProjection;
  append<TType extends Phase16TaskSessionEventType>(
    type: TType,
    data: Phase16TaskSessionEventData<TType>,
  ): Promise<{
    readonly event: DecodedStoredEvent;
    readonly session: ReconstructedMultiRunSession;
    readonly state: TaskStateProjection;
  }>;
}

export type TaskMutationWriterFactory = (
  context: TaskMutationContext,
) => Promise<V2SessionWriter>;

/**
 * PHASE21: an ApplicationService action may hold the one authoritative writer
 * while invoking an existing domain owner that normally owns and closes the
 * writer returned by its factory. This explicit borrowed lease preserves that
 * ownership boundary: every operation is bound to the real writer, while the
 * nested owner's close is a no-op and only the Host releases the lock.
 */
export function borrowedTaskMutationWriterFactory(
  writer: V2SessionWriter,
): TaskMutationWriterFactory {
  const borrowed = new Proxy(writer, {
    get: (target, property) => {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return async (context) => {
    if (writer.isClosed() || writer.readDurableTailIdentity().sessionId !== context.sessionId) {
      throw new TaskControlPlaneError(
        "session_effect_reconciliation_required",
        "borrowed application writer is closed or belongs to another session",
      );
    }
    return borrowed;
  };
}

async function defaultWriterFactory(
  context: TaskMutationContext,
): Promise<V2SessionWriter> {
  return V2SessionWriter.openExisting(context.workspace, context.sessionId, {
    createEventId: context.randomUuid,
    timestamp: context.now,
  });
}

export async function withTaskMutation<T>(
  context: TaskMutationContext,
  operation: (locked: LockedTaskMutationSession) => Promise<T> | T,
  writerFactory: TaskMutationWriterFactory = defaultWriterFactory,
): Promise<T> {
  const writer = await writerFactory(context);
  try {
    const session = reconstructMultiRunSession(writer.events);
    if (
      context.expectedSessionSeq !== undefined &&
      session.taskState.lastSessionSeq !== context.expectedSessionSeq
    ) {
      throw new TaskControlPlaneError(
        "stale_snapshot",
        `session changed since the TUI snapshot (expected ${String(context.expectedSessionSeq)}, current ${String(session.taskState.lastSessionSeq)})`,
      );
    }
    const blocker = taskMutationBlocker(session);
    if (blocker !== null) {
      throw new TaskControlPlaneError(
        blocker.code,
        `session effect reconciliation is required (${blocker.details.join(", ")})`,
      );
    }
    const locked: LockedTaskMutationSession = {
      append: async (type, data) => {
        const event = await writer.appendTaskEvent(type, data);
        const nextSession = reconstructMultiRunSession(writer.events);
        return {
          event,
          session: nextSession,
          state: nextSession.taskState,
        };
      },
      session,
      state: session.taskState,
    };
    return await operation(locked);
  } finally {
    await writer.close();
  }
}

export function allocateTaskUuid(
  context: TaskMutationContext,
  used: ReadonlySet<string>,
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = context.randomUuid();
    if (candidate !== context.sessionId && !used.has(candidate)) {
      return candidate;
    }
  }
  throw new TaskControlPlaneError(
    "task_identity_allocation_failed",
    "could not allocate a unique task identity",
  );
}
