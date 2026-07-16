import type {
  AgentBudgetReason,
  AgentLoopConfig,
} from "./agent-types.js";

export interface BudgetClock {
  now(): number;
}

export interface BudgetSnapshot {
  readonly elapsedMs: number;
  readonly steps: number;
  readonly toolOutputBytes: number;
  readonly totalTokens: number;
}

export interface BudgetExceeded {
  readonly limit: number;
  readonly observed: number;
  readonly reason: Exclude<AgentBudgetReason, "repeated_tool_call">;
}

export interface RemainingBudget {
  readonly durationMs: number;
  readonly tokens: number;
  readonly toolOutputBytes: number;
}

interface ReportedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export class BudgetTracker {
  // PHASE4: Tracker 只记已发生且可审计的消耗；它不主动 abort，也不发布事件。
  private steps = 0;
  private toolOutputBytes = 0;
  private totalTokens = 0;

  constructor(
    private readonly config: AgentLoopConfig,
    private readonly clock: BudgetClock,
    private readonly startedAt: number = clock.now(),
  ) {}

  elapsedMs(): number {
    return Math.max(0, Math.round(this.clock.now() - this.startedAt));
  }

  beginStep(): number {
    // PHASE4: step 代表一次真实 model response，在请求发出前递增并写入 agent.step.started。
    this.steps += 1;
    return this.steps;
  }

  recordUsage(usage: ReportedTokenUsage): void {
    // PHASE4/8: token 只采用 provider reported complete usage，不根据字符数进行猜测；
    // capability preflight 和 AgentLoop 的 turn-boundary check 会阻止 partial/none 进入这里。
    this.totalTokens += usage.totalTokens;
  }

  recordToolOutput(output: string): void {
    // PHASE4: 工具 observation 按 UTF-8 bytes 计费；中文和 emoji 不能用 JS string.length 代替。
    this.toolOutputBytes += Buffer.byteLength(output, "utf8");
  }

  snapshot(): BudgetSnapshot {
    return {
      elapsedMs: this.elapsedMs(),
      steps: this.steps,
      toolOutputBytes: this.toolOutputBytes,
      totalTokens: this.totalTokens,
    };
  }

  remaining(): RemainingBudget {
    const snapshot = this.snapshot();
    return {
      durationMs: Math.max(0, this.config.maxDurationMs - snapshot.elapsedMs),
      tokens: Math.max(0, this.config.maxTokens - snapshot.totalTokens),
      toolOutputBytes: Math.max(
        0,
        this.config.maxToolOutputBytes - snapshot.toolOutputBytes,
      ),
    };
  }

  checkBeforeStep(): BudgetExceeded | undefined {
    // PHASE4: pre-step gate 决定是否允许下一次模型请求，并固定检查优先级以保持终态可复现。
    const snapshot = this.snapshot();
    if (snapshot.elapsedMs >= this.config.maxDurationMs) {
      return {
        limit: this.config.maxDurationMs,
        observed: snapshot.elapsedMs,
        reason: "max_duration",
      };
    }
    if (snapshot.steps >= this.config.maxSteps) {
      return {
        limit: this.config.maxSteps,
        observed: snapshot.steps,
        reason: "max_steps",
      };
    }
    if (snapshot.totalTokens >= this.config.maxTokens) {
      return {
        limit: this.config.maxTokens,
        observed: snapshot.totalTokens,
        reason: "max_tokens",
      };
    }
    if (snapshot.toolOutputBytes >= this.config.maxToolOutputBytes) {
      return {
        limit: this.config.maxToolOutputBytes,
        observed: snapshot.toolOutputBytes,
        reason: "max_tool_output",
      };
    }
    return undefined;
  }

  checkAfterModelForMoreWork(): BudgetExceeded | undefined {
    // PHASE4: 模型若已经给出 final，可直接完成；只有它还请求工具时才检查是否允许继续动作。
    const snapshot = this.snapshot();
    if (snapshot.elapsedMs >= this.config.maxDurationMs) {
      return {
        limit: this.config.maxDurationMs,
        observed: snapshot.elapsedMs,
        reason: "max_duration",
      };
    }
    if (snapshot.totalTokens >= this.config.maxTokens) {
      return {
        limit: this.config.maxTokens,
        observed: snapshot.totalTokens,
        reason: "max_tokens",
      };
    }
    return undefined;
  }

  checkAfterToolOutput(): BudgetExceeded | undefined {
    // PHASE4: observation 已持久化后再计入累计预算；超限时禁止把它送入下一 model step。
    const snapshot = this.snapshot();
    if (snapshot.elapsedMs >= this.config.maxDurationMs) {
      return {
        limit: this.config.maxDurationMs,
        observed: snapshot.elapsedMs,
        reason: "max_duration",
      };
    }
    if (snapshot.totalTokens >= this.config.maxTokens) {
      return {
        limit: this.config.maxTokens,
        observed: snapshot.totalTokens,
        reason: "max_tokens",
      };
    }
    if (snapshot.toolOutputBytes >= this.config.maxToolOutputBytes) {
      return {
        limit: this.config.maxToolOutputBytes,
        observed: snapshot.toolOutputBytes,
        reason: "max_tool_output",
      };
    }
    return undefined;
  }
}
