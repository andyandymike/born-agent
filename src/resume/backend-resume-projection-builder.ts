import type { CheckpointStore } from "../checkpoints/checkpoint-store.js";
import type { StoredCheckpointRef } from "../checkpoints/checkpoint-types.js";
import type { DecodedRunEvent } from "../events/event-decoder-registry.js";
import {
  BackendContinuation,
  type BackendIdentity,
  type ModelBackend,
} from "../model/model-backend.js";
import type {
  BackendResumeProjection,
  CheckpointPendingCall,
  PendingToolCall,
  PendingToolKind,
  RecoveredToolObservation,
  VerifiedCheckpointProjection,
} from "./resume-types.js";

type BackendSelectedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "backend.selected" }
>;
type CanonicalBoundaryEvent = Extract<
  DecodedRunEvent,
  { readonly type: "backend.canonical_boundary.created" }
>;
type CheckpointCreatedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "backend.checkpoint.created" }
>;
type ToolCallRequestedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "tool.call.requested" }
>;
type ToolCallCompletedEvent = Extract<
  DecodedRunEvent,
  { readonly type: "tool.call.completed" }
>;

const locallyVerifiedCheckpoints = new WeakSet<object>();

export type BackendResumeProjectionBuildErrorCode =
  | "backend_capabilities_mismatch"
  | "backend_identity_mismatch"
  | "backend_selection_ambiguous"
  | "backend_selection_missing"
  | "canonical_boundary_sequence_invalid"
  | "checkpoint_codec_mismatch"
  | "checkpoint_decode_invalid"
  | "checkpoint_event_unexpected"
  | "checkpoint_identity_mismatch"
  | "checkpoint_sequence_invalid"
  | "checkpoint_verification_failed"
  | "resume_capability_mismatch"
  | "resume_capability_missing"
  | "resume_event_unexpected"
  | "run_event_set_invalid";

export class BackendResumeProjectionBuildError extends Error {
  public constructor(
    public readonly code: BackendResumeProjectionBuildErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BackendResumeProjectionBuildError";
  }
}

export interface BackendResumeProjectionBuildInput {
  readonly backend: ModelBackend;
  readonly events: readonly DecodedRunEvent[];
}

export interface BackendResumeProjectionBuildResult {
  readonly continuation: BackendContinuation | null;
  readonly projection: BackendResumeProjection;
}

/**
 * Returns true only for the exact object produced after CheckpointStore
 * validation in this process. Spreading, serializing, or hand-authoring the
 * metadata intentionally destroys this proof and makes the planner fail closed.
 */
export function isLocallyVerifiedCheckpointProjection(
  checkpoint: VerifiedCheckpointProjection,
): boolean {
  return locallyVerifiedCheckpoints.has(checkpoint);
}

function buildError(
  code: BackendResumeProjectionBuildErrorCode,
  message: string,
  cause?: unknown,
): BackendResumeProjectionBuildError {
  return new BackendResumeProjectionBuildError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}

function sameIdentity(
  selected: BackendSelectedEvent,
  identity: BackendIdentity,
): boolean {
  return (
    selected.data.adapter === identity.adapter &&
    selected.data.adapter_version === identity.adapterVersion &&
    selected.data.config_fingerprint === identity.configFingerprint &&
    selected.data.model === identity.model &&
    selected.data.provider === identity.provider
  );
}

function sameCapabilities(
  selected: BackendSelectedEvent,
  backend: ModelBackend,
): boolean {
  const persisted = selected.data.capabilities;
  const current = backend.capabilities;
  return (
    persisted.cancellation === current.cancellation &&
    persisted.reasoning === current.reasoning &&
    persisted.streaming === current.streaming &&
    persisted.tools === current.tools &&
    persisted.usage === current.usage
  );
}

function assertOneRun(events: readonly DecodedRunEvent[]): void {
  const first = events[0];
  if (first === undefined || first.type !== "run.started") {
    throw buildError(
      "run_event_set_invalid",
      "resume projection requires one decoded run beginning with run.started",
    );
  }
  let expectedRunSeq = 1;
  for (const event of events) {
    if (
      event.sessionId !== first.sessionId ||
      event.runId !== first.runId ||
      event.runSeq !== expectedRunSeq
    ) {
      throw buildError(
        "run_event_set_invalid",
        "resume projection events must be one contiguous decoded run",
      );
    }
    expectedRunSeq += 1;
  }
}

function assertIncreasingTurns(
  events: readonly (CanonicalBoundaryEvent | CheckpointCreatedEvent)[],
  code:
    | "canonical_boundary_sequence_invalid"
    | "checkpoint_sequence_invalid",
): void {
  let previousTurn = 0;
  for (const event of events) {
    if (event.data.turn <= previousTurn) {
      throw buildError(code, "resume boundary turns must increase strictly");
    }
    previousTurn = event.data.turn;
  }
}

function checkpointMatches(
  event: CheckpointCreatedEvent,
  selected: BackendSelectedEvent,
  backend: ModelBackend & {
    readonly resume: Extract<ModelBackend["resume"], { capability: "exact_checkpoint" }>;
  },
): boolean {
  return (
    event.data.adapter === selected.data.adapter &&
    event.data.adapter_version === selected.data.adapter_version &&
    event.data.codec_version === backend.resume.checkpointCodec.codecVersion &&
    event.data.model === selected.data.model &&
    event.data.provider === selected.data.provider
  );
}

function checkpointReference(
  event: CheckpointCreatedEvent,
  selected: BackendSelectedEvent,
  backend: ModelBackend,
): StoredCheckpointRef {
  return Object.freeze({
    adapter: event.data.adapter,
    adapterVersion: event.data.adapter_version,
    bytes: event.data.bytes,
    checkpointId: event.data.checkpoint_id,
    codecVersion: event.data.codec_version,
    configFingerprint: selected.data.config_fingerprint,
    model: event.data.model,
    provider: backend.identity.provider,
    relativeRef: event.data.ref,
    runId: event.runId,
    sessionId: event.sessionId,
    sha256: event.data.sha256,
    turnNumber: event.data.turn,
  });
}

function projectionFromReference(
  reference: StoredCheckpointRef,
): VerifiedCheckpointProjection {
  const projection = Object.freeze({
    adapter: reference.adapter,
    adapterVersion: reference.adapterVersion,
    artifactBytes: reference.bytes,
    artifactSha256: reference.sha256,
    checkpointId: reference.checkpointId,
    codecVersion: reference.codecVersion,
    model: reference.model,
    provider: reference.provider,
    relativeRef: reference.relativeRef,
    turnNumber: reference.turnNumber,
  });
  locallyVerifiedCheckpoints.add(projection);
  return projection;
}

function pendingToolKind(toolName: string): PendingToolKind {
  if (toolName === "apply_patch") return "apply_patch";
  if (toolName === "run_command") return "run_command";
  if (toolName === "finish_task") return "finish_task";
  if (["list_files", "read_file", "search"].includes(toolName)) {
    return "read_only";
  }
  return "unknown";
}

function pendingCallFromEvent(event: ToolCallRequestedEvent): PendingToolCall {
  return Object.freeze({
    argumentsJson: event.data.arguments_json,
    callId: event.data.call_id,
    kind: pendingToolKind(event.data.tool_name),
    providerResponseId: event.data.provider_response_id ?? null,
    sourceRunId: event.runId,
    step: event.data.step,
    toolName: event.data.tool_name,
  });
}

function recoveredObservationFromEvent(
  event: ToolCallCompletedEvent,
): RecoveredToolObservation {
  return Object.freeze({
    ...(event.data.error_category === undefined
      ? {}
      : { errorCategory: event.data.error_category }),
    ...(event.data.error_code === undefined
      ? {}
      : { errorCode: event.data.error_code }),
    output: event.data.output,
    ...(event.data.retryable === undefined
      ? {}
      : { retryable: event.data.retryable }),
    status: event.data.status,
    truncated: event.data.truncated,
  });
}

function canonicalBoundaryIsClosed(
  events: readonly DecodedRunEvent[],
): boolean {
  const pendingCalls = new Set<string>();
  let awaitingToolRequest: { readonly callId: string; readonly step: number } | null = null;
  let modelTurnOpen = false;
  for (const event of events) {
    if (event.type === "agent.step.started") modelTurnOpen = true;
    if (event.type === "agent.step.completed") {
      modelTurnOpen = false;
      awaitingToolRequest =
        event.data.outcome === "tool_call" &&
        event.data.tool_call_id !== undefined
          ? {
              callId: event.data.tool_call_id,
              step: event.data.step,
            }
          : null;
    }
    if (event.type === "tool.call.requested") {
      if (
        awaitingToolRequest?.callId === event.data.call_id &&
        awaitingToolRequest.step === event.data.step
      ) {
        awaitingToolRequest = null;
      }
      pendingCalls.add(event.data.call_id);
    }
    if (event.type === "resume.pending_call.adopted") {
      // PHASE9: an adoption is the request-side pairing fact in a resumed run.
      // A second crash before its outer completion remains an unresolved call,
      // even though no ordinary tool.call.requested event exists in that run.
      pendingCalls.add(event.data.call_id);
    }
    if (event.type === "tool.call.completed") {
      pendingCalls.delete(event.data.call_id);
    }
    if (event.type === "run.cancelled") {
      // PHASE16: A durable user cancellation rejects the unfinished model proposal and
      // therefore closes its canonical assistant turn. Already-requested tool
      // calls remain pending until their own durable observations resolve; a
      // tool proposal that never reached tool.call.requested has no effect to
      // inherit.
      modelTurnOpen = false;
      awaitingToolRequest = null;
    }
  }
  return (
    !modelTurnOpen &&
    awaitingToolRequest === null &&
    pendingCalls.size === 0
  );
}

function checkpointCallState(
  events: readonly DecodedRunEvent[],
  checkpoint: CheckpointCreatedEvent,
): {
  readonly pendingCall: CheckpointPendingCall | null;
  readonly usable: boolean;
} {
  const checkpointIndex = events.indexOf(checkpoint);
  if (checkpointIndex < 0) {
    return { pendingCall: null, usable: false };
  }
  const unresolved = new Map<string, ToolCallRequestedEvent>();
  for (const event of events.slice(0, checkpointIndex + 1)) {
    if (event.type === "tool.call.requested") {
      unresolved.set(event.data.call_id, event);
    } else if (event.type === "tool.call.completed") {
      unresolved.delete(event.data.call_id);
    }
  }
  if (unresolved.size > 1) {
    return { pendingCall: null, usable: false };
  }

  const afterCheckpoint = events.slice(checkpointIndex + 1);
  const providerAdvanced = afterCheckpoint.some((event) =>
    [
      "agent.step.started",
      "agent.step.completed",
      "model.usage",
      "text.delta",
      "tool.call.requested",
    ].includes(event.type),
  );
  const requested = unresolved.values().next().value as
    | ToolCallRequestedEvent
    | undefined;
  if (requested === undefined) {
    const unexpectedCompletion = afterCheckpoint.some(
      (event) => event.type === "tool.call.completed",
    );
    return {
      pendingCall: null,
      usable: !providerAdvanced && !unexpectedCompletion,
    };
  }

  const completions = afterCheckpoint.filter(
    (event): event is ToolCallCompletedEvent =>
      event.type === "tool.call.completed" &&
      event.data.call_id === requested.data.call_id,
  );
  if (completions.length > 1) {
    return { pendingCall: null, usable: false };
  }
  const completed = completions[0];
  // PHASE9: the checkpoint is the provider state before the tool result. A
  // later durable outer observation therefore remains usable only by adopting
  // the original call and submitting those exact bytes; it is never a prompt.
  return {
    pendingCall: Object.freeze({
      call: pendingCallFromEvent(requested),
      recoveredObservation:
        completed === undefined
          ? null
          : recoveredObservationFromEvent(completed),
    }),
    usable: !providerAdvanced,
  };
}

function baseProjection(
  backend: ModelBackend,
  canonicalBoundaryClosed: boolean,
  checkpoint: VerifiedCheckpointProjection | null,
  checkpointPendingCall: CheckpointPendingCall | null = null,
  exactCheckpointUsable = false,
): BackendResumeProjection {
  return Object.freeze({
    canonicalBoundaryClosed,
    capability: backend.resume.capability,
    checkpoint,
    checkpointPendingCall,
    exactCheckpointUsable,
    identity: Object.freeze({ ...backend.identity }),
    supportsCanonicalDegradedResume:
      backend.resume.supportsCanonicalDegradedResume,
  });
}

export class BackendResumeProjectionBuilder {
  public constructor(private readonly checkpointStore: CheckpointStore) {}

  public async build(
    input: BackendResumeProjectionBuildInput,
  ): Promise<BackendResumeProjectionBuildResult> {
    assertOneRun(input.events);
    const selectedEvents = input.events.filter(
      (event): event is BackendSelectedEvent => event.type === "backend.selected",
    );
    if (selectedEvents.length === 0) {
      throw buildError(
        "backend_selection_missing",
        "persisted run does not contain backend.selected",
      );
    }
    if (selectedEvents.length !== 1) {
      throw buildError(
        "backend_selection_ambiguous",
        "persisted run contains more than one backend.selected event",
      );
    }
    const selected = selectedEvents[0];
    if (selected === undefined) {
      throw buildError("backend_selection_missing", "backend selection is missing");
    }
    if (!sameIdentity(selected, input.backend.identity)) {
      throw buildError(
        "backend_identity_mismatch",
        "persisted backend identity does not match the selected local backend",
      );
    }
    if (!sameCapabilities(selected, input.backend)) {
      throw buildError(
        "backend_capabilities_mismatch",
        "persisted backend capabilities do not match the selected local backend",
      );
    }
    const persistedCapability = selected.data.resume_capability;
    if (persistedCapability === undefined) {
      throw buildError(
        "resume_capability_missing",
        "legacy backend selection has no persisted resume capability",
      );
    }
    if (persistedCapability !== input.backend.resume.capability) {
      throw buildError(
        "resume_capability_mismatch",
        "persisted resume capability does not match the selected local backend",
      );
    }

    const checkpointEvents = input.events.filter(
      (event): event is CheckpointCreatedEvent =>
        event.type === "backend.checkpoint.created",
    );
    const canonicalEvents = input.events.filter(
      (event): event is CanonicalBoundaryEvent =>
        event.type === "backend.canonical_boundary.created",
    );
    assertIncreasingTurns(checkpointEvents, "checkpoint_sequence_invalid");
    assertIncreasingTurns(canonicalEvents, "canonical_boundary_sequence_invalid");

    if (input.backend.resume.capability === "none") {
      if (checkpointEvents.length > 0 || canonicalEvents.length > 0) {
        throw buildError(
          "resume_event_unexpected",
          "backend capability none cannot own persisted resume events",
        );
      }
      if (selected.data.checkpoint_codec_version !== undefined) {
        throw buildError(
          "checkpoint_codec_mismatch",
          "backend capability none cannot declare a checkpoint codec",
        );
      }
      return Object.freeze({
        continuation: null,
        projection: baseProjection(input.backend, false, null),
      });
    }

    if (input.backend.resume.capability === "canonical_only") {
      if (checkpointEvents.length > 0) {
        throw buildError(
          "checkpoint_event_unexpected",
          "canonical-only backend cannot own an exact checkpoint event",
        );
      }
      if (selected.data.checkpoint_codec_version !== undefined) {
        throw buildError(
          "checkpoint_codec_mismatch",
          "canonical-only backend cannot declare a checkpoint codec",
        );
      }
      const latestBoundary = canonicalEvents.at(-1);
      const cancelledAtTerminal = input.events.at(-1)?.type === "run.cancelled";
      return Object.freeze({
        continuation: null,
        projection: baseProjection(
          input.backend,
          (latestBoundary !== undefined || cancelledAtTerminal) &&
            canonicalBoundaryIsClosed(input.events),
          null,
        ),
      });
    }

    const backend = input.backend as ModelBackend & {
      readonly resume: Extract<
        ModelBackend["resume"],
        { capability: "exact_checkpoint" }
      >;
    };
    const codec = backend.resume.checkpointCodec;
    if (
      selected.data.checkpoint_codec_version !== codec.codecVersion ||
      codec.provider !== backend.identity.provider
    ) {
      throw buildError(
        "checkpoint_codec_mismatch",
        "persisted checkpoint codec does not match the selected local backend",
      );
    }
    for (const event of checkpointEvents) {
      if (!checkpointMatches(event, selected, backend)) {
        throw buildError(
          "checkpoint_identity_mismatch",
          "persisted checkpoint identity does not match backend.selected",
        );
      }
    }
    const latestCheckpoint = checkpointEvents.at(-1);
    if (latestCheckpoint === undefined) {
      return Object.freeze({
        continuation: null,
        projection: baseProjection(
          backend,
          canonicalBoundaryIsClosed(input.events),
          null,
        ),
      });
    }

    const reference = checkpointReference(latestCheckpoint, selected, backend);
    let continuation: BackendContinuation;
    try {
      continuation = await this.checkpointStore.readExact({
        codec,
        identity: backend.identity,
        reference,
      });
    } catch (error) {
      throw buildError(
        "checkpoint_verification_failed",
        "checkpoint store verification or codec decode failed",
        error,
      );
    }
    if (!(continuation instanceof BackendContinuation)) {
      throw buildError(
        "checkpoint_decode_invalid",
        "checkpoint codec did not return an opaque backend continuation",
      );
    }
    const checkpoint = projectionFromReference(reference);
    const checkpointState = checkpointCallState(
      input.events,
      latestCheckpoint,
    );
    return Object.freeze({
      continuation,
      projection: baseProjection(
        backend,
        canonicalBoundaryIsClosed(input.events),
        checkpoint,
        checkpointState.pendingCall,
        checkpointState.usable,
      ),
    });
  }
}
