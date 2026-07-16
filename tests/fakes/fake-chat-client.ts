import type {
  ChatClient,
  ChatRequest,
  ChatResponse,
} from "../../src/chat/types.js";

export type FakeChatBehavior = (
  request: ChatRequest,
  signal: AbortSignal,
) => Promise<ChatResponse>;

export class FakeChatClient implements ChatClient {
  readonly calls: Array<{ request: ChatRequest; signal: AbortSignal }> = [];

  constructor(private readonly behavior: FakeChatBehavior) {}

  complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    this.calls.push({ request, signal });
    return this.behavior(request, signal);
  }
}

export function fixedResponse(text = "fake response"): FakeChatBehavior {
  return async (request) => ({
    model: request.model,
    providerResponseId: "resp_fake",
    text,
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  });
}

export function emptyResponse(): FakeChatBehavior {
  return async (request) => ({ model: request.model, text: "   " });
}

export function rejected(error: unknown): FakeChatBehavior {
  return async () => Promise.reject(error);
}

export function waitForAbort(): FakeChatBehavior {
  return async (request, signal) =>
    new Promise<ChatResponse>((_resolve, reject) => {
      const abort = () => reject(new Error("fake request aborted"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
}

export function createDeferredBehavior(): {
  behavior: FakeChatBehavior;
  release(text?: string): void;
} {
  let releasePromise: ((response: ChatResponse) => void) | undefined;
  let capturedRequest: ChatRequest | undefined;
  const promise = new Promise<ChatResponse>((resolve) => {
    releasePromise = resolve;
  });

  return {
    behavior: async (request) => {
      capturedRequest = request;
      return promise;
    },
    release: (text = "released response") => {
      if (!releasePromise || !capturedRequest) {
        throw new Error("deferred fake has not received a request");
      }
      releasePromise({ model: capturedRequest.model, text });
    },
  };
}

