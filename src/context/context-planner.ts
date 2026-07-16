import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import {
  contextItemCanonicalValue,
  type ContextItem,
  type ContextJson,
} from "./context-item.js";
import type { ProjectedContextState } from "./context-projector.js";
import {
  DeterministicCompactor,
  type ContextCompactionResult,
  type DeterministicCompactorOptions,
} from "./deterministic-compactor.js";
import {
  parseContextPlan,
  type ContextPlan,
} from "./context-plan-schema.js";
import type { ContextBudget, TokenEstimator } from "./token-estimator.js";

export interface ContextPlannerOptions extends DeterministicCompactorOptions {
  readonly plannerVersion?: string;
}

export interface MaterializedCanonicalContext {
  readonly bytes: Uint8Array;
  readonly items: readonly ContextItem[];
  readonly sha256: string;
  readonly text: string;
}

interface BuiltPlan {
  readonly compaction: ContextCompactionResult;
  readonly envelope: ContextJson;
  readonly plan: ContextPlan;
}

export class ContextPlanError extends Error {
  public readonly exitCode = 7 as const;

  public constructor(
    public readonly code: "context_estimate_overflow",
    message: string,
    public readonly estimatedTokens: number,
    public readonly limitTokens: number,
  ) {
    super(message);
    this.name = "ContextPlanError";
  }
}

function canonicalEnvelope(
  compaction: ContextCompactionResult,
  budget: ContextBudget,
  estimator: TokenEstimator,
  plannerVersion: string,
): ContextJson {
  return {
    budget: {
      absolute_input_tokens: budget.absoluteInputTokens,
      capacity_source: budget.capacitySource,
      compaction_target_tokens: budget.compactionTargetTokens,
      compaction_threshold: budget.compactionThreshold,
      context_window_tokens: budget.contextWindowTokens,
      fixed_safety_margin_tokens: budget.fixedSafetyMarginTokens,
      reserved_output_tokens: budget.reservedOutputTokens,
    },
    epoch: compaction.epoch,
    estimator: {
      estimator_id: estimator.estimatorId,
      ...estimator.metadata,
    },
    items: compaction.includedItems.map(contextItemCanonicalValue),
    planner_version: plannerVersion,
    protected_facts: compaction.ledger.facts.map((fact) => ({
      category: fact.category,
      fact_id: fact.factId,
      item_id: fact.itemId,
      source_event_ids: fact.sourceEventIds,
    })),
    schema_version: 1,
  };
}

export class ContextPlanner {
  readonly #compactor: DeterministicCompactor;
  readonly #plannerVersion: string;

  public constructor(
    private readonly estimator: TokenEstimator,
    options: ContextPlannerOptions = {},
  ) {
    this.#plannerVersion = options.plannerVersion ?? "phase10-v1";
    if (!/^[a-z0-9._-]+$/u.test(this.#plannerVersion)) {
      throw new TypeError("planner version must be a stable identifier");
    }
    this.#compactor = new DeterministicCompactor(estimator, options);
  }

  public plan(
    state: ProjectedContextState,
    budget: ContextBudget,
  ): ContextPlan {
    return this.#build(state, budget).plan;
  }

  public materialize(
    state: ProjectedContextState,
    budget: ContextBudget,
    expectedPlan: ContextPlan,
  ): MaterializedCanonicalContext {
    const built = this.#build(state, budget);
    if (
      canonicalJson(built.plan) !== canonicalJson(expectedPlan)
    ) {
      throw new TypeError("context plan no longer matches its deterministic inputs");
    }
    const text = canonicalJson(built.envelope);
    return Object.freeze({
      bytes: new TextEncoder().encode(text),
      items: built.compaction.includedItems,
      sha256: built.plan.canonicalContextSha256,
      text,
    });
  }

  #build(state: ProjectedContextState, budget: ContextBudget): BuiltPlan {
    const compaction = this.#compactor.compact(state, budget);
    const envelope = canonicalEnvelope(
      compaction,
      budget,
      this.estimator,
      this.#plannerVersion,
    );
    // PHASE10: this provider-neutral hash is the replay authority. A backend's
    // optional credential-free encoded request hash is separate wire evidence
    // and must never replace this value or drive compaction.
    const canonicalContextSha256 = sha256Canonical(envelope);
    const estimatedInputTokens = this.estimator.estimateText(
      canonicalJson(envelope),
    ).estimatedTokens;
    if (estimatedInputTokens > budget.absoluteInputTokens) {
      throw new ContextPlanError(
        "context_estimate_overflow",
        "materialized canonical context exceeds absolute input capacity",
        estimatedInputTokens,
        budget.absoluteInputTokens,
      );
    }
    const plan = parseContextPlan({
      archivedItemIds: compaction.archivedItemIds,
      canonicalContextSha256,
      capacity: budget,
      compacted: compaction.compacted,
      descriptorItemIds: compaction.descriptorItemIds,
      epoch: compaction.epoch,
      estimatedInputTokens,
      estimator: {
        estimatorId: this.estimator.estimatorId,
        ...this.estimator.metadata,
      },
      includedItemIds: compaction.includedItems.map(({ id }) => id),
      plannerVersion: this.#plannerVersion,
      protectedEstimatedTokens:
        compaction.protectedClosureEstimatedTokens,
      protectedFactIds: compaction.ledger.facts.map(({ factId }) => factId),
      protectedItemIds: compaction.ledger.protectedItemIds,
      schemaVersion: 1,
    });
    return Object.freeze({ compaction, envelope, plan });
  }
}
