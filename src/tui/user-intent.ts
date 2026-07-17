export type UserIntent =
  | { readonly actionSha256: string; readonly decision: "approved" | "denied"; readonly requestId: string; readonly type: "decide_approval" }
  | { readonly type: "cancel_active_run" }
  | { readonly type: "exit" }
  | { readonly itemId: string; readonly type: "toggle_item" }
  | { readonly sessionId: string; readonly type: "select_session" }
  | { readonly text: string; readonly type: "submit_message" };
