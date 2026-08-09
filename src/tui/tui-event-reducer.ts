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
import { reduceRepositoryStatusEvent } from "../repository-intelligence/repository-status-projection.js";

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
  "goal.created",
  "goal.change.recorded",
  "goal.execution.baseline.captured",
  "goal.revised",
  "goal.status.changed",
  "hook.approval.decided",
  "hook.approval.requested",
  "hook.invocation.completed",
  "hook.invocation.decided",
  "hook.invocation.failed",
  "hook.invocation.requested",
  "hook.invocation.started",
  "hook.matched",
  "hook.permission.evaluated",
  "context.compaction.failed",
  "context.compaction.started",
  "context.estimate.created",
  "context.plan.created",
  "model.request.encoded",
  "model.usage",
  "mcp.approval.decided",
  "mcp.approval.requested",
  "mcp.catalog.changed",
  "mcp.catalog.discovered",
  "mcp.permission.evaluated",
  "mcp.prompt.catalog.stale",
  "mcp.prompt.cataloged",
  "mcp.prompt.get.completed",
  "mcp.prompt.get.failed",
  "mcp.prompt.get.requested",
  "mcp.prompt.user.invoked",
  "mcp.resource.catalog.stale",
  "mcp.resource.cataloged",
  "mcp.resource.read.completed",
  "mcp.resource.read.failed",
  "mcp.resource.read.requested",
  "mcp.server.negotiated",
  "mcp.server.start.effect_unknown",
  "mcp.server.start.failed",
  "mcp.server.start.requested",
  "mcp.server.started",
  "mcp.server.stderr",
  "mcp.server.stopped",
  "mcp.server.stopping",
  "mcp.tool.call.completed",
  "mcp.tool.call.effect_unknown",
  "mcp.tool.call.started",
  "patch.apply.completed",
  "patch.apply.started",
  "patch.plan.created",
  "plan.approved",
  "plan.completed",
  "plan.item.status_changed",
  "plan.proposed",
  "plan.rejected",
  "plan.revised",
  "permission.evaluated",
  "repository.rules.changed",
  "repository.rules.loaded",
  "repository.rules.manifest.loaded",
  "repository.source.snapshot.captured",
  "repository.index.invalidated",
  "repository.index.selected",
  "resume.pending_call.adopted",
  "run.budget_exceeded",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.incomplete",
  "run.started",
  "sandbox.container.cleaned",
  "sandbox.container.create.requested",
  "sandbox.container.created",
  "sandbox.container.exited",
  "sandbox.container.inspected",
  "sandbox.container.start.requested",
  "sandbox.container.started",
  "sandbox.container.stopping",
  "sandbox.snapshot.changed",
  "sandbox.snapshot.cleaned",
  "sandbox.snapshot.created",
  "session.lock.recovered",
  "session.resume.requested",
  "session.tail.recovered",
  "side_effect.reconciled",
  "skill.activated",
  "skill.activation.failed",
  "skill.activation.requested",
  "skill.resource.read",
  "task_budget.exhausted",
  "task_graph.approved",
  "task_graph.cancel.requested",
  "task_graph.enqueued",
  "task_graph.proposed",
  "task_graph.rejected",
  "task_graph.replaced",
  "task_graph.stale",
  "task_graph.started",
  "task_graph.terminal",
  "task_graph.waiting_for_user",
  "task_node.attempt.requested",
  "task_node.attempt.started",
  "task_node.attempt.terminal",
  "task_node.attempt.waiting_for_user",
  "task_node.retry.requested",
  "task_node.skipped",
  "task_origin_verification.approved",
  "task_origin_verification.completed",
  "task_origin_verification.requested",
  "task_scheduler.lease.acquired",
  "task_scheduler.lease.recovered",
  "task_worker.control.accepted",
  "task_worker.reconciled",
  "task_worker.spawn.requested",
  "task_worker.started",
  "task_worker.terminal",
  "task_worktree.allocation.approved",
  "task_worktree.allocation.prepared",
  "task_worktree.baseline.seeded",
  "task_worktree.cleanup.completed",
  "task_worktree.cleanup.requested",
  "task_worktree.create.requested",
  "task_worktree.created",
  "task_worktree.lease.acquired",
  "task_worktree.lease.released",
  "task_worktree.promotion.applied",
  "task_worktree.promotion.approved",
  "task_worktree.promotion.proposed",
  "task_worktree.promotion.requested",
  "task_worktree.reconciled",
  "task_worktree.snapshot.accepted",
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
          ...(event.data.capability_snapshot === undefined
            ? {}
            : {
                capabilitySnapshot: {
                  componentCount: event.data.capability_snapshot.component_count,
                  eligiblePluginCount:
                    event.data.capability_snapshot.eligible_plugin_count,
                  enablementRevision:
                    event.data.capability_snapshot.enablement_revision,
                  snapshotId: event.data.capability_snapshot.snapshot_id,
                },
              }),
          completionProof: "none",
          currentStep: 1,
          executionEnvironment:
            event.data.command === "agent" && event.data.executor === "docker"
              ? `docker:${event.data.docker_sandbox!.image}; network=none; limits=${event.data.docker_sandbox!.limits.cpus}cpu/${event.data.docker_sandbox!.limits.memory_mib}MiB/${event.data.docker_sandbox!.limits.pids}pids`
              : "local; isolation=none",
          id: event.runId,
          model: sanitize(event.data.model),
          policyMode:
            event.data.runtime_policy?.profile_mode ?? "legacy_unrecorded",
          policyProfile:
            event.data.runtime_policy?.profile_id ?? "legacy-unrecorded",
          policySha256:
            event.data.runtime_policy?.profile_sha256 ?? "unavailable",
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
    case "mcp.approval.requested": {
      if (state.run?.id !== event.runId || state.run.status !== "running") {
        return failClosed(state, event, "MCP approval request is outside the active run");
      }
      const previous = expireApproval(state.approval, "new_request");
      const preview = sanitize(event.data.preview);
      let next: TuiViewState = {
        ...state,
        approval: {
          actionKind: event.data.action_kind,
          actionSha256: event.data.action_sha256,
          callId: `mcp:${event.data.server_id}`,
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
      if (previous !== null) {
        next = replaceItems(next, (item) =>
          item.kind === "approval" &&
          item.requestId === previous.requestId &&
          item.status === "requested"
            ? { ...item, status: "expired" }
            : item,
        );
      }
      return appendItem(next, {
        actionKind: event.data.action_kind,
        id: event.eventId,
        kind: "approval",
        requestId: event.data.approval_request_id,
        runId: event.runId,
        status: "requested",
      });
    }
    case "mcp.approval.decided": {
      const approval = state.approval;
      if (
        approval === null ||
        approval.expiresState.status !== "active" ||
        approval.requestId !== event.data.approval_request_id ||
        approval.actionSha256 !== event.data.action_sha256 ||
        approval.actionKind !== event.data.action_kind ||
        approval.runId !== event.runId
      ) {
        return failClosed(state, event, "MCP approval decision identity is stale");
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
    case "hook.approval.requested": {
      if (state.run?.id !== event.runId || state.run.status !== "running") {
        return failClosed(state, event, "Hook approval request is outside the active run");
      }
      const previous = expireApproval(state.approval, "new_request");
      const preview = sanitize(event.data.preview);
      let next: TuiViewState = {
        ...state,
        approval: {
          actionKind: "run_command",
          actionSha256: event.data.action_sha256,
          callId: `hook:${event.data.invocation_id}`,
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
      if (previous !== null) {
        next = replaceItems(next, (item) =>
          item.kind === "approval" &&
          item.requestId === previous.requestId &&
          item.status === "requested"
            ? { ...item, status: "expired" }
            : item,
        );
      }
      return appendItem(next, {
        actionKind: "run_command",
        id: event.eventId,
        kind: "approval",
        requestId: event.data.approval_request_id,
        runId: event.runId,
        status: "requested",
      });
    }
    case "hook.approval.decided": {
      const approval = state.approval;
      if (
        approval === null ||
        approval.expiresState.status !== "active" ||
        approval.requestId !== event.data.approval_request_id ||
        approval.actionSha256 !== event.data.action_sha256 ||
        approval.actionKind !== "run_command" ||
        approval.callId !== `hook:${event.data.invocation_id}` ||
        approval.runId !== event.runId
      ) {
        return failClosed(state, event, "Hook approval decision identity is stale");
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
    case "repository.rules.manifest.loaded":
      return appendItem({ ...state, repository: reduceRepositoryStatusEvent(state.repository, event) }, {
        id: event.eventId,
        kind: "session",
        label: `repository rule manifest loaded (${event.data.rule_count} rules)`,
        runId: event.runId,
      });
    case "repository.rules.changed":
      return appendItem(
        {
          ...state,
          repository: reduceRepositoryStatusEvent(state.repository, event),
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
    case "repository.source.snapshot.captured":
      return appendItem({ ...state, repository: reduceRepositoryStatusEvent(state.repository, event) }, {
        id: event.eventId,
        kind: "session",
        label: `repository source captured (${event.data.file_count} files, ${event.data.coverage})`,
        runId: event.runId,
      });
    case "repository.index.invalidated":
      return appendItem({ ...state, repository: reduceRepositoryStatusEvent(state.repository, event) }, {
        id: event.eventId,
        kind: "session",
        label: `repository index invalidated (${sanitize(event.data.reason)})`,
        runId: event.runId,
      });
    case "repository.index.selected":
      return appendItem({ ...state, repository: reduceRepositoryStatusEvent(state.repository, event) }, {
        id: event.eventId,
        kind: "session",
        label: `repository index ${event.data.generation_sha256.slice(0, 8)} selected (${event.data.coverage})`,
        runId: event.runId,
      });
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
    case "mcp.catalog.changed":
    case "mcp.server.start.effect_unknown":
    case "mcp.tool.call.effect_unknown":
      return appendItem(
        {
          ...state,
          approval: expireApproval(state.approval, "workspace_or_action_changed"),
          session: {
            ...state.session,
            actionBlocked: true,
            resumeBlocked: true,
          },
        },
        {
          id: event.eventId,
          kind: "session",
          label: `MCP action blocked (${sanitize(event.type)})`,
          runId: event.runId,
        },
      );
    case "mcp.catalog.discovered":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP:${sanitize(event.data.server_id)} discovered ${event.data.tools.length} tool(s)`,
        runId: event.runId,
      });
    case "mcp.server.started":
    case "mcp.server.stopped":
    case "mcp.server.start.failed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP:${sanitize(event.data.server_id)} ${sanitize(event.type)}`,
        runId: event.runId,
      });
    case "mcp.permission.evaluated":
    case "mcp.server.start.requested":
    case "mcp.server.stderr":
    case "mcp.server.stopping":
    case "mcp.tool.call.completed":
    case "mcp.tool.call.started":
      return state;
    case "sandbox.snapshot.created":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Docker snapshot ready (${event.data.file_count} files, network=none)`,
        runId: event.runId,
      });
    case "sandbox.container.started":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: "Docker sandbox started",
        runId: event.runId,
      });
    case "sandbox.snapshot.changed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `ephemeral sandbox changes: +${event.data.created} ~${event.data.modified} -${event.data.deleted}`,
        runId: event.runId,
      });
    case "sandbox.container.cleaned":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: "Docker sandbox cleaned",
        runId: event.runId,
      });
    case "sandbox.snapshot.cleaned":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: "Docker snapshot cleaned",
        runId: event.runId,
      });
    case "sandbox.container.create.requested":
    case "sandbox.container.created":
    case "sandbox.container.exited":
    case "sandbox.container.inspected":
    case "sandbox.container.start.requested":
    case "sandbox.container.stopping":
      return state;
    case "skill.activation.requested":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Skill requested: ${event.data.skill_identity.componentId} (${event.data.selected_by})`,
        runId: event.runId,
      });
    case "skill.activated":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Skill activated: ${event.data.activation_id.slice(0, 8)} (${String(event.data.byte_length)} bytes)`,
        runId: event.runId,
      });
    case "skill.resource.read":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Skill resource: ${event.data.resource_id} (${String(event.data.byte_length)}/${String(event.data.total_bytes)} bytes)`,
        runId: event.runId,
      });
    case "skill.activation.failed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Skill activation failed: ${event.data.code}`,
        runId: event.runId,
      });
    case "mcp.server.negotiated":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP negotiated: ${event.data.server_id} (${event.data.protocol_version})`,
        runId: event.runId,
      });
    case "mcp.resource.cataloged":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP resources: ${event.data.server_id} (${String(event.data.count)})`,
        runId: event.runId,
      });
    case "mcp.prompt.cataloged":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP prompts: ${event.data.server_id} (${String(event.data.count)})`,
        runId: event.runId,
      });
    case "mcp.resource.catalog.stale":
    case "mcp.prompt.catalog.stale":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP catalog stale: ${event.data.server_id} (${event.data.reason})`,
        runId: event.runId,
      });
    case "mcp.resource.read.completed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP resource read: ${event.data.resource_id.slice(0, 24)} (${String(event.data.byte_length)} bytes)`,
        runId: event.runId,
      });
    case "mcp.prompt.get.completed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP prompt added: ${event.data.prompt_id.slice(0, 24)} (${String(event.data.message_count)} messages)`,
        runId: event.runId,
      });
    case "mcp.resource.read.failed":
    case "mcp.prompt.get.failed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP primitive failed: ${event.data.code}`,
        runId: event.runId,
      });
    case "mcp.resource.read.requested":
    case "mcp.prompt.get.requested":
      return state;
    case "mcp.prompt.user.invoked":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `MCP prompt requested by user: ${event.data.selector}`,
        runId: event.runId,
      });
    case "hook.matched":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Hook matched: ${event.data.hook_identity.componentId} (${event.data.event})`,
        runId: event.runId,
      });
    case "hook.invocation.decided":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Hook decision: ${event.data.decision}${event.data.code === undefined ? "" : ` (${event.data.code})`}`,
        runId: event.runId,
      });
    case "hook.invocation.completed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Hook observer: ${event.data.status}`,
        runId: event.runId,
      });
    case "hook.invocation.failed":
      return appendItem(state, {
        id: event.eventId,
        kind: "session",
        label: `Hook failed: ${event.data.code}`,
        runId: event.runId,
      });
    case "hook.invocation.requested":
    case "hook.invocation.started":
    case "hook.permission.evaluated":
      return state;
    case "goal.created":
    case "goal.revised":
    case "goal.status.changed":
    case "goal.change.recorded":
    case "goal.execution.baseline.captured":
    case "plan.approved":
    case "plan.completed":
    case "plan.item.status_changed":
    case "plan.proposed":
    case "plan.rejected":
    case "plan.revised":
    case "task_graph.proposed":
    case "task_graph.replaced":
    case "task_graph.approved":
    case "task_graph.rejected":
    case "task_graph.stale":
    case "task_graph.enqueued":
    case "task_graph.started":
    case "task_graph.waiting_for_user":
    case "task_graph.cancel.requested":
    case "task_graph.terminal":
    case "task_scheduler.lease.acquired":
    case "task_scheduler.lease.recovered":
    case "task_node.attempt.requested":
    case "task_node.attempt.started":
    case "task_node.attempt.waiting_for_user":
    case "task_node.attempt.terminal":
    case "task_node.retry.requested":
    case "task_node.skipped":
    case "task_budget.exhausted":
    case "task_worktree.allocation.prepared":
    case "task_worktree.allocation.approved":
    case "task_worktree.create.requested":
    case "task_worktree.created":
    case "task_worktree.baseline.seeded":
    case "task_worktree.lease.acquired":
    case "task_worktree.lease.released":
    case "task_worktree.snapshot.accepted":
    case "task_worktree.promotion.proposed":
    case "task_worktree.promotion.approved":
    case "task_worktree.promotion.requested":
    case "task_worktree.promotion.applied":
    case "task_origin_verification.approved":
    case "task_origin_verification.requested":
    case "task_origin_verification.completed":
    case "task_worktree.cleanup.requested":
    case "task_worktree.cleanup.completed":
    case "task_worktree.reconciled":
    case "task_worker.spawn.requested":
    case "task_worker.started":
    case "task_worker.control.accepted":
    case "task_worker.terminal":
    case "task_worker.reconciled":
      return state;
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
