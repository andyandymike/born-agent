import type { CurrentVerificationCommandFact } from "../events/event-publisher.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import type { HookDurableFacts } from "./hook-runtime.js";

function key(runId: string, localId: string): string {
  return `${runId}\0${localId}`;
}

function unresolvedEffects(
  events: readonly DecodedStoredEvent[],
  runId: string,
): readonly string[] {
  const commands = new Set<string>();
  const patches = new Set<string>();
  const mcpCalls = new Set<string>();
  const mcpStarts = new Set<string>();
  const hookCommands = new Set<string>();
  const unknown: string[] = [];
  for (const event of events) {
    if (event.scope !== "run" || event.runId !== runId) continue;
    switch (event.type) {
      case "command.execution.requested":
      case "command.started":
        commands.add(key(runId, event.data.execution_id));
        break;
      case "command.completed":
        if (event.data.cleanup_verified && event.data.termination !== "cleanup_failed") {
          commands.delete(key(runId, event.data.execution_id));
        } else {
          unknown.push(`event:${event.eventId}`);
        }
        break;
      case "patch.apply.started":
        patches.add(key(runId, event.data.plan_id));
        break;
      case "patch.apply.completed":
        patches.delete(key(runId, event.data.plan_id));
        break;
      case "mcp.server.start.requested":
        mcpStarts.add(key(runId, event.data.server_id));
        break;
      case "mcp.server.started":
      case "mcp.server.start.failed":
        mcpStarts.delete(key(runId, event.data.server_id));
        break;
      case "mcp.server.start.effect_unknown":
        mcpStarts.add(key(runId, event.data.server_id));
        unknown.push(`event:${event.eventId}`);
        break;
      case "mcp.tool.call.started":
        mcpCalls.add(key(runId, event.data.call_id));
        break;
      case "mcp.tool.call.completed":
        mcpCalls.delete(key(runId, event.data.call_id));
        break;
      case "mcp.tool.call.effect_unknown":
        mcpCalls.add(key(runId, event.data.call_id));
        unknown.push(`event:${event.eventId}`);
        break;
      case "hook.invocation.requested":
        if (event.data.handler === "command") {
          hookCommands.add(key(runId, event.data.invocation_id));
        }
        break;
      case "hook.invocation.decided":
      case "hook.invocation.completed":
        hookCommands.delete(key(runId, event.data.invocation_id));
        break;
      case "hook.invocation.failed":
        if (event.data.effect_state === "none") {
          hookCommands.delete(key(runId, event.data.invocation_id));
        } else {
          hookCommands.add(key(runId, event.data.invocation_id));
          unknown.push(`event:${event.eventId}`);
        }
        break;
      default:
        break;
    }
  }
  return Object.freeze([
    ...unknown,
    ...[...commands].map((value) => `pending-command:${value}`),
    ...[...patches].map((value) => `pending-patch:${value}`),
    ...[...mcpCalls].map((value) => `pending-mcp-call:${value}`),
    ...[...mcpStarts].map((value) => `pending-mcp-start:${value}`),
    ...[...hookCommands].map((value) => `pending-hook-command:${value}`),
  ].sort());
}

export function projectHookDurableFacts(input: {
  readonly events: readonly DecodedStoredEvent[];
  readonly runId: string;
  readonly taskState?: TaskStateProjection;
  readonly verifications: readonly CurrentVerificationCommandFact[];
}): HookDurableFacts {
  const approved = input.taskState?.currentApprovedPlan ?? null;
  const planApproval = approved === null
    ? undefined
    : [...input.events].reverse().find((event) =>
        event.scope === "session" &&
        event.type === "plan.approved" &&
        event.data.plan_id === approved.planId &&
        event.data.revision === approved.revision
      );
  const unresolved = unresolvedEffects(input.events, input.runId);
  const latestByCommand = new Map<string, CurrentVerificationCommandFact>();
  for (const verification of input.verifications) {
    latestByCommand.set(verification.command, verification);
  }
  return Object.freeze({
    cleanEffectReconciliation: unresolved.length === 0,
    cleanEffectReconciliationEvidence: Object.freeze(
      unresolved.length === 0
        ? [`host:effect-ledger-clean:${String(input.events.at(-1)?.sessionSeq ?? 0)}`]
        : unresolved,
    ),
    currentVerifications: Object.freeze(
      [...latestByCommand.values()]
        .sort((left, right) => left.command.localeCompare(right.command))
        .map((verification) => Object.freeze({
          command: verification.command,
          evidence: Object.freeze([
            ...verification.evidenceEventIds.map((eventId) => `event:${eventId}`),
            `action:sha256:${verification.actionSha256}`,
            `source:sha256:${verification.sourceSnapshotSha256}`,
          ]),
        })),
    ),
    planApproved: approved !== null && planApproval !== undefined,
    planApprovalEvidence: Object.freeze(
      planApproval === undefined ? [] : [`event:${planApproval.eventId}`],
    ),
  });
}
