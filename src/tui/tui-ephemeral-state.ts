import type { UserIntent } from "./user-intent.js";

export interface TuiEphemeralState {
  readonly approvalFocus: "allow" | "deny";
  readonly approvalRequestId: string | null;
  readonly draftInput: string;
  readonly focusedItemId: string | null;
  readonly foldedItemIds: readonly string[];
  readonly scrollOffset: number;
}

export function createInitialTuiEphemeralState(): TuiEphemeralState {
  // PHASE11: scroll, focus, folds, and draft input are presentation state; if
  // persisted as facts they could change completion or resume on replay.
  return {
    approvalFocus: "deny",
    approvalRequestId: null,
    draftInput: "",
    focusedItemId: null,
    foldedItemIds: [],
    scrollOffset: 0,
  };
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
