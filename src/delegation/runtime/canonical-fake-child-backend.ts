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
export const PHASE20_CANONICAL_CODING_FAKE_QUALIFICATION_SHA256 = sha256Canonical({
  backend: "bornagent-phase20-canonical-fake",
  model: PHASE20_CANONICAL_FAKE_MODEL_ID,
  provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
  schemaVersion: 1,
  scope: "managed_worktree_coding_fixture",
});

class CanonicalFakeContinuation extends BackendContinuation {}

async function waitForDurableObservationWindow(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isPhase20CanonicalFakeSelection(input: {
  readonly modelId: string;
  readonly policyProfileId: string;
  readonly providerId: string;
  readonly taskProfile: "coding" | "read-only";
}): boolean {
  return input.modelId === PHASE20_CANONICAL_FAKE_MODEL_ID &&
    input.providerId === PHASE20_CANONICAL_FAKE_PROVIDER_ID &&
    input.policyProfileId === PHASE20_CANONICAL_FAKE_POLICY_PROFILE_ID;
}

export class Phase20CanonicalFakeChildBackend implements ModelBackend {
  #turn = 0;
  private readonly observationWindowMs: number;
  private readonly taskProfile: "coding" | "read-only";
  readonly identity: BackendIdentity;

  constructor(taskProfile: "coding" | "read-only" = "read-only", observationWindowMs = 300) {
    if (!Number.isSafeInteger(observationWindowMs) || observationWindowMs < 1 || observationWindowMs > 120_000) {
      throw new RangeError("canonical fake observation window must be an integer from 1 to 120000 milliseconds");
    }
    this.taskProfile = taskProfile;
    this.observationWindowMs = observationWindowMs;
    this.identity = Object.freeze({
      adapter: "bornagent-phase20-canonical-fake",
      adapterVersion: "phase20-v1",
      configFingerprint: taskProfile === "coding"
        ? PHASE20_CANONICAL_CODING_FAKE_QUALIFICATION_SHA256
        : PHASE20_CANONICAL_FAKE_QUALIFICATION_SHA256,
      model: PHASE20_CANONICAL_FAKE_MODEL_ID,
      provider: PHASE20_CANONICAL_FAKE_PROVIDER_ID,
    });
  }

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
  readonly resume = Object.freeze({
    capability: "canonical_only" as const,
    supportsCanonicalDegradedResume: true,
  });

  async *runTurn(
    _request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    if (this.taskProfile === "coding") {
      const calls = [
        {
          argumentsJson: JSON.stringify({
            patch: [
              "diff --git a/fixtures/phase-07-fix-and-verify/src/clamp.mjs b/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
              "--- a/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
              "+++ b/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
              "@@ -1,3 +1,3 @@",
              " export function clamp(value, minimum, maximum) {",
              "-  return Math.min(minimum, Math.max(maximum, value));",
              "+  return Math.min(maximum, Math.max(minimum, value));",
              " }",
              "",
            ].join("\n"),
          }),
          callId: "phase20_canonical_coding_patch",
          name: "apply_patch",
        },
        {
          argumentsJson: JSON.stringify({
            args: ["verify.mjs"],
            cwd: "fixtures/phase-07-fix-and-verify",
            executable: "node",
            purpose: "verify",
            timeout_ms: 120_000,
          }),
          callId: "phase20_canonical_coding_verify",
          name: "run_command",
        },
        {
          argumentsJson: JSON.stringify({
            status: "completed",
            summary: "The delegated managed-worktree patch passed its independent verification.",
          }),
          callId: "phase20_canonical_coding_finish",
          name: "finish_task",
        },
      ] as const;
      const call = calls[this.#turn];
      this.#turn += 1;
      if (call === undefined) {
        yield {
          error: {
            category: "protocol",
            code: "phase20_canonical_coding_turn_overflow",
            message: "canonical coding fixture received an unexpected model turn",
            retryable: false,
          },
          type: "failed",
        };
        return;
      }
      yield {
        argumentsDelta: call.argumentsJson,
        callId: call.callId,
        name: call.name,
        type: "tool_call_delta",
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
        outcome: "tool_calls",
        providerRequestId: `phase20_canonical_coding_${String(this.#turn)}`,
        type: "turn_completed",
      };
      return;
    }
    // This package-owned backend keeps the real child in its running state for
    // one bounded watcher interval so CLI/TUI/pack gates can observe the
    // durable two-process overlap instead of relying only on terminal history.
    await waitForDurableObservationWindow(signal, this.observationWindowMs);
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
