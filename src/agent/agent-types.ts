import type { ChatProvider } from "../chat/types.js";

export interface AgentCommandOptions {
  readonly artifactCaptureBytes?: string | undefined;
  readonly commandApproval: string | undefined;
  readonly commandTimeoutMs: string | undefined;
  readonly completionPolicy: string | undefined;
  readonly contextCompactionThreshold?: string | undefined;
  readonly contextReserveOutputTokens?: string | undefined;
  readonly contextWindowTokens?: string | undefined;
  readonly editApproval: string | undefined;
  readonly maxDurationMs: string | undefined;
  readonly maxCommandOutputBytes: string | undefined;
  readonly maxSteps: string | undefined;
  readonly maxTokens: string | undefined;
  readonly maxToolOutputBytes: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly reportFormat: string | undefined;
  readonly requireVerification: string | undefined;
  readonly requestTimeoutMs: string | undefined;
  readonly task: string;
  readonly taskProfile: string | undefined;
  readonly verbose: boolean;
}

export type EditApprovalMode = "ask" | "deny";
export type CommandApprovalMode = "ask" | "deny";
export type CompletionPolicyMode = "verified";
export type ReportFormat = "text" | "json";
export type RequireVerificationMode = "auto";
export type TaskProfile = "coding" | "read-only";

export interface AgentLoopConfig {
  // PHASE4: 这些都是一次 run 的硬边界；requestTimeoutMs 例外，它只约束单个模型请求。
  readonly maxDurationMs: number;
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxToolOutputBytes: number;
  readonly requestTimeoutMs: number;
  readonly reportFormat?: ReportFormat;
  readonly taskProfile?: TaskProfile;
}

export interface ResolvedAgentConfig extends AgentLoopConfig {
  readonly artifactCaptureBytes?: number;
  readonly commandApproval: CommandApprovalMode;
  readonly commandTimeoutMs: number;
  readonly completionPolicy: CompletionPolicyMode;
  readonly contextCompactionThreshold?: number;
  readonly contextReserveOutputTokens?: number;
  readonly contextWindowTokens?: number;
  readonly editApproval: EditApprovalMode;
  readonly model: string;
  readonly maxCommandOutputBytes: number;
  readonly ollamaBaseURL?: string;
  readonly provider: ChatProvider;
  readonly reportFormat: ReportFormat;
  readonly requireVerification: RequireVerificationMode;
  readonly task: string;
  readonly taskProfile: TaskProfile;
  readonly verbose: boolean;
}

export type AgentBudgetReason =
  // PHASE4: budget_exceeded 是可解释的策略终止，不与 provider/internal failure 混为一类。
  | "max_steps"
  | "max_duration"
  | "max_tokens"
  | "max_tool_output"
  | "context_estimate_overflow"
  | "context_protected_overflow"
  | "context_unsafe_compaction"
  | "repeated_tool_call";

export type AgentExitCode = 0 | 1 | 2 | 4 | 5 | 6 | 7 | 8 | 130;

export type AgentTerminal =
  // PHASE4: AgentLoop 返回结构化终态，外层 command 只负责资源关闭和转换成进程退出码。
  | { readonly exitCode: 0; readonly type: "completed" }
  | { readonly exitCode: 1 | 4 | 5 | 6; readonly type: "failed" }
  | { readonly exitCode: 7; readonly reason: AgentBudgetReason; readonly type: "budget_exceeded" }
  | { readonly exitCode: 8; readonly reason: string; readonly type: "incomplete" }
  | { readonly exitCode: 130; readonly type: "cancelled" };

export interface AgentClock {
  clearTimer(handle: unknown): void;
  now(): number;
  setTimer(listener: () => void, delayMs: number): unknown;
}
