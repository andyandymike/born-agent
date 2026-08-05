import type { UserIntent } from "./user-intent.js";

export interface TuiPlanDecisionDialog {
  readonly action: "approve" | "approve_build" | "reject";
  readonly currentApprovedRevision: number | null;
  readonly expectedSessionSeq: number;
  readonly goalId: string;
  readonly goalObjective: string;
  readonly goalRevision: number;
  readonly items: readonly {
    readonly acceptance: string;
    readonly itemId: string;
    readonly required: boolean;
    readonly title: string;
  }[];
  readonly planId: string;
  readonly planSha256: string;
  readonly reason: string | null;
  readonly revision: number;
  readonly sessionId: string;
}

export interface TuiEphemeralState {
  readonly approvalFocus: "allow" | "deny";
  readonly approvalRequestId: string | null;
  readonly coreDiagnostic: string | null;
  readonly draftInput: string;
  readonly focusedItemId: string | null;
  readonly foldedItemIds: readonly string[];
  readonly planDecisionDialog: TuiPlanDecisionDialog | null;
  readonly planDecisionFocus: "cancel" | "confirm";
  readonly scrollOffset: number;
  readonly selectedAgentMode: "build" | "plan";
  readonly selectedAgentModeSource: "explicit_tui" | "tui_default";
  readonly sessionBusy: boolean;
}

export function createInitialTuiEphemeralState(): TuiEphemeralState {
  // PHASE11: scroll, focus, folds, and draft input are presentation state; if
  // persisted as facts they could change completion or resume on replay.
  return {
    approvalFocus: "deny",
    approvalRequestId: null,
    coreDiagnostic: null,
    draftInput: "",
    focusedItemId: null,
    foldedItemIds: [],
    planDecisionDialog: null,
    planDecisionFocus: "cancel",
    scrollOffset: 0,
    selectedAgentMode: "plan",
    selectedAgentModeSource: "tui_default",
    sessionBusy: false,
  };
}

export function openPlanDecisionDialog(
  state: TuiEphemeralState,
  dialog: TuiPlanDecisionDialog,
): TuiEphemeralState {
  return {
    ...state,
    draftInput: "",
    planDecisionDialog: dialog,
    planDecisionFocus: "cancel",
  };
}

export function closePlanDecisionDialog(
  state: TuiEphemeralState,
): TuiEphemeralState {
  return {
    ...state,
    planDecisionDialog: null,
    planDecisionFocus: "cancel",
  };
}

export function setPlanDecisionFocus(
  state: TuiEphemeralState,
  focus: "cancel" | "confirm",
): TuiEphemeralState {
  return { ...state, planDecisionFocus: focus };
}

export function setCoreDiagnostic(
  state: TuiEphemeralState,
  coreDiagnostic: string | null,
): TuiEphemeralState {
  return { ...state, coreDiagnostic };
}

export function setSessionBusy(
  state: TuiEphemeralState,
  sessionBusy: boolean,
): TuiEphemeralState {
  return { ...state, sessionBusy };
}

export function openApprovalDialog(
  state: TuiEphemeralState,
  approvalRequestId: string,
): TuiEphemeralState {
  return { ...state, approvalFocus: "deny", approvalRequestId };
}

export function setDraftInput(
  state: TuiEphemeralState,
  draftInput: string,
): TuiEphemeralState {
  return { ...state, draftInput };
}

export function setApprovalFocus(
  state: TuiEphemeralState,
  approvalFocus: "allow" | "deny",
): TuiEphemeralState {
  return { ...state, approvalFocus };
}

export function setScrollOffset(
  state: TuiEphemeralState,
  scrollOffset: number,
): TuiEphemeralState {
  return {
    ...state,
    scrollOffset: Math.max(0, Math.trunc(scrollOffset)),
  };
}

export function reduceEphemeralIntent(
  state: TuiEphemeralState,
  intent: UserIntent,
): TuiEphemeralState {
  switch (intent.type) {
    case "toggle_item": {
      const folded = new Set(state.foldedItemIds);
      if (folded.has(intent.itemId)) folded.delete(intent.itemId);
      else folded.add(intent.itemId);
      return {
        ...state,
        foldedItemIds: [...folded].sort(),
        focusedItemId: intent.itemId,
      };
    }
    case "submit_message":
      return { ...state, draftInput: "" };
    case "cancel_active_run":
    case "decide_approval":
    case "exit":
    case "select_session":
      return state;
  }
}

export function enterApprovalDecision(
  state: TuiEphemeralState,
  requestId: string,
  actionSha256: string,
): Extract<UserIntent, { type: "decide_approval" }> {
  return {
    actionSha256,
    // Enter on the initial focus remains deny. Allow requires a prior explicit
    // focus move, so an accidental confirmation cannot authorize an effect.
    decision:
      state.approvalRequestId === requestId &&
      state.approvalFocus === "allow"
        ? "approved"
        : "denied",
    requestId,
    type: "decide_approval",
  };
}
