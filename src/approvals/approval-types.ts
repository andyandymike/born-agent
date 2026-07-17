import type { OutputWriter } from "../cli/types.js";

export type ApprovalDecision = "approved" | "cancelled" | "denied";

export interface ApprovalPath {
  readonly kind: "create" | "modify";
  readonly path: string;
}

export interface PatchApprovalPreview {
  readonly actionKind: "apply_patch";
  readonly addedLines: number;
  readonly paths: readonly ApprovalPath[];
  readonly planId: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly removedLines: number;
}

export interface CommandApprovalPreview {
  readonly actionKind: "run_command";
  readonly actionSha256: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executable: string;
  readonly purpose: "inspect" | "verify";
  readonly reviewLines: readonly string[];
  readonly riskWarning: string;
}

export interface McpApprovalPreview {
  readonly actionKind: "mcp.server.start" | "mcp.tool.call";
  readonly actionSha256: string;
  readonly reviewLines: readonly string[];
  readonly riskWarning: string;
  readonly title: string;
}

export type ApprovalPreview =
  | CommandApprovalPreview
  | McpApprovalPreview
  | PatchApprovalPreview;

export interface ApprovalPrompt {
  request(
    preview: ApprovalPreview,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
}

export interface ApprovalLineReader {
  readonly interactive: boolean;
  readLine(signal: AbortSignal): Promise<string | null>;
}

export interface TerminalApprovalPromptOptions extends ApprovalLineReader {
  readonly output: OutputWriter;
}
