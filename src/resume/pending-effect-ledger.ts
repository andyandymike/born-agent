import type { RunEvent } from "../events/run-event.js";
import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import { recoverDurableMappedMcpResult } from "../mcp/mcp-result-mapper.js";
import type {
  ApprovalExpiry,
  PendingEffectLedger,
  PendingPatchEffect,
  PendingToolCall,
  PendingToolKind,
  RecoveredInnerEffect,
  RecoveredToolObservation,
  UnknownCommandEffect,
  UnknownMcpCallEffect,
  UnknownMcpServerEffect,
} from "./resume-types.js";

const MAX_COMMAND_TOOL_OUTPUT_BYTES = 1_114_112;
const OMITTED_SUFFIX = "\n[bornagent: output omitted to fit observation limit]";

type CommandCompletedData = Extract<
  RunEvent,
  { type: "command.completed" }
>["data"];
type PatchCompletedData = Extract<
  RunEvent,
  { type: "patch.apply.completed" }
>["data"];

export interface CommandOutputAccumulator {
  readonly stderr: string[];
  readonly stdout: string[];
}

type RecoveredErrorCategory = NonNullable<
  RecoveredToolObservation["errorCategory"]
>;

interface ApprovalAccumulator {
  actionKind: "apply_patch" | "run_command";
  actionSha256: string | null;
  approvalRequestId: string;
  callId: string;
  decision: "approved" | "cancelled" | "denied" | null;
  sourceRunId: string;
}

interface CommandAccumulator {
  actionSha256: string;
  callId: string;
  executionId: string;
  sourceRunId: string;
  stage: "requested" | "started";
  step: number;
}

function pendingToolKind(toolName: string): PendingToolKind {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (toolName === "apply_patch") return "apply_patch";
  if (toolName === "run_command") return "run_command";
  if (toolName === "finish_task") return "finish_task";
  if (["list_files", "read_file", "search"].includes(toolName)) {
    return "read_only";
  }
  return "unknown";
}

function runKey(runId: string, localId: string): string {
  return `${runId}\0${localId}`;
}

function freezeArray<T extends object>(values: readonly T[]): readonly T[] {
  return Object.freeze(values.map((value) => Object.freeze(value)));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function commandError(
  termination: CommandCompletedData["termination"],
):
  | {
      readonly category: RecoveredErrorCategory;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | undefined {
  switch (termination) {
    case "exit":
    case "signal":
      return undefined;
    case "cancelled":
      return {
        category: "cancelled",
        code: "command_cancelled",
        message: "command execution was cancelled",
        retryable: false,
      };
    case "output_limit_exceeded":
      return {
        category: "limit",
        code: "command_output_limit_exceeded",
        message: "command output reached the configured limit",
        retryable: false,
      };
    case "timeout":
      return {
        category: "limit",
        code: "command_timeout",
        message: "command reached the configured timeout",
        retryable: false,
      };
    case "spawn_error":
      return {
        category: "tool",
        code: "command_spawn_failed",
        message: "command could not be started",
        retryable: false,
      };
    case "cleanup_failed":
      return {
        category: "system",
        code: "command_cleanup_failed",
        message: "command process tree cleanup could not be verified",
        retryable: false,
      };
  }
}

export function recoverCommandToolObservation(
  completed: CommandCompletedData,
  chunks: CommandOutputAccumulator,
): RecoveredToolObservation {
  const stdout = chunks.stdout.join("");
  const stderr = chunks.stderr.join("");
  if (
    Buffer.byteLength(stdout, "utf8") !== completed.stdout_bytes ||
    Buffer.byteLength(stderr, "utf8") !== completed.stderr_bytes ||
    completed.total_bytes !== completed.stdout_bytes + completed.stderr_bytes
  ) {
    throw new Error("completed command output bytes cannot be reconstructed");
  }
  const initial = {
    cleanup_verified: completed.cleanup_verified,
    duration_ms: completed.duration_ms,
    ...(completed.error_code === undefined
      ? {}
      : { error_code: completed.error_code }),
    exit_code: completed.exit_code,
    signal: completed.signal,
    stderr,
    stdout,
    termination: completed.termination,
    truncated: completed.truncated,
  };
  const error = commandError(completed.termination);
  let fitted = initial;
  let fittedStdout = stdout;
  let fittedStderr = stderr;
  let truncated = completed.truncated;
  const serialize = () =>
    JSON.stringify(
      error === undefined
        ? { ...fitted, ok: true }
        : { ...fitted, error, ok: false },
    );
  while (Buffer.byteLength(serialize(), "utf8") > MAX_COMMAND_TOOL_OUTPUT_BYTES) {
    truncated = true;
    const trimStdout =
      Buffer.byteLength(fittedStdout, "utf8") >=
      Buffer.byteLength(fittedStderr, "utf8");
    const selected = trimStdout ? fittedStdout : fittedStderr;
    if (selected.length === 0) {
      throw new Error("completed command observation metadata is too large");
    }
    const targetBytes = Math.max(
      0,
      Math.floor(Buffer.byteLength(selected, "utf8") * 0.75),
    );
    const shortened = `${truncateUtf8(
      selected,
      Math.max(
        0,
        targetBytes - Buffer.byteLength(OMITTED_SUFFIX, "utf8"),
      ),
    )}${OMITTED_SUFFIX}`;
    if (trimStdout) fittedStdout = shortened;
    else fittedStderr = shortened;
    fitted = {
      ...initial,
      stderr: fittedStderr,
      stdout: fittedStdout,
      truncated: true,
    };
  }
  return {
    ...(error === undefined
      ? {}
      : {
          errorCategory: error.category,
          errorCode: error.code,
          retryable: error.retryable,
        }),
    output: serialize(),
    status: error === undefined ? "success" : "error",
    truncated,
  };
}

export function recoverPatchToolObservation(
  completed: PatchCompletedData,
): RecoveredToolObservation {
  // PHASE9: the recovery mapper is intentionally the same compact JSON shape
  // produced by ToolRegistry. Re-executing a completed patch merely to obtain
  // an outer observation would duplicate a durable side effect.
  return {
    output: JSON.stringify({
      approved: true,
      files: completed.files.map((file) => ({
        kind: file.kind,
        path: file.path,
        post_sha256: file.post_sha256,
        pre_sha256: file.pre_sha256,
      })),
      plan_id: completed.plan_id,
      stats: {
        added_lines: completed.added_lines,
        removed_lines: completed.removed_lines,
      },
      ok: true,
    }),
    status: "success",
    truncated: false,
  };
}

export function reconstructPendingEffectLedger(
  events: readonly RunEvent[],
): PendingEffectLedger {
  const approvals = new Map<string, ApprovalAccumulator>();
  const commandEffects = new Map<string, CommandAccumulator>();
  const completedCommands = new Set<string>();
  const completedPatches = new Set<string>();
  const commandOutputs = new Map<string, CommandOutputAccumulator>();
  const innerEffects = new Map<string, RecoveredInnerEffect>();
  const patchStarts = new Map<string, PendingPatchEffect>();
  const pendingCalls = new Map<string, PendingToolCall>();
  const completedCalls = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "approval.requested": {
        approvals.set(event.data.approval_request_id, {
          actionKind: event.data.action,
          actionSha256: event.data.action_sha256 ?? null,
          approvalRequestId: event.data.approval_request_id,
          callId: event.data.call_id,
          decision: null,
          sourceRunId: event.run_id,
        });
        break;
      }
      case "approval.decided": {
        const previous = approvals.get(event.data.approval_request_id);
        approvals.set(event.data.approval_request_id, {
          actionKind: event.data.action,
          actionSha256:
            event.data.action_sha256 ?? previous?.actionSha256 ?? null,
          approvalRequestId: event.data.approval_request_id,
          callId: event.data.call_id,
          decision: event.data.decision,
          sourceRunId: previous?.sourceRunId ?? event.run_id,
        });
        break;
      }
      case "tool.call.requested": {
        pendingCalls.set(runKey(event.run_id, event.data.call_id), {
          argumentsJson: event.data.arguments_json,
          callId: event.data.call_id,
          kind: pendingToolKind(event.data.tool_name),
          providerResponseId: event.data.provider_response_id ?? null,
          sourceRunId: event.run_id,
          step: event.data.step,
          toolName: event.data.tool_name,
        });
        break;
      }
      case "tool.call.completed": {
        const key = runKey(event.run_id, event.data.call_id);
        completedCalls.add(key);
        pendingCalls.delete(key);
        break;
      }
      case "patch.apply.started": {
        patchStarts.set(runKey(event.run_id, event.data.plan_id), {
          approvalRequestId: event.data.approval_request_id,
          callId: event.data.call_id,
          files: Object.freeze(
            event.data.files.map((file) =>
              Object.freeze({
                kind: file.kind,
                path: file.path,
                postSha256: file.post_sha256 ?? null,
                preSha256: file.pre_sha256,
              }),
            ),
          ),
          planId: event.data.plan_id,
          sourceRunId: event.run_id,
          step: event.data.step,
        });
        break;
      }
      case "patch.apply.completed": {
        const key = runKey(event.run_id, event.data.plan_id);
        completedPatches.add(key);
        patchStarts.delete(key);
        innerEffects.set(`patch:${key}`, {
          callId: event.data.call_id,
          effectId: event.data.plan_id,
          kind: "patch",
          observation: recoverPatchToolObservation(event.data),
          sourceRunId: event.run_id,
          step: event.data.step,
        });
        break;
      }
      case "command.execution.requested": {
        const key = runKey(event.run_id, event.data.execution_id);
        commandEffects.set(key, {
          actionSha256: event.data.action_sha256,
          callId: event.data.call_id,
          executionId: event.data.execution_id,
          sourceRunId: event.run_id,
          stage: "requested",
          step: event.data.step,
        });
        commandOutputs.set(key, { stderr: [], stdout: [] });
        break;
      }
      case "command.started": {
        const key = runKey(event.run_id, event.data.execution_id);
        const previous = commandEffects.get(key);
        commandEffects.set(key, {
          actionSha256: event.data.action_sha256,
          callId: event.data.call_id,
          executionId: event.data.execution_id,
          sourceRunId: previous?.sourceRunId ?? event.run_id,
          stage: "started",
          step: event.data.step,
        });
        break;
      }
      case "command.output": {
        const key = runKey(event.run_id, event.data.execution_id);
        const output = commandOutputs.get(key);
        if (output === undefined) {
          throw new Error("command output has no matching execution request");
        }
        const expectedIndex = output[event.data.channel].length;
        if (event.data.chunk_index !== expectedIndex) {
          throw new Error("command output chunk sequence cannot be recovered");
        }
        output[event.data.channel].push(event.data.chunk);
        break;
      }
      case "command.completed": {
        const key = runKey(event.run_id, event.data.execution_id);
        const output = commandOutputs.get(key);
        if (output === undefined) {
          throw new Error("completed command has no recoverable output ledger");
        }
        if (
          !event.data.cleanup_verified ||
          event.data.termination === "cleanup_failed"
        ) {
          // PHASE9: a terminal command event does not prove that its process
          // tree is gone. Unverified cleanup remains an unknown side effect and
          // therefore cannot be converted into a model observation on resume.
          break;
        }
        completedCommands.add(key);
        commandEffects.delete(key);
        innerEffects.set(`command:${key}`, {
          callId: event.data.call_id,
          effectId: event.data.execution_id,
          kind: "command",
          observation: recoverCommandToolObservation(event.data, output),
          sourceRunId: event.run_id,
          step: event.data.step,
        });
        break;
      }
      default:
        break;
    }
  }

  const recoveredInnerEffects = [...innerEffects.values()].filter(
    (effect) => !completedCalls.has(runKey(effect.sourceRunId, effect.callId)),
  );

  // PHASE9: persisted command.execution.requested is already on the dangerous
  // side of the spawn boundary. Across a crash, both requested-without-started
  // and started-without-completed mean the effect is unknown, so neither may be
  // translated back into an automatically runnable tool call.
  const unknownCommands: UnknownCommandEffect[] = [
    ...commandEffects.values(),
  ].filter((effect) =>
    !completedCommands.has(runKey(effect.sourceRunId, effect.executionId)),
  );

  // PHASE9: replaying an approval proves only that a user made a historical
  // decision. It does not restore authority in a new run, even when the action
  // digest is byte-for-byte identical; every prior request is expired.
  const approvalsToExpire: ApprovalExpiry[] = [...approvals.values()];

  const ledger: PendingEffectLedger = {
    approvalsToExpire: freezeArray(approvalsToExpire),
    pendingPatches: freezeArray(
      [...patchStarts.values()].filter(
        (effect) =>
          !completedPatches.has(runKey(effect.sourceRunId, effect.planId)),
      ),
    ),
    pendingToolCalls: freezeArray([...pendingCalls.values()]),
    recoveredInnerEffects: freezeArray(recoveredInnerEffects),
    unknownCommands: freezeArray(unknownCommands),
    unknownMcpCalls: Object.freeze([]),
    unknownMcpServers: Object.freeze([]),
  };
  return Object.freeze(ledger);
}

export function mergeMcpPendingEffects(
  ledger: PendingEffectLedger,
  events: readonly DecodedRunEvent[],
): PendingEffectLedger {
  const servers = new Map<string, UnknownMcpServerEffect>();
  const calls = new Map<string, UnknownMcpCallEffect>();
  const completedOuterCalls = new Set(
    events
      .filter((event) => event.type === "tool.call.completed")
      .map((event) => `${event.runId}\0${event.data.call_id}`),
  );
  const recovered = [...ledger.recoveredInnerEffects];
  for (const event of events) {
    switch (event.type) {
      case "mcp.server.start.requested":
        servers.set(`${event.runId}\0${event.data.server_id}`, {
          actionSha256: event.data.action_sha256,
          processIdentitySha256: null,
          serverId: event.data.server_id,
          sourceRunId: event.runId,
          stage: "requested",
        });
        break;
      case "mcp.server.start.failed":
        servers.delete(`${event.runId}\0${event.data.server_id}`);
        break;
      case "mcp.server.start.effect_unknown": {
        const key = `${event.runId}\0${event.data.server_id}`;
        const previous = servers.get(key);
        servers.set(key, {
          actionSha256: event.data.action_sha256,
          processIdentitySha256: previous?.processIdentitySha256 ?? null,
          serverId: event.data.server_id,
          sourceRunId: event.runId,
          stage: "effect_unknown",
        });
        break;
      }
      case "mcp.server.started":
        servers.set(`${event.runId}\0${event.data.server_id}`, {
          actionSha256: event.data.action_sha256,
          processIdentitySha256: event.data.process_identity_sha256,
          serverId: event.data.server_id,
          sourceRunId: event.runId,
          stage: "started",
        });
        break;
      case "mcp.server.stopped":
        servers.delete(`${event.runId}\0${event.data.server_id}`);
        break;
      case "mcp.tool.call.started":
        calls.set(`${event.runId}\0${event.data.call_id}`, {
          actionSha256: event.data.action_sha256,
          callId: event.data.call_id,
          serverId: event.data.server_id,
          sourceRunId: event.runId,
          stage: "started",
          step: event.data.step,
        });
        break;
      case "mcp.tool.call.effect_unknown":
        calls.set(`${event.runId}\0${event.data.call_id}`, {
          actionSha256: event.data.action_sha256,
          callId: event.data.call_id,
          serverId: event.data.server_id,
          sourceRunId: event.runId,
          stage: "effect_unknown",
          step: event.data.step,
        });
        break;
      case "mcp.tool.call.completed": {
        const key = `${event.runId}\0${event.data.call_id}`;
        calls.delete(key);
        if (!completedOuterCalls.has(key)) {
          if (event.data.artifact_ref !== undefined) {
            throw new Error("MCP result artifact requires store verification before recovery");
          }
          const mapped = recoverDurableMappedMcpResult({
            bytes: event.data.bytes,
            mapperVersion: event.data.mapper_version,
            observation: event.data.observation,
            observationSha256: event.data.observation_sha256,
            status: event.data.status,
            truncated: event.data.truncated,
          });
          recovered.push({
            callId: event.data.call_id,
            effectId: event.data.action_sha256,
            kind: "mcp",
            observation:
              mapped.status === "success"
                ? {
                    output: mapped.observation,
                    status: "success",
                    truncated: mapped.truncated,
                  }
                : {
                    errorCategory: "tool",
                    errorCode: "mcp_tool_error",
                    output: mapped.observation,
                    retryable: false,
                    status: "error",
                    truncated: mapped.truncated,
                  },
            sourceRunId: event.runId,
            step: event.data.step,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  // PHASE12: old MCP clients, stdio streams, catalogs, and approvals never
  // survive resume. Requested/started tails block until exact process/effect
  // reconciliation; only verified durable mapped bytes can recover an outer result.
  return Object.freeze({
    ...ledger,
    recoveredInnerEffects: freezeArray(recovered),
    unknownMcpCalls: freezeArray([...calls.values()]),
    unknownMcpServers: freezeArray([...servers.values()]),
  });
}
