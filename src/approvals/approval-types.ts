import type { OutputWriter } from "../cli/types.js";

export type ApprovalDecision = "approved" | "cancelled" | "denied";

export interface ApprovalPath {
  readonly kind: "create" | "modify";
  readonly path: string;
}

export interface PatchApprovalPreview {
  readonly actionSha256?: string;
  readonly actionKind: "apply_patch";
  readonly addedLines: number;
  readonly paths: readonly ApprovalPath[];
  readonly planId: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly removedLines: number;
  readonly ruleManifestSha256?: string;
  readonly ruleScopeSetSha256?: string;
}

export interface CommandApprovalPreview {
  readonly actionKind: "run_command";
  readonly actionSha256: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly executor?: "docker" | "local";
  readonly executable: string;
  readonly purpose: "inspect" | "verify";
  readonly reviewLines: readonly string[];
  readonly riskWarning: string;
}

export interface McpApprovalPreview {
  readonly actionKind:
    | "mcp.server.start"
    | "mcp.tool.call"
    | "mcp.resource.read"
    | "mcp.prompt.get";
  readonly actionSha256: string;
  readonly reviewLines: readonly string[];
  readonly riskWarning: string;
  readonly title: string;
}

export interface WorktreeAllocationApprovalPreview {
  readonly actionKind: "task_worktree.allocate";
  readonly actionSha256: string;
  readonly baseCommit: string;
  readonly dirtyEntries: readonly string[];
  readonly fileCount: number;
  readonly graphId: string;
  readonly nodeIds: readonly string[];
  readonly requestedBytes: number;
  readonly workspaceId: string;
}

export interface WorktreePromotionApprovalPreview {
  readonly actionKind: "task_worktree.promote";
  readonly actionSha256: string;
  readonly bundleSha256: string;
  readonly changedBytes: number;
  readonly graphId: string;
  readonly nodeId: string;
  readonly paths: readonly string[];
  readonly targetSnapshotSha256: string;
  readonly workspaceId: string;
}

export interface WorktreeCleanupApprovalPreview {
  readonly actionKind: "task_worktree.cleanup";
  readonly actionSha256: string;
  readonly archiveSha256: string;
  readonly bytes: number;
  readonly files: number;
  readonly graphId: string;
  readonly workspaceId: string;
}

export type ApprovalPreview =
  | CommandApprovalPreview
  | McpApprovalPreview
  | PatchApprovalPreview
  | WorktreeAllocationApprovalPreview
  | WorktreeCleanupApprovalPreview
  | WorktreePromotionApprovalPreview;

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
