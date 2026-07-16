import {
  BackendContinuation,
  type BackendIdentity,
  type ModelBackend,
  type ModelTurnRequest,
} from "../../src/model/model-backend.js";
import type { ModelEvent } from "../../src/model/model-events.js";
import type { ProviderFailure } from "../../src/model/provider-failure.js";

export class FakeContinuation extends BackendContinuation {
  constructor(readonly label = "fake") {
    super();
  }
}

export type FakeModelTurnRequest = ModelTurnRequest & {
  readonly model: string;
};

export type FakeModelTurnSignal =
  | { readonly delta: string; readonly type: "text_delta" }
  | {
      readonly call: {
        readonly argumentsJson: string;
        readonly callId: string;
        readonly name: string;
      };
      readonly type: "tool_call";
    }
  | {
      readonly type: "usage";
      readonly usage: {
        readonly cachedInputTokens?: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
      };
    }
  | {
      readonly continuation: BackendContinuation;
      readonly providerResponseId?: string;
      readonly type: "turn_completed";
    }
  | { readonly error: ProviderFailure; readonly type: "failed" };

export type FakeStreamBehavior = (
  request: FakeModelTurnRequest,
  signal: AbortSignal,
) => AsyncIterable<FakeModelTurnSignal>;

export class FakeStreamingChatClient implements ModelBackend {
  readonly calls: Array<{
    request: FakeModelTurnRequest;
    signal: AbortSignal;
  }> = [];
  readonly capabilities = {
    cancellation: "abort_signal",
    reasoning: "opaque_passthrough",
    streaming: true,
    tools: "strict",
    usage: "complete",
  } as const;
  readonly resume = Object.freeze({
    capability: "canonical_only",
    supportsCanonicalDegradedResume: true,
  } as const);
  #identity: BackendIdentity;

  constructor(
    private readonly behavior: FakeStreamBehavior,
    selection: { readonly model?: string; readonly provider?: BackendIdentity["provider"] } = {},
  ) {
    this.#identity = {
      adapter: "deterministic-fake",
      adapterVersion: "phase8-test-v1",
      configFingerprint: "0".repeat(64),
      model: selection.model ?? "gpt-5.6-terra",
      provider: selection.provider ?? "openai",
    };
  }

  get identity(): BackendIdentity {
    return this.#identity;
  }

  selectIdentity(
    provider: BackendIdentity["provider"],
    model: string,
  ): this {
    this.#identity = Object.freeze({
      ...this.#identity,
      model,
      provider,
    });
    return this;
  }

  async *runTurn(
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const fakeRequest: FakeModelTurnRequest = {
      input: request.input,
      instructions: request.instructions,
      model: this.identity.model,
      timeoutMs: request.timeoutMs,
      tools: request.tools,
    };
    this.calls.push({ request: fakeRequest, signal });
    let sawToolCall = false;
    for await (const event of this.behavior(fakeRequest, signal)) {
      switch (event.type) {
        case "text_delta":
          yield { text: event.delta, type: "text_delta" };
          break;
        case "tool_call":
          sawToolCall = true;
          yield {
            argumentsDelta: event.call.argumentsJson,
            callId: event.call.callId,
            name: event.call.name,
            type: "tool_call_delta",
          };
          break;
        case "usage":
          yield {
            type: "usage",
            usage: {
              cacheReadTokens: event.usage.cachedInputTokens ?? null,
              cacheWriteTokens: null,
              completeness: "complete",
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              totalTokens: event.usage.totalTokens,
            },
          };
          break;
        case "turn_completed":
          yield {
            continuation: event.continuation as BackendContinuation,
            outcome: sawToolCall ? "tool_calls" : "text",
            ...(event.providerResponseId === undefined
              ? {}
              : { providerRequestId: event.providerResponseId }),
            type: "turn_completed",
          };
          break;
        case "failed":
          yield event;
          break;
      }
    }
  }
}

export function fixedStream(
  deltas: readonly string[] = ["fake response"],
): FakeStreamBehavior {
  return async function* () {
    for (const delta of deltas) {
      yield { delta, type: "text_delta" };
    }
    yield {
      type: "usage",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    };
    yield {
      continuation: new FakeContinuation(),
      providerResponseId: "resp_fake",
      type: "turn_completed",
    };
  };
}

export function failedStream(
  error: Extract<FakeModelTurnSignal, { type: "failed" }>["error"],
): FakeStreamBehavior {
  return async function* () {
    yield { error, type: "failed" };
  };
}

export function waitForAbort(): FakeStreamBehavior {
  return async function* (_request, signal) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (!signal.aborted) {
      yield { delta: "unreachable", type: "text_delta" };
    }
  };
}

export function createControlledStream(): {
  readonly behavior: FakeStreamBehavior;
  end(): void;
  push(signal: FakeModelTurnSignal): void;
  waitUntilStarted(): Promise<void>;
} {
  const queue: FakeModelTurnSignal[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  return {
    behavior: async function* () {
      markStarted?.();
      while (!ended || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    end: () => {
      ended = true;
      waiters.shift()?.();
    },
    push: (signal) => {
      queue.push(signal);
      waiters.shift()?.();
    },
    waitUntilStarted: () => started,
  };
}
