import type {
  DecodedRunEvent,
  DecodedStoredEvent,
} from "./event-decoder-registry.js";
import {
  recoverCommandToolObservation,
  recoverPatchToolObservation,
  type CommandOutputAccumulator,
} from "../resume/pending-effect-ledger.js";
import type { RecoveredToolObservation } from "../resume/resume-types.js";

type BackendSelectedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "backend.selected" }
>;
type CheckpointEvent = Extract<
  DecodedRunEvent,
  { readonly type: "backend.checkpoint.created" }
>;
type PendingCallAdoptedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "resume.pending_call.adopted" }
>;
type RunStartedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "run.started" }
>;
type ToolCallRequestedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "tool.call.requested" }
>;
type ToolCallCompletedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "tool.call.completed" }
>;
type ToolCallRecoveredEvent = Extract<
  DecodedRunEvent,
  { readonly type: "tool.call.recovered" }
>;

export type Phase9RunEventSemanticErrorCode =
  | "adoption_invalid"
  | "backend_capability_mismatch"
  | "checkpoint_identity_mismatch"
  | "recovered_effect_mismatch"
  | "turn_sequence_invalid";

export class Phase9RunEventSemanticError extends Error {
  override readonly name = "Phase9RunEventSemanticError";

  constructor(
    readonly code: Phase9RunEventSemanticErrorCode,
    message: string,
    readonly runId: string,
    readonly sessionSeq: number,
  ) {
    super(`${message} at session_seq ${sessionSeq}`);
  }
}

interface InnerEffect {
  readonly kind: "command" | "patch";
  readonly observation: RecoveredToolObservation;
  readonly sessionSeq: number;
}

interface RunSemanticState {
  readonly adoptions: Map<string, PendingCallAdoptedEvent>;
  backend: BackendSelectedEvent | undefined;
  readonly checkpoints: Map<string, CheckpointEvent>;
  readonly checkpointCalls: Map<string, ToolCallRequestedEvent | null>;
  readonly commandOutputs: Map<string, CommandOutputAccumulator>;
  readonly completedCalls: Map<string, ToolCallCompletedEvent>;
  readonly innerEffects: Map<string, InnerEffect[]>;
  lastBoundaryTurn: number;
  latestCheckpointId: string | undefined;
  readonly pendingCalls: Map<string, ToolCallRequestedEvent>;
  readonly recoveredAdoptions: Set<string>;
  readonly recoveredEvents: Map<string, ToolCallRecoveredEvent>;
  readonly resolvedAdoptions: Set<string>;
  readonly started: RunStartedEvent;
}

function fail(
  event: DecodedRunEvent,
  code: Phase9RunEventSemanticErrorCode,
  message: string,
): never {
  throw new Phase9RunEventSemanticError(
    code,
    message,
    event.runId,
    event.sessionSeq,
  );
}

function requireBackend(
  state: RunSemanticState,
  event: DecodedRunEvent,
): BackendSelectedEvent {
  if (state.backend === undefined) {
    fail(event, "backend_capability_mismatch", "Phase 9 event has no selected backend");
  }
  return state.backend;
}

function assertExactBackendDeclaration(
  backend: BackendSelectedEvent,
  event: DecodedRunEvent,
): void {
  if (
    backend.data.resume_capability !== "exact_checkpoint" ||
    backend.data.checkpoint_codec_version === undefined
  ) {
    fail(
      event,
      "backend_capability_mismatch",
      "exact resume event requires an exact-checkpoint backend and codec",
    );
  }
}

function advanceTurn(state: RunSemanticState, event: CheckpointEvent | Extract<DecodedRunEvent, { readonly type: "backend.canonical_boundary.created" }>): void {
  const expected = state.lastBoundaryTurn + 1;
  if (event.data.turn !== expected) {
    fail(
      event,
      "turn_sequence_invalid",
      `backend boundary turn must be ${expected}, received ${event.data.turn}`,
    );
  }
  state.lastBoundaryTurn = event.data.turn;
}

function assertCheckpointIdentity(
  backend: BackendSelectedEvent,
  checkpoint: CheckpointEvent,
): void {
  if (
    checkpoint.data.adapter !== backend.data.adapter ||
    checkpoint.data.adapter_version !== backend.data.adapter_version ||
    checkpoint.data.codec_version !== backend.data.checkpoint_codec_version ||
    checkpoint.data.model !== backend.data.model ||
    checkpoint.data.provider !== backend.data.provider
  ) {
    fail(
      checkpoint,
      "checkpoint_identity_mismatch",
      "checkpoint identity does not match backend.selected",
    );
  }
}

function assertPendingBoundary(
  state: RunSemanticState,
  event: CheckpointEvent | Extract<DecodedRunEvent, { readonly type: "backend.canonical_boundary.created" }>,
  declaredPending: boolean | undefined,
): ToolCallRequestedEvent | undefined {
  const pending = [...state.pendingCalls.values()];
  if (pending.length > 1) {
    fail(
      event,
      "turn_sequence_invalid",
      "backend boundary cannot contain multiple unresolved tool calls",
    );
  }
  const call = pending[0];
  if (call !== undefined && call.data.step !== event.data.turn) {
    fail(
      event,
      "turn_sequence_invalid",
      "backend boundary turn does not match its unresolved tool call",
    );
  }
  if (declaredPending !== undefined && declaredPending !== (call !== undefined)) {
    fail(
      event,
      "turn_sequence_invalid",
      "canonical boundary pending_call does not match the durable call ledger",
    );
  }
  return call;
}

function assertCurrentBackendMatchesCheckpoint(
  backend: BackendSelectedEvent,
  checkpoint: CheckpointEvent,
  event: PendingCallAdoptedEvent,
): void {
  if (
    checkpoint.data.adapter !== backend.data.adapter ||
    checkpoint.data.adapter_version !== backend.data.adapter_version ||
    checkpoint.data.codec_version !== backend.data.checkpoint_codec_version ||
    checkpoint.data.model !== backend.data.model ||
    checkpoint.data.provider !== backend.data.provider
  ) {
    fail(
      event,
      "adoption_invalid",
      "adopted checkpoint is incompatible with the current backend",
    );
  }
}

function appendInnerEffect(
  state: RunSemanticState,
  callId: string,
  effect: InnerEffect,
): void {
  const effects = state.innerEffects.get(callId) ?? [];
  effects.push(effect);
  state.innerEffects.set(callId, effects);
}

function assertAdoption(
  runs: ReadonlyMap<string, RunSemanticState>,
  state: RunSemanticState,
  event: PendingCallAdoptedEvent,
): void {
  const backend = requireBackend(state, event);
  assertExactBackendDeclaration(backend, event);
  if (
    state.started.data.resume_mode !== "exact" ||
    state.started.data.resume_of_run_id !== event.data.source_run_id ||
    event.data.call_id !== event.data.source_call_id
  ) {
    fail(
      event,
      "adoption_invalid",
      "pending call adoption does not match the exact resume source",
    );
  }
  const source = runs.get(event.data.source_run_id);
  if (source === undefined || source === state) {
    fail(event, "adoption_invalid", "pending call adoption source run is invalid");
  }
  const checkpoint = source.checkpoints.get(event.data.checkpoint_id);
  const sourceCall = source.checkpointCalls.get(event.data.checkpoint_id);
  if (
    sourceCall === undefined ||
    sourceCall === null ||
    sourceCall.data.step !== event.data.step ||
    sourceCall.data.call_id !== event.data.source_call_id ||
    sourceCall.data.tool_name !== event.data.tool_name
  ) {
    fail(
      event,
      "adoption_invalid",
      "pending call adoption does not match the call pending at its checkpoint",
    );
  }
  if (
    checkpoint === undefined ||
    source.latestCheckpointId !== checkpoint.data.checkpoint_id ||
    checkpoint.data.turn !== sourceCall.data.step ||
    checkpoint.sessionSeq <= sourceCall.sessionSeq
  ) {
    fail(
      event,
      "adoption_invalid",
      "pending call adoption does not reference the source call checkpoint",
    );
  }
  assertCurrentBackendMatchesCheckpoint(backend, checkpoint, event);
  if (state.adoptions.has(event.data.call_id)) {
    fail(event, "adoption_invalid", "pending call was adopted more than once");
  }
  state.adoptions.set(event.data.call_id, event);
}

function sameRecoveredObservation(
  recovered: ToolCallRecoveredEvent["data"],
  completed: ToolCallCompletedEvent["data"],
): boolean {
  return (
    recovered.call_id === completed.call_id &&
    recovered.error_category === completed.error_category &&
    recovered.error_code === completed.error_code &&
    recovered.output === completed.output &&
    recovered.retryable === completed.retryable &&
    recovered.status === completed.status &&
    recovered.step === completed.step &&
    recovered.tool_name === completed.tool_name &&
    recovered.truncated === completed.truncated
  );
}

function recoveredMatchesObservation(
  recovered: ToolCallRecoveredEvent["data"],
  observation: RecoveredToolObservation,
): boolean {
  return (
    recovered.error_category === observation.errorCategory &&
    recovered.error_code === observation.errorCode &&
    recovered.output === observation.output &&
    recovered.retryable === observation.retryable &&
    recovered.status === observation.status &&
    recovered.truncated === observation.truncated
  );
}

function assertRecoveredEffect(
  runs: ReadonlyMap<string, RunSemanticState>,
  state: RunSemanticState,
  event: ToolCallRecoveredEvent,
): void {
  const adoption = state.adoptions.get(event.data.call_id);
  if (
    adoption === undefined ||
    state.resolvedAdoptions.has(event.data.call_id) ||
    adoption.data.source_run_id !== event.data.source_run_id ||
    adoption.data.step !== event.data.step ||
    adoption.data.tool_name !== event.data.tool_name
  ) {
    fail(
      event,
      "recovered_effect_mismatch",
      "recovered tool result has no matching adopted pending call",
    );
  }
  const source = runs.get(event.data.source_run_id);
  const sourceCompletion = source?.completedCalls.get(
    adoption.data.source_call_id,
  );
  if (sourceCompletion !== undefined) {
    const checkpoint = source?.checkpoints.get(adoption.data.checkpoint_id);
    if (
      checkpoint === undefined ||
      sourceCompletion.sessionSeq <= checkpoint.sessionSeq ||
      !sameRecoveredObservation(event.data, sourceCompletion.data)
    ) {
      fail(
        event,
        "recovered_effect_mismatch",
        "recovered tool result differs from the durable source observation",
      );
    }
    state.recoveredAdoptions.add(event.data.call_id);
    state.recoveredEvents.set(event.data.call_id, event);
    return;
  }
  const effects = source?.innerEffects.get(adoption.data.source_call_id) ?? [];
  if (effects.length !== 1) {
    fail(
      event,
      "recovered_effect_mismatch",
      "recovered tool result does not match exactly one completed source effect",
    );
  }
  const effect = effects[0];
  const expectedTool = effect?.kind === "patch" ? "apply_patch" : "run_command";
  if (
    effect === undefined ||
    event.data.tool_name !== expectedTool ||
    !recoveredMatchesObservation(event.data, effect.observation)
  ) {
    fail(
      event,
      "recovered_effect_mismatch",
      "recovered tool result tool does not match the completed source effect",
    );
  }
  state.recoveredAdoptions.add(event.data.call_id);
  state.recoveredEvents.set(event.data.call_id, event);
}

/**
 * Validates Phase 9 events as one session-wide state machine.
 *
 * The same function is used before durable append and during replay so a
 * schema-valid checkpoint/adoption cannot bypass online or offline semantics.
 */
export function assertPhase9RunEventSemantics(
  events: readonly DecodedStoredEvent[],
): void {
  const runs = new Map<string, RunSemanticState>();
  const checkpointIds = new Set<string>();

  for (const event of events) {
    if (event.scope === "session") continue;
    if (event.type === "run.started") {
      runs.set(event.runId, {
        adoptions: new Map(),
        backend: undefined,
        checkpoints: new Map(),
        checkpointCalls: new Map(),
        commandOutputs: new Map(),
        completedCalls: new Map(),
        innerEffects: new Map(),
        lastBoundaryTurn: 0,
        latestCheckpointId: undefined,
        pendingCalls: new Map(),
        recoveredAdoptions: new Set(),
        recoveredEvents: new Map(),
        resolvedAdoptions: new Set(),
        started: event,
      });
      continue;
    }
    const state = runs.get(event.runId);
    if (state === undefined) {
      fail(event, "backend_capability_mismatch", "run has no run.started event");
    }

    switch (event.type) {
      case "backend.selected": {
        state.backend = event;
        if (
          event.data.resume_capability === "exact_checkpoint" &&
          event.data.checkpoint_codec_version === undefined
        ) {
          fail(
            event,
            "backend_capability_mismatch",
            "exact-checkpoint backend must declare a checkpoint codec",
          );
        }
        if (
          event.data.resume_capability !== "exact_checkpoint" &&
          event.data.checkpoint_codec_version !== undefined
        ) {
          fail(
            event,
            "backend_capability_mismatch",
            "non-exact backend must not declare a checkpoint codec",
          );
        }
        break;
      }
      case "tool.call.requested":
        state.pendingCalls.set(event.data.call_id, event);
        break;
      case "tool.call.completed": {
        const adoption = state.adoptions.get(event.data.call_id);
        if (adoption !== undefined) {
          const source = runs.get(adoption.data.source_run_id);
          const sourceEffects =
            source?.innerEffects.get(adoption.data.source_call_id) ?? [];
          const sourceCompletion = source?.completedCalls.get(
            adoption.data.source_call_id,
          );
          if (
            state.resolvedAdoptions.has(event.data.call_id) ||
            adoption.data.step !== event.data.step ||
            adoption.data.tool_name !== event.data.tool_name
          ) {
            fail(
              event,
              "adoption_invalid",
              "completed adopted call does not match its adoption event",
            );
          }
          if (
            (sourceEffects.length > 0 || sourceCompletion !== undefined) &&
            !state.recoveredAdoptions.has(event.data.call_id)
          ) {
            fail(
              event,
              "recovered_effect_mismatch",
              "a completed source side effect must be recovered, never re-executed",
            );
          }
          if (
            state.recoveredAdoptions.has(event.data.call_id) &&
            event.data.status === "success" &&
            event.data.error_code !== undefined
          ) {
            fail(
              event,
              "recovered_effect_mismatch",
              "recovered success contains error metadata",
            );
          }
          const recovered = state.recoveredEvents.get(event.data.call_id);
          if (
            recovered !== undefined &&
            !sameRecoveredObservation(recovered.data, event.data)
          ) {
            fail(
              event,
              "recovered_effect_mismatch",
              "outer tool completion differs from its recovered observation",
            );
          }
          state.resolvedAdoptions.add(event.data.call_id);
        }
        state.completedCalls.set(event.data.call_id, event);
        state.pendingCalls.delete(event.data.call_id);
        break;
      }
      case "patch.apply.completed":
        appendInnerEffect(state, event.data.call_id, {
          kind: "patch",
          observation: recoverPatchToolObservation(event.data),
          sessionSeq: event.sessionSeq,
        });
        break;
      case "command.execution.requested":
        state.commandOutputs.set(event.data.execution_id, {
          stderr: [],
          stdout: [],
        });
        break;
      case "command.output": {
        const output = state.commandOutputs.get(event.data.execution_id);
        if (output === undefined) {
          fail(
            event,
            "recovered_effect_mismatch",
            "command output has no durable execution request",
          );
        }
        output[event.data.channel].push(event.data.chunk);
        break;
      }
      case "command.completed":
        if (
          event.data.cleanup_verified &&
          event.data.termination !== "cleanup_failed"
        ) {
          const output = state.commandOutputs.get(event.data.execution_id);
          if (output === undefined) {
            fail(
              event,
              "recovered_effect_mismatch",
              "command completion does not match reconstructable output",
            );
          }
          let observation: RecoveredToolObservation;
          try {
            observation = recoverCommandToolObservation(event.data, output);
          } catch {
            fail(
              event,
              "recovered_effect_mismatch",
              "completed command output cannot be reconstructed exactly",
            );
          }
          appendInnerEffect(state, event.data.call_id, {
            kind: "command",
            observation,
            sessionSeq: event.sessionSeq,
          });
        }
        break;
      case "backend.canonical_boundary.created": {
        const backend = requireBackend(state, event);
        if (backend.data.resume_capability !== "canonical_only") {
          fail(
            event,
            "backend_capability_mismatch",
            "canonical boundary requires a canonical-only backend",
          );
        }
        advanceTurn(state, event);
        assertPendingBoundary(state, event, event.data.pending_call);
        break;
      }
      case "backend.checkpoint.created": {
        const backend = requireBackend(state, event);
        assertExactBackendDeclaration(backend, event);
        assertCheckpointIdentity(backend, event);
        advanceTurn(state, event);
        const checkpointCall = assertPendingBoundary(state, event, undefined);
        if (checkpointIds.has(event.data.checkpoint_id)) {
          fail(
            event,
            "checkpoint_identity_mismatch",
            "checkpoint id is duplicated in the session",
          );
        }
        checkpointIds.add(event.data.checkpoint_id);
        state.checkpoints.set(event.data.checkpoint_id, event);
        state.checkpointCalls.set(
          event.data.checkpoint_id,
          checkpointCall ?? null,
        );
        state.latestCheckpointId = event.data.checkpoint_id;
        break;
      }
      case "resume.pending_call.adopted":
        assertAdoption(runs, state, event);
        break;
      case "tool.call.recovered":
        assertRecoveredEffect(runs, state, event);
        break;
      default:
        break;
    }
  }
}
