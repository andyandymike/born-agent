import type { TuiEphemeralState } from "./tui-ephemeral-state.js";
import type { TuiViewState } from "./tui-view-state.js";
import type { UserIntent } from "./user-intent.js";

export interface SingleActiveRunState {
  readonly activeRunId: string | null;
  readonly cancellationRequested: boolean;
}

export type BeginRunResult =
  | { readonly state: SingleActiveRunState; readonly status: "accepted" }
  | { readonly activeRunId: string; readonly state: SingleActiveRunState; readonly status: "busy" };

export interface CtrlCResolution {
  readonly ephemeral: TuiEphemeralState;
  readonly intent: Extract<
    UserIntent,
    { type: "cancel_active_run" | "exit" }
  > | null;
  readonly runState: SingleActiveRunState;
}

export function createSingleActiveRunState(): SingleActiveRunState {
  return { activeRunId: null, cancellationRequested: false };
}

export function beginSingleActiveRun(
  state: SingleActiveRunState,
  runId: string,
): BeginRunResult {
  if (state.activeRunId !== null) {
    return {
      activeRunId: state.activeRunId,
      state,
      status: "busy",
    };
  }
  return {
    state: { activeRunId: runId, cancellationRequested: false },
    status: "accepted",
  };
}

export function finishSingleActiveRun(
  state: SingleActiveRunState,
  runId: string,
): SingleActiveRunState {
  return state.activeRunId === runId
    ? { activeRunId: null, cancellationRequested: false }
    : state;
}

export function resolveCtrlC(
  view: TuiViewState,
  ephemeral: TuiEphemeralState,
  runState: SingleActiveRunState,
): CtrlCResolution {
  const durableRunActive = view.run?.status === "running";
  const approvalActive = view.approval?.expiresState.status === "active";
  if (runState.activeRunId !== null || durableRunActive || approvalActive) {
    // PHASE11: Ctrl+C during a run requests core cancellation and cleanup; it
    // must not exit the process or leak the run's eventual 130 into app exit.
    return {
      ephemeral,
      intent: { type: "cancel_active_run" },
      runState: { ...runState, cancellationRequested: true },
    };
  }
  if (ephemeral.draftInput.length > 0) {
    return {
      ephemeral: { ...ephemeral, draftInput: "" },
      intent: null,
      runState,
    };
  }
  return { ephemeral, intent: { type: "exit" }, runState };
}
