import { runAgentLoop } from "../agent/agent-loop.js";
import { resolveAgentConfig } from "../agent/agent-config.js";
import type {
  AgentCommandOptions,
  AgentExitCode,
  ResolvedAgentConfig,
} from "../agent/agent-types.js";
import { BudgetTracker } from "../agent/budget-tracker.js";
import {
  AGENT_SYSTEM_INSTRUCTIONS,
  READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS,
} from "../agent/system-instructions.js";
import type { ChatClientConfiguration } from "../chat/types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  EventPersistenceError,
  EventPublisher,
} from "../events/event-publisher.js";
import { ConsoleEventRenderer } from "../render/console-event-renderer.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import { FatalToolExecutionError } from "../tools/tool-types.js";

function clientConfiguration(
  config: ResolvedAgentConfig,
  env: Readonly<Record<string, string | undefined>>,
): ChatClientConfiguration | { readonly error: string } {
  if (config.provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    return apiKey
      ? { apiKey, provider: "openai" }
      : { error: "OPENAI_API_KEY is not configured" };
  }
  return config.ollamaBaseURL === undefined
    ? { error: "internal protocol error" }
    : { baseURL: config.ollamaBaseURL, provider: "ollama" };
}

export async function executeAgent(
  options: AgentCommandOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<AgentExitCode> {
  // PHASE4: 命令边界负责配置、真实资源装配和关闭；循环策略全部下沉到 runAgentLoop。
  const renderer = new ConsoleEventRenderer(io, options.verbose);
  const configResult = resolveAgentConfig(options, runtime.env);
  if (!configResult.ok) {
    renderer.renderDiagnostic(`usage/config error: ${configResult.error}`);
    return 2;
  }
  const config = configResult.value;
  const modelEvidence = runtime.agentModelEvidence(config.provider);
  if (config.taskProfile === "coding" && modelEvidence === null) {
    renderer.renderDiagnostic(
      "usage/config error: coding profile requires a deterministic fake backend or literal-loopback Ollama",
    );
    return 2;
  }
  const connection = clientConfiguration(config, runtime.env);
  if ("error" in connection) {
    renderer.renderDiagnostic(connection.error);
    return connection.error === "OPENAI_API_KEY is not configured" ? 4 : 1;
  }

  const sessionId = runtime.randomUUID();
  const runId = runtime.randomUUID();
  let writer: SessionWriter;
  try {
    writer = await runtime.createSessionWriter(runtime.cwd, sessionId);
  } catch {
    renderer.renderStorageError();
    return 1;
  }

  const publisher = new EventPublisher({
    // PHASE4: 一个 agent run 仍使用一个 session/run id，所有 step 和工具事件共享同一审计流。
    randomUUID: runtime.randomUUID,
    renderer,
    runId,
    sessionId,
    timestamp: runtime.timestamp,
    writer,
  });
  const startedAt = runtime.now();
  const budget = new BudgetTracker(config, runtime, startedAt);
  const userController = new AbortController();
  // PHASE4: CLI 的 SIGINT 只转成用户 signal；AgentLoop 再负责映射 run.cancelled/130。
  const stopListening = runtime.onCancel(() => userController.abort());
  let exitCode: AgentExitCode;

  try {
    // PHASE4: run.started 先保存完整预算合同；后续重建器据此验证每个 budget terminal。
    await publisher.publish({
      data: {
        command: "agent",
        command_approval: config.commandApproval,
        command_timeout_ms: config.commandTimeoutMs,
        completion_policy: config.completionPolicy,
        edit_approval: config.editApproval,
        input: { role: "user", text: config.task },
        max_duration_ms: config.maxDurationMs,
        max_command_output_bytes: config.maxCommandOutputBytes,
        max_steps: config.maxSteps,
        max_tokens: config.maxTokens,
        max_tool_output_bytes: config.maxToolOutputBytes,
        model: config.model,
        provider: config.provider,
        report_format: config.reportFormat,
        require_verification: config.requireVerification,
        request_timeout_ms: config.requestTimeoutMs,
        task_profile: config.taskProfile,
        tools:
          config.taskProfile === "read-only"
            ? ["list_files", "read_file", "search"]
            : [
                "apply_patch",
                "finish_task",
                "list_files",
                "read_file",
                "run_command",
                "search",
              ],
        tools_enabled: true,
        workspace: runtime.cwd,
      },
      type: "run.started",
    });
    const tools = await runtime.createAgentToolRegistry({
      approvalMode: config.editApproval,
      approvalPrompt: runtime.createApprovalPrompt(io),
      caseInsensitivePaths: runtime.platform === "win32",
      commandApprovalMode: config.commandApproval,
      commandTimeoutMs: config.commandTimeoutMs,
      maxCommandOutputBytes: config.maxCommandOutputBytes,
      modelEvidence:
        modelEvidence ?? {
          backend: "fake",
          endpointScope: "in_process",
          kind: "contract_verified",
          remoteBillableRequests: 0,
        },
      now: runtime.now,
      publisher,
      randomUUID: runtime.randomUUID,
      reportFormat: config.reportFormat,
      runId,
      secrets: [runtime.env.OPENAI_API_KEY],
      taskProfile: config.taskProfile,
      sessionId,
      timestamp: runtime.timestamp,
      workspace: runtime.cwd,
    });
    const model = runtime.createModelTurnClient(connection);
    const terminal = await runAgentLoop(
      config.task,
      config,
      {
        budget,
        clock: runtime,
        instructions:
          config.taskProfile === "read-only"
            ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
            : AGENT_SYSTEM_INSTRUCTIONS,
        model,
        modelId: config.model,
        publisher,
        renderCompletionReport: (report, terminal) =>
          terminal === "completed"
            ? io.stdout.write(report)
            : io.stderr.write(report),
        secrets: [runtime.env.OPENAI_API_KEY],
        tools,
      },
      userController.signal,
    );
    exitCode = terminal.exitCode;
  } catch (error) {
    // PHASE4: EventPersistenceError 表示 writer 已不可信，不能尝试再补 terminal event。
    const wasUserCancelled = userController.signal.aborted;
    if (!wasUserCancelled) userController.abort();
    if (error instanceof EventPersistenceError) {
      renderer.renderStorageError();
      exitCode = 1;
    } else if (error instanceof FatalToolExecutionError && error.kind === "storage") {
      renderer.renderStorageError();
      if (error.workspaceMayHaveChanged) {
        renderer.renderDiagnostic(
          "workspace may have changed; inspect the run-local diff before continuing",
        );
      }
      exitCode = 1;
    } else if (
      error instanceof FatalToolExecutionError &&
      error.kind === "user_cancelled"
    ) {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            duration_ms: snapshot.elapsedMs,
            output_chars: publisher.outputLength,
            reason: "user",
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.cancelled",
        });
        exitCode = 130;
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
        exitCode = 1;
      }
    } else if (error instanceof FatalToolExecutionError) {
      const commandStateUnknown =
        error.kind === "ambiguous_command_state";
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            category: "internal",
            code: commandStateUnknown
              ? "ambiguous_command_state"
              : "ambiguous_patch_state",
            duration_ms: snapshot.elapsedMs,
            message: commandStateUnknown
              ? "command effect or process cleanup is ambiguous; inspect the workspace and running processes before continuing"
              : "workspace state is ambiguous; inspect the diff before continuing",
            output_chars: publisher.outputLength,
            retryable: false,
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.failed",
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic(
            commandStateUnknown
              ? "command effect or process cleanup is ambiguous"
              : "workspace state is ambiguous",
          );
        }
      }
      exitCode = 1;
    } else if (wasUserCancelled) {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            duration_ms: snapshot.elapsedMs,
            output_chars: publisher.outputLength,
            reason: "user",
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.cancelled",
        });
        exitCode = 130;
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
        exitCode = 1;
      }
    } else {
      try {
        const snapshot = budget.snapshot();
        await publisher.publish({
          data: {
            category: "internal",
            code: "internal_error",
            duration_ms: snapshot.elapsedMs,
            message: "internal protocol error",
            output_chars: publisher.outputLength,
            retryable: false,
            steps: snapshot.steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.failed",
        });
      } catch (publishError) {
        if (publishError instanceof EventPersistenceError) {
          renderer.renderStorageError();
        } else {
          renderer.renderDiagnostic("internal protocol error");
        }
      }
      exitCode = 1;
    }
  } finally {
    stopListening();
  }

  try {
    await writer.close();
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
