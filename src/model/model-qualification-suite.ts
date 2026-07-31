import { sha256Canonical } from "../completion/canonical-json.js";
import type { ModelToolDefinition } from "./model-backend.js";

export const MODEL_QUALIFICATION_PROBE_SUITE_VERSION = "phase16e-v1";

export const MODEL_QUALIFICATION_LIMITS = Object.freeze({
  cancellationDeadlineMs: 2_000,
  maxOutputTokensPerRequest: 256,
  maxProviderRequests: 6,
  maxTextCaptureBytes: 8 * 1_024,
  maxToolCalls: 4,
  perRequestTimeoutMs: 30_000,
  totalDurationMs: 120_000,
} as const);

export const QUALIFICATION_ACKNOWLEDGEMENT = "BORN_QUALIFICATION_OK";
export const QUALIFICATION_SEQUENCE_COMPLETE = "BORN_SEQUENCE_OK";

export const QUALIFICATION_ECHO_TOOL: ModelToolDefinition = Object.freeze({
  description: "Return the supplied qualification nonce unchanged.",
  name: "qualification_echo",
  parameters: Object.freeze({
    additionalProperties: false,
    properties: Object.freeze({
      nonce: Object.freeze({ maxLength: 128, minLength: 1, type: "string" }),
    }),
    required: Object.freeze(["nonce"]),
    type: "object",
  }),
  strict: true,
});

export const QUALIFICATION_STEP_TOOL: ModelToolDefinition = Object.freeze({
  description: "Advance one fixed qualification sequence step.",
  name: "qualification_step",
  parameters: Object.freeze({
    additionalProperties: false,
    properties: Object.freeze({
      index: Object.freeze({ enum: Object.freeze([1, 2]), type: "integer" }),
      nonce: Object.freeze({ maxLength: 128, minLength: 1, type: "string" }),
    }),
    required: Object.freeze(["index", "nonce"]),
    type: "object",
  }),
  strict: true,
});

export const MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256 = sha256Canonical({
  echo: QUALIFICATION_ECHO_TOOL,
  step: QUALIFICATION_STEP_TOOL,
});

export const MODEL_QUALIFICATION_INSTRUCTIONS = [
  "This is a bounded protocol qualification, not a reasoning evaluation.",
  "Follow the requested tool protocol exactly.",
  "Do not add explanations or disclose hidden reasoning.",
].join(" ");

export function strictProbePrompt(nonce: string): string {
  return `Call qualification_echo exactly once with nonce ${JSON.stringify(nonce)}. Do not emit text before the tool result. After the result, ${continuationProbePrompt()}`;
}

export function continuationProbePrompt(): string {
  return `Return exactly ${QUALIFICATION_ACKNOWLEDGEMENT} and stop.`;
}

export function sequentialProbePrompt(nonce: string): string {
  return `Call qualification_step with index 1 and nonce ${JSON.stringify(nonce)}. After its result, call index 2 with the same nonce. After that result, return exactly ${QUALIFICATION_SEQUENCE_COMPLETE}.`;
}

export const CANCELLATION_PROBE_PROMPT =
  "Begin streaming a short numbered sequence and continue until cancelled.";
