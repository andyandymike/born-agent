import type { OutcomeReport } from "../coordination/outcome-report.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import { initialRepositoryStatusProjection, type RepositoryStatusProjection } from "../repository-intelligence/repository-status-projection.js";
import type { TaskGraphProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskExecutionProjectionV1 } from "../scheduling/task-execution-projector.js";
import type { WorktreeProjectionV1 } from "../worktrees/worktree-projector.js";
import type { BackgroundProjectionV1 } from "../background/background-projector.js";
import type { DelegationProjectionV1 } from "../delegation/delegation-projector.js";

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
  readonly capabilitySnapshot?: {
    readonly componentCount: number;
    readonly eligiblePluginCount: number;
    readonly enablementRevision: number;
    readonly snapshotId: string;
  };
  readonly completionProof: "accepted" | "candidate" | "none" | "rejected";
  readonly currentStep: number | null;
  readonly executionEnvironment?: string;
  readonly id: string;
  readonly model: string;
  readonly policyMode?: "local_free" | "remote_explicit" | "legacy_unrecorded";
  readonly policyProfile?: string;
  readonly policySha256?: string;
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
    | "mcp.resource.read"
    | "mcp.prompt.get"
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
  readonly background: BackgroundProjectionV1;
  readonly context: ContextView;
  readonly delegations: DelegationProjectionV1;
  readonly outcomeReport: OutcomeReport | null;
  readonly repository: RepositoryStatusProjection;
  readonly run: RunView | null;
  readonly session: SessionView;
  readonly taskState: TaskStateProjection;
  readonly taskExecution: TaskExecutionProjectionV1 | null;
  readonly taskGraph: TaskGraphProjectionV1;
  readonly transcript: readonly TranscriptViewItem[];
  readonly worktrees: WorktreeProjectionV1;
}

export function createInitialTuiViewState(): TuiViewState {
  return {
    approval: null,
    background: {
      current: null,
      lastSessionSeq: 0,
      workers: [],
    },
    context: {
      absoluteInputTokens: null,
      compacting: false,
      epoch: 0,
      estimatedInputTokens: null,
      protectedEstimatedTokens: null,
    },
    delegations: {
      activeActorSlots: [],
      activeConflictClaims: [],
      barriers: [],
      budget: {
        held: { artifactBytes: 0, attempts: 0, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 0, modelSteps: 0, reportedTokens: 0 },
        released: { artifactBytes: 0, attempts: 0, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 0, modelSteps: 0, reportedTokens: 0 },
        reserved: { artifactBytes: 0, attempts: 0, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 0, modelSteps: 0, reportedTokens: 0 },
        used: { artifactBytes: 0, attempts: 0, changedBytes: 0, changedFiles: 0, commandExecutions: 0, commandOutputBytes: 0, durationMs: 0, modelSteps: 0, reportedTokens: 0 },
      },
      lastSessionSeq: 0,
      maximumObservedActiveChildren: 0,
      revisions: [],
      takeoverCount: 0,
      trackingMode: "none",
      waitingApprovals: [],
      workspaceConflictDeferrals: 0,
    },
    outcomeReport: null,
    repository: initialRepositoryStatusProjection(),
    run: null,
    session: {
      actionBlocked: false,
      fatalReason: null,
      id: null,
      lastSessionSeq: 0,
      resumeBlocked: false,
    },
    taskState: {
      activeGoalId: null,
      blockers: [],
      currentApprovedPlan: null,
      goals: [],
      lastSessionSeq: 0,
      pendingDraft: null,
      plans: [],
      readyForCompletion: false,
      trackingMode: "legacy_untracked",
    },
    taskExecution: null,
    taskGraph: {
      currentApproved: null,
      currentDraft: null,
      currentExecution: null,
      lastSessionSeq: 0,
      revisions: [],
      trackingMode: "none",
    },
    transcript: [],
    worktrees: {
      lastSessionSeq: 0,
      originVerifications: [],
      pendingOperationIds: [],
      promotions: [],
      workspaces: [],
    },
  };
}

export function isActiveRun(run: RunView | null): boolean {
  return run?.status === "running";
}
