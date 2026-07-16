import type {
  ChatStreamSignal,
  StreamingChatClient,
} from "../../src/chat/stream-types.js";
import type { ChatRequest } from "../../src/chat/types.js";

export type FakeStreamBehavior = (
  request: ChatRequest,
  signal: AbortSignal,
) => AsyncIterable<ChatStreamSignal>;

export class FakeStreamingChatClient implements StreamingChatClient {
  readonly calls: Array<{ request: ChatRequest; signal: AbortSignal }> = [];

  constructor(private readonly behavior: FakeStreamBehavior) {}

  stream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamSignal> {
    this.calls.push({ request, signal });
    return this.behavior(request, signal);
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
    yield { providerResponseId: "resp_fake", type: "completed" };
  };
}

export function failedStream(
  error: Extract<ChatStreamSignal, { type: "failed" }>["error"],
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
  push(signal: ChatStreamSignal): void;
  waitUntilStarted(): Promise<void>;
} {
  const queue: ChatStreamSignal[] = [];
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
