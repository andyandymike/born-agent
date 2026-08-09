import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { resolveAgentConfig } from "../agent/agent-config.js";
import type { AgentCommandOptions } from "../agent/agent-types.js";
import { CheckpointStore } from "../checkpoints/checkpoint-store.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { runEventSchema } from "../events/run-event-schema.js";
import type { RunEvent } from "../events/run-event.js";
import { BackendPreflightError } from "../model/backend-factory.js";
import type { ModelBackend } from "../model/model-backend.js";
import { BackendResumeProjectionBuilder } from "../resume/backend-resume-projection-builder.js";
import {
  reconcilePendingPatchFromReader,
  type PatchReconciliation,
} from "../resume/patch-reconciler.js";
import {
  mergeMcpPendingEffects,
  reconstructPendingEffectLedger,
} from "../resume/pending-effect-ledger.js";
import { ResumePlanner } from "../resume/resume-planner.js";
import type { BlockedResumePlan } from "../resume/resume-types.js";
import { WorkspacePatchObservationReader } from "../resume/workspace-patch-observation-reader.js";
import { buildWorkspaceResumeFingerprint } from "../resume/workspace-resume-fingerprint-builder.js";
import {
  restoreWorkspaceResumeFingerprint,
  workspaceResumeFingerprintSha256,
} from "../resume/workspace-resume-fingerprint.js";
import { redactSensitiveText } from "../security/redact.js";
import {
  buildCanonicalTranscript,
  type CanonicalTranscriptItem,
} from "../sessions/canonical-transcript.js";
import {
  SessionCatalog,
  type SessionCatalogEntry,
} from "../sessions/session-catalog.js";
import type {
  ReconstructedMultiRunSession,
  ReconstructedRunProjection,
} from "../sessions/reconstruct-multi-run-session.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import { assertCanonicalSessionId, SessionPathError } from "../sessions/session-path-policy.js";
import { SessionLockError } from "../sessions/session-lock.js";
import { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { executeAgent } from "./agent.js";
import { countPendingContainerLifecycles } from "../execution/docker/container-reconciliation-runtime.js";
import { CapabilityError } from "../capabilities/capability-errors.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type EffectiveRuntimePolicy,
} from "../policy/policy-resolver.js";
import { restoreDockerExecutionImageIdentity } from "../execution/docker/acquisition/docker-image-identity.js";
import { agentModeSchema } from "../agent/agent-mode.js";
import { stripPhase16RunBinding } from "../events/phase16-run-event-extension.js";
import { CompletionTransitionReconciler } from "../coordination/completion-transition-reconciler.js";
import { GoalChangeRecordReconciler } from "../coordination/goal-change-record-reconciler.js";
import { OutcomeReportBuilder } from "../coordination/outcome-report.js";
import { renderOutcomeReport } from "../coordination/outcome-report-renderer.js";

const MAX_SHOW_ITEMS = 200;
const MAX_SHOW_TEXT_BYTES = 128 * 1024;
const MAX_RESUME_PROMPT_BYTES = 64 * 1024;

export interface SessionsListOptions {
  readonly json: boolean;
  readonly limit: string | undefined;
}

export interface SessionsShowOptions {
  readonly context?: boolean;
  readonly events: boolean;
  readonly json: boolean;
  readonly sessionId: string;
}

export interface SessionsResumeOptions {
  readonly allowDegradedResume: boolean;
  readonly continueApprovedPlan?: boolean | undefined;
  /** TUI-only optimistic binding, checked immediately after lock acquisition. */
  readonly expectedSessionSeq?: number | undefined;
  /** Internal trusted surface used only for run mode provenance. */
  readonly inputSurface?: "cli" | "tui";
  readonly message: string | undefined;
  readonly mode?: string | undefined;
  readonly modeSource?: AgentCommandOptions["modeSource"];
  readonly planRevision?: string | undefined;
  readonly planSha256?: string | undefined;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly sessionId: string;
}

function redact(_runtime: CliRuntime, value: string): string {
  // PHASE15: replay is not provider selection and must not read ambient API
  // keys. Persisted runs are already redacted; pattern redaction is retained
  // as a second read-only safety net for legacy data.
  return redactSensitiveText(value);
}

function writeJson(io: CliIO, runtime: CliRuntime, value: unknown): void {
  const text = JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "string" ? redact(runtime, item) : item,
    2,
  );
  io.stdout.write(`${text}\n`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function usageError(io: CliIO, message: string): 2 {
  io.stderr.write(`usage/config error: ${message}\n`);
  return 2;
}

function dataError(io: CliIO, message: string): 1 {
  io.stderr.write(`session data error: ${message}\n`);
  return 1;
}

function resolveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 50;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 200
    ? parsed
    : undefined;
}

function publicCatalogEntry(
  runtime: CliRuntime,
  entry: SessionCatalogEntry,
): Omit<SessionCatalogEntry, "path"> {
  const { path: _path, ...rest } = entry;
  void _path;
  return {
    ...rest,
    ...(rest.error === undefined ? {} : { error: redact(runtime, rest.error) }),
    taskSummary: redact(runtime, rest.taskSummary),
  };
}

export async function executeSessionsList(
  options: SessionsListOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  const limit = resolveLimit(options.limit);
  if (limit === undefined) {
    return usageError(io, "session list limit must be an integer from 1 to 200");
  }
  let result;
  try {
    result = await new SessionCatalog(runtime.cwd).scan(limit);
  } catch (error) {
    return dataError(io, error instanceof Error ? error.message : "catalog scan failed");
  }
  const entries = result.entries.map((entry) =>
    publicCatalogEntry(runtime, entry),
  );
  if (options.json) {
    writeJson(io, runtime, {
      diagnostics: result.diagnostics,
      entries,
      schemaVersion: 1,
    });
  } else if (entries.length === 0) {
    io.stdout.write("No sessions found.\n");
  } else {
    io.stdout.write(
      "SESSION\tSTATUS\tPROVIDER/MODEL\tCHANGED\tRESUME\tTASK\n",
    );
    for (const entry of entries) {
      const backend =
        entry.provider === null || entry.model === null
          ? "-"
          : `${entry.provider}/${entry.model}`;
      const summary = entry.error ?? entry.taskSummary;
      io.stdout.write(
        `${entry.sessionId}\t${entry.status}\t${backend}\t${entry.changedCount}\t${entry.resumeStatus}\t${summary}\n`,
      );
    }
  }
  if (result.diagnostics.truncated) {
    io.stderr.write(
      `session catalog truncated after ${result.diagnostics.filesScanned} files\n`,
    );
  }
  return 0;
}

async function hasWriterLock(workspace: string, sessionId: string): Promise<boolean> {
  const path = join(workspace, ".bornagent", "sessions", `${sessionId}.lock`);
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function transcriptLine(item: CanonicalTranscriptItem): string | undefined {
  switch (item.kind) {
    case "user_text":
      return `User: ${item.text}`;
    case "assistant_text":
      return item.visibility === "user_visible"
        ? `Assistant: ${item.text}`
        : undefined;
    case "tool_call":
      return `Tool requested: ${item.toolName} (${item.callId})`;
    case "tool_observation":
      return `Tool ${item.status}: ${item.toolName} (${item.callId}) ${item.output}`;
    case "change":
      return `Change: ${item.files.map(({ path }) => path).join(", ")}`;
    case "verification":
      return `Verification: ${item.status} (${item.verificationId})`;
    case "completion":
      return item.phase === "terminal"
        ? `Run outcome: ${item.outcome}`
        : undefined;
    case "task_graph":
      return `Task Graph ${item.fact}: ${item.graphId} rev ${String(item.graphRevision)} status=${item.status}${item.nodeId === undefined ? "" : ` node=${item.nodeId}`}`;
  }
}

function boundedTranscriptText(
  transcript: readonly CanonicalTranscriptItem[],
  runtime: CliRuntime,
): { readonly text: string; readonly truncated: boolean } {
  let text = "";
  let truncated = transcript.length > MAX_SHOW_ITEMS;
  for (const item of transcript.slice(0, MAX_SHOW_ITEMS)) {
    const line = transcriptLine(item);
    if (line === undefined) continue;
    const candidate = `${text}${redact(runtime, line)}\n`;
    if (Buffer.byteLength(candidate, "utf8") > MAX_SHOW_TEXT_BYTES) {
      truncated = true;
      break;
    }
    text = candidate;
  }
  return { text, truncated };
}

function publicTranscript(
  transcript: readonly CanonicalTranscriptItem[],
): readonly CanonicalTranscriptItem[] {
  return transcript
    .filter(
      (item) =>
        item.kind !== "assistant_text" || item.visibility === "user_visible",
    )
    .slice(0, MAX_SHOW_ITEMS);
}

function publicArtifactFacts(
  session: ReconstructedMultiRunSession,
): Readonly<Record<string, unknown>> {
  return {
    capturedBytes: session.artifacts.budgetUsage.sessionBytes ?? 0,
    objects: session.artifacts.objects.slice(0, MAX_SHOW_ITEMS).map((artifact) => ({
      artifactId: artifact.artifactId,
      bytes: artifact.bytes,
      mediaTypes: artifact.mediaTypes,
      referenceCount: artifact.referenceCount,
      sha256: artifact.sha256,
      wasCaptureTruncated: artifact.wasCaptureTruncated,
    })),
    objectsTruncated: session.artifacts.objects.length > MAX_SHOW_ITEMS,
    storedReferences: session.artifacts.storedReferenceCount,
    truncatedCaptures: session.artifacts.truncatedCaptureEventCount,
    uniqueObjectBytes: session.artifacts.uniqueObjectBytes,
    uniqueObjects: session.artifacts.objects.length,
  };
}

function publicContextFacts(
  session: ReconstructedMultiRunSession,
): Readonly<Record<string, unknown>> {
  const estimates = new Map<string, Extract<
    (typeof session.events)[number],
    { readonly type: "context.estimate.created" }
  >>();
  const encoded = new Map<string, Extract<
    (typeof session.events)[number],
    { readonly type: "model.request.encoded" }
  >>();
  const key = (runId: string, step: number): string => `${runId}:${step}`;
  for (const event of session.events) {
    if (event.scope !== "run") continue;
    if (event.type === "context.estimate.created") {
      estimates.set(key(event.runId, event.data.step), event);
    } else if (event.type === "model.request.encoded") {
      encoded.set(key(event.runId, event.data.step), event);
    }
  }
  const plans = session.events.filter(
    (event): event is Extract<
      (typeof session.events)[number],
      { readonly type: "context.plan.created" }
    > => event.scope === "run" && event.type === "context.plan.created",
  );
  return {
    plans: plans.slice(0, MAX_SHOW_ITEMS).map((plan) => {
      const requestKey = key(plan.runId, plan.data.step);
      const estimate = estimates.get(requestKey);
      const request = encoded.get(requestKey);
      return {
        adapter: request?.data.adapter ?? null,
        adapterEncodingVersion:
          request?.data.adapter_encoding_version ?? null,
        archivedItemCount: plan.data.archived_item_ids.length,
        canonicalContextSha256: plan.data.canonical_context_sha256,
        compacted: plan.data.compacted,
        compactionThreshold:
          estimate?.data.compaction_threshold ?? null,
        contextWindowTokens:
          estimate?.data.context_window_tokens ?? null,
        encodedRequestSha256:
          request?.data.encoded_request_sha256 ?? null,
        epoch: plan.data.epoch,
        estimatedInputTokens: plan.data.estimated_input_tokens,
        includedItemCount: plan.data.included_item_ids.length,
        plannerVersion: plan.data.planner_version,
        protectedCategories: plan.data.protected_categories ?? [],
        protectedEstimatedTokens: plan.data.protected_estimated_tokens,
        protectedFactCount: plan.data.protected_fact_ids.length,
        runId: plan.runId,
        step: plan.data.step,
      };
    }),
    plansTruncated: plans.length > MAX_SHOW_ITEMS,
  };
}

export async function executeSessionsShow(
  options: SessionsShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  if (options.context === true && options.events) {
    return usageError(io, "session show --context cannot be combined with --events");
  }
  try {
    assertCanonicalSessionId(options.sessionId);
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : "invalid session id");
  }
  try {
    // PHASE9: show is a deterministic read-only snapshot. A lock means bytes
    // may advance between validation and rendering, so it refuses rather than
    // presenting a mixed-time projection as an authoritative replay.
    if (await hasWriterLock(runtime.cwd, options.sessionId)) {
      return usageError(io, "session has an active or unverified writer lock");
    }
    const session = await new SessionCatalog(runtime.cwd).read(options.sessionId);
    if (await hasWriterLock(runtime.cwd, options.sessionId)) {
      return usageError(io, "session acquired a writer lock during replay");
    }
    const transcript = buildCanonicalTranscript(session.events);
    const lastRun = session.lastRun;
    const outcomeReport = new OutcomeReportBuilder().build(session);
    if (options.json) {
      writeJson(io, runtime, {
        artifacts: publicArtifactFacts(session),
        ...(options.context === true
          ? { context: publicContextFacts(session) }
          : options.events
          ? { events: session.events }
          : {
              transcript: publicTranscript(transcript),
              transcriptTruncated: transcript.length > MAX_SHOW_ITEMS,
            }),
        lastRunId: lastRun?.runId ?? null,
        taskGraph: session.taskGraph,
        taskExecution: session.taskExecution,
        worktrees: session.worktrees,
        background: session.background,
        model: lastRun?.started.data.model ?? null,
        outcomeReport,
        provider: lastRun?.started.data.provider ?? null,
        runtimePolicy:
          lastRun === null
            ? null
            : lastRun.started.data.runtime_policy ?? "legacy_unrecorded",
        runs: session.runs.length,
        schemaVersion: 1,
        sessionId: session.sessionId,
        status: session.status,
      });
      return 0;
    }
    io.stdout.write(`Session: ${session.sessionId}\n`);
    io.stdout.write(`Last run: ${lastRun?.runId ?? "none"}\n`);
    io.stdout.write(`Status: ${session.status}\n`);
    if (lastRun === null) {
      io.stdout.write("Backend: none\n");
      io.stdout.write("Runtime policy: none\n");
    } else {
      io.stdout.write(
        `Backend: ${lastRun.started.data.provider}/${lastRun.started.data.model}\n`,
      );
      const runtimePolicy = lastRun.started.data.runtime_policy;
      io.stdout.write(
        runtimePolicy === undefined
          ? "Runtime policy: legacy_unrecorded\n"
          : `Runtime policy: ${runtimePolicy.profile_id}/${runtimePolicy.profile_mode} (${runtimePolicy.profile_sha256})\n`,
      );
    }
    io.stdout.write(
      `Artifacts: ${session.artifacts.storedReferenceCount} references, ${session.artifacts.objects.length} objects, ${session.artifacts.budgetUsage.sessionBytes ?? 0} captured bytes, ${session.artifacts.truncatedCaptureEventCount} truncated\n`,
    );
    if (session.taskExecution !== null) {
      io.stdout.write(`Task Graph: ${session.taskExecution.graph.graphId} rev ${String(session.taskExecution.graph.revision)} status=${session.taskExecution.status}\n`);
      io.stdout.write(`Task nodes: ${String(session.taskExecution.nodes.filter((node) => node.status === "succeeded").length)}/${String(session.taskExecution.nodes.length)} succeeded\n`);
    }
    if (session.background.workers.length > 0) {
      io.stdout.write(`Background workers: ${String(session.background.workers.length)} historical, current=${session.background.current?.status ?? "none"}\n`);
    }
    io.stdout.write(renderOutcomeReport(outcomeReport, "text"));
    if (options.context === true) {
      const facts = publicContextFacts(session) as {
        readonly plans: readonly Readonly<Record<string, unknown>>[];
        readonly plansTruncated: boolean;
      };
      io.stdout.write(`Context plans: ${facts.plans.length}\n`);
      for (const plan of facts.plans) {
        io.stdout.write(
          `run=${String(plan.runId)} step=${String(plan.step)} epoch=${String(plan.epoch)} estimated_input_tokens=${String(plan.estimatedInputTokens)} context_window_tokens=${String(plan.contextWindowTokens)} protected_estimated_tokens=${String(plan.protectedEstimatedTokens)} protected_categories=${(plan.protectedCategories as readonly string[]).join(",") || "none"} archived_items=${String(plan.archivedItemCount)} compacted=${String(plan.compacted)} canonical_context_sha256=${String(plan.canonicalContextSha256)} encoded_request_sha256=${String(plan.encodedRequestSha256 ?? "unavailable")}\n`,
        );
      }
      if (facts.plansTruncated) io.stdout.write("[context plans truncated]\n");
      return 0;
    }
    if (options.events) {
      for (const event of session.events.slice(0, MAX_SHOW_ITEMS)) {
        io.stdout.write(
          `${event.sessionSeq}\t${event.scope}\t${event.type}\t${redact(runtime, JSON.stringify(event.data))}\n`,
        );
      }
      if (session.events.length > MAX_SHOW_ITEMS) io.stdout.write("[events truncated]\n");
      return 0;
    }
    const rendered = boundedTranscriptText(transcript, runtime);
    io.stdout.write("\n");
    io.stdout.write(rendered.text);
    if (rendered.truncated) io.stdout.write("[transcript truncated]\n");
    return 0;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return usageError(io, "session was not found");
    }
    return dataError(io, error instanceof Error ? error.message : "session replay failed");
  }
}

function lastBackend(run: ReconstructedRunProjection) {
  return [...run.events]
    .reverse()
    .find((event) => event.type === "backend.selected");
}

const NON_LEGACY_RUN_EVENTS = new Set([
  "goal.change.recorded",
  "goal.execution.baseline.captured",
  "hook.invocation.completed",
  "hook.invocation.decided",
  "hook.invocation.failed",
  "hook.invocation.requested",
  "hook.invocation.started",
  "hook.matched",
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
  "skill.activation.failed",
  "skill.activation.requested",
  "skill.activated",
  "skill.resource.read",
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
  "artifact.capture.truncated",
  "artifact.stored",
  "backend.canonical_boundary.created",
  "backend.checkpoint.created",
  "context.compaction.failed",
  "context.compaction.started",
  "context.estimate.created",
  "context.plan.created",
  "model.request.encoded",
  "mcp.approval.decided",
  "mcp.approval.requested",
  "mcp.catalog.changed",
  "mcp.catalog.discovered",
  "mcp.permission.evaluated",
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
  "repository.rules.changed",
  "repository.rules.loaded",
  "repository.rules.manifest.loaded",
  "repository.source.snapshot.captured",
  "repository.index.invalidated",
  "repository.index.selected",
  "resume.pending_call.adopted",
  "tool.call.recovered",
]);

function legacyDomainEvents(
  session: ReconstructedMultiRunSession,
  run: ReconstructedRunProjection,
): readonly RunEvent[] {
  return run.events.flatMap((event) => {
    if (event.type === "resume.pending_call.adopted") {
      const source = session.runs.find(
        (candidate) => candidate.runId === event.data.source_run_id,
      );
      const requested = source?.events.find(
        (candidate) =>
          candidate.type === "tool.call.requested" &&
          candidate.data.call_id === event.data.source_call_id,
      );
      if (requested?.type !== "tool.call.requested") {
        throw new Error("adopted call has no recoverable source request");
      }
      // PHASE9: adoption is a synthetic request only for ledger reconstruction.
      // Its original call bytes remain authoritative and an unmatched second
      // crash must block degraded resume rather than re-plan the side effect.
      return [
        runEventSchema.parse({
          data: { ...requested.data, call_id: event.data.call_id },
          event_id: event.eventId,
          run_id: event.runId,
          schema_version: 1,
          seq: event.runSeq,
          session_id: event.sessionId,
          timestamp: event.timestamp,
          type: "tool.call.requested",
        }),
      ];
    }
    if (NON_LEGACY_RUN_EVENTS.has(event.type)) return [];
    return [
      runEventSchema.parse({
        data:
          event.type === "run.started"
            ? stripPhase16RunBinding(event.data)
            : event.type === "run.completed" &&
                event.data.completion_mode === "plan_ready"
              ? { ...event.data, completion_mode: "model_final" }
            : event.data,
        event_id: event.eventId,
        run_id: event.runId,
        schema_version: 1,
        seq: event.runSeq,
        session_id: event.sessionId,
        timestamp: event.timestamp,
        type: event.type,
      }),
    ];
  });
}

function historicalAgentOptions(
  session: ReconstructedMultiRunSession,
  task: string,
  policy: Pick<
    SessionsResumeOptions,
    "mode" | "modeSource" | "policyConfig" | "policyProfile"
    | "inputSurface"
  > & {
    readonly continueApprovedPlan?: AgentCommandOptions["continueApprovedPlan"];
  },
): AgentCommandOptions | undefined {
  if (session.lastRun === null) return undefined;
  const started = session.lastRun.started.data;
  if (started.command !== "agent") return undefined;
  const selectedMode =
    policy.mode ??
    ("agent_mode" in started &&
    (started.agent_mode === "plan" || started.agent_mode === "build")
      ? started.agent_mode
      : undefined);
  const dockerEvidence = started.docker_sandbox;
  const restoredImageIdentity =
    dockerEvidence?.image_identity === undefined
      ? undefined
      : restoreDockerExecutionImageIdentity(dockerEvidence.image_identity);
  const dockerArtifactExecution =
    restoredImageIdentity?.kind === "trusted_local_build" &&
    dockerEvidence?.artifact_contract !== undefined
      ? Object.freeze({
          artifactId: dockerEvidence.artifact_contract.artifact_id,
          expectedLockfileSha256:
            dockerEvidence.artifact_contract.expected_lockfile_sha256,
          imageIdentity: restoredImageIdentity,
          imagePath: dockerEvidence.artifact_contract.image_path,
          runtime: dockerEvidence.artifact_contract.runtime,
          runtimeVersion: dockerEvidence.artifact_contract.runtime_version,
          supportsCUtf8: dockerEvidence.artifact_contract.supports_c_utf8,
          wrapperSha256: dockerEvidence.artifact_contract.wrapper_sha256,
        })
      : undefined;
  return {
    commandApproval: started.command_approval,
    commandTimeoutMs:
      started.command_timeout_ms === undefined
        ? undefined
        : String(started.command_timeout_ms),
    completionPolicy: started.completion_policy,
    dockerImage:
      selectedMode === "plan" ? undefined : started.docker_sandbox?.image,
    ...(dockerArtifactExecution === undefined || selectedMode === "plan"
      ? {}
      : { dockerArtifactExecution }),
    editApproval: started.edit_approval,
    executor: selectedMode === "plan" ? undefined : started.executor,
    maxDurationMs: String(started.max_duration_ms),
    maxCommandOutputBytes:
      started.max_command_output_bytes === undefined
        ? undefined
        : String(started.max_command_output_bytes),
    maxSteps: String(started.max_steps),
    maxTokens: String(started.max_tokens),
    maxToolOutputBytes: String(started.max_tool_output_bytes),
    mcpServerIds: started.mcp_servers ?? [],
    ...(policy.inputSurface === undefined
      ? {}
      : { inputSurface: policy.inputSurface }),
    mode: selectedMode,
    ...(policy.modeSource === undefined
      ? {}
      : { modeSource: policy.modeSource }),
    model: started.model,
    policyConfig: policy.policyConfig,
    policyProfile: policy.policyProfile,
    provider: started.provider,
    providerSource: started.provider_source,
    reportFormat: started.report_format,
    requireVerification: started.require_verification,
    requestTimeoutMs: String(started.request_timeout_ms),
    sandboxCpus:
      started.docker_sandbox === undefined
        ? undefined
        : String(started.docker_sandbox.limits.cpus),
    sandboxMemoryMiB:
      started.docker_sandbox === undefined
        ? undefined
        : String(started.docker_sandbox.limits.memory_mib),
    sandboxPids:
      started.docker_sandbox === undefined
        ? undefined
        : String(started.docker_sandbox.limits.pids),
    sandboxTmpMiB:
      started.docker_sandbox === undefined
        ? undefined
        : String(started.docker_sandbox.limits.tmp_mib),
    task,
    taskProfile:
      selectedMode === "plan"
        ? "read-only"
        : selectedMode === "build"
          ? "coding"
          : started.task_profile ?? "read-only",
    ...(policy.continueApprovedPlan === undefined
      ? {}
      : { continueApprovedPlan: policy.continueApprovedPlan }),
    verbose: false,
  };
}

function canonicalResumePrompt(
  session: ReconstructedMultiRunSession,
  message: string | undefined,
  runtime: CliRuntime,
): string | undefined {
  const transcript = buildCanonicalTranscript(session.events);
  const continuation =
    message === undefined
      ? "Continue the original task from these persisted facts."
      : `New user message: ${message}`;
  const prompt = redact(
    runtime,
    [
      "This is an explicitly approved canonical-degraded resume.",
      "Provider-private reasoning and continuation state were not restored.",
      continuation,
      "Persisted canonical facts (JSON):",
      JSON.stringify(transcript),
    ].join("\n"),
  );
  return Buffer.byteLength(prompt, "utf8") <= MAX_RESUME_PROMPT_BYTES
    ? prompt
    : undefined;
}

function createBackend(
  options: AgentCommandOptions,
  runtime: CliRuntime,
  effectivePolicy: EffectiveRuntimePolicy,
): { readonly backend: ModelBackend; readonly options: AgentCommandOptions } | string {
  let request;
  try {
    request = resolveProviderPolicyRequest(effectivePolicy, {
      endpoint:
        options.provider === "ollama" || options.provider === undefined
          ? runtime.env.BORN_OLLAMA_BASE_URL
          : undefined,
      model: options.model,
      provider: options.provider,
      ...(options.providerSource === undefined
        ? {}
        : { source: options.providerSource }),
    });
  } catch (error) {
    return error instanceof Error ? error.message : "runtime policy preflight failed";
  }
  const normalized = {
    ...options,
    model: request.model,
    provider: request.provider,
  };
  const config = resolveAgentConfig(normalized, {
    ...runtime.env,
    ...(request.provider === "ollama"
      ? { BORN_OLLAMA_BASE_URL: request.endpoint }
      : {}),
  });
  if (!config.ok) return config.error;
  try {
    const backend = runtime.createModelBackend({
      ...(config.value.ollamaBaseURL === undefined
        ? {}
        : { endpoint: config.value.ollamaBaseURL }),
      model: config.value.model,
      provider: config.value.provider,
      runtimePolicy: effectivePolicy,
      requirement: {
        cancellation: true,
        completeUsageForReportedTokenCeiling: true,
        streaming: true,
        tools: true,
      },
    });
    return { backend, options: normalized };
  } catch (error) {
    return error instanceof Error ? error.message : "backend preflight failed";
  }
}

function resumePolicyMismatch(
  started: ReconstructedRunProjection["started"]["data"],
  effectivePolicy: EffectiveRuntimePolicy,
): string | undefined {
  const persisted = started.runtime_policy;
  if (persisted === undefined) {
    // PHASE15: legacy sessions had no policy evidence. Only an Ollama run may
    // migrate to the built-in local-free profile; policy-less remote history
    // cannot acquire remote authority during resume.
    return effectivePolicy.entry.profile.id === "local-free-v1" &&
      effectivePolicy.entry.profile.mode === "local_free" &&
      started.provider === "ollama"
      ? undefined
      : "legacy session has no exact runtime policy evidence";
  }
  if (
    persisted.profile_id !== effectivePolicy.entry.profile.id ||
    persisted.profile_mode !== effectivePolicy.entry.profile.mode ||
    persisted.profile_sha256 !== effectivePolicy.entry.profileSha256
  ) {
    return "session runtime policy profile ID/mode/hash does not exact-match";
  }
  return undefined;
}

function blockedResumeMessage(plan: BlockedResumePlan): string {
  const reason = plan.reasons[0];
  if (reason === "pending_command_effect_unknown") {
    return "command effect is unknown and will not be rerun";
  }
  if (reason === "pending_mcp_effect_unknown") {
    return "MCP process or tool-call effect is unknown and will not be reused or rerun";
  }
  if (reason === "degraded_resume_requires_confirmation") {
    return "canonical resume requires --allow-degraded-resume; no model was called";
  }
  if (reason === "pending_patch_ambiguous") {
    return "patch effect is ambiguous and requires reconciliation";
  }
  if (reason === "workspace_root_mismatch") {
    return "session workspace does not match the current workspace";
  }
  return `${plan.reasons.join(", ")}: ${plan.details.join(", ")}`;
}

function approvalExpiries(session: ReconstructedMultiRunSession): readonly {
  readonly approvalRequestId: string;
  readonly sourceRunId: string;
}[] {
  const expired = new Set(
    session.sessionEvents
      .filter((event) => event.type === "approval.expired")
      .map((event) => event.data.approval_request_id),
  );
  return session.runs.flatMap((run) =>
    run.events.flatMap((event) =>
      event.type === "approval.requested" &&
      !expired.has(event.data.approval_request_id)
        ? [
            {
              approvalRequestId: event.data.approval_request_id,
              sourceRunId: run.runId,
            },
          ]
        : [],
    ),
  );
}

function allocateRunId(
  session: ReconstructedMultiRunSession,
  runtime: CliRuntime,
): string | undefined {
  const used = new Set(session.runs.map(({ runId }) => runId));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = runtime.randomUUID();
    if (candidate !== session.sessionId && !used.has(candidate)) return candidate;
  }
  return undefined;
}

export async function executeSessionsResume(
  options: SessionsResumeOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    assertCanonicalSessionId(options.sessionId);
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : "invalid session id");
  }
  let effectivePolicy: EffectiveRuntimePolicy;
  try {
    effectivePolicy = resolveEffectiveRuntimePolicy(
      await loadRuntimePolicyRegistry({
        ...(options.policyConfig === undefined
          ? {}
          : { configPath: options.policyConfig }),
        env: runtime.env,
        platform: runtime.platform,
        workspace: runtime.cwd,
      }),
      options.policyProfile,
    );
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    return dataError(io, "runtime policy could not be loaded");
  }
  let writer: V2SessionWriter | undefined;
  try {
    writer = await V2SessionWriter.openExisting(runtime.cwd, options.sessionId);
    runtime.observeSessionWriter?.(writer);
    let session = reconstructMultiRunSession(writer.events);
    if (
      options.expectedSessionSeq !== undefined &&
      session.taskState.lastSessionSeq !== options.expectedSessionSeq
    ) {
      return usageError(
        io,
        `stale_snapshot: expected session sequence ${String(options.expectedSessionSeq)}, current ${String(session.taskState.lastSessionSeq)}`,
      );
    }
    let lastRun = session.lastRun;
    if (lastRun === null) {
      return usageError(
        io,
        "idle Phase 16 task has no historical run to resume; start an explicit run instead",
      );
    }
    const reconcileActiveGoalChanges = async (): Promise<number> => {
      const active = session.taskState.goals.find(
        (goal) => goal.content.goalId === session.taskState.activeGoalId,
      );
      if (active === undefined) return 0;
      const result = await new GoalChangeRecordReconciler({
        goalId: active.content.goalId,
        goalRevision: active.content.revision,
        randomUUID: runtime.randomUUID,
        workspace: runtime.cwd,
        writer: writer!,
      }).reconcile();
      if (result.recovered > 0) {
        session = reconstructMultiRunSession(writer!.events);
        lastRun = session.lastRun;
      }
      return result.recovered;
    };
    await reconcileActiveGoalChanges();
    const completionRecovery = await new CompletionTransitionReconciler({
      randomUUID: runtime.randomUUID,
      timestamp: runtime.timestamp,
      workspace: runtime.cwd,
      writer,
    }).reconcile();
    if (completionRecovery.status === "completed") {
      io.stdout.write(`Session: ${session.sessionId}\n`);
      io.stdout.write(`Recovered run: ${completionRecovery.runId}\n`);
      io.stdout.write(
        `Completion recovery: ${completionRecovery.appendedEventTypes.join(", ")}\n`,
      );
      return 0;
    }
    const modeResult =
      options.mode === undefined
        ? undefined
        : agentModeSchema.safeParse(options.mode);
    if (modeResult !== undefined && !modeResult.success) {
      return usageError(io, "agent mode must be plan or build");
    }
    const continuationFieldsPresent =
      options.continueApprovedPlan === true ||
      options.planRevision !== undefined ||
      options.planSha256 !== undefined;
    if (
      continuationFieldsPresent &&
      !(
        options.continueApprovedPlan === true &&
        options.planRevision !== undefined &&
        options.planSha256 !== undefined
      )
    ) {
      return usageError(
        io,
        "--continue-approved-plan requires --plan-revision and --plan-sha256",
      );
    }
    let continueApprovedPlan:
      | AgentCommandOptions["continueApprovedPlan"]
      | undefined;
    if (continuationFieldsPresent) {
      if (!/^[1-9]\d*$/u.test(options.planRevision ?? "")) {
        return usageError(io, "plan revision must be a positive integer");
      }
      if (!/^[a-f0-9]{64}$/u.test(options.planSha256 ?? "")) {
        return usageError(io, "plan SHA-256 must be lowercase hexadecimal");
      }
      const current = session.taskState.currentApprovedPlan;
      if (
        current === null ||
        current.revision !== Number(options.planRevision) ||
        current.planSha256 !== options.planSha256
      ) {
        return usageError(io, "approved Plan continuation identity is stale");
      }
      continueApprovedPlan = current;
    }
    const mismatch = resumePolicyMismatch(lastRun.started.data, effectivePolicy);
    if (mismatch !== undefined) return usageError(io, mismatch);
    const pendingContainers = countPendingContainerLifecycles(lastRun.events);
    if (pendingContainers > 0) {
      if (runtime.reconcileDockerContainers === undefined || writer.appendRunEvent === undefined) {
        return usageError(
          io,
          "Docker container cleanup is unknown and this runtime cannot reconcile it",
        );
      }
      const reconciled = await runtime.reconcileDockerContainers({
        appender: {
          append: (runId, type, data) => writer!.appendRunEvent!(runId, type, data).then(() => undefined),
        },
        events: lastRun.events,
      });
      if (reconciled.blocked.length > 0) {
        return usageError(
          io,
          `Docker container cleanup remains unknown: ${reconciled.blocked[0]}`,
        );
      }
      session = reconstructMultiRunSession(writer.events);
      lastRun = session.lastRun;
      if (lastRun === null) {
        return dataError(io, "reconciled session unexpectedly lost its last run");
      }
    }
    const historicalBackend = lastBackend(lastRun);
    if (historicalBackend?.data.resume_capability === undefined) {
      return usageError(
        io,
        "session does not declare a supported resume capability",
      );
    }
    if (
      historicalBackend.data.resume_capability === "canonical_only" &&
      !options.allowDegradedResume
    ) {
      // PHASE9: known canonical-only history can enforce explicit degradation
      // before backend/credential construction. The full planner repeats this
      // decision after current identity and fingerprint verification.
      return usageError(
        io,
        "canonical resume requires --allow-degraded-resume; no model was called",
      );
    }
    const userTurn = redact(
      runtime,
      options.message?.trim() ?? lastRun.started.data.input.text,
    );
    const agentOptions = historicalAgentOptions(session, userTurn, {
      ...(options.inputSurface === undefined
        ? {}
        : { inputSurface: options.inputSurface }),
      mode: options.mode,
      ...(options.modeSource === undefined
        ? {}
        : { modeSource: options.modeSource }),
      policyConfig: options.policyConfig,
      policyProfile: options.policyProfile,
      ...(continueApprovedPlan === undefined
        ? {}
        : { continueApprovedPlan }),
    });
    if (agentOptions === undefined) {
      return usageError(io, "chat sessions are not resumable by the Phase 9 agent CLI");
    }

    const ledger = mergeMcpPendingEffects(
      reconstructPendingEffectLedger(legacyDomainEvents(session, lastRun)),
      lastRun.events,
    );
    const allocatedRunId = allocateRunId(session, runtime);
    if (allocatedRunId === undefined) {
      return dataError(io, "could not allocate a unique run id");
    }
    const planner = new ResumePlanner({ createRunId: () => allocatedRunId });
    const effectPreflight = planner.preflightPendingEffects({
      ledger,
      sessionId: session.sessionId,
      sourceRunId: lastRun.runId,
    });
    if (effectPreflight?.status === "blocked") {
      return usageError(io, blockedResumeMessage(effectPreflight));
    }

    const persistedFingerprint = lastRun.started.data.workspace_resume_fingerprint;
    if (persistedFingerprint === undefined) {
      return usageError(io, "session has no resumable workspace fingerprint");
    }
    const expectedFingerprint = restoreWorkspaceResumeFingerprint(
      persistedFingerprint,
    );
    if (
      lastRun.started.data.workspace_fingerprint !==
      workspaceResumeFingerprintSha256(expectedFingerprint)
    ) {
      return dataError(io, "persisted workspace fingerprint hash does not match");
    }

    const patchReconciliations: PatchReconciliation[] = [];
    if (ledger.pendingPatches.length > 0) {
      const reader = await WorkspacePatchObservationReader.create(runtime.cwd, {
        caseInsensitive: runtime.platform === "win32",
      });
      for (const pendingPatch of ledger.pendingPatches) {
        patchReconciliations.push(
          await reconcilePendingPatchFromReader(pendingPatch, reader),
        );
      }
    }

    for (const reconciliation of patchReconciliations) {
      if (reconciliation.status !== "reconciled") continue;
      await writer.appendSessionEvent("side_effect.reconciled", {
        effect_id: reconciliation.planId,
        effect_kind: "patch",
        evidence_sha256: sha256Canonical(reconciliation),
        observed: reconciliation.observed,
        source_run_id: lastRun.runId,
      });
    }
    if (patchReconciliations.length > 0) {
      session = reconstructMultiRunSession(writer.events);
      lastRun = session.lastRun;
      if (lastRun === null) {
        return dataError(io, "patch reconciliation lost the source run");
      }
      await reconcileActiveGoalChanges();
    }

    const selected = createBackend(agentOptions, runtime, effectivePolicy);
    if (typeof selected === "string") {
      return usageError(io, redact(runtime, selected));
    }
    const config = resolveAgentConfig(agentOptions, runtime.env);
    if (!config.ok) return usageError(io, config.error);
    const currentCapabilitySnapshot = runtime.createCapabilityPlatform === undefined
      ? undefined
      : await runtime
          .createCapabilityPlatform(runtime.cwd)
          .createSnapshot(runtime.timestamp());
    const currentFingerprint = await buildWorkspaceResumeFingerprint({
      ...(agentOptions.mode === undefined
        ? {}
        : { agentMode: agentModeSchema.parse(agentOptions.mode) }),
      backend: selected.backend,
      ...(currentCapabilitySnapshot === undefined
        ? {}
        : {
            capabilitySnapshotSha256:
              currentCapabilitySnapshot.snapshotSha256,
          }),
      config: config.value,
      platform: runtime.platform,
      workspace: runtime.cwd,
    });
    const checkpointStore = await (
      runtime.createCheckpointStore ?? CheckpointStore.create
    )(runtime.cwd);
    const backendResume = await new BackendResumeProjectionBuilder(
      checkpointStore,
    ).build({ backend: selected.backend, events: lastRun.events });
    const plan = planner.plan({
      allowDegradedResume: options.allowDegradedResume,
      ...(continueApprovedPlan === undefined
        ? {}
        : { approvedPlanContinuation: true }),
      backend: backendResume.projection,
      currentFingerprint,
      expectedFingerprint,
      ledger,
      ...(options.message?.trim()
        ? { message: options.message.trim() }
        : {}),
      patchReconciliations,
      sessionId: session.sessionId,
      sourceRunId: lastRun.runId,
      sourceRunState: lastRun.status,
    });
    if (plan.status === "blocked") {
      return usageError(io, blockedResumeMessage(plan));
    }

    const prompt =
      plan.mode === "canonical_degraded"
        ? canonicalResumePrompt(
            session,
            options.message?.trim() || undefined,
            runtime,
          )
        : redact(
            runtime,
            options.message?.trim() || "Continue the original task from the exact checkpoint.",
          );
    if (prompt === undefined) {
      return usageError(io, "canonical transcript exceeds the safe resume prompt bound");
    }

    await writer.appendSessionEvent("session.resume.requested", {
      ...(options.message?.trim()
        ? { message: redact(runtime, options.message.trim()) }
        : {}),
      requested_mode: plan.mode,
      source_run_id: lastRun.runId,
    });
    const expiries = new Map(
      approvalExpiries(session).map((expiry) => [
        expiry.approvalRequestId,
        expiry,
      ]),
    );
    for (const expiry of plan.approvalsToExpire) {
      expiries.set(expiry.approvalRequestId, {
        approvalRequestId: expiry.approvalRequestId,
        sourceRunId: expiry.sourceRunId,
      });
    }
    for (const expiry of expiries.values()) {
      await writer.appendSessionEvent("approval.expired", {
        approval_request_id: expiry.approvalRequestId,
        reason: "new_run_requires_new_authority",
        source_run_id: expiry.sourceRunId,
      });
    }

    // PHASE9: the planner/persistence steps above invoke no provider or tool.
    // Only after the request and approval expiries are durable do we hand the
    // existing locked writer to a fresh run with reset run-local budgets.
    const handedWriter = writer;
    writer = undefined;
    io.stdout.write(`Session: ${session.sessionId}\n`);
    io.stdout.write(`Previous run: ${lastRun.status}\n`);
    io.stdout.write(`Resume mode: ${plan.mode}\n`);
    io.stdout.write(`New run: ${plan.newRunId}\n`);
    io.stdout.write(
      `Pending effects: ${plan.inheritedPendingCall === null ? "none" : "adopted"}\n`,
    );
    return await executeAgent(selected.options, runtime, io, {
      backend: selected.backend,
      ...(currentCapabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: currentCapabilitySnapshot }),
      continuation: backendResume.continuation,
      fingerprint: currentFingerprint,
      inheritedCall:
        plan.inheritedPendingCall === null ||
        backendResume.continuation === null ||
        backendResume.projection.checkpoint === null
          ? null
          : {
              argumentsJson: plan.inheritedPendingCall.argumentsJson,
              callId: plan.inheritedPendingCall.callId,
              checkpointId:
                backendResume.projection.checkpoint.checkpointId,
              continuation: backendResume.continuation,
              providerResponseId:
                plan.inheritedPendingCall.providerResponseId,
              recovered: plan.recoveredToolObservation,
              sourceRunId: plan.inheritedPendingCall.sourceRunId,
              step: plan.inheritedPendingCall.step,
              toolName: plan.inheritedPendingCall.toolName,
            },
      mode: plan.mode,
      modelTask: prompt,
      runId: plan.newRunId,
      sessionId: session.sessionId,
      sourceRunId: lastRun.runId,
      writer: handedWriter,
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return usageError(io, "session was not found");
    }
    if (error instanceof SessionLockError || error instanceof SessionPathError) {
      return usageError(io, error.message);
    }
    if (error instanceof BackendPreflightError) {
      return usageError(io, error.message);
    }
    if (error instanceof CapabilityError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    return dataError(io, error instanceof Error ? error.message : "resume failed");
  } finally {
    await writer?.close().catch(() => undefined);
  }
}
