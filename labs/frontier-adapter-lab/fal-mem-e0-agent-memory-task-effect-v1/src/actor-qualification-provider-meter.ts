import { createHash } from "node:crypto";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type {
  ModelBackend,
  ModelTurnRequest,
  PreparedModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import type { ModelEvent, ModelUsage } from "../../../../src/model/model-events.js";

import {
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
  MEM_E0_ACTOR_QUALIFICATION_PEAK_INPUT_USD_MICROS_PER_MILLION,
  MEM_E0_ACTOR_QUALIFICATION_PEAK_OUTPUT_USD_MICROS_PER_MILLION,
} from "./actor-qualification.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const TOKENS_PER_PRICING_UNIT = 1_000_000;

export type MemE0ActorQualificationProviderMeterFailureKind =
  | "cap"
  | "contract";

export type MemE0ActorQualificationProviderMeterFailureCode =
  | "aggregate_output_token_ceiling_exceeded"
  | "aggregate_reported_token_ceiling_exceeded"
  | "duplicate_turn_completed"
  | "historical_memory_present"
  | "invalid_canonical_context"
  | "invalid_usage"
  | "per_request_output_token_ceiling_exceeded"
  | "provider_request_ceiling_exceeded"
  | "qualification_observation_incomplete"
  | "stream_ended_without_turn_completed"
  | "turn_completed_without_exact_complete_usage"
  | "usage_after_turn_completed";

export interface MemE0ActorQualificationProviderMeterFailure {
  readonly code: MemE0ActorQualificationProviderMeterFailureCode;
  readonly kind: MemE0ActorQualificationProviderMeterFailureKind;
  readonly limit?: number;
  readonly observed?: number;
  readonly stage: "after_provider_event" | "before_provider_request" | "finalize";
}

export class MemE0ActorQualificationProviderMeterError extends Error {
  override readonly name = "MemE0ActorQualificationProviderMeterError";

  constructor(
    readonly failure: MemE0ActorQualificationProviderMeterFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface MemE0ActorQualificationProviderMeterOptions {
  readonly frozenProductionImplementationIdentitySha256: string;
  readonly pricingSha256: string;
}

export interface MemE0ActorQualificationRetryPolicyEvidence {
  readonly configuredMaximumRetries: 0;
  readonly evidenceKind: "frozen_production_implementation_identity";
  readonly frozenProductionImplementationIdentitySha256: string;
  readonly transportRetriesObserved: null;
}

export interface MemE0ActorQualificationProviderUsageObservation {
  readonly accountedPeakCostUsdMicros: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly completeUsageEvents: number;
  readonly inputTokens: number;
  readonly isProviderInvoice: false;
  readonly maximumAuthorizedCostUsdMicros: 33_609;
  readonly maximumObservedOutputTokensPerRequest: number;
  readonly outputTokens: number;
  readonly partialUsageEvents: number;
  readonly pricingSha256: string;
  readonly requestObservationSha256s: readonly string[];
  readonly requestsCompleted: number;
  readonly requestsStarted: number;
  /**
   * This is the frozen production implementation's configured retry maximum.
   * It is not a transport-retry observation made by this wrapper.
   */
  readonly retries: 0;
  readonly retryPolicyEvidence: MemE0ActorQualificationRetryPolicyEvidence;
  readonly totalTokens: number;
  readonly usageObservationSha256s: readonly string[];
}

export interface MemE0ActorQualificationProviderObservation {
  readonly historicalMemoryItemCount: number;
  readonly providerUsage: MemE0ActorQualificationProviderUsageObservation;
}

interface MutableRequestObservation {
  completeUsageEvents: number;
  partialUsageEvents: number;
  turnCompletedEvents: number;
  usageEvents: number;
}

interface NormalizedUsage {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly completeness: ModelUsage["completeness"];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failure(
  value: MemE0ActorQualificationProviderMeterFailure,
  message: string,
): MemE0ActorQualificationProviderMeterError {
  return new MemE0ActorQualificationProviderMeterError(
    Object.freeze({ ...value }),
    message,
  );
}

function safeNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure({
      code: "invalid_usage",
      kind: "contract",
      stage: "after_provider_event",
    }, `${label} is outside nonnegative safe-integer bounds`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw failure({
      code: "invalid_usage",
      kind: "contract",
      stage: "after_provider_event",
    }, `${label} is outside nonnegative safe-integer bounds`);
  }
  return result;
}

function nullableUsageComponent(
  value: number | null,
  label: string,
): number {
  return value === null ? 0 : safeNonnegativeInteger(value, label);
}

function normalizeUsage(usage: ModelUsage): NormalizedUsage {
  return Object.freeze({
    cacheReadTokens: nullableUsageComponent(
      usage.cacheReadTokens,
      "cache-read tokens",
    ),
    cacheWriteTokens: nullableUsageComponent(
      usage.cacheWriteTokens,
      "cache-write tokens",
    ),
    completeness: usage.completeness,
    inputTokens: nullableUsageComponent(usage.inputTokens, "input tokens"),
    outputTokens: nullableUsageComponent(usage.outputTokens, "output tokens"),
    totalTokens: nullableUsageComponent(usage.totalTokens, "total tokens"),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function historicalMemoryItemCount(request: ModelTurnRequest): number {
  const canonicalContext = request.canonicalContext;
  if (canonicalContext === undefined) {
    if (request.contextPlan !== undefined) {
      throw failure({
        code: "invalid_canonical_context",
        kind: "contract",
        stage: "before_provider_request",
      }, "context-plan evidence was present without canonical context");
    }
    return 0;
  }
  if (
    canonicalContext.encoding !== "bornagent.context.v1+json" ||
    !SHA256.test(canonicalContext.sha256) ||
    sha256Text(canonicalContext.text) !== canonicalContext.sha256 ||
    (request.contextPlan !== undefined &&
      request.contextPlan.canonicalContextSha256 !== canonicalContext.sha256)
  ) {
    throw failure({
      code: "invalid_canonical_context",
      kind: "contract",
      stage: "before_provider_request",
    }, "canonical context did not preserve its hash-bound authority");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(canonicalContext.text) as unknown;
  } catch {
    throw failure({
      code: "invalid_canonical_context",
      kind: "contract",
      stage: "before_provider_request",
    }, "canonical context was not valid JSON");
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.items)) {
    throw failure({
      code: "invalid_canonical_context",
      kind: "contract",
      stage: "before_provider_request",
    }, "canonical context omitted its item array");
  }
  let count = 0;
  for (const item of decoded.items) {
    if (!isRecord(item) || typeof item.kind !== "string") {
      throw failure({
        code: "invalid_canonical_context",
        kind: "contract",
        stage: "before_provider_request",
      }, "canonical context contained an invalid item descriptor");
    }
    if (item.kind === "historical_memory") count += 1;
  }
  return count;
}

function sanitizedRequestObservation(
  backend: ModelBackend,
  request: ModelTurnRequest,
  requestIndex: number,
): Readonly<Record<string, unknown>> {
  const input = request.input.kind === "tool_result"
    ? {
        callIdSha256: sha256Text(request.input.callId),
        kind: request.input.kind,
        outputSha256: sha256Text(request.input.output),
      }
    : {
        kind: request.input.kind,
        textSha256: sha256Text(request.input.text),
      };
  return Object.freeze({
    backendIdentitySha256: sha256Canonical(backend.identity),
    canonicalContextSha256: request.canonicalContext?.sha256 ?? null,
    contextPlanSha256: request.contextPlan === undefined
      ? null
      : sha256Canonical(request.contextPlan),
    input,
    instructionsSha256: sha256Text(request.instructions),
    requestIndex,
    schemaVersion: 1,
    timeoutMs: request.timeoutMs,
    toolCatalogSha256: sha256Canonical(request.tools),
    toolCount: request.tools.length,
  });
}

function peakCostUsdMicros(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
): number {
  const nonOutputTokens = safeAdd(
    safeAdd(inputTokens, cacheReadTokens, "peak-cost non-output tokens"),
    cacheWriteTokens,
    "peak-cost non-output tokens",
  );
  const numerator =
    BigInt(nonOutputTokens) *
      BigInt(MEM_E0_ACTOR_QUALIFICATION_PEAK_INPUT_USD_MICROS_PER_MILLION) +
    BigInt(outputTokens) *
      BigInt(MEM_E0_ACTOR_QUALIFICATION_PEAK_OUTPUT_USD_MICROS_PER_MILLION);
  const result = Number(
    (numerator + BigInt(TOKENS_PER_PRICING_UNIT - 1)) /
      BigInt(TOKENS_PER_PRICING_UNIT),
  );
  if (!Number.isSafeInteger(result) || result < 0) {
    throw failure({
      code: "invalid_usage",
      kind: "contract",
      stage: "finalize",
    }, "peak provider cost is outside nonnegative safe-integer bounds");
  }
  return result;
}

export class MemE0ActorQualificationProviderMeter {
  readonly #requests: MutableRequestObservation[] = [];
  readonly #requestObservationSha256s: string[] = [];
  readonly #usageObservationSha256s: string[] = [];
  readonly #retryPolicyEvidence: MemE0ActorQualificationRetryPolicyEvidence;
  #cacheReadTokens = 0;
  #cacheWriteTokens = 0;
  #completeUsageEvents = 0;
  #fatalFailure: MemE0ActorQualificationProviderMeterError | null = null;
  #finalized: MemE0ActorQualificationProviderObservation | null = null;
  #historicalMemoryItemCount = 0;
  #inputTokens = 0;
  #maximumObservedOutputTokensPerRequest = 0;
  #outputTokens = 0;
  #partialUsageEvents = 0;
  #requestsCompleted = 0;
  #totalTokens = 0;

  constructor(readonly options: MemE0ActorQualificationProviderMeterOptions) {
    if (
      !SHA256.test(options.pricingSha256) ||
      !SHA256.test(options.frozenProductionImplementationIdentitySha256)
    ) {
      throw new TypeError("MEM-E0 provider meter requires hash-bound pricing and production identity");
    }
    this.#retryPolicyEvidence = Object.freeze({
      configuredMaximumRetries: 0,
      evidenceKind: "frozen_production_implementation_identity",
      frozenProductionImplementationIdentitySha256:
        options.frozenProductionImplementationIdentitySha256,
      // The production adapter freezes maxRetries=0. This wrapper is above the
      // transport and therefore deliberately makes no observed-retry claim.
      transportRetriesObserved: null,
    });
  }

  #rememberFatal(
    value: MemE0ActorQualificationProviderMeterError,
  ): MemE0ActorQualificationProviderMeterError {
    this.#fatalFailure ??= value;
    return value;
  }

  #observeUsage(
    usage: ModelUsage,
    request: MutableRequestObservation,
    requestIndex: number,
  ): MemE0ActorQualificationProviderMeterError | null {
    let normalized: NormalizedUsage;
    try {
      normalized = normalizeUsage(usage);
    } catch (error) {
      if (error instanceof MemE0ActorQualificationProviderMeterError) {
        return this.#rememberFatal(error);
      }
      throw error;
    }
    const nextCacheReadTokens = safeAdd(
      this.#cacheReadTokens,
      normalized.cacheReadTokens,
      "aggregate cache-read tokens",
    );
    const nextCacheWriteTokens = safeAdd(
      this.#cacheWriteTokens,
      normalized.cacheWriteTokens,
      "aggregate cache-write tokens",
    );
    const nextInputTokens = safeAdd(
      this.#inputTokens,
      normalized.inputTokens,
      "aggregate input tokens",
    );
    const nextOutputTokens = safeAdd(
      this.#outputTokens,
      normalized.outputTokens,
      "aggregate output tokens",
    );
    const nextTotalTokens = safeAdd(
      this.#totalTokens,
      normalized.totalTokens,
      "aggregate reported tokens",
    );
    request.usageEvents += 1;
    if (normalized.completeness === "complete") {
      request.completeUsageEvents += 1;
      this.#completeUsageEvents += 1;
    } else {
      request.partialUsageEvents += 1;
      this.#partialUsageEvents += 1;
    }
    this.#cacheReadTokens = nextCacheReadTokens;
    this.#cacheWriteTokens = nextCacheWriteTokens;
    this.#inputTokens = nextInputTokens;
    this.#outputTokens = nextOutputTokens;
    this.#totalTokens = nextTotalTokens;
    this.#maximumObservedOutputTokensPerRequest = Math.max(
      this.#maximumObservedOutputTokensPerRequest,
      normalized.outputTokens,
    );
    this.#usageObservationSha256s.push(sha256Canonical({
      ...normalized,
      requestIndex,
      schemaVersion: 1,
      usageEventIndex: request.usageEvents,
    }));

    if (normalized.completeness !== "complete") {
      return this.#rememberFatal(failure({
        code: "invalid_usage",
        kind: "contract",
        stage: "after_provider_event",
      }, "MEM-E0 qualification requires complete provider usage"));
    }
    const expectedTotal = safeAdd(
      safeAdd(
        normalized.inputTokens,
        normalized.outputTokens,
        "per-request reported token components",
      ),
      safeAdd(
        normalized.cacheReadTokens,
        normalized.cacheWriteTokens,
        "per-request reported token components",
      ),
      "per-request reported token components",
    );
    if (normalized.totalTokens !== expectedTotal) {
      return this.#rememberFatal(failure({
        code: "invalid_usage",
        kind: "contract",
        observed: normalized.totalTokens,
        stage: "after_provider_event",
      }, "reported total did not equal input, output, cache-read, and cache-write tokens"));
    }
    if (request.usageEvents !== 1 || request.completeUsageEvents !== 1) {
      return this.#rememberFatal(failure({
        code: "invalid_usage",
        kind: "contract",
        observed: request.usageEvents,
        stage: "after_provider_event",
      }, "one provider request emitted more than one usage event"));
    }
    if (
      normalized.outputTokens >
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST
    ) {
      return this.#rememberFatal(failure({
        code: "per_request_output_token_ceiling_exceeded",
        kind: "cap",
        limit: MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST,
        observed: normalized.outputTokens,
        stage: "after_provider_event",
      }, "per-request output-token ceiling was exceeded"));
    }
    if (
      this.#outputTokens >
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL
    ) {
      return this.#rememberFatal(failure({
        code: "aggregate_output_token_ceiling_exceeded",
        kind: "cap",
        limit: MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL,
        observed: this.#outputTokens,
        stage: "after_provider_event",
      }, "aggregate output-token ceiling was exceeded"));
    }
    if (
      this.#totalTokens > MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS
    ) {
      return this.#rememberFatal(failure({
        code: "aggregate_reported_token_ceiling_exceeded",
        kind: "cap",
        limit: MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS,
        observed: this.#totalTokens,
        stage: "after_provider_event",
      }, "aggregate reported-token ceiling was exceeded"));
    }
    return null;
  }

  async *#runMeteredTurn(
    backend: ModelBackend,
    request: ModelTurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (this.#finalized !== null) {
      throw this.#rememberFatal(failure({
        code: "qualification_observation_incomplete",
        kind: "contract",
        stage: "before_provider_request",
      }, "provider request was attempted after meter finalization"));
    }
    if (this.#fatalFailure !== null) throw this.#fatalFailure;
    if (
      this.#requests.length >=
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS
    ) {
      throw this.#rememberFatal(failure({
        code: "provider_request_ceiling_exceeded",
        kind: "cap",
        limit: MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS,
        observed: this.#requests.length + 1,
        stage: "before_provider_request",
      }, "provider request ceiling would be exceeded"));
    }

    let historicalCount: number;
    try {
      historicalCount = historicalMemoryItemCount(request);
    } catch (error) {
      if (error instanceof MemE0ActorQualificationProviderMeterError) {
        throw this.#rememberFatal(error);
      }
      throw error;
    }
    this.#historicalMemoryItemCount = safeAdd(
      this.#historicalMemoryItemCount,
      historicalCount,
      "historical-memory item count",
    );
    if (historicalCount !== 0) {
      throw this.#rememberFatal(failure({
        code: "historical_memory_present",
        kind: "contract",
        observed: historicalCount,
        stage: "before_provider_request",
      }, "memory-off qualification cannot send historical memory"));
    }

    const requestIndex = this.#requests.length + 1;
    const state: MutableRequestObservation = {
      completeUsageEvents: 0,
      partialUsageEvents: 0,
      turnCompletedEvents: 0,
      usageEvents: 0,
    };
    this.#requests.push(state);
    this.#requestObservationSha256s.push(
      sha256Canonical(sanitizedRequestObservation(backend, request, requestIndex)),
    );

    for await (const event of backend.runTurn(request, signal)) {
      if (state.turnCompletedEvents !== 0) {
        throw this.#rememberFatal(failure({
          code: event.type === "turn_completed"
            ? "duplicate_turn_completed"
            : "usage_after_turn_completed",
          kind: "contract",
          stage: "after_provider_event",
        }, "provider emitted an event after turn completion"));
      }
      if (event.type === "usage") {
        let violation: MemE0ActorQualificationProviderMeterError | null;
        try {
          violation = this.#observeUsage(event.usage, state, requestIndex);
        } catch (error) {
          if (error instanceof MemE0ActorQualificationProviderMeterError) {
            throw this.#rememberFatal(error);
          }
          throw error;
        }
        // Preserve the billed usage event for the product consumer before a
        // local post-response boundary interrupts the stream.
        yield event;
        if (violation !== null) throw violation;
        continue;
      }
      if (event.type === "turn_completed") {
        state.turnCompletedEvents += 1;
        this.#requestsCompleted += 1;
        if (state.turnCompletedEvents !== 1) {
          throw this.#rememberFatal(failure({
            code: "duplicate_turn_completed",
            kind: "contract",
            observed: state.turnCompletedEvents,
            stage: "after_provider_event",
          }, "provider emitted turn completion more than once"));
        }
        if (
          state.usageEvents !== 1 ||
          state.completeUsageEvents !== 1 ||
          state.partialUsageEvents !== 0
        ) {
          throw this.#rememberFatal(failure({
            code: "turn_completed_without_exact_complete_usage",
            kind: "contract",
            observed: state.usageEvents,
            stage: "after_provider_event",
          }, "turn completion lacked exactly one complete usage event"));
        }
        yield event;
        continue;
      }
      if (event.type === "failed") {
        yield event;
        return;
      }
      yield event;
    }
    if (state.turnCompletedEvents === 0 && !signal.aborted) {
      throw this.#rememberFatal(failure({
        code: "stream_ended_without_turn_completed",
        kind: "contract",
        stage: "after_provider_event",
      }, "provider stream ended without turn completion"));
    }
  }

  wrap(backend: ModelBackend): ModelBackend {
    return Object.freeze({
      capabilities: backend.capabilities,
      ...(backend.contextCapacity === undefined
        ? {}
        : { contextCapacity: backend.contextCapacity }),
      identity: backend.identity,
      ...(backend.prepareTurnRequest === undefined
        ? {}
        : {
            prepareTurnRequest(request: ModelTurnRequest): PreparedModelTurnRequest {
              return backend.prepareTurnRequest!(request);
            },
          }),
      resume: backend.resume,
      runTurn: (
        request: ModelTurnRequest,
        signal: AbortSignal,
      ): AsyncIterable<ModelEvent> => this.#runMeteredTurn(backend, request, signal),
    });
  }

  snapshot(): MemE0ActorQualificationProviderObservation {
    const reportedCost = peakCostUsdMicros(
      this.#inputTokens,
      this.#cacheReadTokens,
      this.#cacheWriteTokens,
      this.#outputTokens,
    );
    const usageCoverageComplete =
      this.#requests.length > 0 &&
      this.#completeUsageEvents === this.#requests.length &&
      this.#partialUsageEvents === 0 &&
      this.#usageObservationSha256s.length === this.#requests.length;
    // A started request without authoritative usage may already have been
    // billed. The failure snapshot therefore reserves the whole authorized
    // qualification budget instead of misreporting that unknown charge as 0.
    const accountedPeakCostUsdMicros =
      this.#requests.length > 0 &&
        (!usageCoverageComplete || this.#fatalFailure !== null)
        ? Math.max(
            reportedCost,
            MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
          )
        : reportedCost;
    return Object.freeze({
      historicalMemoryItemCount: this.#historicalMemoryItemCount,
      providerUsage: Object.freeze({
        accountedPeakCostUsdMicros,
        cacheReadTokens: this.#cacheReadTokens,
        cacheWriteTokens: this.#cacheWriteTokens,
        completeUsageEvents: this.#completeUsageEvents,
        inputTokens: this.#inputTokens,
        isProviderInvoice: false,
        maximumAuthorizedCostUsdMicros:
          MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
        maximumObservedOutputTokensPerRequest:
          this.#maximumObservedOutputTokensPerRequest,
        outputTokens: this.#outputTokens,
        partialUsageEvents: this.#partialUsageEvents,
        pricingSha256: this.options.pricingSha256,
        requestObservationSha256s: Object.freeze([
          ...this.#requestObservationSha256s,
        ]),
        requestsCompleted: this.#requestsCompleted,
        requestsStarted: this.#requests.length,
        // This numeric field is retained for the receipt schema. Its evidence
        // is configuration identity, never a meter-observed transport count.
        retries: 0,
        retryPolicyEvidence: this.#retryPolicyEvidence,
        totalTokens: this.#totalTokens,
        usageObservationSha256s: Object.freeze([
          ...this.#usageObservationSha256s,
        ]),
      }),
    });
  }

  finalize(): MemE0ActorQualificationProviderObservation {
    if (this.#finalized !== null) return this.#finalized;
    const complete =
      this.#fatalFailure === null &&
      this.#historicalMemoryItemCount === 0 &&
      this.#requests.length > 0 &&
      this.#requests.length <=
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_PROVIDER_REQUESTS &&
      this.#requestsCompleted === this.#requests.length &&
      this.#completeUsageEvents === this.#requests.length &&
      this.#partialUsageEvents === 0 &&
      this.#requestObservationSha256s.length === this.#requests.length &&
      this.#usageObservationSha256s.length === this.#requests.length &&
      this.#maximumObservedOutputTokensPerRequest <=
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_PER_REQUEST &&
      this.#outputTokens <=
        MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_OUTPUT_TOKENS_TOTAL &&
      this.#totalTokens <= MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_REPORTED_TOKENS &&
      this.#requests.every((request) =>
        request.usageEvents === 1 &&
        request.completeUsageEvents === 1 &&
        request.partialUsageEvents === 0 &&
        request.turnCompletedEvents === 1
      );
    if (!complete) {
      throw this.#rememberFatal(failure({
        code: "qualification_observation_incomplete",
        kind: "contract",
        stage: "finalize",
      }, "provider observation did not close every qualification request exactly once"));
    }
    this.#finalized = this.snapshot();
    return this.#finalized;
  }
}
