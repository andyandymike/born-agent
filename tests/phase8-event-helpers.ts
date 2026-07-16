import type { RunEventDraft } from "../src/events/run-event.js";

export function testBackendSelected(
  provider: string,
  model: string,
): Extract<RunEventDraft, { type: "backend.selected" }> {
  return {
    data: {
      adapter: "deterministic-test-adapter",
      adapter_version: "1.0.0-test",
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      config_fingerprint: "b".repeat(64),
      model,
      provider,
    },
    type: "backend.selected",
  };
}

export function testCompleteModelUsage(
  provider: string,
  step: number,
  inputTokens = 1,
  outputTokens = 1,
): Extract<RunEventDraft, { type: "model.usage" }> {
  return {
    data: {
      cache_read_tokens: null,
      cache_write_tokens: null,
      completeness: "complete",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      provider,
      step,
      total_tokens: inputTokens + outputTokens,
    },
    type: "model.usage",
  };
}
