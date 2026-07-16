import type { ChatUsage } from "../chat/types.js";
import type { ProviderFailure } from "../chat/stream-types.js";
import type { EventPublisher } from "../events/event-publisher.js";
import type {
  ModelContinuation,
  ModelToolCall,
  ModelTurnClient,
  ModelTurnInput,
  ModelTurnRequest,
} from "../model/model-turn-types.js";
import { redactSensitiveText } from "../security/redact.js";
import type { ToolExecution, ToolRegistryLike } from "../tools/tool-types.js";
import type {
  AgentClock,
  AgentLoopConfig,
  AgentTerminal,
} from "./agent-types.js";
import type { BudgetExceeded, BudgetTracker } from "./budget-tracker.js";
import { RepetitionDetector } from "./repetition-detector.js";
import { AGENT_SYSTEM_INSTRUCTIONS } from "./system-instructions.js";

type RunAbortReason = "max_duration" | "user";

interface CompletedTurn {
  readonly call?: ModelToolCall;
  readonly continuation: ModelContinuation;
  readonly kind: "completed";
  readonly providerResponseId?: string;
  readonly sawNonWhitespaceText: boolean;
  readonly textChars: number;
  readonly usage?: ChatUsage;
}

type TurnResult =
  | CompletedTurn
  | { readonly error: ProviderFailure; readonly kind: "failed" }
  | { readonly kind: "aborted" };

export interface AgentLoopDeps {
  // PHASE4: Loop 只依赖 provider-neutral model、只读 Registry、Publisher、预算和时钟，
  // 因此测试无需真实网络、磁盘、timer 或子进程。
  readonly budget: BudgetTracker;
  readonly clock: AgentClock;
  readonly instructions?: string;
  readonly model: ModelTurnClient;
  readonly modelId: string;
  readonly publisher: EventPublisher;
  readonly secrets?: readonly (string | undefined)[];
  readonly tools: ToolRegistryLike;
}

interface RequestAbortState {
  readonly controller: AbortController;
  readonly timedOut: () => boolean;
  cleanup(): void;
}

function protocolFailure(code: string, message: string): ProviderFailure {
  return { category: "protocol", code, message, retryable: false };
}

function providerExitCode(error: ProviderFailure): 1 | 4 | 5 {
  if (error.category === "auth") return 4;
  return error.category === "protocol" ? 1 : 5;
}

function safeToolArguments(
  argumentsJson: string,
  secrets: readonly (string | undefined)[],
): string {
  const redacted = redactSensitiveText(argumentsJson, secrets);
  return Buffer.byteLength(redacted, "utf8") <= 16 * 1024
    ? redacted
    : '{"omitted":"arguments_too_large"}';
}

function toolCompletedData(
  call: ModelToolCall,
  execution: ToolExecution,
  step: number,
  durationMs: number,
) {
  return {
    call_id: call.callId,
    duration_ms: durationMs,
    ...(execution.ok
      ? {}
      : {
          error_category: execution.error.category,
          error_code: execution.error.code,
          retryable: execution.error.retryable,
        }),
    output: execution.output,
    status: execution.ok ? ("success" as const) : ("error" as const),
    step,
    tool_name: call.name,
    truncated: execution.truncated,
  };
}

async function consumeModelTurn(
  client: ModelTurnClient,
  request: ModelTurnRequest,
  requestAbort: RequestAbortState,
  publisher: EventPublisher,
): Promise<TurnResult> {
  // PHASE4: 一个 model turn 内聚合最多一个 tool call/usage，并把 text delta 立即持久化渲染。
  // provider 的 turn_completed 仍不等于整个 Agent run 完成。
  let call: ModelToolCall | undefined;
  let usage: ChatUsage | undefined;
  let sawNonWhitespaceText = false;
  let textChars = 0;

  for await (const signal of client.streamTurn(
    request,
    requestAbort.controller.signal,
  )) {
    if (requestAbort.controller.signal.aborted) return { kind: "aborted" };
    switch (signal.type) {
      case "text_delta":
        if (signal.delta.length > 0) {
          sawNonWhitespaceText ||= signal.delta.trim().length > 0;
          textChars += signal.delta.length;
          await publisher.publish({
            data: { delta: signal.delta },
            type: "text.delta",
          });
        }
        break;
      case "tool_call":
        // PHASE4: 单 response 多 tool call 在执行任何工具前 fail closed；并行工具留给后续阶段。
        if (call !== undefined) {
          return {
            error: protocolFailure(
              "multiple_tool_calls",
              "provider returned more than one tool call",
            ),
            kind: "failed",
          };
        }
        call = signal.call;
        break;
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
      case "turn_completed":
        return {
          ...(call === undefined ? {} : { call }),
          continuation: signal.continuation,
          kind: "completed",
          ...(signal.providerResponseId === undefined
            ? {}
            : { providerResponseId: signal.providerResponseId }),
          sawNonWhitespaceText,
          textChars,
          ...(usage === undefined ? {} : { usage }),
        };
    }
  }

  return requestAbort.controller.signal.aborted
    ? { kind: "aborted" }
    : {
        error: protocolFailure(
          "stream_ended_without_terminal",
          "provider stream ended without a terminal event",
        ),
        kind: "failed",
      };
}

export async function runAgentLoop(
  task: string,
  config: AgentLoopConfig,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<AgentTerminal> {
  // PHASE4: 这是独立 AgentLoop 的 orchestration root；外层 executeAgent 负责创建/关闭资源。
  const { budget, clock, publisher } = deps;
  const usages: ChatUsage[] = [];
  const repetition = new RepetitionDetector();
  const runController = new AbortController();
  let runAbortReason: RunAbortReason | undefined;
  let aggregateUsagePublished = false;
  // PHASE4: 第一步消费 user task；每次工具完成后改为携带 continuation 的 tool_result。
  let pendingInput: ModelTurnInput = { kind: "user_prompt", text: task };
  let lastProviderResponseId: string | undefined;

  const abortRun = (reason: RunAbortReason) => {
    // PHASE4: AbortSignal 只携带“已中止”，独立保存最先发生的原因，才能把用户取消、
    // global deadline 和单 request timeout 映射为不同终态与退出码。
    if (runAbortReason === undefined) {
      runAbortReason = reason;
      runController.abort();
    }
  };
  const onUserAbort = () => abortRun("user");
  if (signal.aborted) onUserAbort();
  else signal.addEventListener("abort", onUserAbort, { once: true });

  const remainingDuration = Math.max(
    0,
    config.maxDurationMs - budget.elapsedMs(),
  );
  const durationTimer = clock.setTimer(
    // PHASE4: global deadline 覆盖 model、tool 和 step 间隙；它与每次请求自己的 timeout 分开。
    () => abortRun("max_duration"),
    remainingDuration,
  );

  const publishAggregateUsage = async () => {
    // PHASE4: run 级 usage 必须精确等于所有 step 的 model.usage 聚合；缺失任一步时不发布。
    if (
      aggregateUsagePublished ||
      usages.length === 0 ||
      usages.length !== publisher.startedAgentSteps
    ) {
      return;
    }
    const cached = usages
      .map((usage) => usage.cachedInputTokens)
      .filter((value) => value !== undefined);
    await publisher.publish({
      data: {
        ...(cached.length === 0
          ? {}
          : { cached_input_tokens: cached.reduce((sum, value) => sum + value, 0) }),
        input_tokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
        model_turns: usages.length,
        output_tokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
        total_tokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
      },
      type: "usage",
    });
    aggregateUsagePublished = true;
  };

  const publishCancelled = async (): Promise<AgentTerminal> => {
    await publishAggregateUsage();
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
    return { exitCode: 130, type: "cancelled" };
  };

  const publishBudget = async (
    exceeded: BudgetExceeded | {
      readonly limit: number;
      readonly observed: number;
      readonly reason: "repeated_tool_call";
    },
  ): Promise<AgentTerminal> => {
    // PHASE4: 预算耗尽使用独立 terminal/exit 7，表明这是受控策略停止而非程序故障。
    await publishAggregateUsage();
    const snapshot = budget.snapshot();
    const observed =
      exceeded.reason === "max_duration"
        ? Math.max(exceeded.limit, exceeded.observed, snapshot.elapsedMs)
        : exceeded.observed;
    const duration =
      exceeded.reason === "max_duration"
        ? observed
        : snapshot.elapsedMs;
    await publisher.publish({
      data: {
        duration_ms: duration,
        limit: exceeded.limit,
        observed,
        output_chars: publisher.outputLength,
        reason: exceeded.reason,
        steps: snapshot.steps,
        tool_calls: publisher.completedToolCalls,
      },
      type: "run.budget_exceeded",
    });
    return {
      exitCode: 7,
      reason: exceeded.reason,
      type: "budget_exceeded",
    };
  };

  const publishFailure = async (
    error: ProviderFailure,
  ): Promise<AgentTerminal> => {
    const snapshot = budget.snapshot();
    await publisher.publish({
      data: {
        category: error.category,
        code: error.code,
        duration_ms: snapshot.elapsedMs,
        message: redactSensitiveText(error.message, deps.secrets ?? []),
        output_chars: publisher.outputLength,
        ...(error.providerRequestId === undefined
          ? {}
          : { provider_request_id: error.providerRequestId }),
        retryable: error.retryable,
        steps: snapshot.steps,
        tool_calls: publisher.completedToolCalls,
      },
      type: "run.failed",
    });
    return { exitCode: providerExitCode(error), type: "failed" };
  };

  const publishInternalFailure = async (
    code: string,
    message: string,
    retryable = false,
  ): Promise<AgentTerminal> => {
    await publishAggregateUsage();
    const snapshot = budget.snapshot();
    await publisher.publish({
      data: {
        category: "internal",
        code,
        duration_ms: snapshot.elapsedMs,
        message: redactSensitiveText(message, deps.secrets ?? []),
        output_chars: publisher.outputLength,
        retryable,
        steps: snapshot.steps,
        tool_calls: publisher.completedToolCalls,
      },
      type: "run.failed",
    });
    return { exitCode: 1, type: "failed" };
  };

  const createRequestAbort = (): RequestAbortState => {
    // PHASE4: 每个 provider request 有子 controller；它同时继承 run abort，并单独记录 request timeout。
    const controller = new AbortController();
    let timedOut = false;
    const onRunAbort = () => controller.abort();
    if (runController.signal.aborted) controller.abort();
    else runController.signal.addEventListener("abort", onRunAbort, { once: true });
    const timer = clock.setTimer(() => {
      if (!controller.signal.aborted) {
        timedOut = true;
        controller.abort();
      }
    }, config.requestTimeoutMs);
    return {
      cleanup: () => {
        clock.clearTimer(timer);
        runController.signal.removeEventListener("abort", onRunAbort);
      },
      controller,
      timedOut: () => timedOut,
    };
  };

  try {
    // PHASE4: 真正的 Agent Loop。唯一正常退出是 final answer；其余路径都发布明确 terminal。
    while (true) {
      if (runAbortReason === "user") return await publishCancelled();
      if (runAbortReason === "max_duration") {
        return await publishBudget({
          limit: config.maxDurationMs,
          observed: budget.elapsedMs(),
          reason: "max_duration",
        });
      }
      const beforeStep = budget.checkBeforeStep();
      // PHASE4: pre-step gate 判断“下一次 model response 是否获准”；最后允许 step
      // 若请求工具，工具结果仍会落盘，只有回到这里时才由 maxSteps 阻止额外 model call。
      if (beforeStep !== undefined) return await publishBudget(beforeStep);

      const step = budget.beginStep();
      const remaining = budget.remaining();
      // PHASE4: step.started 在模型请求前持久化；写盘失败时该请求不会发生。
      await publisher.publish({
        data: {
          input_kind: step === 1 ? "user_task" : "tool_result",
          max_steps: config.maxSteps,
          remaining_duration_ms: remaining.durationMs,
          remaining_tokens: remaining.tokens,
          remaining_tool_output_bytes: remaining.toolOutputBytes,
          step,
        },
        type: "agent.step.started",
      });

      const stepStartedAt = clock.now();
      const requestAbort = createRequestAbort();
      let turn: TurnResult;
      try {
        // PHASE4: 每一步都继续提供完整只读工具集，这是与 Phase 3 第二回合 tools:[] 的关键区别。
        turn = await consumeModelTurn(
          deps.model,
          {
            input: pendingInput,
            instructions: deps.instructions ?? AGENT_SYSTEM_INSTRUCTIONS,
            model: deps.modelId,
            timeoutMs: config.requestTimeoutMs,
            tools: deps.tools.modelDefinitions,
          },
          requestAbort,
          publisher,
        );
      } finally {
        requestAbort.cleanup();
      }

      if (turn.kind === "aborted") {
        // PHASE4: 同一个 abort 结果要按首个真实原因映射为 user/global/request 三种不同终态。
        if (runAbortReason === "user") return await publishCancelled();
        if (runAbortReason === "max_duration") {
          return await publishBudget({
            limit: config.maxDurationMs,
            observed: budget.elapsedMs(),
            reason: "max_duration",
          });
        }
        if (requestAbort.timedOut()) {
          const snapshot = budget.snapshot();
          await publisher.publish({
            data: {
              category: "timeout",
              code: "request_timeout",
              duration_ms: snapshot.elapsedMs,
              message: `request timed out after ${config.requestTimeoutMs} ms`,
              output_chars: publisher.outputLength,
              retryable: true,
              steps: snapshot.steps,
              tool_calls: publisher.completedToolCalls,
            },
            type: "run.failed",
          });
          return { exitCode: 6, type: "failed" };
        }
        return await publishInternalFailure(
          "unexpected_abort",
          "model turn was aborted unexpectedly",
        );
      }
      if (turn.kind === "failed") return await publishFailure(turn.error);

      // PHASE4: provider 的 turn_completed 只闭合一个 model step；只有后续确认该 turn
      // 没有 tool call 且含非空文本，整个 run 才能发布 run.completed。
      lastProviderResponseId = turn.providerResponseId;
      if (turn.usage !== undefined) {
        budget.recordUsage(turn.usage);
        usages.push(turn.usage);
        await publisher.publish({
          data: {
            ...(turn.usage.cachedInputTokens === undefined
              ? {}
              : { cached_input_tokens: turn.usage.cachedInputTokens }),
            input_tokens: turn.usage.inputTokens,
            output_tokens: turn.usage.outputTokens,
            ...(turn.providerResponseId === undefined
              ? {}
              : { provider_response_id: turn.providerResponseId }),
            step,
            total_tokens: turn.usage.totalTokens,
          },
          type: "model.usage",
        });
      }

      if (turn.call !== undefined) {
        // PHASE4: step.completed 先闭合模型决策，随后 tool.call.requested 才记录待执行动作。
        if (
          !/^[a-z][a-z0-9_]{0,63}$/u.test(turn.call.name) ||
          turn.call.callId.length === 0 ||
          turn.call.callId.length > 200
        ) {
          return await publishFailure(
            protocolFailure("invalid_tool_call", "provider returned invalid tool call metadata"),
          );
        }
        await publisher.publish({
          data: {
            duration_ms: Math.max(0, Math.round(clock.now() - stepStartedAt)),
            outcome: "tool_call",
            ...(turn.providerResponseId === undefined
              ? {}
              : { provider_response_id: turn.providerResponseId }),
            step,
            text_chars: turn.textChars,
            tool_call_id: turn.call.callId,
          },
          type: "agent.step.completed",
        });
      } else {
        await publisher.publish({
          data: {
            duration_ms: Math.max(0, Math.round(clock.now() - stepStartedAt)),
            outcome: "final",
            ...(turn.providerResponseId === undefined
              ? {}
              : { provider_response_id: turn.providerResponseId }),
            step,
            text_chars: turn.textChars,
          },
          type: "agent.step.completed",
        });
      }

      if (turn.usage === undefined) {
        // PHASE4: token ceiling 只信任 provider reported usage；缺失时不能用字符数猜测，
        // 也不能在未知消耗上继续下一 step，因此在完整 turn 边界 fail closed。
        return await publishInternalFailure(
          "usage_required_for_budget",
          "provider did not report usage required by the token budget",
        );
      }

      if (turn.call === undefined) {
        // PHASE4: 无 tool call + 非空文本才是 final；单纯 response completed 不足以完成 run。
        if (!turn.sawNonWhitespaceText) {
          return await publishFailure(
            protocolFailure(
              "empty_model_output",
              "provider completed without final text",
            ),
          );
        }
        if (runAbortReason === "user") return await publishCancelled();
        if (runAbortReason === "max_duration") {
          return await publishBudget({
            limit: config.maxDurationMs,
            observed: budget.elapsedMs(),
            reason: "max_duration",
          });
        }
        await publishAggregateUsage();
        await publisher.publish({
          data: {
            duration_ms: budget.elapsedMs(),
            model_turns: budget.snapshot().steps,
            output_chars: publisher.outputLength,
            ...(lastProviderResponseId === undefined
              ? {}
              : { provider_response_id: lastProviderResponseId }),
            steps: budget.snapshot().steps,
            tool_calls: publisher.completedToolCalls,
          },
          type: "run.completed",
        });
        return { exitCode: 0, type: "completed" };
      }

      // PHASE4: token/duration 是执行前置门禁；超限后不能把未被允许的
      // tool call 持久化成 requested 事实，否则重放会误判为一次被中断的真实动作。
      if (runAbortReason === "user") return await publishCancelled();
      if (runAbortReason === "max_duration") {
        return await publishBudget({
          limit: config.maxDurationMs,
          observed: budget.elapsedMs(),
          reason: "max_duration",
        });
      }
      const afterModel = budget.checkAfterModelForMoreWork();
      if (afterModel !== undefined) return await publishBudget(afterModel);

      const repeated = repetition.observe(
        turn.call.name,
        turn.call.argumentsJson,
      );
      // PHASE4: fingerprint 先规范化 JSON key 顺序再 hash，使等价参数稳定相同；
      // 连续第三次在 Registry executor 前阻止，避免把模型死循环变成真实重复工作。
      await publisher.publish({
        data: {
          arguments_json: safeToolArguments(
            turn.call.argumentsJson,
            deps.secrets ?? [],
          ),
          call_id: turn.call.callId,
          fingerprint: repeated.fingerprint,
          ...(turn.providerResponseId === undefined
            ? {}
            : { provider_response_id: turn.providerResponseId }),
          step,
          tool_name: turn.call.name,
        },
        type: "tool.call.requested",
      });
      // PHASE4: requested 成为审计事实后，仅剩重复策略决定是否执行真实工具。

      if (repeated.blocked) {
        const execution: ToolExecution = {
          error: {
            category: "limit",
            code: "repeated_call_blocked",
            message: "identical tool call was blocked before execution",
            retryable: false,
          },
          ok: false,
          output:
            '{"error":{"category":"limit","code":"repeated_call_blocked","message":"identical tool call was blocked before execution","retryable":false},"ok":false}',
          truncated: false,
        };
        await publisher.publish({
          data: toolCompletedData(turn.call, execution, step, 0),
          type: "tool.call.completed",
        });
        return await publishBudget({
          limit: 3,
          observed: repeated.count,
          reason: "repeated_tool_call",
        });
      }

      const toolStartedAt = clock.now();
      // PHASE4: 所有 step 共用 run AbortSignal，Ctrl+C/global deadline 能终止正在运行的 rg。
      const execution = await deps.tools.execute(
        {
          argumentsJson: turn.call.argumentsJson,
          callId: turn.call.callId,
          name: turn.call.name,
          step,
        },
        runController.signal,
      );
      if (runAbortReason === "user") return await publishCancelled();
      if (runAbortReason === "max_duration") {
        return await publishBudget({
          limit: config.maxDurationMs,
          observed: budget.elapsedMs(),
          reason: "max_duration",
        });
      }

      await publisher.publish({
        // PHASE4: observation 先 persist；只有成功落盘后才可能成为下一 step 的输入。
        data: toolCompletedData(
          turn.call,
          execution,
          step,
          Math.max(0, Math.round(clock.now() - toolStartedAt)),
        ),
        type: "tool.call.completed",
      });
      if (!execution.ok && execution.error.category === "system") {
        return await publishInternalFailure(
          execution.error.code,
          execution.error.message,
          execution.error.retryable,
        );
      }
      if (!execution.ok && execution.error.category === "cancelled") {
        return await publishInternalFailure(
          "unexpected_tool_cancellation",
          "tool execution was cancelled without a run cancellation reason",
        );
      }

      budget.recordToolOutput(execution.output);
      const afterTool = budget.checkAfterToolOutput();
      if (afterTool !== undefined) return await publishBudget(afterTool);
      pendingInput = {
        // PHASE4: continuation 让 provider 保留此前全部回合上下文，output 是刚持久化的 observation。
        callId: turn.call.callId,
        continuation: turn.continuation,
        kind: "tool_result",
        output: execution.output,
      };
    }
  } finally {
    // PHASE4: 所有 terminal 和异常路径都撤销 timer/listener，并 abort 尚未结束的 model/tool 工作。
    clock.clearTimer(durationTimer);
    signal.removeEventListener("abort", onUserAbort);
    runController.abort();
  }
}
