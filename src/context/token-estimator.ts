import {
  canonicalJson,
  sha256Canonical,
} from "../completion/canonical-json.js";
import type { ContextCapacity } from "../model/model-context-capacity.js";

export type { ContextCapacity } from "../model/model-context-capacity.js";

export interface TokenEstimatorMetadata {
  readonly model: string;
  readonly provider: string;
  readonly tokenizer: string;
  readonly version: string;
}

export interface TokenEstimate {
  readonly estimatedTokens: number;
  readonly estimatorId: string;
  readonly utf8Bytes: number;
}

export interface TokenEstimator {
  readonly estimatorId: string;
  readonly metadata: TokenEstimatorMetadata;
  estimateCanonical(value: unknown): TokenEstimate;
  estimateText(text: string): TokenEstimate;
}

export interface DeterministicTokenEstimatorOptions
  extends TokenEstimatorMetadata {
  readonly bytesPerToken?: number;
  readonly itemOverheadTokens?: number;
}

export interface ContextBudgetOptions {
  readonly compactionThreshold: number;
  readonly fixedSafetyMarginTokens?: number;
  readonly reservedOutputTokens: number;
}

export interface ContextBudget {
  readonly absoluteInputTokens: number;
  readonly capacitySource: ContextCapacity["source"];
  readonly compactionTargetTokens: number;
  readonly compactionThreshold: number;
  readonly contextWindowTokens: number;
  readonly fixedSafetyMarginTokens: number;
  readonly reservedOutputTokens: number;
}

export type ContextBudgetErrorCode =
  | "context_capacity_unknown"
  | "context_capacity_invalid"
  | "context_reserve_invalid"
  | "context_threshold_invalid";

export class ContextBudgetError extends Error {
  public constructor(
    public readonly code: ContextBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class DeterministicTokenEstimator implements TokenEstimator {
  public readonly estimatorId: string;
  public readonly metadata: TokenEstimatorMetadata;
  readonly #bytesPerToken: number;
  readonly #itemOverheadTokens: number;

  public constructor(options: DeterministicTokenEstimatorOptions) {
    if (
      options.model.length === 0 ||
      options.provider.length === 0 ||
      options.tokenizer.length === 0 ||
      options.version.length === 0
    ) {
      throw new TypeError("token estimator metadata must be non-empty");
    }
    const bytesPerToken = options.bytesPerToken ?? 3;
    const itemOverheadTokens = options.itemOverheadTokens ?? 8;
    if (!positiveInteger(bytesPerToken) || !Number.isSafeInteger(itemOverheadTokens) || itemOverheadTokens < 0) {
      throw new RangeError("token estimator formula must use bounded integers");
    }
    this.metadata = Object.freeze({
      model: options.model,
      provider: options.provider,
      tokenizer: options.tokenizer,
      version: options.version,
    });
    this.#bytesPerToken = bytesPerToken;
    this.#itemOverheadTokens = itemOverheadTokens;
    this.estimatorId = sha256Canonical({
      bytes_per_token: bytesPerToken,
      item_overhead_tokens: itemOverheadTokens,
      metadata: this.metadata,
      schema_version: 1,
    });
  }

  public estimateCanonical(value: unknown): TokenEstimate {
    return this.estimateText(canonicalJson(value));
  }

  public estimateText(text: string): TokenEstimate {
    const bytes = utf8Bytes(text);
    // PHASE10: this deterministic estimate is planning/UI evidence only. It
    // must never be persisted or aggregated as provider-reported usage.
    return Object.freeze({
      estimatedTokens:
        Math.max(1, Math.ceil(bytes / this.#bytesPerToken)) +
        this.#itemOverheadTokens,
      estimatorId: this.estimatorId,
      utf8Bytes: bytes,
    });
  }
}

export function resolveContextBudget(
  capacity: ContextCapacity,
  options: ContextBudgetOptions,
): ContextBudget {
  if (capacity.contextWindowTokens === null) {
    throw new ContextBudgetError(
      "context_capacity_unknown",
      "context window is unknown; a conservative user limit is required",
    );
  }
  if (
    !positiveInteger(capacity.contextWindowTokens) ||
    (capacity.maximumOutputTokens !== null &&
      !positiveInteger(capacity.maximumOutputTokens))
  ) {
    throw new ContextBudgetError(
      "context_capacity_invalid",
      "context capacity values must be positive safe integers",
    );
  }
  if (
    !Number.isFinite(options.compactionThreshold) ||
    options.compactionThreshold < 0.5 ||
    options.compactionThreshold > 0.95
  ) {
    throw new ContextBudgetError(
      "context_threshold_invalid",
      "compaction threshold must be within 0.50..0.95",
    );
  }
  const reserve = options.reservedOutputTokens;
  const margin = options.fixedSafetyMarginTokens ?? 256;
  if (
    !positiveInteger(reserve) ||
    reserve < 512 ||
    reserve > 32_768 ||
    reserve * 2 > capacity.contextWindowTokens ||
    !Number.isSafeInteger(margin) ||
    margin < 0
  ) {
    throw new ContextBudgetError(
      "context_reserve_invalid",
      "reserved output or fixed safety margin is outside its safe range",
    );
  }
  const absoluteInputTokens =
    capacity.contextWindowTokens - reserve - margin;
  if (absoluteInputTokens <= 0) {
    throw new ContextBudgetError(
      "context_reserve_invalid",
      "reserved output and safety margin leave no input capacity",
    );
  }
  return Object.freeze({
    absoluteInputTokens,
    capacitySource: capacity.source,
    compactionTargetTokens: Math.max(
      1,
      Math.floor(absoluteInputTokens * options.compactionThreshold),
    ),
    compactionThreshold: options.compactionThreshold,
    contextWindowTokens: capacity.contextWindowTokens,
    fixedSafetyMarginTokens: margin,
    reservedOutputTokens: reserve,
  });
}
