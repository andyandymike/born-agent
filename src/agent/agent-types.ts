import type { ChatProvider } from "../chat/types.js";

export interface AgentCommandOptions {
  readonly maxDurationMs: string | undefined;
  readonly maxSteps: string | undefined;
  readonly maxTokens: string | undefined;
  readonly maxToolOutputBytes: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly requestTimeoutMs: string | undefined;
  readonly task: string;
  readonly verbose: boolean;
}

export interface AgentLoopConfig {
  // PHASE4: 这些都是一次 run 的硬边界；requestTimeoutMs 例外，它只约束单个模型请求。
  readonly maxDurationMs: number;
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxToolOutputBytes: number;
  readonly requestTimeoutMs: number;
}

export interface ResolvedAgentConfig extends AgentLoopConfig {
  readonly model: string;
  readonly ollamaBaseURL?: string;
  readonly provider: ChatProvider;
  readonly task: string;
  readonly verbose: boolean;
}

export type AgentBudgetReason =
  // PHASE4: budget_exceeded 是可解释的策略终止，不与 provider/internal failure 混为一类。
  | "max_steps"
  | "max_duration"
  | "max_tokens"
  | "max_tool_output"
  | "repeated_tool_call";

export type AgentExitCode = 0 | 1 | 2 | 4 | 5 | 6 | 7 | 130;

export type AgentTerminal =
  // PHASE4: AgentLoop 返回结构化终态，外层 command 只负责资源关闭和转换成进程退出码。
  | { readonly exitCode: 0; readonly type: "completed" }
  | { readonly exitCode: 1 | 4 | 5 | 6; readonly type: "failed" }
  | { readonly exitCode: 7; readonly reason: AgentBudgetReason; readonly type: "budget_exceeded" }
  | { readonly exitCode: 130; readonly type: "cancelled" };

export interface AgentClock {
  clearTimer(handle: unknown): void;
  now(): number;
  setTimer(listener: () => void, delayMs: number): unknown;
}
