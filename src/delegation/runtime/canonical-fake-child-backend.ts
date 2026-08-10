import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  BackendContinuation,
  type BackendIdentity,
  type ModelBackend,
  type ModelTurnRequest,
} from "../../model/model-backend.js";
import type { ModelEvent } from "../../model/model-events.js";

export const PHASE20_CANONICAL_FAKE_MODEL_ID =
  "qwen3:1.7b" as const;
export const PHASE20_CANONICAL_FAKE_PROVIDER_ID = "ollama" as const;
export const PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID = "local-free-v1" as const;
export const PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256 = sha256Canonical({
  backend: "bornagent-phase20-canonical-fake",
  model: PHASE20_CANONICAL_FAKE_MODEL_ID,
  provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
  schemaVersion: 1,
  scope: "read_only_contract_fixture",
});

class CanonicalFakeContinuation extends BackendContinuation {}

export function isPhase20CanonicalFakeSelection(input: {
  readonly modelId: string;
  readonly policyProfileId: string;
  readonly providerId: string;
  readonly taskProfile: "coding" | "read-only";
}): boolean {
  return input.taskProfile === "read-only" &&
    input.modelId === PHASE20_CANONICAL_FAKE_MODEL_ID &&
    input.providerId === PHASE20_CANONICAL_FAKE_PROVIDER_ID &&
    input.policyProfileId === PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID;
}

export class Phase20CanonicalFakeChildBackend implements ModelBackend {
  readonly capabilities = Object.freeze({
    cancellation: "abort_signal" as const,
    reasoning: "none" as const,
    streaming: true,
    tools: "strict" as const,
    usage: "complete" as const,
  });
  readonly contextCapacity = Object.freeze({
    contextWindowTokens: 32_768,
    maximumOutputTokens: 1_024,
    source: "pinned_catalog" as const,
  });
  readonly identity: BackendIdentity = Object.freeze({
    adapter: "bornagent-phase20-canonical-fake",
    adapterVersion: "phase20-v1",
    configFingerprint: PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
    model: PHASE20_CANONICAL_FAKE_MODEL_ID,
    provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
  });
  readonly resume = Object.freeze({
    capability: "canonical_only" as const,
    supportsCanonicalDegradedResume: true,
  });

  async *runTurn(
    _request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    yield {
      text: "Canonical Phase 20 child completed its bounded analysis contract.",
      type: "text_delta",
    };
    yield {
      type: "usage",
      usage: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completeness: "complete",
        inputTokens: 8,
        outputTokens: 9,
        totalTokens: 17,
      },
    };
    yield {
      continuation: new CanonicalFakeContinuation(),
      outcome: "text",
      providerRequestId: "phase20_canonical_fake_1",
      type: "turn_completed",
    };
  }
}
