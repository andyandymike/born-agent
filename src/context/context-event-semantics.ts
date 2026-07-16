import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";

type EstimateEvent = Extract<
  DecodedRunEvent,
  { readonly type: "context.estimate.created" }
>;
type CompactionEvent = Extract<
  DecodedRunEvent,
  { readonly type: "context.compaction.started" }
>;
type PlanEvent = Extract<
  DecodedRunEvent,
  { readonly type: "context.plan.created" }
>;
type EncodedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "model.request.encoded" }
>;
type FailureEvent = Extract<
  DecodedRunEvent,
  { readonly type: "context.compaction.failed" }
>;

interface ContextStepState {
  compaction?: CompactionEvent;
  encoded?: EncodedEvent;
  estimate?: EstimateEvent;
  failure?: FailureEvent;
  plan?: PlanEvent;
}

interface ContextRunState {
  epoch: number;
  phase10Observed: boolean;
  readonly startedSteps: Set<number>;
  readonly steps: Map<number, ContextStepState>;
}

export class ContextEventSemanticError extends Error {
  override readonly name = "ContextEventSemanticError";

  public constructor(
    message: string,
    readonly runId: string,
    readonly sessionSeq: number,
  ) {
    super(`${message} at session_seq ${sessionSeq}`);
  }
}

function fail(event: DecodedRunEvent, message: string): never {
  throw new ContextEventSemanticError(message, event.runId, event.sessionSeq);
}

function stepState(
  state: ContextRunState,
  step: number,
): ContextStepState {
  const existing = state.steps.get(step) ?? {};
  state.steps.set(step, existing);
  return existing;
}

function contextBudgetReason(value: string): boolean {
  return [
    "context_estimate_overflow",
    "context_protected_overflow",
    "context_unsafe_compaction",
  ].includes(value);
}

function activatePhase10(
  state: ContextRunState,
  event: DecodedRunEvent,
): void {
  state.phase10Observed = true;
  for (const startedStep of state.startedSteps) {
    if (state.steps.get(startedStep)?.encoded === undefined) {
      fail(
        event,
        "Phase 10 run contains an agent step without a durable encoded request",
      );
    }
  }
}

/**
 * Replay and online append share this validator so a schema-valid encoded
 * request cannot appear before its durable provider-neutral plan.
 */
export function assertPhase10ContextEventSemantics(
  events: readonly DecodedStoredEvent[],
): void {
  const runs = new Map<string, ContextRunState>();
  let sessionEpoch = 0;
  for (const event of events) {
    if (event.scope === "session") continue;
    if (event.type === "run.started") {
      runs.set(event.runId, {
        epoch: sessionEpoch,
        phase10Observed: false,
        startedSteps: new Set(),
        steps: new Map(),
      });
      continue;
    }
    const state = runs.get(event.runId);
    if (state === undefined) fail(event, "context event has no run.started");

    switch (event.type) {
      case "repository.rules.loaded":
        activatePhase10(state, event);
        break;
      case "context.estimate.created": {
        activatePhase10(state, event);
        const step = stepState(state, event.data.step);
        if (step.estimate !== undefined || event.data.epoch !== state.epoch) {
          fail(event, "context estimate duplicates a step or uses a stale epoch");
        }
        step.estimate = event;
        break;
      }
      case "context.compaction.started": {
        activatePhase10(state, event);
        const step = stepState(state, event.data.step);
        if (
          step.estimate === undefined ||
          step.compaction !== undefined ||
          step.plan !== undefined ||
          event.data.from_epoch !== state.epoch ||
          event.data.to_epoch !== state.epoch + 1 ||
          event.data.estimated_input_tokens !==
            step.estimate.data.estimated_input_tokens ||
          event.data.target_input_tokens !==
            step.estimate.data.compaction_target_tokens
        ) {
          fail(event, "context compaction does not match its durable estimate");
        }
        step.compaction = event;
        break;
      }
      case "context.plan.created": {
        activatePhase10(state, event);
        const step = stepState(state, event.data.step);
        const expectedEpoch =
          step.compaction === undefined ? state.epoch : state.epoch + 1;
        if (
          step.estimate === undefined ||
          step.plan !== undefined ||
          step.failure !== undefined ||
          event.data.epoch !== expectedEpoch ||
          event.data.compacted !== (step.compaction !== undefined) ||
          event.data.estimated_input_tokens >
            step.estimate.data.absolute_input_tokens
        ) {
          fail(event, "context plan does not match its estimate/compaction epoch");
        }
        step.plan = event;
        state.epoch = event.data.epoch;
        sessionEpoch = event.data.epoch;
        break;
      }
      case "model.request.encoded": {
        activatePhase10(state, event);
        const step = stepState(state, event.data.step);
        if (
          step.plan === undefined ||
          step.encoded !== undefined ||
          step.failure !== undefined ||
          event.data.epoch !== step.plan.data.epoch ||
          event.data.canonical_context_sha256 !==
            step.plan.data.canonical_context_sha256
        ) {
          fail(event, "encoded model request has no matching durable context plan");
        }
        step.encoded = event;
        break;
      }
      case "context.compaction.failed": {
        activatePhase10(state, event);
        const step = stepState(state, event.data.step);
        if (
          step.estimate === undefined ||
          step.failure !== undefined ||
          step.plan !== undefined ||
          step.encoded !== undefined ||
          event.data.epoch !== step.estimate.data.epoch
        ) {
          fail(event, "context failure has no matching unplanned estimate");
        }
        step.failure = event;
        break;
      }
      case "agent.step.started": {
        state.startedSteps.add(event.data.step);
        const step = state.steps.get(event.data.step);
        if (state.phase10Observed && step?.encoded === undefined) {
          fail(event, "agent step started before model.request.encoded was durable");
        }
        break;
      }
      case "run.budget_exceeded": {
        if (!contextBudgetReason(event.data.reason)) break;
        const failure = [...state.steps.values()]
          .map(({ failure }) => failure)
          .filter((value): value is FailureEvent => value !== undefined)
          .at(-1);
        if (
          failure === undefined ||
          failure.data.reason !== event.data.reason ||
          failure.data.limit_input_tokens !== event.data.limit ||
          failure.data.estimated_input_tokens !== event.data.observed
        ) {
          fail(event, "context budget terminal does not match compaction failure");
        }
        break;
      }
      default:
        break;
    }
  }
}
