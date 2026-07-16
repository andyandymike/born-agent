export type ModelCapabilities = {
  readonly cancellation: "abort_signal" | "unsupported";
  readonly reasoning: "opaque_passthrough" | "none";
  readonly streaming: true;
  readonly tools: "strict" | "best_effort" | "none";
  readonly usage: "complete" | "partial" | "none";
};

