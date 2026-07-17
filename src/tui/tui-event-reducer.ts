import { createHash } from "node:crypto";

import type {
  Phase10ArtifactEvent,
} from "../artifacts/artifact-types.js";
import type {
  Phase10ContextRunEventData,
  Phase10ContextRunEventType,
} from "../context/context-event-schema.js";
import type {
  DecodedStoredEvent,
} from "../events/event-decoder-registry.js";
import { sanitizeTerminalText } from "./terminal-sanitizer.js";
import type {
  ApprovalExpiryReason,
  ApprovalView,
  ModelTranscriptViewItem,
  TranscriptViewItem,
  TuiViewState,
} from "./tui-view-state.js";

interface DecodedExtensionRunEvent<TType extends string, TData> {
  readonly data: TData;
  readonly eventId: string;
  readonly runId: string;
  readonly runSeq: number;
  readonly scope: "run";
  readonly sessionId: string;
  readonly sessionSeq: number;
  readonly sourceSchemaVersion: 2;
  readonly timestamp: string;
  readonly type: TType;
}

type DecodedContextRunEvent = {
  [TType in Phase10ContextRunEventType]: DecodedExtensionRunEvent<
    TType,
    Phase10ContextRunEventData<TType>
  >;
}[Phase10ContextRunEventType];

type DecodedArtifactRunEvent =
  Phase10ArtifactEvent extends infer TEvent
    ? TEvent extends { readonly data: infer TData; readonly type: infer TType }
      ? TType extends string
        ? DecodedExtensionRunEvent<TType, TData>
        : never
      : never
    : never;

type KnownTuiPersistedEvent =
  | DecodedArtifactRunEvent
  | DecodedContextRunEvent
  | DecodedStoredEvent;

export interface UnsupportedDurableEvent {
  readonly data: unknown;
  readonly eventId: string;
  readonly runId?: string;
  readonly runSeq?: number;
  readonly scope: "run" | "session";
  readonly sessionId: string;
  readonly sessionSeq: number;
  readonly sourceSchemaVersion: number;
  readonly timestamp: string;
  readonly type: string;
}

export type TuiPersistedEvent =
  | KnownTuiPersistedEvent
  | UnsupportedDurableEvent;

const KNOWN_EVENT_TYPES = new Set<string>([
  "agent.step.completed",
  "agent.step.started",
  "approval.decided",
  "approval.expired",
  "approval.requested",
  "artifact.capture.truncated",
  "artifact.stored",
  "backend.canonical_boundary.created",
  "backend.checkpoint.created",
  "backend.selected",
  "command.completed",
  "command.execution.requested",
  "command.output",
  "command.started",
  "completion.candidate",
  "completion.evaluated",
  "completion.evidence",
  "context.compaction.failed",
  "context.compaction.started",
  "context.estimate.created",
  "context.plan.created",
  "model.request.encoded",
  "model.usage",
  "patch.apply.completed",
  "patch.apply.started",
  "patch.plan.created",
  "permission.evaluated",
  "repository.rules.changed",
  "repository.rules.loaded",
  "resume.pending_call.adopted",
  "run.budget_exceeded",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.incomplete",
  "run.started",
  "session.lock.recovered",
  "session.resume.requested",
  "session.tail.recovered",
  "side_effect.reconciled",
  "text.delta",
  "tool.call.completed",
  "tool.call.recovered",
  "tool.call.requested",
  "usage",
  "verification.completed",
  "verification.started",
]);

const MAX_TRANSCRIPT_ITEMS = 2_000;
const MAX_RENDERED_TEXT_CHARS = 128 * 1024;

function assertNever(value: never): never {
  throw new Error(`unhandled durable event ${String(value)}`);
}

function isKnownEvent(event: TuiPersistedEvent): event is KnownTuiPersistedEvent {
  return KNOWN_EVENT_TYPES.has(event.type);
}

function appendItem(
  state: TuiViewState,
  item: TranscriptViewItem,
): TuiViewState {
  const next = [...state.transcript, item];
  return {
    ...state,
    transcript:
      next.length <= MAX_TRANSCRIPT_ITEMS
        ? next
        : next.slice(next.length - MAX_TRANSCRIPT_ITEMS),
  };
}

function appendModelDelta(
  state: TuiViewState,
  item: ModelTranscriptViewItem,
): TuiViewState {
  const previous = state.transcript.at(-1);
  if (
    previous?.kind !== "model" ||
    previous.runId !== item.runId ||
    previous.step !== item.step ||
    previous.status !== "streaming" ||
    previous.visibility !== item.visibility
  ) {
    return appendItem(state, item);
  }
  const combined = previous.text + item.text;
  const text = combined.slice(0, MAX_RENDERED_TEXT_CHARS);
  return {
    ...state,
    transcript: [
      ...state.transcript.slice(0, -1),
      {
        ...previous,
        text,
        truncated: previous.truncated || text.length < combined.length,
      },
    ],
  };
}

function replaceItems(
  state: TuiViewState,
  replace: (item: TranscriptViewItem) => TranscriptViewItem,
): TuiViewState {
  return { ...state, transcript: state.transcript.map(replace) };
}

function expireApproval(
  approval: ApprovalView | null,
  reason: ApprovalExpiryReason,
): ApprovalView | null {
  if (approval === null || approval.expiresState.status === "expired") {
    return approval;
  }
  return { ...approval, expiresState: { reason, status: "expired" } };
}

function failClosed(
  state: TuiViewState,
  event: TuiPersistedEvent,
  reason: string,
): TuiViewState {
  const runId = event.scope === "run" ? (event.runId ?? null) : null;
  return {
    ...state,
    approval: expireApproval(state.approval, "workspace_or_action_changed"),
    session: {
      ...state.session,
      actionBlocked: true,
      fatalReason: reason,
      resumeBlocked: true,
    },
    transcript: [
      ...state.transcript,
      {
        id: `fatal:${event.eventId}`,
        kind: "session",
        label: reason,
        runId,
      },
    ],
  };
}

function sanitize(value: string): string {
  return sanitizeTerminalText(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function updateModelStatus(
  state: TuiViewState,
  runId: string,
  step: number | null,
  status: ModelTranscriptViewItem["status"],
): TuiViewState {
  return replaceItems(state, (item) =>
    item.kind === "model" &&
    item.runId === runId &&
    (step === null || item.step === step)
      ? { ...item, status }
      : item,
  );
}

function patchActionSha256(
  data: Extract<
    DecodedStoredEvent,
    { type: "approval.requested" | "approval.decided" }
  >["data"],
): string {
  return data.action === "apply_patch"
    ? (data.action_sha256 ?? data.plan_id)
    : data.action_sha256;
}

function failedExitCode(
  category: Extract<DecodedStoredEvent, { type: "run.failed" }>["data"]["category"],
): 1 | 4 | 5 | 6 {
  if (category === "auth" || category === "authentication") return 4;
  if (category === "timeout") return 6;
  if (
    category === "internal" ||
    category === "permission" ||
    category === "storage"
  ) {
    return 1;
  }
  return 5;
}

function reduceKnownEvent(
  state: TuiViewState,
  event: KnownTuiPersistedEvent,
): TuiViewState {
  // PHASE11: this reducer consumes only append-confirmed durable events; reading
  // AgentLoop private state would make replay disagree with the live screen.
  switch (event.type) {
    case "run.started": {
      if (state.run?.status === "running") {
        return failClosed(state, event, "multiple active runs are not allowed");
      }
      const next: TuiViewState = {
        ...state,
        approval: null,
        run: {
          acceptedCompletionCallId: null,
          acceptedCompletionStep: null,
          command: event.data.command,
          completionProof: "none",
          currentStep: 1,
          id: event.runId,
          model: sanitize(event.data.model),
          provider: sanitize(event.data.provider),
          runExitCode: null,
          status: "running",
          taskProfile:
            event.data.command === "agent"
              ? (event.data.task_profile ?? "read-only")
              : "read-only",
          workspace: sanitize(event.data.workspace),
        },
      };
      return appendItem(next, {
        id: event.eventId,
        kind: "user",
        runId: event.runId,
        text: sanitize(event.data.input.text),
      });
    }
    case "backend.selected":
      // PHASE11: the TUI reports only the backend evidence core persisted; a
      // fake/mock trace must never be relabelled as a live provider result.
      return state.run?.id === event.runId
        ? {
            ...state,
            run: {
              ...state.run,
              model: sanitize(event.data.model),
              provider: sanitize(event.data.provider),
            },
          }
        : failClosed(state, event, "backend selected outside the active run");
    case "text.delta": {
      // PHASE11: streamed coding text is an Agent draft, never completion proof.
      const visibility =
        event.data.visibility === "internal_candidate"
          ? "internal_candidate"
          : "user_visible";
      if (state.run?.id !== event.runId || state.run.currentStep === null) {
        return failClosed(state, event, "model delta is outside the active step");
      }
      return appendModelDelta(state, {
        id: event.eventId,
        kind: "model",
        runId: event.runId,
        step: state.run.currentStep,
        status: "streaming",
        text: sanitize(event.data.delta),
        truncated: false,
        visibility,
      });
    }
    case "agent.step.completed":
      return event.data.outcome === "final"
        ? updateModelStatus(state, event.runId, event.data.step, "candidate")
        : state;
    case "agent.step.started":
      return state.run?.id === event.runId
        ? {
            ...state,
            run: { ...state.run, currentStep: event.data.step },
          }
        : failClosed(state, event, "agent step is outside the active run");
    case "backend.canonical_boundary.created":
    case "backend.checkpoint.created":
    case "completion.evidence":
    case "model.usage":
    case "usage":
      return state;
    case "tool.call.requested":
      return appendItem(state, {
        callId: event.data.call_id,
        id: event.eventId,
        kind: "tool",
        output: "",
        runId: event.runId,
        status: "requested",
        toolName: sanitize(event.data.tool_name),
        truncated: false,
      });
    case "resume.pending_call.adopted":
      return appendItem(state, {
        callId: event.data.call_id,
        id: event.eventId,
        kind: "tool",
        output: "",
        runId: event.runId,
        status: "requested",
        toolName: sanitize(event.data.tool_name),
        truncated: false,
      });
    case "tool.call.completed":
    case "tool.call.recovered":
      return replaceItems(state, (item) =>
        item.kind === "tool" &&
        item.runId === event.runId &&
        item.callId === event.data.call_id
          ? {
              ...item,
              output: sanitize(event.data.output),
              status: event.data.status,
              truncated: event.data.truncated,
            }
          : item,
      );
    case "patch.plan.created":
      return appendItem(state, {
        addedLines: event.data.added_lines,
        id: event.eventId,
        kind: "patch",
        planId: event.data.plan_id,
        preview: sanitize(event.data.preview),
        removedLines: event.data.removed_lines,
        runId: event.runId,
        status: "planned",
        truncated: event.data.truncated,
      });
    case "approval.requested": {
      if (state.run?.id !== event.runId || state.run.status !== "running") {
        return failClosed(state, event, "approval request is outside the active run");
      }
      const previous = expireApproval(state.approval, "new_request");
      let next =
        previous === state.approval
          ? state
          : replaceItems(state, (item) =>
              item.kind === "approval" &&
              item.requestId === previous?.requestId &&
              item.status === "requested"
                ? { ...item, status: "expired" }
                : item,
            );
      const preview = sanitize(event.data.preview);
      const actionKind =
        event.data.action === "apply_patch" ? "apply_patch" : "run_command";
      next = {
        ...next,
        approval: {
          actionKind,
          actionSha256: patchActionSha256(event.data),
          callId: event.data.call_id,
          decision: null,
          expiresState: { status: "active" },
          preview,
          previewSha256: sha256(preview),
          previewTruncated: event.data.truncated,
          requestId: event.data.approval_request_id,
          runId: event.runId,
          sessionId: event.sessionId,
        },
      };
      next = appendItem(next, {
        actionKind,
        id: event.eventId,
        kind: "approval",
        requestId: event.data.approval_request_id,
        runId: event.runId,
        status: "requested",
      });
      if (event.data.action === "apply_patch") {
        const planId = event.data.plan_id;
        next = replaceItems(next, (item) =>
          item.kind === "patch" && item.planId === planId
            ? { ...item, status: "awaiting_approval" }
            : item,
        );
      }
      return next;
    }
    case "approval.decided": {
      const approval = state.approval;
      const actionSha256 = patchActionSha256(event.data);
      if (
        approval === null ||
        approval.expiresState.status !== "active" ||
        approval.requestId !== event.data.approval_request_id ||
        approval.actionSha256 !== actionSha256 ||
        approval.runId !== event.runId
      ) {
        return failClosed(state, event, "approval decision identity is stale");
      }
      return replaceItems(
        {
          ...state,
          approval: {
            ...approval,
            decision: event.data.decision,
            expiresState: { reason: "decided", status: "expired" },
          },
        },
        (item) =>
          item.kind === "approval" && item.requestId === approval.requestId
            ? { ...item, status: event.data.decision }
            : item,
      );
    }
    case "approval.expired": {
      if (state.approval?.requestId !== event.data.approval_request_id) {
        return state;
      }
      return replaceItems(
        {
          ...state,
          approval: expireApproval(state.approval, "workspace_or_action_changed"),
        },
        (item) =>
          item.kind === "approval" &&
          item.requestId === event.data.approval_request_id
            ? { ...item, status: "expired" }
            : item,
      );
    }
    case "patch.apply.started":
      return replaceItems(state, (item) =>
        item.kind === "patch" && item.planId === event.data.plan_id
          ? { ...item, status: "applying" }
          : item,
      );
    case "patch.apply.completed":
      return replaceItems(state, (item) =>
        item.kind === "patch" && item.planId === event.data.plan_id
          ? { ...item, status: "applied" }
          : item,
      );
    case "permission.evaluated":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `permission ${event.data.effect}: ${sanitize(event.data.rule_id)}`,
        runId: event.runId,
      });
    case "command.execution.requested":
      return appendItem(state, {
        artifactId: null,
        bytes: 0,
        executionId: event.data.execution_id,
        id: event.eventId,
        kind: "command",
        output: "",
        runId: event.runId,
        status: "requested",
        termination: null,
        truncated: false,
      });
    case "command.started":
      return replaceItems(state, (item) =>
        item.kind === "command" &&
        item.executionId === event.data.execution_id
          ? { ...item, status: "running" }
          : item,
      );
    case "command.output":
      return replaceItems(state, (item) =>
        item.kind === "command" &&
        item.executionId === event.data.execution_id
          ? (() => {
              const combined = item.output + sanitize(event.data.chunk);
              const output = combined.slice(0, MAX_RENDERED_TEXT_CHARS);
              return {
                ...item,
                bytes: item.bytes + event.data.bytes,
                output,
                truncated: item.truncated || output.length < combined.length,
              };
            })()
          : item,
      );
    case "command.completed":
      return replaceItems(state, (item) =>
        item.kind === "command" &&
        item.executionId === event.data.execution_id
          ? {
              ...item,
              bytes: event.data.total_bytes,
              status: "completed",
              termination: sanitize(event.data.termination),
              truncated: event.data.truncated,
            }
          : item,
      );
    case "verification.started":
      return appendItem(state, {
        generation: event.data.generation,
        id: event.eventId,
        kind: "verification",
        runId: event.runId,
        stale: false,
        status: "running",
        verificationId: event.data.verification_id,
      });
    case "verification.completed":
      return replaceItems(state, (item) =>
        item.kind === "verification" &&
        item.verificationId === event.data.verification_id
          ? {
              ...item,
              generation: event.data.completed_generation,
              stale: event.data.stale,
              status: event.data.status,
            }
          : item,
      );
    case "completion.candidate":
      return appendItem(
        state.run?.id === event.runId
          ? {
              ...state,
              run: { ...state.run, completionProof: "candidate" },
            }
          : state,
        {
          callId: event.data.call_id,
          id: event.eventId,
          kind: "completion",
          reasons: [],
          runId: event.runId,
          status: "candidate",
          summary: sanitize(event.data.summary),
        },
      );
    case "completion.evaluated": {
      const proof =
        event.data.effect === "accept"
          ? ("accepted" as const)
          : ("rejected" as const);
      let next =
        state.run?.id === event.runId
          ? {
              ...state,
              run: {
                ...state.run,
                acceptedCompletionCallId:
                  event.data.effect === "accept" ? event.data.call_id : null,
                acceptedCompletionStep:
                  event.data.effect === "accept" ? event.data.step : null,
                completionProof: proof,
              },
            }
          : state;
      next = replaceItems(next, (item) =>
        item.kind === "completion" && item.callId === event.data.call_id
          ? {
              ...item,
              reasons: event.data.reasons.map(sanitize),
              status:
                event.data.effect === "accept"
                  ? "accepted"
                  : event.data.effect === "incomplete"
                    ? "incomplete"
                    : event.data.effect === "error"
                      ? "error"
                      : "rejected",
            }
          : item,
      );
      if (event.data.effect !== "accept") {
        next = updateModelStatus(next, event.runId, event.data.step, "rejected");
      }
      return next;
    }
    case "run.completed": {
      if (state.run?.id !== event.runId) {
        return failClosed(state, event, "completion does not match the active run");
      }
      if (state.run.taskProfile === "coding") {
        const acceptedCallId = state.run.acceptedCompletionCallId;
        const finishSucceeded = state.transcript.some(
          (item) =>
            item.kind === "tool" &&
            item.callId === acceptedCallId &&
            item.toolName === "finish_task" &&
            item.status === "success",
        );
        if (
          event.data.completion_mode !== "verified_finish_task" ||
          state.run.completionProof !== "accepted" ||
          !finishSucceeded
        ) {
          return failClosed(
            state,
            event,
            "coding completion lacks accepted finish_task evidence",
          );
        }
      }
      const accepted = updateModelStatus(
        state,
        event.runId,
        state.run.acceptedCompletionStep,
        "accepted",
      );
      return {
        ...accepted,
        approval: expireApproval(accepted.approval, "run_terminal"),
        run: { ...state.run, runExitCode: 0, status: "completed" },
      };
    }
    case "run.incomplete":
      if (state.run?.id !== event.runId) {
        return failClosed(state, event, "terminal does not match the active run");
      }
      return {
        ...updateModelStatus(state, event.runId, state.run.currentStep, "rejected"),
        approval: expireApproval(state.approval, "run_terminal"),
        run:
          state.run?.id === event.runId
            ? { ...state.run, runExitCode: 8, status: "incomplete" }
            : state.run,
      };
    case "run.budget_exceeded":
      if (state.run?.id !== event.runId) {
        return failClosed(state, event, "terminal does not match the active run");
      }
      return {
        ...updateModelStatus(state, event.runId, state.run.currentStep, "rejected"),
        approval: expireApproval(state.approval, "run_terminal"),
        run:
          state.run?.id === event.runId
            ? { ...state.run, runExitCode: 7, status: "budget_exceeded" }
            : state.run,
      };
    case "run.cancelled":
      if (state.run?.id !== event.runId) {
        return failClosed(state, event, "terminal does not match the active run");
      }
      return {
        ...updateModelStatus(state, event.runId, state.run.currentStep, "rejected"),
        approval: expireApproval(state.approval, "cancelled"),
        run:
          state.run?.id === event.runId
            ? { ...state.run, runExitCode: 130, status: "cancelled" }
            : state.run,
      };
    case "run.failed":
      if (state.run?.id !== event.runId) {
        return failClosed(state, event, "terminal does not match the active run");
      }
      return {
        ...updateModelStatus(state, event.runId, state.run.currentStep, "rejected"),
        approval: expireApproval(state.approval, "run_terminal"),
        run:
          state.run?.id === event.runId
            ? {
                ...state.run,
                runExitCode: failedExitCode(event.data.category),
                status: "failed",
              }
            : state.run,
      };
    case "context.estimate.created":
      return {
        ...state,
        context: {
          ...state.context,
          absoluteInputTokens: event.data.absolute_input_tokens,
          epoch: event.data.epoch,
          estimatedInputTokens: event.data.estimated_input_tokens,
        },
      };
    case "context.compaction.started":
      return appendItem(
        {
          ...state,
          context: {
            ...state.context,
            compacting: true,
            epoch: event.data.to_epoch,
            estimatedInputTokens: event.data.estimated_input_tokens,
            protectedEstimatedTokens: event.data.protected_estimated_tokens,
          },
        },
        {
          id: event.eventId,
          kind: "context",
          label: `compacting epoch ${event.data.from_epoch} -> ${event.data.to_epoch}`,
          runId: event.runId,
        },
      );
    case "context.plan.created":
      return appendItem(
        {
          ...state,
          context: {
            ...state.context,
            compacting: false,
            epoch: event.data.epoch,
            estimatedInputTokens: event.data.estimated_input_tokens,
            protectedEstimatedTokens: event.data.protected_estimated_tokens,
          },
        },
        {
          id: event.eventId,
          kind: "context",
          label: `context plan epoch ${event.data.epoch}${event.data.compacted ? " compacted" : ""}`,
          runId: event.runId,
        },
      );
    case "context.compaction.failed":
      return appendItem(
        {
          ...state,
          context: {
            ...state.context,
            compacting: false,
            epoch: event.data.epoch,
            estimatedInputTokens: event.data.estimated_input_tokens,
          },
        },
        {
          id: event.eventId,
          kind: "context",
          label: sanitize(event.data.reason),
          runId: event.runId,
        },
      );
    case "model.request.encoded":
      return appendItem(state, {
        id: event.eventId,
        kind: "context",
        label: `model request encoded at epoch ${event.data.epoch}`,
        runId: event.runId,
      });
    case "artifact.stored":
      return appendItem(state, {
        artifactId: event.data.artifact_id,
        bytes: event.data.bytes,
        id: event.eventId,
        kind: "artifact",
        runId: event.runId,
        status: "stored",
      });
    case "artifact.capture.truncated":
      return appendItem(state, {
        artifactId: event.data.artifact_id ?? null,
        bytes: event.data.captured_bytes,
        id: event.eventId,
        kind: "artifact",
        runId: event.runId,
        status: "truncated",
      });
    case "repository.rules.loaded":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label:
          event.data.state === "loaded"
            ? `repository rules loaded (${event.data.bytes} bytes)`
            : "repository rules missing",
        runId: event.runId,
      });
    case "repository.rules.changed":
      return appendItem(
        {
          ...state,
          approval: expireApproval(
            state.approval,
            "workspace_or_action_changed",
          ),
          session: {
            ...state.session,
            actionBlocked: true,
            resumeBlocked: true,
          },
        },
        {
          id: event.eventId,
          kind: "session",
          label: `repository rules changed (${sanitize(event.data.reason)})`,
          runId: event.runId,
        },
      );
    case "session.lock.recovered":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: "stale session lock recovered",
        runId: null,
      });
    case "session.tail.recovered":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `session tail recovered (${sanitize(event.data.repair)})`,
        runId: null,
      });
    case "session.resume.requested":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `resume requested (${sanitize(event.data.requested_mode)})`,
        runId: null,
      });
    case "side_effect.reconciled":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `patch effect reconciled as ${sanitize(event.data.observed)}`,
        runId: null,
      });
    default:
      return assertNever(event);
  }
}

export function reducePersistedEvent(
  state: TuiViewState,
  event: TuiPersistedEvent,
): TuiViewState {
  if (state.session.fatalReason !== null) return state;
  const expectedSessionSeq = state.session.lastSessionSeq + 1;
  if (event.sessionSeq !== expectedSessionSeq) {
    return failClosed(
      state,
      event,
      `durable event sequence mismatch: expected ${expectedSessionSeq}, received ${event.sessionSeq}`,
    );
  }
  if (state.session.id !== null && state.session.id !== event.sessionId) {
    return failClosed(state, event, "durable event belongs to another session");
  }

  const sequenced: TuiViewState = {
    ...state,
    session: {
      ...state.session,
      id: event.sessionId,
      lastSessionSeq: event.sessionSeq,
    },
  };
  if (!isKnownEvent(event)) {
    // Unknown future facts may carry new authority semantics. Showing an
    // unsupported badge while blocking actions is safer than guessing.
    return {
      ...sequenced,
      approval: expireApproval(
        sequenced.approval,
        "workspace_or_action_changed",
      ),
      session: {
        ...sequenced.session,
        actionBlocked: true,
        fatalReason: `unsupported durable event: ${sanitize(event.type)}`,
        resumeBlocked: true,
      },
      transcript: [
        ...sequenced.transcript,
        {
          eventType: sanitize(event.type),
          id: event.eventId,
          kind: "unsupported",
          runId: event.scope === "run" ? (event.runId ?? null) : null,
        },
      ],
    };
  }
  return reduceKnownEvent(sequenced, event);
}

export function replayPersistedEvents(
  events: readonly TuiPersistedEvent[],
  initial: TuiViewState,
): TuiViewState {
  return events.reduce(reducePersistedEvent, initial);
}
