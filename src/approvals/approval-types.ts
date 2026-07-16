import type { OutputWriter } from "../cli/types.js";

export type ApprovalDecision = "approved" | "cancelled" | "denied";

export interface ApprovalPath {
  readonly kind: "create" | "modify";
  readonly path: string;
}

export interface ApprovalPreview {
  readonly addedLines: number;
  readonly paths: readonly ApprovalPath[];
  readonly planId: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly removedLines: number;
}

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
