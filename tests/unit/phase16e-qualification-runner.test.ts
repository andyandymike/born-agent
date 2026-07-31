import { describe, expect, it } from "vitest";

import type { AdapterCapabilityDeclaration } from "../../src/model/model-capability-declaration.js";
import type { ModelQualificationIdentity } from "../../src/model/model-qualification-identity.js";
import { ModelQualificationRunner } from "../../src/model/model-qualification-runner.js";
import {
  QUALIFICATION_ACKNOWLEDGEMENT,
  QUALIFICATION_SEQUENCE_COMPLETE,
} from "../../src/model/model-qualification-suite.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
  type FakeStreamBehavior,
} from "../fakes/fake-chat-client.js";

const declaration: AdapterCapabilityDeclaration = {
  adapterId: "deterministic-fake",
  adapterVersion: "phase8-test-v1",
  continuationCodecVersion: null,
  provider: "openai",
  schemaVersion: 1,
  supports: {
    cancellation: "abort_signal",
    sequentialToolCalls: true,
    streamingText: true,
    strictTools: true,
    toolContinuation: true,
    usage: "complete",
  },
};

const identity: ModelQualificationIdentity = {
  adapterId: declaration.adapterId,
  adapterVersion: declaration.adapterVersion,
  continuationCodecVersion: null,
  endpointScope: { kind: "remote_explicit", originSha256: "1".repeat(64) },
  model: "fixture-v1",
  modelRuntimeIdentity: { fixtureVersion: "fixture-v1", kind: "fake_fixture" },
  policyProfileId: "test-profile",
  policyProfileSha256: "2".repeat(64),
  probeSuiteVersion: "phase16e-v1",
  probeToolSchemaSha256: "3".repeat(64),
  provider: "openai",
};

const usage = {
  type: "usage" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function passingBehavior(): FakeStreamBehavior {
  let request = 0;
  return async function* (_input, signal) {
    request += 1;
    if (request === 1) {
      yield {
        call: {
          argumentsJson: JSON.stringify({ nonce: "nonce-fixture" }),
          callId: "echo-1",
          name: "qualification_echo",
        },
        type: "tool_call",
      };
    } else if (request === 2) {
      yield { delta: "BORN_QUALIFICATION_", type: "text_delta" };
      yield { delta: "OK", type: "text_delta" };
    } else if (request === 3 || request === 4) {
      yield {
        call: {
          argumentsJson: JSON.stringify({ index: request - 2, nonce: "nonce-fixture" }),
          callId: `step-${String(request - 2)}`,
          name: "qualification_step",
        },
        type: "tool_call",
      };
    } else if (request === 5) {
      yield { delta: QUALIFICATION_SEQUENCE_COMPLETE, type: "text_delta" };
    } else {
      yield { delta: "1", type: "text_delta" };
      if (!signal.aborted) throw new Error("runner did not cancel after first delta");
      yield {
        error: {
          category: "cancelled",
          code: "cancelled",
          message: "cancelled",
          retryable: false,
        },
        type: "failed",
      };
      return;
    }
    yield usage;
    yield { continuation: new FakeContinuation(`request-${String(request)}`), type: "turn_completed" };
  };
}

function runtime() {
  return {
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => 1,
    randomNonce: () => "nonce-fixture",
    setTimer: (listener: () => void, delayMs: number) => setTimeout(listener, delayMs),
    timestamp: () => "2026-07-31T00:00:00.000Z",
  };
}

describe("Phase 16E qualification runner", () => {
  it("proves both modes with exactly six requests and stores no nonce or free text", async () => {
    const backend = new FakeStreamingChatClient(passingBehavior(), {
      model: identity.model,
      provider: "openai",
    });
    const result = await new ModelQualificationRunner(runtime()).run({
      backend,
      declaration,
      identity,
    });

    expect(result.requestCount).toBe(6);
    expect(backend.calls).toHaveLength(6);
    expect(result.record.qualifiedModes).toEqual(["plan", "build"]);
    expect(result.record.probeResults.map((probe) => probe.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(JSON.stringify(result.record)).not.toContain("nonce-fixture");
    expect(JSON.stringify(result.record)).not.toContain(QUALIFICATION_ACKNOWLEDGEMENT);
  });

  it("does not continue a malformed strict conversation or qualify Plan", async () => {
    let request = 0;
    const backend = new FakeStreamingChatClient(async function* (_input, signal) {
      request += 1;
      if (request === 1) {
        yield {
          call: {
            argumentsJson: '{"nonce":"wrong","extra":true}',
            callId: "bad",
            name: "qualification_echo",
          },
          type: "tool_call",
        };
      } else if (request === 2 || request === 3) {
        yield {
          call: {
            argumentsJson: JSON.stringify({ index: request - 1, nonce: "nonce-fixture" }),
            callId: `step-${String(request - 1)}`,
            name: "qualification_step",
          },
          type: "tool_call",
        };
      } else if (request === 4) {
        yield { delta: QUALIFICATION_SEQUENCE_COMPLETE, type: "text_delta" };
      } else {
        yield { delta: "1", type: "text_delta" };
        if (signal.aborted) return;
      }
      yield usage;
      yield { continuation: new FakeContinuation(), type: "turn_completed" };
    }, { model: identity.model, provider: "openai" });

    const result = await new ModelQualificationRunner(runtime()).run({
      backend,
      declaration,
      identity,
    });
    expect(result.requestCount).toBe(5);
    expect(result.record.qualifiedModes).toEqual([]);
    expect(result.record.probeResults[1]?.status).toBe("failed");
    expect(result.record.probeResults[2]?.status).toBe("not_run");
  });
});
