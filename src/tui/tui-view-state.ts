export type TuiRunStatus =
  | "budget_exceeded"
  | "cancelled"
  | "completed"
  | "failed"
  | "incomplete"
  | "running";

export interface SessionView {
  readonly actionBlocked: boolean;
  readonly fatalReason: string | null;
  readonly id: string | null;
  readonly lastSessionSeq: number;
  readonly resumeBlocked: boolean;
}

export interface RunView {
  readonly acceptedCompletionCallId: string | null;
  readonly acceptedCompletionStep: number | null;
  readonly command: "agent" | "chat";
  readonly completionProof: "accepted" | "candidate" | "none" | "rejected";
  readonly currentStep: number | null;
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly runExitCode: number | null;
  readonly status: TuiRunStatus;
  readonly taskProfile: "coding" | "read-only";
  readonly workspace: string;
}

export interface ContextView {
  readonly absoluteInputTokens: number | null;
  readonly compacting: boolean;
  readonly epoch: number;
  readonly estimatedInputTokens: number | null;
  readonly protectedEstimatedTokens: number | null;
}

export type ApprovalExpiryReason =
  | "cancelled"
  | "decided"
  | "new_request"
  | "run_terminal"
  | "workspace_or_action_changed";

export interface ApprovalView {
  readonly actionKind:
    | "apply_patch"
    | "mcp.server.start"
    | "mcp.tool.call"
    | "run_command";
  readonly actionSha256: string;
  readonly callId: string;
  readonly decision: "approved" | "cancelled" | "denied" | null;
  readonly expiresState:
    | { readonly status: "active" }
    | {
        readonly reason: ApprovalExpiryReason;
        readonly status: "expired";
      };
  readonly preview: string;
  readonly previewSha256: string;
  readonly previewTruncated: boolean;
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
}

export interface UserTranscriptViewItem {
  readonly id: string;
  readonly kind: "user";
  readonly runId: string;
  readonly text: string;
}

export interface ModelTranscriptViewItem {
  readonly id: string;
  readonly kind: "model";
  readonly runId: string;
  readonly step: number;
  readonly status: "accepted" | "candidate" | "rejected" | "streaming";
  readonly text: string;
  readonly truncated: boolean;
  readonly visibility: "internal_candidate" | "user_visible";
}

export interface ToolTranscriptViewItem {
  readonly callId: string;
  readonly id: string;
  readonly kind: "tool";
  readonly output: string;
  readonly runId: string;
  readonly status: "error" | "requested" | "success";
  readonly toolName: string;
  readonly truncated: boolean;
}

export interface PatchTranscriptViewItem {
  readonly addedLines: number;
  readonly id: string;
  readonly kind: "patch";
  readonly planId: string;
  readonly preview: string;
  readonly removedLines: number;
  readonly runId: string;
  readonly status: "applied" | "applying" | "awaiting_approval" | "planned";
  readonly truncated: boolean;
}

export interface CommandTranscriptViewItem {
  readonly artifactId: string | null;
  readonly bytes: number;
  readonly executionId: string;
  readonly id: string;
  readonly kind: "command";
  readonly output: string;
  readonly runId: string;
  readonly status: "completed" | "requested" | "running";
  readonly termination: string | null;
  readonly truncated: boolean;
}

export interface VerificationTranscriptViewItem {
  readonly generation: number;
  readonly id: string;
  readonly kind: "verification";
  readonly runId: string;
  readonly stale: boolean;
  readonly status: "failed" | "passed" | "running" | "stale";
  readonly verificationId: string;
}

export interface CompletionTranscriptViewItem {
  readonly callId: string;
  readonly id: string;
  readonly kind: "completion";
  readonly reasons: readonly string[];
  readonly runId: string;
  readonly status: "accepted" | "candidate" | "error" | "incomplete" | "rejected";
  readonly summary: string;
}

export interface ContextTranscriptViewItem {
  readonly id: string;
  readonly kind: "context";
  readonly label: string;
  readonly runId: string;
}

export interface ArtifactTranscriptViewItem {
  readonly artifactId: string | null;
  readonly bytes: number;
  readonly id: string;
  readonly kind: "artifact";
  readonly runId: string;
  readonly status: "stored" | "truncated";
}

export interface SessionTranscriptViewItem {
  readonly id: string;
  readonly kind: "session";
  readonly label: string;
  readonly runId: string | null;
}

export interface UnsupportedTranscriptViewItem {
  readonly eventType: string;
  readonly id: string;
  readonly kind: "unsupported";
  readonly runId: string | null;
}

export type TranscriptViewItem =
  | ApprovalTranscriptViewItem
  | ArtifactTranscriptViewItem
  | CommandTranscriptViewItem
  | CompletionTranscriptViewItem
  | ContextTranscriptViewItem
  | ModelTranscriptViewItem
  | PatchTranscriptViewItem
  | SessionTranscriptViewItem
  | ToolTranscriptViewItem
  | UnsupportedTranscriptViewItem
  | UserTranscriptViewItem
  | VerificationTranscriptViewItem;

export interface ApprovalTranscriptViewItem {
  readonly actionKind: ApprovalView["actionKind"];
  readonly id: string;
  readonly kind: "approval";
  readonly requestId: string;
  readonly runId: string;
  readonly status: "approved" | "cancelled" | "denied" | "expired" | "requested";
}

export interface TuiViewState {
  readonly approval: ApprovalView | null;
  readonly context: ContextView;
  readonly run: RunView | null;
  readonly session: SessionView;
  readonly transcript: readonly TranscriptViewItem[];
}

export function createInitialTuiViewState(): TuiViewState {
  return {
    approval: null,
    context: {
      absoluteInputTokens: null,
      compacting: false,
      epoch: 0,
      estimatedInputTokens: null,
      protectedEstimatedTokens: null,
    },
    run: null,
    session: {
      actionBlocked: false,
      fatalReason: null,
      id: null,
      lastSessionSeq: 0,
      resumeBlocked: false,
    },
    transcript: [],
  };
}

export function isActiveRun(run: RunView | null): boolean {
  return run?.status === "running";
}
