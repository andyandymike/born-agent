import type {
  ModelBackend,
  ModelTurnRequest,
  PreparedModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import type { ModelEvent, ModelUsage } from "../../../../src/model/model-events.js";

import type { Ds0Contract, Ds0PriceBand } from "./ds0-contract.js";

export interface Ds0UsageAggregate {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly completeUsageEvents: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly partialUsageEvents: number;
  readonly totalTokens: number;
}

export interface Ds0CostEstimate {
  readonly cachedInputTokens: number;
  readonly costUsdMicros: number;
  readonly outputTokens: number;
  readonly uncachedInputTokens: number;
}

export class Ds0ProviderCapError extends Error {
  override readonly name = "Ds0ProviderCapError";
}

function safeSum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Ds0ProviderCapError(`${label} is outside the safe integer range`);
  }
  return value;
}

export function aggregateDs0Usage(
  events: readonly ModelUsage[],
): Ds0UsageAggregate {
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let completeUsageEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let partialUsageEvents = 0;
  let totalTokens = 0;
  for (const event of events) {
    if (event.completeness === "partial") {
      partialUsageEvents += 1;
      continue;
    }
    completeUsageEvents += 1;
    const cacheRead = event.cacheReadTokens ?? 0;
    const cacheWrite = event.cacheWriteTokens ?? 0;
    const expectedTotal = [
      event.inputTokens,
      event.outputTokens,
      cacheRead,
      cacheWrite,
    ].reduce(
      (total, value) => safeSum(total, value, "reported token components"),
      0,
    );
    if (event.totalTokens !== expectedTotal) {
      throw new Ds0ProviderCapError(
        "complete usage total does not equal normalized pi-ai token components",
      );
    }
    cacheReadTokens = safeSum(
      cacheReadTokens,
      cacheRead,
      "cache-read token total",
    );
    cacheWriteTokens = safeSum(
      cacheWriteTokens,
      cacheWrite,
      "cache-write token total",
    );
    inputTokens = safeSum(inputTokens, event.inputTokens, "input token total");
    outputTokens = safeSum(outputTokens, event.outputTokens, "output token total");
    totalTokens = safeSum(totalTokens, event.totalTokens, "reported token total");
  }
  return Object.freeze({
    cacheReadTokens,
    cacheWriteTokens,
    completeUsageEvents,
    inputTokens,
    outputTokens,
    partialUsageEvents,
    totalTokens,
  });
}

export function estimateDs0Cost(
  usage: Ds0UsageAggregate,
  price: Ds0PriceBand,
): Ds0CostEstimate {
  // pi-ai normalizes cached and cache-write tokens out of `inputTokens`.
  // DeepSeek cache writes/misses are therefore conservatively charged at the
  // uncached-input rate instead of subtracting cache reads a second time.
  const uncachedInputTokens = safeSum(
    usage.inputTokens,
    usage.cacheWriteTokens,
    "uncached input tokens",
  );
  const raw =
    usage.cacheReadTokens * price.cachedInput +
    uncachedInputTokens * price.uncachedInput +
    usage.outputTokens * price.output;
  if (!Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) {
    throw new Ds0ProviderCapError("estimated provider cost is invalid");
  }
  return Object.freeze({
    cachedInputTokens: usage.cacheReadTokens,
    costUsdMicros: Math.round(raw),
    outputTokens: usage.outputTokens,
    uncachedInputTokens,
  });
}

function minuteOfDay(value: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) throw new TypeError("invalid DS0 peak interval");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function ds0PriceBandAt(
  contract: Ds0Contract,
  timestamp: Date,
): Readonly<{ readonly id: "off_peak" | "peak"; readonly rates: Ds0PriceBand }> {
  const weekday = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][timestamp.getUTCDay()]!;
  const minute = timestamp.getUTCHours() * 60 + timestamp.getUTCMinutes();
  const peak =
    contract.peakWeekdays.includes(weekday) &&
    contract.peakIntervals.some(
      (interval) =>
        minute >= minuteOfDay(interval.startInclusive) &&
        minute < minuteOfDay(interval.endExclusive),
    );
  return peak
    ? Object.freeze({ id: "peak" as const, rates: contract.peak })
    : Object.freeze({ id: "off_peak" as const, rates: contract.offPeak });
}

export class Ds0ProviderMeter {
  readonly #usage: ModelUsage[] = [];
  #requestCount = 0;
  #reportedTokenCeilingExceeded = false;

  constructor(
    readonly stage: "actor" | "qualification",
    readonly maximumRequests: number,
    readonly maximumReportedTokens: number | null,
  ) {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) {
      throw new TypeError("DS0 provider request ceiling is invalid");
    }
  }

  get requestCount(): number {
    return this.#requestCount;
  }

  get reportedTokenCeilingExceeded(): boolean {
    return this.#reportedTokenCeilingExceeded;
  }

  get usageEvents(): readonly ModelUsage[] {
    return Object.freeze([...this.#usage]);
  }

  usage(): Ds0UsageAggregate {
    return aggregateDs0Usage(this.#usage);
  }

  async *#runMeteredTurn(
    backend: ModelBackend,
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (this.#requestCount >= this.maximumRequests) {
      yield {
        error: {
          category: "protocol",
          code: "ds0_provider_request_ceiling_exceeded",
          message: `${this.stage} provider request ceiling would be exceeded`,
          retryable: false,
        },
        type: "failed",
      } as const;
      return;
    }
    if (this.#reportedTokenCeilingExceeded) {
      yield {
        error: {
          category: "protocol",
          code: "ds0_reported_token_ceiling_exceeded",
          message: `${this.stage} reported-token ceiling was exceeded`,
          retryable: false,
        },
        type: "failed",
      } as const;
      return;
    }
    this.#requestCount += 1;
    for await (const event of backend.runTurn(request, signal)) {
      if (event.type === "usage") {
        this.#usage.push(event.usage);
        const aggregate = this.usage();
        if (
          this.maximumReportedTokens !== null &&
          aggregate.totalTokens > this.maximumReportedTokens
        ) {
          // Preserve an already billed usage event. AgentLoop owns the
          // matching turn-edge max_tokens stop; throwing here would hide
          // usage and misclassify a bounded stop as internal_error.
          this.#reportedTokenCeilingExceeded = true;
        }
      }
      yield event;
    }
  }

  wrap(backend: ModelBackend): ModelBackend {
    return Object.freeze({
      capabilities: backend.capabilities,
      ...(backend.contextCapacity === undefined
        ? {}
        : { contextCapacity: backend.contextCapacity }),
      identity: backend.identity,
      prepareTurnRequest(request: ModelTurnRequest): PreparedModelTurnRequest {
        if (backend.prepareTurnRequest === undefined) {
          throw new Ds0ProviderCapError(
            "DS0 production backend omitted request preparation evidence",
          );
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
