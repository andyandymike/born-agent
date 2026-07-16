import type { RunEvent } from "../events/run-event.js";
import type { RepositoryRuleSet } from "../repository-rules/repository-rule-set.js";
import {
  ContextProjector,
  type FrozenRepositoryRulesInput,
  type ProjectableContextEvent,
  type ProjectedContextState,
} from "./context-projector.js";
import type {
  ContextArtifactReference,
  ContextItem,
} from "./context-item.js";
import {
  ContextPlanner,
  type MaterializedCanonicalContext,
} from "./context-planner.js";
import type { ContextPlan } from "./context-plan-schema.js";
import type {
  ContextBudget,
  TokenEstimator,
  TokenEstimatorMetadata,
} from "./token-estimator.js";

export interface AgentContextRuntimeOptions {
  readonly budget: ContextBudget;
  readonly estimator: TokenEstimator;
  readonly plannerVersion?: string;
  readonly repositoryRules?: RepositoryRuleSet;
  readonly repositoryRulesEventId?: string;
  readonly systemInstructions: string;
}

export interface AgentContextPlanningInput {
  readonly additionalItems?: readonly ContextItem[];
  readonly artifactRefsByEventId?: Readonly<
    Record<string, readonly ContextArtifactReference[]>
  >;
  readonly epoch: number;
  readonly events: readonly (ProjectableContextEvent | RunEvent)[];
}

export interface AgentContextPlanningResult {
  readonly fullEstimatedInputTokens: number;
  readonly materialized: MaterializedCanonicalContext;
  readonly plan: ContextPlan;
  readonly state: ProjectedContextState;
}

export interface AgentContextProjectionResult {
  readonly fullEstimatedInputTokens: number;
  readonly state: ProjectedContextState;
}

function projectableEvent(
  event: ProjectableContextEvent | RunEvent,
): ProjectableContextEvent {
  if ("eventId" in event) return event;
  return Object.freeze({
    data: event.data,
    eventId: event.event_id,
    runId: event.run_id,
    runSeq: event.seq,
    sessionSeq: event.seq,
    type: event.type,
  });
}

function frozenRules(
  rules: RepositoryRuleSet | undefined,
  eventId: string | undefined,
): FrozenRepositoryRulesInput | null {
  const snapshot = rules?.snapshot;
  if (snapshot === undefined || snapshot.state === "missing") return null;
  return Object.freeze({
    artifactRef: Object.freeze({
      artifactId: snapshot.artifact.artifactId,
      bytes: snapshot.artifact.bytes,
      mediaType: "text/markdown; charset=utf-8",
      relativeRef: snapshot.artifact.relativeRef,
      sha256: snapshot.artifact.sha256,
    }),
    content: snapshot.content,
    eventId:
      eventId ??
      (() => {
        throw new TypeError(
          "loaded repository rules require their durable event id",
        );
      })(),
    priorityExplanation:
      "BornAgent policy > current user instructions > root AGENTS.md > narrative/content",
    sha256: snapshot.contentSha256,
  });
}

export class AgentContextRuntime {
  public readonly budget: ContextBudget;
  readonly #estimator: TokenEstimator;
  readonly #planner: ContextPlanner;
  readonly #projector: ContextProjector;
  readonly #repositoryRules: FrozenRepositoryRulesInput | null;
  readonly #systemInstructions: string;

  public constructor(options: AgentContextRuntimeOptions) {
    this.budget = options.budget;
    this.#estimator = options.estimator;
    this.#planner = new ContextPlanner(options.estimator, {
      ...(options.plannerVersion === undefined
        ? {}
        : { plannerVersion: options.plannerVersion }),
    });
    this.#projector = new ContextProjector(options.estimator);
    this.#repositoryRules = frozenRules(
      options.repositoryRules,
      options.repositoryRulesEventId,
    );
    this.#systemInstructions = options.systemInstructions;
  }

  public plan(input: AgentContextPlanningInput): AgentContextPlanningResult {
    return this.planProjected(this.project(input));
  }

  public project(
    input: AgentContextPlanningInput,
  ): AgentContextProjectionResult {
    const state = this.#projector.project({
      ...(input.additionalItems === undefined
        ? {}
        : { additionalItems: input.additionalItems }),
      ...(input.artifactRefsByEventId === undefined
        ? {}
        : { artifactRefsByEventId: input.artifactRefsByEventId }),
      epoch: input.epoch,
      events: input.events.map(projectableEvent),
      repositoryRules: this.#repositoryRules,
      systemInstructions: [
        {
          id: "agent-system-instructions",
          text: this.#systemInstructions,
          version: "phase10-v1",
        },
      ],
    });
    const fullEstimatedInputTokens = state.items.reduce(
      (total, item) => total + item.estimatedTokens,
      0,
    );
    return Object.freeze({ fullEstimatedInputTokens, state });
  }

  public planProjected(
    projection: AgentContextProjectionResult,
  ): AgentContextPlanningResult {
    const { fullEstimatedInputTokens, state } = projection;
    const plan = this.#planner.plan(state, this.budget);
    return Object.freeze({
      fullEstimatedInputTokens,
      materialized: this.#planner.materialize(state, this.budget, plan),
      plan,
      state,
    });
  }

  public estimateText(text: string): number {
    return this.#estimator.estimateText(text).estimatedTokens;
  }

  public get estimatorId(): string {
    return this.#estimator.estimatorId;
  }

  public get estimatorMetadata(): TokenEstimatorMetadata {
    return this.#estimator.metadata;
  }
}
