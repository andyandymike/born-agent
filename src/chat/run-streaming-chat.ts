import type {
  ChatCommandOptions,
  ResolvedChatConfig,
} from "./types.js";
import { resolveChatConfig } from "./config.js";
import {
  READONLY_SYSTEM_INSTRUCTIONS,
  SYSTEM_INSTRUCTIONS,
} from "./system-instructions.js";
import {
  EventPersistenceError,
  EventPublisher,
  type RunEventRenderer,
} from "../events/event-publisher.js";
import type { RunEventDraft } from "../events/run-event.js";
import type {
  BackendContinuation,
  ModelBackend,
  ModelTurnRequest,
} from "../model/model-backend.js";
import {
  BackendPreflightError,
  type BackendCreationRequest,
} from "../model/backend-factory.js";
import type { ModelUsage } from "../model/model-events.js";
import type { ProviderFailure } from "../model/provider-failure.js";
import { redactSensitiveText } from "../security/redact.js";
import type { SessionWriter } from "../sessions/jsonl-session-writer.js";
import {
  createTurnBoundaryRecorder,
  type TurnBoundaryRecorder,
} from "../sessions/turn-boundary-recorder.js";
import type {
  ToolExecution,
  ToolRegistryLike,
} from "../tools/tool-types.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type EffectiveRuntimePolicy,
  type ResolvedProviderPolicyRequest,
} from "../policy/policy-resolver.js";
import { persistRuntimePolicyEvidence } from "../policy/policy-evidence.js";
import { credentialSecretsForPolicy } from "../policy/provider-access-policy.js";

type CancellationReason = "cancelled" | "timeout";
export type StreamingChatExitCode = 0 | 1 | 2 | 4 | 5 | 6 | 130;

export interface StreamingRunRenderer extends RunEventRenderer {
  renderDiagnostic(message: string): void;
  renderStorageError(): void;
}

export interface StreamingChatRuntime {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  clearTimer(handle: unknown): void;
  createModelBackend(request: BackendCreationRequest): ModelBackend;
  createSessionWriter(
    workspace: string,
    sessionId: string,
  ): Promise<SessionWriter>;
  createToolRegistry(
    workspace: string,
    secrets: readonly (string | undefined)[],
  ): Promise<ToolRegistryLike>;
  now(): number;
  onCancel(listener: () => void): () => void;
  randomUUID(): string;
  setTimer(listener: () => void, delayMs: number): unknown;
  timestamp(): string;
}

interface CompletedTurn {
  // PHASE3: consumeModelTurn 只汇总一个回合；是否结束整个 run 由外层固定状态机决定。
  readonly call?: ModelToolCall;
  readonly continuation: BackendContinuation;
  readonly kind: "completed";
  readonly providerResponseId?: string;
  readonly sawNonWhitespaceText: boolean;
  readonly usage?: ModelUsage;
}

interface ModelToolCall {
  readonly argumentsJson: string;
  readonly callId: string;
  readonly name: string;
}

type TurnResult =
  | CompletedTurn
  | { readonly error: ProviderFailure; readonly kind: "failed" }
  | { readonly kind: "aborted" };

function durationMs(runtime: StreamingChatRuntime, startedAt: number): number {
  return Math.max(0, Math.round(runtime.now() - startedAt));
}

function failureDraft(
  error: ProviderFailure,
  duration: number,
): RunEventDraft {
  return {
    data: {
      category: error.category,
      code: error.code,
      duration_ms: duration,
      message: error.message,
      ...(error.providerRequestId === undefined
        ? {}
        : { provider_request_id: error.providerRequestId }),
      retryable: error.retryable,
    },
    type: "run.failed",
  };
}

function protocolFailure(code: string, message: string): ProviderFailure {
  return {
    category: "protocol",
    code,
    message,
    retryable: false,
  };
}

function exitCodeForProviderFailure(error: ProviderFailure): StreamingChatExitCode {
  if (error.category === "authentication") return 4;
  return error.category === "timeout" ? 6 : 5;
}

async function publishCancellation(
  reason: CancellationReason,
  config: ResolvedChatConfig,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
): Promise<StreamingChatExitCode> {
  // PHASE2: timeout 和 Ctrl+C 都会 abort 同一个请求，但它们是不同的业务事实：
  // 用户取消写 run.cancelled/130；超时写 run.failed/6。
  const duration = durationMs(runtime, startedAt);
  if (reason === "cancelled") {
    await publisher.publish({
      data: { duration_ms: duration, reason: "user" },
      type: "run.cancelled",
    });
    return 130;
  }
  await publisher.publish({
    data: {
      category: "timeout",
      code: "request_timeout",
      duration_ms: duration,
      message: `request timed out after ${config.timeoutMs} ms`,
      retryable: true,
    },
    type: "run.failed",
  });
  return 6;
}

async function consumeModelTurn(
  backend: ModelBackend,
  request: ModelTurnRequest,
  controller: AbortController,
  publisher: EventPublisher,
  cancellationReason: () => CancellationReason | undefined,
): Promise<TurnResult> {
  // PHASE2/3: provider-neutral 主事件泵。text delta 立即走 persist-before-render；
  // tool call、usage 和 opaque continuation 只在当前 model turn 内聚合。
  const calls = new Map<string, ModelToolCall>();
  let usage: ModelUsage | undefined;
  let sawNonWhitespaceText = false;

  for await (const signal of backend.runTurn(request, controller.signal)) {
    if (cancellationReason() !== undefined) {
      return { kind: "aborted" };
    }
    switch (signal.type) {
      case "text_delta":
        if (signal.text.length > 0) {
          sawNonWhitespaceText ||= signal.text.trim().length > 0;
          await publisher.publish({
            data: { delta: signal.text },
            type: "text.delta",
          });
        }
        break;
      case "tool_call_delta": {
        const current = calls.get(signal.callId);
        if (current !== undefined && current.name !== signal.name) {
          return {
            error: protocolFailure(
              "tool_call_name_changed",
              "provider changed a tool name while streaming one call",
            ),
            kind: "failed",
          };
        }
        calls.set(signal.callId, {
          argumentsJson: `${current?.argumentsJson ?? ""}${signal.argumentsDelta}`,
          callId: signal.callId,
          name: signal.name,
        });
        break;
      }
      case "usage":
        if (usage !== undefined) {
          return {
            error: protocolFailure(
              "duplicate_turn_usage",
              "provider returned usage more than once in one model turn",
            ),
            kind: "failed",
          };
        }
        usage = signal.usage;
        break;
      case "failed":
        return { error: signal.error, kind: "failed" };
      case "turn_completed": {
        // PHASE3: 只有 provider 明确完成回合后才把 tool call 和 continuation 交给外层。
        const declaredUsage = backend.capabilities.usage;
        if (
          (declaredUsage === "none" && usage !== undefined) ||
          (declaredUsage !== "none" &&
            (usage === undefined || usage.completeness !== declaredUsage))
        ) {
          return {
            error: protocolFailure(
              "protocol_capability_mismatch",
              "backend usage events do not match its declared capability",
            ),
            kind: "failed",
          };
        }
        if (
          (signal.outcome === "text" && calls.size !== 0) ||
          (signal.outcome === "tool_calls" && calls.size === 0)
        ) {
          return {
            error: protocolFailure(
              "protocol_capability_mismatch",
              "backend terminal outcome does not match streamed tool calls",
            ),
            kind: "failed",
          };
        }
        if (calls.size > 1) {
          return {
            error: protocolFailure(
              "multiple_tool_calls",
              "provider returned more than one tool call",
            ),
            kind: "failed",
          };
        }
        const call = calls.values().next().value as ModelToolCall | undefined;
        return {
          ...(call === undefined ? {} : { call }),
          continuation: signal.continuation,
          kind: "completed",
          ...(signal.providerRequestId === undefined
            ? {}
            : { providerResponseId: signal.providerRequestId }),
          sawNonWhitespaceText,
          ...(usage === undefined ? {} : { usage }),
        };
      }
    }
  }
  return cancellationReason() === undefined
    ? {
        error: protocolFailure(
          "stream_ended_without_terminal",
          "provider stream ended without a terminal event",
        ),
        kind: "failed",
      }
    : { kind: "aborted" };
}

function aggregateUsage(usages: readonly (ModelUsage | undefined)[]):
  | {
      readonly usage: {
        readonly cachedInputTokens?: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
      };
      readonly usageIncomplete: boolean;
    }
  | undefined {
  // PHASE3: 两个 model turn 的 usage 汇总为一个 RunEvent；缺少某回合数据时标记 incomplete，
  // 不把未知 token 数伪造成 0。
  const known = usages.filter(
    (
      usage,
    ): usage is ModelUsage & {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    } =>
      usage !== undefined &&
      usage.inputTokens !== null &&
      usage.outputTokens !== null &&
      usage.totalTokens !== null,
  );
  if (known.length === 0) {
    return undefined;
  }
  const cached = known.map((usage) => usage.cacheReadTokens);
  return {
    usage: {
      ...(cached.some((value) => value === null)
        ? {}
        : {
            cachedInputTokens: cached.reduce<number>(
              (sum, value) => sum + (value ?? 0),
              0,
            ),
          }),
      inputTokens: known.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: known.reduce((sum, usage) => sum + usage.outputTokens, 0),
      totalTokens: known.reduce((sum, usage) => sum + usage.totalTokens, 0),
    },
    usageIncomplete:
      known.length !== usages.length ||
      known.some((usage) => usage.completeness !== "complete"),
  };
}

async function publishUsage(
  usages: readonly (ModelUsage | undefined)[],
  publisher: EventPublisher,
): Promise<void> {
  const aggregate = aggregateUsage(usages);
  if (aggregate === undefined) {
    return;
  }
  await publisher.publish({
    data: {
      ...(aggregate.usage.cachedInputTokens === undefined
        ? {}
        : { cached_input_tokens: aggregate.usage.cachedInputTokens }),
      input_tokens: aggregate.usage.inputTokens,
      model_turns: usages.length,
      output_tokens: aggregate.usage.outputTokens,
      total_tokens: aggregate.usage.totalTokens,
      ...(aggregate.usageIncomplete ? { usage_incomplete: true } : {}),
    },
    type: "usage",
  });
}

async function publishCompleted(
  modelTurns: number,
  providerResponseId: string | undefined,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
): Promise<0> {
  await publisher.publish({
    data: {
      duration_ms: durationMs(runtime, startedAt),
      model_turns: modelTurns,
      output_chars: publisher.outputLength,
      ...(providerResponseId === undefined
        ? {}
        : { provider_response_id: providerResponseId }),
      tool_calls: publisher.completedToolCalls,
    },
    type: "run.completed",
  });
  return 0;
}

async function publishProviderFailure(
  error: ProviderFailure,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
): Promise<StreamingChatExitCode> {
  await publisher.publish(failureDraft(error, durationMs(runtime, startedAt)));
  return exitCodeForProviderFailure(error);
}

function toolCompletedDraft(
  call: ModelToolCall,
  execution: ToolExecution,
  duration: number,
): RunEventDraft {
  return {
    data: {
      call_id: call.callId,
      duration_ms: duration,
      ...(execution.ok
        ? {}
        : {
            error_category: execution.error.category,
            error_code: execution.error.code,
            retryable: execution.error.retryable,
          }),
      output: execution.output,
      status: execution.ok ? "success" : "error",
      step: 1,
      tool_name: call.name,
      truncated: execution.truncated,
    },
    type: "tool.call.completed",
  };
}

async function runFixedToolRoundTrip(
  config: ResolvedChatConfig,
  backend: ModelBackend,
  tools: ToolRegistryLike | undefined,
  controller: AbortController,
  publisher: EventPublisher,
  runtime: StreamingChatRuntime,
  startedAt: number,
  cancellationReason: () => CancellationReason | undefined,
  secrets: readonly (string | undefined)[],
  persistTurnBoundary?: TurnBoundaryRecorder,
): Promise<StreamingChatExitCode> {
  // PHASE3 状态机：first turn -> (直接回答 | 一个工具) -> second turn -> terminal。
  // 这里刻意没有 while；通用 AgentLoop、step budget 和重复调用检测属于 Phase 4。
  const first = await consumeModelTurn(
    backend,
    {
      input: { kind: "user_prompt", text: config.prompt },
      instructions: config.toolsEnabled
        ? READONLY_SYSTEM_INSTRUCTIONS
        : SYSTEM_INSTRUCTIONS,
      timeoutMs: config.timeoutMs,
      tools: tools?.modelDefinitions ?? [],
    },
    controller,
    publisher,
    cancellationReason,
  );
  if (first.kind === "aborted") {
    const reason = cancellationReason();
    if (reason === undefined) {
      return publishProviderFailure(
        protocolFailure("unexpected_abort", "model turn was aborted unexpectedly"),
        publisher,
        runtime,
        startedAt,
      );
    }
    return publishCancellation(reason, config, publisher, runtime, startedAt);
  }
  if (first.kind === "failed") {
    return publishProviderFailure(first.error, publisher, runtime, startedAt);
  }
  if (first.call === undefined) {
    // PHASE3: 模型没有请求工具时，退化成单回合流式聊天路径。
    if (!first.sawNonWhitespaceText) {
      return publishProviderFailure(
        protocolFailure("empty_model_output", "provider completed without text"),
        publisher,
        runtime,
        startedAt,
      );
    }
    await persistTurnBoundary?.({
      continuation: first.continuation,
      pendingCall: false,
      runId: publisher.runId,
      sessionId: publisher.sessionId,
      turn: 1,
    });
    await publishUsage([first.usage], publisher);
    return publishCompleted(
      1,
      first.providerResponseId,
      publisher,
      runtime,
      startedAt,
    );
  }
  if (!config.toolsEnabled || tools === undefined) {
    return publishProviderFailure(
      protocolFailure("tools_disabled", "provider requested a disabled tool"),
      publisher,
      runtime,
      startedAt,
    );
  }

  // PHASE3: 必须等第一回合完整结束后才记录并执行 tool call。
  // requested 先持久化，保证 session 中存在模型确实提出过该调用的证据。
  await publisher.publish({
    data: {
      arguments_json: redactSensitiveText(first.call.argumentsJson, secrets),
      call_id: first.call.callId,
      ...(first.providerResponseId === undefined
        ? {}
        : { provider_response_id: first.providerResponseId }),
      step: 1,
      tool_name: first.call.name,
    },
    type: "tool.call.requested",
  });
  await persistTurnBoundary?.({
    continuation: first.continuation,
    pendingCall: true,
    runId: publisher.runId,
    sessionId: publisher.sessionId,
    turn: 1,
  });

  const toolStartedAt = runtime.now();
  // PHASE3: 模型只能“请求”工具；参数验证、权限判定和真正执行权都在 Registry。
  const execution = await tools.execute(
    {
      argumentsJson: first.call.argumentsJson,
      callId: first.call.callId,
      name: first.call.name,
      step: 1,
    },
    controller.signal,
  );
  const reasonAfterTool = cancellationReason();
  if (reasonAfterTool !== undefined || (!execution.ok && execution.error.category === "cancelled")) {
    return publishCancellation(
      reasonAfterTool ?? "cancelled",
      config,
      publisher,
      runtime,
      startedAt,
    );
  }

  await publisher.publish(
    // PHASE3: tool result 先 persist，再进入第二个 model turn；模型不会看到未落盘的 observation。
    toolCompletedDraft(
      first.call,
      execution,
      durationMs(runtime, toolStartedAt),
    ),
  );
  if (!execution.ok && execution.error.category === "system") {
    // PHASE3: permission/not_found 等可反馈错误交给模型解释；system 错误表示工具基础设施失效，
    // 直接终止 run，不伪装成正常 observation。
    await publisher.publish({
      data: {
        category: "internal",
        code: execution.error.code,
        duration_ms: durationMs(runtime, startedAt),
        message: execution.error.message,
        retryable: execution.error.retryable,
      },
      type: "run.failed",
    });
    return 1;
  }

  const second = await consumeModelTurn(
    backend,
    {
      input: {
        callId: first.call.callId,
        continuation: first.continuation,
        kind: "tool_result",
        output: execution.output,
      },
      instructions: READONLY_SYSTEM_INSTRUCTIONS,
      timeoutMs: config.timeoutMs,
      tools: [],
      // PHASE3: 第二回合不再提供工具定义，以机械方式限制最多一次工具执行。
    },
    controller,
    publisher,
    cancellationReason,
  );
  if (second.kind === "aborted") {
    const reason = cancellationReason();
    return reason === undefined
      ? publishProviderFailure(
          protocolFailure("unexpected_abort", "model turn was aborted unexpectedly"),
          publisher,
          runtime,
          startedAt,
        )
      : publishCancellation(reason, config, publisher, runtime, startedAt);
  }
  if (second.kind === "failed") {
    return publishProviderFailure(second.error, publisher, runtime, startedAt);
  }
  if (second.call !== undefined) {
    // PHASE3: 即便 provider 在无 tools 的请求中仍返回 function call，也明确以 round limit 失败。
    return publishProviderFailure(
      protocolFailure(
        "tool_round_limit",
        "model requested another tool after the Phase 3 tool limit",
      ),
      publisher,
      runtime,
      startedAt,
    );
  }
  if (!second.sawNonWhitespaceText) {
    return publishProviderFailure(
      protocolFailure("empty_model_output", "provider completed without final text"),
      publisher,
      runtime,
      startedAt,
    );
  }
  await persistTurnBoundary?.({
    continuation: second.continuation,
    pendingCall: false,
    runId: publisher.runId,
    sessionId: publisher.sessionId,
    turn: 2,
  });
  await publishUsage([first.usage, second.usage], publisher);
  return publishCompleted(
    2,
    second.providerResponseId,
    publisher,
    runtime,
    startedAt,
  );
}

export async function runStreamingChat(
  options: ChatCommandOptions,
  runtime: StreamingChatRuntime,
  renderer: StreamingRunRenderer,
): Promise<StreamingChatExitCode> {
  // PHASE2/3 orchestration root：配置 -> session -> event publisher ->
  // model turn -> 可选一次工具 -> model turn -> 唯一 terminal -> 清理关闭。
  let effectivePolicy: EffectiveRuntimePolicy;
  let policyRequest: ResolvedProviderPolicyRequest;
  try {
    const registry = await loadRuntimePolicyRegistry({
      ...(options.policyConfig === undefined ? {} : { configPath: options.policyConfig }),
      env: runtime.env,
      platform: runtime.platform,
      workspace: runtime.cwd,
    });
    effectivePolicy = resolveEffectiveRuntimePolicy(registry, options.policyProfile);
    const requestedProvider = options.provider ?? runtime.env.BORN_PROVIDER;
    policyRequest = resolveProviderPolicyRequest(effectivePolicy, {
      endpoint:
        requestedProvider?.trim().toLowerCase() === "ollama" || requestedProvider === undefined
          ? runtime.env.BORN_OLLAMA_BASE_URL
          : undefined,
      model: options.model ?? runtime.env.BORN_MODEL,
      provider: requestedProvider,
    });
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      return error.exitCode;
    }
    renderer.renderDiagnostic("runtime policy internal error");
    return 1;
  }
  const configResult = resolveChatConfig(
    {
      ...options,
      model: policyRequest.model,
      provider: policyRequest.provider,
    },
    {
      ...runtime.env,
      ...(policyRequest.provider === "ollama"
        ? { BORN_OLLAMA_BASE_URL: policyRequest.endpoint }
        : {}),
    },
  );
  if (!configResult.ok) {
    renderer.renderDiagnostic(`usage/config error: ${configResult.error}`);
    return 2;
  }
  const config = configResult.value;
  let backend: ModelBackend;
  try {
    // PHASE8: selection, credential routing, loopback policy and capabilities
    // are frozen before session creation, so a rejected run leaves no partial log
    // and cannot create a provider request or silently choose a fallback.
    backend = runtime.createModelBackend({
      ...(policyRequest.endpoint === undefined ? {} : { endpoint: policyRequest.endpoint }),
      model: config.model,
      provider: config.provider,
      runtimePolicy: effectivePolicy,
      requirement: {
        cancellation: true,
        completeUsageForReportedTokenCeiling: false,
        streaming: true,
        tools: config.toolsEnabled,
      },
    });
  } catch (error) {
    if (error instanceof BackendPreflightError) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      return error.exitCode;
    }
    if (
      error instanceof Error &&
      "exitCode" in error &&
      (error.exitCode === 2 || error.exitCode === 4)
    ) {
      renderer.renderDiagnostic(`usage/config error: ${error.message}`);
      return error.exitCode;
    }
    renderer.renderDiagnostic("internal protocol error");
    return 1;
  }
  const secrets = credentialSecretsForPolicy(
    effectivePolicy,
    config.provider,
    runtime.env,
  );

  const sessionId = runtime.randomUUID();
  const runId = runtime.randomUUID();
  // PHASE2: 目前一个 session 只有一个 run，但 ID 仍分开，为未来多轮 session 保留语义。
  let writer: SessionWriter;
  try {
    writer = await runtime.createSessionWriter(runtime.cwd, sessionId);
  } catch {
    renderer.renderStorageError();
    return 1;
  }

  const publisher = new EventPublisher({
    randomUUID: runtime.randomUUID,
    renderer,
    runId,
    sessionId,
    timestamp: runtime.timestamp,
    writer,
  });
  const controller = new AbortController();
  // PHASE2: AbortSignal 只说明已中止；另存原因才能区分 timeout 与 Ctrl+C。
  let cancellationReason: CancellationReason | undefined;
  const startedAt = runtime.now();
  const timer = runtime.setTimer(() => {
    if (cancellationReason === undefined) {
      cancellationReason = "timeout";
      controller.abort();
    }
  }, config.timeoutMs);
  const stopListening = runtime.onCancel(() => {
    if (cancellationReason === undefined) {
      cancellationReason = "cancelled";
      controller.abort();
    }
  });
  let exitCode: StreamingChatExitCode;

  try {
    // PHASE2/3: run.started 是 session 第一条事实；无效配置不会创建 session。
    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: config.prompt },
        model: config.model,
        provider: config.provider,
        runtime_policy: persistRuntimePolicyEvidence(effectivePolicy.evidence),
        timeout_ms: config.timeoutMs,
        tools: config.toolsEnabled
          ? ["list_files", "read_file", "search"]
          : [],
        tools_enabled: config.toolsEnabled,
        workspace: runtime.cwd,
      },
      type: "run.started",
    });
    await publisher.publish({
      data: {
        adapter: backend.identity.adapter,
        adapter_version: backend.identity.adapterVersion,
        capabilities: backend.capabilities,
        ...(backend.resume.capability === "exact_checkpoint"
          ? {
              checkpoint_codec_version:
                backend.resume.checkpointCodec.codecVersion,
            }
          : {}),
        config_fingerprint: backend.identity.configFingerprint,
        model: backend.identity.model,
        provider: backend.identity.provider,
        resume_capability: backend.resume.capability,
      },
      type: "backend.selected",
    });
    const tools = config.toolsEnabled
      ? await runtime.createToolRegistry(runtime.cwd, secrets)
      : undefined;
    const turnBoundaryRecorder = createTurnBoundaryRecorder(
      writer,
      backend,
      runtime.cwd,
    );
    exitCode = await runFixedToolRoundTrip(
      config,
      backend,
      tools,
      controller,
      publisher,
      runtime,
      startedAt,
      () => cancellationReason,
      secrets,
      turnBoundaryRecorder,
    );
  } catch (error) {
    // PHASE2: 存储失败后 writer 不可信，不能再尝试补 terminal event。
    controller.abort();
    if (error instanceof EventPersistenceError) {
      renderer.renderStorageError();
      exitCode = 1;
    } else if (cancellationReason !== undefined) {
      try {
        exitCode = await publishCancellation(
          cancellationReason,
          config,
          publisher,
          runtime,
          startedAt,
        );
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
        await publisher.publish({
          data: {
            category: "internal",
            code: "internal_error",
            duration_ms: durationMs(runtime, startedAt),
            message: "internal protocol error",
            retryable: false,
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
    // PHASE2: 无论成功、失败还是取消，都撤销计时器和 SIGINT listener。
    runtime.clearTimer(timer);
    stopListening();
  }

  try {
    // PHASE2: close 失败会把命令结果降级为内部错误。
    await writer.close();
  } catch {
    renderer.renderStorageError();
    return 1;
  }
  return exitCode;
}
