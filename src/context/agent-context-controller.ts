import type {
  ModelBackend,
  ModelTurnRequest,
} from "../model/model-backend.js";
import type { RunEvent } from "../events/run-event.js";
import type {
  AgentContextRuntime,
  AgentContextPlanningInput,
} from "./agent-context-runtime.js";
import {
  type Phase10ContextRunEventData,
  type Phase10ContextRunEventType,
} from "./context-event-schema.js";
import type { ProjectableContextEvent } from "./context-projector.js";
import {
  ContextCompactionError,
} from "./deterministic-compactor.js";
import type { ProtectedFactCategory } from "./context-item.js";
import { ContextPlanError } from "./context-planner.js";
import {
  modelCanonicalContextPayload,
  modelContextPlanReference,
  prepareContextBoundModelRequest,
} from "./model-context-request.js";
import { ProtectedFactLedger } from "./protected-fact-ledger.js";

export type ContextBudgetFailureReason =
  | "context_estimate_overflow"
  | "context_protected_overflow"
  | "context_unsafe_compaction";

export class ContextRequestBudgetError extends Error {
  public readonly exitCode = 7 as const;

  public constructor(
    public readonly reason: ContextBudgetFailureReason,
    public readonly estimatedTokens: number,
    public readonly limitTokens: number,
  ) {
    super(`context planning stopped: ${reason}`);
    this.name = "ContextRequestBudgetError";
  }
}

export interface ContextEventAppender {
  append<TType extends Phase10ContextRunEventType>(
    type: TType,
    data: Phase10ContextRunEventData<TType>,
  ): Promise<void>;
}

export interface AgentContextControllerOptions {
  readonly backend: ModelBackend;
  readonly beforePlan?: () => Promise<void>;
  readonly eventAppender: ContextEventAppender;
  readonly events: () => readonly (ProjectableContextEvent | RunEvent)[];
  readonly initialEpoch?: number;
  readonly runtime: AgentContextRuntime;
}

export interface ContextRequestInput {
  readonly input: ModelTurnRequest["input"];
  readonly instructions: string;
  readonly step: number;
  readonly timeoutMs: number;
  readonly tools: ModelTurnRequest["tools"];
}

function categoryEntries(
  values: Readonly<Record<string, number>>,
): readonly { readonly category: string; readonly estimated_tokens: number }[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, estimatedTokens]) => ({
      category,
      estimated_tokens: estimatedTokens,
    }));
}

export class AgentContextController {
  readonly #backend: ModelBackend;
  readonly #beforePlan: (() => Promise<void>) | undefined;
  readonly #eventAppender: ContextEventAppender;
  readonly #events: AgentContextControllerOptions["events"];
  readonly #runtime: AgentContextRuntime;
  #epoch: number;

  public constructor(options: AgentContextControllerOptions) {
    this.#backend = options.backend;
    this.#beforePlan = options.beforePlan;
    this.#eventAppender = options.eventAppender;
    this.#events = options.events;
    this.#runtime = options.runtime;
    this.#epoch = options.initialEpoch ?? 0;
    if (!Number.isSafeInteger(this.#epoch) || this.#epoch < 0) {
      throw new RangeError("initial context epoch must be nonnegative");
    }
  }

  public get epoch(): number {
    return this.#epoch;
  }

  public async prepare(input: ContextRequestInput): Promise<ModelTurnRequest> {
    await this.#beforePlan?.();
    const planningInput: AgentContextPlanningInput = {
      epoch: this.#epoch,
      events: this.#events(),
    };
    const projection = this.#runtime.project(planningInput);
    const budget = this.#runtime.budget;
    const metadata = this.#runtime.estimatorMetadata;
    await this.#eventAppender.append("context.estimate.created", {
      absolute_input_tokens: budget.absoluteInputTokens,
      capacity_source: budget.capacitySource,
      compaction_target_tokens: budget.compactionTargetTokens,
      compaction_threshold: budget.compactionThreshold,
      context_window_tokens: budget.contextWindowTokens,
      epoch: this.#epoch,
      estimated_input_tokens: projection.fullEstimatedInputTokens,
      estimator_id: this.#runtime.estimatorId,
      estimator_version: metadata.version,
      fixed_safety_margin_tokens: budget.fixedSafetyMarginTokens,
      model: metadata.model,
      provider: metadata.provider,
      reserved_output_tokens: budget.reservedOutputTokens,
      step: input.step,
      tokenizer: metadata.tokenizer,
    });

    const ledger = new ProtectedFactLedger().project({
      activeEffectIds: projection.state.activeEffectIds,
      items: projection.state.items,
    });
    const shouldCompact =
      projection.fullEstimatedInputTokens > budget.compactionTargetTokens;
    if (shouldCompact) {
      await this.#eventAppender.append("context.compaction.started", {
        estimated_input_tokens: projection.fullEstimatedInputTokens,
        from_epoch: this.#epoch,
        protected_estimated_tokens: ledger.totalEstimatedTokens,
        step: input.step,
        target_input_tokens: budget.compactionTargetTokens,
        to_epoch: this.#epoch + 1,
      });
    }

    let planned;
    try {
      planned = this.#runtime.planProjected(projection);
    } catch (error) {
      const failure =
        error instanceof ContextCompactionError &&
        ["context_protected_overflow", "context_unsafe_compaction"].includes(
          error.code,
        )
          ? {
              activeEffectIds: error.details.activeEffectIds,
              categoryEstimatedTokens: error.details.categoryEstimatedTokens,
              estimatedTokens: error.details.estimatedTokens,
              limitTokens: error.details.limitTokens,
              reason: error.code as ContextBudgetFailureReason,
            }
          : error instanceof ContextPlanError
            ? {
                activeEffectIds: [] as readonly string[],
                categoryEstimatedTokens: ledger.categoryEstimatedTokens,
                estimatedTokens: error.estimatedTokens,
                limitTokens: error.limitTokens,
                reason: error.code as ContextBudgetFailureReason,
              }
            : null;
      if (failure === null) throw error;
      await this.#eventAppender.append("context.compaction.failed", {
        active_effect_ids: [...failure.activeEffectIds],
        category_estimated_tokens: categoryEntries(
          failure.categoryEstimatedTokens,
        ) as Phase10ContextRunEventData<"context.compaction.failed">["category_estimated_tokens"],
        epoch: this.#epoch,
        estimated_input_tokens: failure.estimatedTokens,
        limit_input_tokens: failure.limitTokens,
        reason: failure.reason,
        step: input.step,
      });
      throw new ContextRequestBudgetError(
        failure.reason,
        failure.estimatedTokens,
        failure.limitTokens,
      );
    }

    const plan = planned.plan;
    await this.#eventAppender.append("context.plan.created", {
      archived_item_ids: [...plan.archivedItemIds],
      canonical_context_sha256: plan.canonicalContextSha256,
      compacted: plan.compacted,
      descriptor_item_ids: [...plan.descriptorItemIds],
      epoch: plan.epoch,
      estimated_input_tokens: plan.estimatedInputTokens,
      included_item_ids: [...plan.includedItemIds],
      planner_version: plan.plannerVersion,
      protected_estimated_tokens: plan.protectedEstimatedTokens,
      protected_categories: (
        Object.keys(ledger.categoryEstimatedTokens) as ProtectedFactCategory[]
      ).sort(),
      protected_fact_ids: [...plan.protectedFactIds],
      protected_item_ids: [...plan.protectedItemIds],
      step: input.step,
    });
    // PHASE10: advance the in-memory epoch only after the plan is durable.
    this.#epoch = plan.epoch;

    const prepared = prepareContextBoundModelRequest(this.#backend, {
      canonicalContext: modelCanonicalContextPayload(
        planned.materialized,
        plan.compacted ? "replace" : "augment",
      ),
      contextPlan: modelContextPlanReference(plan),
      input: input.input,
      instructions: input.instructions,
      timeoutMs: input.timeoutMs,
      tools: input.tools,
    });
    await this.#eventAppender.append("model.request.encoded", {
      adapter: this.#backend.identity.adapter,
      adapter_encoding_version: prepared.adapterEncodingVersion,
      adapter_version: this.#backend.identity.adapterVersion,
      canonical_context_sha256: plan.canonicalContextSha256,
      ...(prepared.encodedRequestSha256 === undefined
        ? {}
        : { encoded_request_sha256: prepared.encodedRequestSha256 }),
      epoch: plan.epoch,
      model: this.#backend.identity.model,
      provider: this.#backend.identity.provider,
      step: input.step,
    });
    return prepared.request;
  }
}
