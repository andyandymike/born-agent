import type { Phase16MutationIntent, Phase16StartIntent } from "../coordination/phase16-user-intent.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import type { TuiSessionProjectionSnapshotV1 } from "./tui-session-projection-port.js";
import type { RepositoryStatusProjection } from "../repository-intelligence/repository-status-projection.js";

export type TuiSessionSnapshot = readonly TuiPersistedEvent[] | TuiSessionProjectionSnapshotV1;

export interface TuiCoreRunResult {
  readonly diagnostic: string | null;
  readonly exitCode: number;
}

export type TuiGraphIntent =
  | { readonly expectedSessionSeq: number; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "approve" }
  | { readonly background: boolean; readonly expectedSessionSeq: number; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "enqueue" }
  | { readonly background: boolean; readonly expectedSessionSeq: number; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "run" }
  | { readonly expectedSessionSeq: number; readonly reason: string; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "cancel" }
  | { readonly background: boolean; readonly expectedSessionSeq: number; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "resume" }
  | { readonly expectedSessionSeq: number; readonly promotionOperation: string; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "verify_origin" }
  | { readonly attemptId: string; readonly expectedSessionSeq: number; readonly nodeId: string; readonly revision: number; readonly sessionId: string; readonly sha256: string; readonly type: "promote" };

export interface TuiDelegationIntent {
  readonly action: "approve" | "cancel" | "reject" | "start_or_resume";
  readonly delegationId: string;
  readonly expectedSessionSeq: number;
  readonly reason: string | null;
  readonly revision: number;
  readonly sessionId: string;
  readonly sha256: string;
}

/**
 * AS4.2: the controller receives one presentation-facing application facade.
 * Composition, writers, registries, and domain owners remain behind it.
 */
export interface TuiApplicationFacadeV1 {
  abortActiveOwnerRun(): void;
  cancelActiveRun(): void;
  activeOwnerComposite?(): boolean;
  activeDelegationOwner?(): boolean;
  cancelRepositoryRefresh?(): void;
  loadSession(sessionId: string): Promise<TuiSessionSnapshot>;
  listPlugins?(): Promise<string>;
  selectMcpPrompt?(selector: string, argumentsJson: string | undefined): Promise<string>;
  selectSkill?(selector: string, argumentsText: string): Promise<string>;
  typedSessionQueries?: boolean;
  mutateIntent?(intent: Phase16MutationIntent): Promise<TuiCoreRunResult>;
  resumeSession(sessionId: string, message?: string): Promise<TuiCoreRunResult>;
  startTask(task: string): Promise<TuiCoreRunResult>;
  refreshRepository?(): Promise<RepositoryStatusProjection>;
  graphCommand?(intent: TuiGraphIntent): Promise<TuiCoreRunResult>;
  delegationCommand?(intent: TuiDelegationIntent): Promise<TuiCoreRunResult>;
  startIntent?(
    intent: Phase16StartIntent,
    selectedMode: "build" | "plan",
    modeSource: "explicit_tui" | "tui_default",
  ): Promise<TuiCoreRunResult>;
  watchSession?(
    sessionId: string,
    onChange: (kind: "lock" | "session") => void,
    onError: (error: Error) => void,
  ): Promise<() => void>;
}

export function createTuiApplicationFacade(
  implementation: TuiApplicationFacadeV1,
): TuiApplicationFacadeV1 {
  return Object.freeze({ ...implementation });
}
