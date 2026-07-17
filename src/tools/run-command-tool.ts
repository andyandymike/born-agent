import { z } from "zod";

import type { CommandApprovalGate } from "../approvals/command-approval-gate.js";
import {
  EventPersistenceError,
  type EventPublisher,
} from "../events/event-publisher.js";
import {
  ExecutionPreparationError,
  type ExecutionPreparerLike,
  type ExecutionResult,
  type Executor,
  type PreparedExecution,
} from "../execution/execution-types.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionEngineLike,
} from "../permissions/permission-types.js";
import type {
  ActiveVerificationContext,
  Phase7CompletionRuntime,
} from "../completion/phase7-completion-runtime.js";
import { redactSensitiveText } from "../security/redact.js";
import { toolError } from "./tool-errors.js";
import {
  FatalToolExecutionError,
  type ToolDefinition,
  type ToolError,
  type ToolRawResult,
} from "./tool-types.js";

export const MAX_COMMAND_TOOL_OUTPUT_BYTES = 1_114_112;
const MAX_EVENT_CHUNK_BYTES = 32 * 1024;
const OMITTED_SUFFIX = "\n[bornagent: output omitted to fit observation limit]";

const argumentSchema = z.string().max(4096);

export const runCommandInputSchema = z
  .object({
    args: z.array(argumentSchema).max(64),
    cwd: z.string().max(4096).nullable(),
    executable: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_-]*$/u),
    purpose: z.enum(["inspect", "verify"]),
    timeout_ms: z.number().int().min(1000).max(600_000).nullable(),
  })
  .strict();

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

export interface RunCommandToolOptions {
  readonly approvalGate: CommandApprovalGate;
  readonly defaultTimeoutMs: number;
  readonly executor: Executor;
  readonly maxOutputBytes: number;
  readonly permissionContext: (
    prepared: PreparedExecution,
  ) => PermissionContext;
  readonly permissionEngine: PermissionEngineLike;
  readonly preparer: ExecutionPreparerLike;
  readonly publisher: EventPublisher;
  readonly randomUUID: () => string;
  readonly secrets?: readonly (string | undefined)[];
  readonly verification?: Pick<
    Phase7CompletionRuntime,
    | "completeVerification"
    | "prepareVerification"
    | "publishVerificationStarted"
  >;
}

interface CommandObservation {
  readonly [key: string]: unknown;
  readonly cleanup_verified: boolean;
  readonly duration_ms: number;
  readonly error_code?: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination: ExecutionResult["termination"];
  readonly truncated: boolean;
}

function sanitizeDisplayText(
  value: string,
  secrets: readonly (string | undefined)[],
): string {
  const redacted = redactSensitiveText(value, secrets);
  let escaped = "";
  for (const character of redacted) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      escaped +=
        character === "\n"
          ? "\\n"
          : character === "\r"
            ? "\\r"
            : character === "\t"
              ? "\\t"
              : `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return truncateUtf8(escaped, 4096);
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

function splitEventChunks(value: string): readonly string[] {
  if (value.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_EVENT_CHUNK_BYTES && current.length > 0) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function executionIdentity(
  prepared: PreparedExecution,
  executionId: string,
  callId: string,
  step: number,
) {
  return {
    action_sha256: prepared.actionSha256,
    call_id: callId,
    execution_id: executionId,
    executor: prepared.environmentEvidence?.executor ?? ("local" as const),
    step,
  };
}

async function publishBoundary(
  publisher: EventPublisher,
  draft: Parameters<EventPublisher["publish"]>[0],
  executionAttempted: boolean,
): Promise<void> {
  try {
    await publisher.publish(draft);
  } catch (error) {
    if (error instanceof EventPersistenceError) {
      throw new FatalToolExecutionError(
        "storage",
        executionAttempted
          ? "session storage failed after command execution began"
          : "session storage failed before command execution",
        { cause: error, workspaceMayHaveChanged: executionAttempted },
      );
    }
    if (executionAttempted) {
      throw new FatalToolExecutionError(
        "ambiguous_command_state",
        "command evidence became inconsistent after execution began",
        { cause: error, workspaceMayHaveChanged: true },
      );
    }
    throw error;
  }
}

function preparationFailure(error: unknown): ToolRawResult {
  if (error instanceof ExecutionPreparationError) {
    return {
      error: toolError("permission", error.code, error.message),
      ok: false,
    };
  }
  return {
    error: toolError(
      "system",
      "command_preparation_failed",
      "command could not be prepared",
    ),
    ok: false,
  };
}

function commandObservation(result: ExecutionResult): CommandObservation {
  return {
    cleanup_verified: result.cleanupVerified,
    duration_ms: result.durationMs,
    ...(result.errorCode === undefined ? {} : { error_code: result.errorCode }),
    exit_code: result.exitCode,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
    termination: result.termination,
    truncated: result.truncated,
  };
}

function serializedObservationBytes(
  observation: CommandObservation,
  error: ToolError | undefined,
): number {
  return Buffer.byteLength(
    JSON.stringify(
      error === undefined
        ? { ...observation, ok: true }
        : { ...observation, error, ok: false },
    ),
    "utf8",
  );
}

function fitObservation(
  initial: CommandObservation,
  error?: ToolError,
): { readonly observation: CommandObservation; readonly truncated: boolean } {
  let stdout = initial.stdout;
  let stderr = initial.stderr;
  let observation = initial;
  let truncated = initial.truncated;
  while (
    serializedObservationBytes(observation, error) >
    MAX_COMMAND_TOOL_OUTPUT_BYTES
  ) {
    truncated = true;
    const trimStdout =
      Buffer.byteLength(stdout, "utf8") >= Buffer.byteLength(stderr, "utf8");
    const selected = trimStdout ? stdout : stderr;
    if (selected.length === 0) {
      throw new Error("command observation metadata exceeded its fixed limit");
    }
    const selectedBytes = Buffer.byteLength(selected, "utf8");
    const targetBytes = Math.max(0, Math.floor(selectedBytes * 0.75));
    const shortened = `${truncateUtf8(
      selected,
      Math.max(0, targetBytes - Buffer.byteLength(OMITTED_SUFFIX, "utf8")),
    )}${OMITTED_SUFFIX}`;
    if (trimStdout) stdout = shortened;
    else stderr = shortened;
    observation = { ...initial, stderr, stdout, truncated: true };
  }
  return { observation, truncated };
}

function resultError(result: ExecutionResult): ToolError | undefined {
  switch (result.termination) {
    case "exit":
    case "signal":
      return undefined;
    case "cancelled":
      return toolError(
        "cancelled",
        "command_cancelled",
        "command execution was cancelled",
      );
    case "output_limit_exceeded":
      return toolError(
        "limit",
        "command_output_limit_exceeded",
        "command output reached the configured limit",
      );
    case "timeout":
      return toolError(
        "limit",
        "command_timeout",
        "command reached its configured timeout",
      );
    case "spawn_error":
      return toolError(
        "tool",
        "command_spawn_failed",
        "command could not be started",
      );
    case "cleanup_failed":
      return toolError(
        "system",
        "command_cleanup_failed",
        "command process tree cleanup could not be verified",
      );
    case "stale":
      return toolError(
        "permission",
        "command_stale",
        "command inputs changed after approval",
        true,
      );
  }
}

async function evaluatePermission(
  options: RunCommandToolOptions,
  prepared: PreparedExecution,
  callId: string,
  step: number,
): Promise<PermissionDecision> {
  const decision = options.permissionEngine.evaluate(
    prepared.actionIdentity,
    options.permissionContext(prepared),
  );
  await publishBoundary(
    options.publisher,
    {
      data: {
        action_kind: "run_command",
        action_sha256: prepared.actionSha256,
        call_id: callId,
        effect: decision.effect,
        policy_version: decision.policyVersion,
        ...(decision.effect === "allow"
          ? {}
          : { reason_code: decision.reasonCode }),
        rule_id: decision.ruleId,
        step,
      },
      type: "permission.evaluated",
    },
    false,
  );
  return decision;
}

export function createRunCommandTool(
  options: RunCommandToolOptions,
): ToolDefinition<RunCommandInput> {
  return {
    capability: "mutation",
    description:
      "Run one policy-controlled executable with an exact argv array in the configured local or Docker executor; local execution is not an OS sandbox and either backend may require user approval.",
    execute: async (input, context) => {
      let prepared: PreparedExecution;
      try {
        prepared = await options.preparer.prepare({
          args: input.args,
          cwd: input.cwd,
          executable: input.executable,
          outputLimitBytes: options.maxOutputBytes,
          purpose: input.purpose,
          timeoutMs: input.timeout_ms ?? options.defaultTimeoutMs,
        });
      } catch (error) {
        return preparationFailure(error);
      }

      const decision = await evaluatePermission(
        options,
        prepared,
        context.callId,
        context.step,
      );
      if (decision.effect === "deny") {
        return {
          error: toolError(
            "permission",
            "command_denied",
            `command was denied by rule ${decision.ruleId}`,
          ),
          ok: false,
        };
      }

      const secrets = options.secrets ?? [];
      const displayArgs = prepared.actionIdentity.argv.map((argument) =>
        sanitizeDisplayText(argument, secrets),
      );
      let approvalRequestId: string | undefined;
      if (decision.effect === "ask") {
        let approval;
        try {
          approval = await options.approvalGate.request(
            {
              actionSha256: prepared.actionSha256,
              args: displayArgs,
              callId: context.callId,
              cwd: prepared.actionIdentity.canonicalCwd,
              executable: prepared.actionIdentity.logicalExecutable,
              executor:
                prepared.environmentEvidence?.executor ?? "local",
              purpose: prepared.actionIdentity.purpose,
              reviewLines: [
                ...(prepared.review.environmentLines ?? []),
                ...prepared.review.lifecycleScripts.map(
                  (script) => `${script.name}: ${script.body}`,
                ),
              ].map((line) => sanitizeDisplayText(line, secrets)),
              riskWarning: prepared.review.warning,
              step: context.step,
            },
            context.signal,
          );
        } catch (error) {
          if (error instanceof EventPersistenceError) {
            throw new FatalToolExecutionError(
              "storage",
              "command approval audit could not be persisted",
              { cause: error, workspaceMayHaveChanged: false },
            );
          }
          throw error;
        }
        approvalRequestId = approval.approvalRequestId;
        if (approval.decision === "cancelled") {
          throw new FatalToolExecutionError(
            "user_cancelled",
            "command approval was cancelled",
            { workspaceMayHaveChanged: false },
          );
        }
        if (approval.decision === "denied") {
          return {
            error: toolError(
              "permission",
              "command_approval_denied",
              "command was not approved",
            ),
            ok: false,
          };
        }
      }

      if ((await prepared.revalidate()) !== "current") {
        return {
          error: toolError(
            "permission",
            "command_stale",
            "command inputs changed after permission evaluation",
            true,
          ),
          ok: false,
        };
      }

      const executionId = options.randomUUID();
      prepared =
        prepared.bindExecutionContext?.({ executionId }) ?? prepared;
      const identity = executionIdentity(
        prepared,
        executionId,
        context.callId,
        context.step,
      );
      let verification: ActiveVerificationContext | null = null;
      if (options.verification !== undefined) {
        try {
          verification = await options.verification.prepareVerification(
            prepared,
            executionId,
          );
        } catch {
          return {
            error: toolError(
              "system",
              "verification_snapshot_failed",
              "verification inputs or the source-state snapshot could not be established",
            ),
            ok: false,
          };
        }
      }
      // PHASE6: request evidence is durable before crossing the spawn boundary;
      // a write failure here therefore guarantees that no child was attempted.
      await publishBoundary(
        options.publisher,
        {
          data: {
            ...identity,
            ...(approvalRequestId === undefined
              ? {}
              : { approval_request_id: approvalRequestId }),
            cwd: prepared.actionIdentity.canonicalCwd,
            executable: prepared.actionIdentity.logicalExecutable,
            purpose: prepared.actionIdentity.purpose,
            redacted_argv: [
              prepared.actionIdentity.logicalExecutable,
              ...displayArgs,
            ],
          },
          type: "command.execution.requested",
        },
        false,
      );
      if (verification !== null && options.verification !== undefined) {
        await options.verification.publishVerificationStarted(
          verification,
          context.callId,
          context.step,
        );
      }

      let executionAttempted = false;
      let started = false;
      let completed: ExecutionResult | undefined;
      const outputParts = { stderr: [] as string[], stdout: [] as string[] };
      const chunkIndexes = { stderr: 0, stdout: 0 };
      try {
        executionAttempted = true;
        for await (const signal of options.executor.execute(
          prepared,
          context.signal,
        )) {
          if (completed !== undefined) {
            throw new Error("executor emitted a signal after completion");
          }
          if (signal.type === "started") {
            if (started) throw new Error("executor emitted duplicate start");
            started = true;
            await publishBoundary(
              options.publisher,
              {
                data: {
                  ...identity,
                  ...(signal.processIdentity === undefined
                    ? {}
                    : { process_identity: signal.processIdentity }),
                },
                type: "command.started",
              },
              true,
            );
          } else if (signal.type === "output") {
            if (!started) {
              throw new Error("executor emitted output before start");
            }
            if (
              signal.chunkBytes !== Buffer.byteLength(signal.chunk, "utf8")
            ) {
              throw new Error("executor output byte count mismatch");
            }
            for (const chunk of splitEventChunks(signal.chunk)) {
              outputParts[signal.stream].push(chunk);
              await publishBoundary(
                options.publisher,
                {
                  data: {
                    ...identity,
                    bytes: Buffer.byteLength(chunk, "utf8"),
                    channel: signal.stream,
                    chunk,
                    chunk_index: chunkIndexes[signal.stream],
                  },
                  type: "command.output",
                },
                true,
              );
              chunkIndexes[signal.stream] += 1;
            }
          } else {
            completed = signal.result;
          }
        }
      } catch (error) {
        if (error instanceof FatalToolExecutionError) throw error;
        throw new FatalToolExecutionError(
          "ambiguous_command_state",
          "command executor failed before durable completion evidence",
          { cause: error, workspaceMayHaveChanged: executionAttempted },
        );
      }

      if (completed === undefined) {
        throw new FatalToolExecutionError(
          "ambiguous_command_state",
          "command executor ended without completion evidence",
          { workspaceMayHaveChanged: executionAttempted },
        );
      }
      if (
        (!started &&
          completed.termination !== "spawn_error" &&
          completed.termination !== "cancelled") ||
        outputParts.stdout.join("") !== completed.stdout ||
        outputParts.stderr.join("") !== completed.stderr ||
        Buffer.byteLength(completed.stdout, "utf8") !== completed.stdoutBytes ||
        Buffer.byteLength(completed.stderr, "utf8") !== completed.stderrBytes
      ) {
        throw new FatalToolExecutionError(
          "ambiguous_command_state",
          "command executor returned inconsistent evidence",
          { workspaceMayHaveChanged: executionAttempted },
        );
      }
      if (completed.termination === "stale") {
        throw new FatalToolExecutionError(
          "ambiguous_command_state",
          "executor revalidated after the durable command boundary",
          { workspaceMayHaveChanged: executionAttempted },
        );
      }

      await publishBoundary(
        options.publisher,
        {
          data: {
            ...identity,
            cleanup_verified: completed.cleanupVerified,
            duration_ms: completed.durationMs,
            ...(completed.errorCode === undefined
              ? {}
              : { error_code: completed.errorCode }),
            exit_code: completed.exitCode,
            signal: completed.signal,
            stderr_bytes: completed.stderrBytes,
            stdout_bytes: completed.stdoutBytes,
            termination: completed.termination,
            total_bytes: completed.stdoutBytes + completed.stderrBytes,
            truncated: completed.truncated,
          },
          type: "command.completed",
        },
        true,
      );

      if (!completed.cleanupVerified || completed.termination === "cleanup_failed") {
        throw new FatalToolExecutionError(
          "ambiguous_command_state",
          "command process tree cleanup could not be verified",
          { workspaceMayHaveChanged: true },
        );
      }

      if (verification !== null && options.verification !== undefined) {
        try {
          await options.verification.completeVerification(
            verification,
            completed,
            context.callId,
            context.step,
          );
        } catch (error) {
          if (error instanceof FatalToolExecutionError) throw error;
          throw new FatalToolExecutionError(
            "ambiguous_command_state",
            "verification completion snapshot could not be established",
            { cause: error, workspaceMayHaveChanged: true },
          );
        }
      }

      const error = resultError(completed);
      const fitted = fitObservation(commandObservation(completed), error);
      return error === undefined
        ? {
            ok: true,
            truncated: fitted.truncated,
            value: fitted.observation,
          }
        : {
            error,
            ok: false,
            truncated: fitted.truncated,
            value: fitted.observation,
          };
    },
    inputSchema: runCommandInputSchema,
    maxOutputBytes: MAX_COMMAND_TOOL_OUTPUT_BYTES,
    name: "run_command",
  };
}
