import type {
  ModelBackend,
  ModelTurnRequest,
  PreparedModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import type { ModelEvent, ModelUsage } from "../../../../src/model/model-events.js";
import type { DevelopmentPilotUsageObservation } from "./development-pilot-production-executor.js";

export class DevelopmentPilotProviderCapError extends Error {
  override readonly name = "DevelopmentPilotProviderCapError";

  constructor(readonly outcome: DevelopmentPilotCapExceeded) {
    super(`development pilot cap exceeded: ${outcome.kind}`);
  }
}

export type DevelopmentPilotCapKind =
  | "provider_requests"
  | "reported_cache_read_tokens"
  | "reported_output_tokens"
  | "reported_total_tokens"
  | "reported_uncached_input_tokens";

export interface DevelopmentPilotCapExceeded {
  readonly kind: DevelopmentPilotCapKind;
  readonly limit: number;
  readonly observed: number;
  readonly stage: "after_provider_usage" | "before_provider_request";
}

export interface DevelopmentPilotProviderCaps {
  readonly maximumCacheReadTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumRequests: number;
  readonly maximumTotalTokens: number;
  readonly maximumUncachedInputTokens: number;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("development pilot provider usage is outside safe integer bounds");
  }
  return result;
}

export class DevelopmentPilotProviderMeter {
  readonly #usages: ModelUsage[] = [];
  #capExceeded: DevelopmentPilotCapExceeded | null = null;
  #requests = 0;

  constructor(readonly caps: DevelopmentPilotProviderCaps) {}

  get capExceeded(): DevelopmentPilotCapExceeded | null {
    return this.#capExceeded === null
      ? null
      : Object.freeze({ ...this.#capExceeded });
  }

  get requestCount(): number {
    return this.#requests;
  }

  get usageEventCount(): number {
    return this.#usages.length;
  }

  #observeCap(
    kind: DevelopmentPilotCapKind,
    limit: number,
    observed: number,
    stage: DevelopmentPilotCapExceeded["stage"],
  ): void {
    if (this.#capExceeded !== null || observed <= limit) return;
    this.#capExceeded = Object.freeze({ kind, limit, observed, stage });
  }

  #observeUsageCaps(): void {
    const usage = this.usage();
    if (
      usage.cacheReadTokens === null ||
      usage.cacheWriteTokens === null ||
      usage.inputTokens === null ||
      usage.outputTokens === null ||
      usage.totalTokens === null
    ) return;
    this.#observeCap(
      "reported_uncached_input_tokens",
      this.caps.maximumUncachedInputTokens,
      safeAdd(usage.inputTokens, usage.cacheWriteTokens),
      "after_provider_usage",
    );
    this.#observeCap(
      "reported_cache_read_tokens",
      this.caps.maximumCacheReadTokens,
      usage.cacheReadTokens,
      "after_provider_usage",
    );
    this.#observeCap(
      "reported_output_tokens",
      this.caps.maximumOutputTokens,
      usage.outputTokens,
      "after_provider_usage",
    );
    this.#observeCap(
      "reported_total_tokens",
      this.caps.maximumTotalTokens,
      usage.totalTokens,
      "after_provider_usage",
    );
  }

  usage(): DevelopmentPilotUsageObservation {
    if (this.#usages.length === 0) {
      return Object.freeze({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        completeness: "none",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
    }
    const complete = this.#usages.every((usage) => usage.completeness === "complete");
    const nullableSum = (
      select: (usage: ModelUsage) => number | null,
    ): number | null => this.#usages.every((usage) => select(usage) !== null)
      ? this.#usages.reduce((total, usage) => safeAdd(total, select(usage) ?? 0), 0)
      : null;
    return Object.freeze({
      cacheReadTokens: nullableSum((usage) => usage.cacheReadTokens),
      cacheWriteTokens: nullableSum((usage) => usage.cacheWriteTokens),
      completeness: complete && this.#usages.length === this.#requests ? "complete" : "partial",
      inputTokens: nullableSum((usage) => usage.inputTokens),
      outputTokens: nullableSum((usage) => usage.outputTokens),
      totalTokens: nullableSum((usage) => usage.totalTokens),
    });
  }

  async *#runMeteredTurn(
    backend: ModelBackend,
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (this.#capExceeded !== null) {
      throw new DevelopmentPilotProviderCapError(this.#capExceeded);
    }
    if (this.#requests >= this.caps.maximumRequests) {
      this.#observeCap(
        "provider_requests",
        this.caps.maximumRequests,
        this.#requests + 1,
        "before_provider_request",
      );
      throw new DevelopmentPilotProviderCapError(this.#capExceeded!);
    }
    this.#requests += 1;
    for await (const event of backend.runTurn(request, signal)) {
      if (event.type === "usage") {
        this.#usages.push(event.usage);
        // Preserve and yield the complete billed usage first. Throwing at
        // this point makes production executeAgent misclassify a local
        // cost boundary as provider/internal failure and loses session
        // cross-checkability. A subsequent request is denied locally.
        this.#observeUsageCaps();
      }
      yield event;
    }
  }

  wrap(backend: ModelBackend): ModelBackend {
    return Object.freeze({
      capabilities: backend.capabilities,
      ...(backend.contextCapacity === undefined ? {} : { contextCapacity: backend.contextCapacity }),
      identity: backend.identity,
      prepareTurnRequest(request: ModelTurnRequest): PreparedModelTurnRequest {
        if (backend.prepareTurnRequest === undefined) {
          throw new TypeError("production backend omitted request preparation");
        }
        return backend.prepareTurnRequest(request);
      },
      resume: backend.resume,
      runTurn: (request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> => {
        return this.#runMeteredTurn(backend, request, signal);
      },
    });
  }
}
