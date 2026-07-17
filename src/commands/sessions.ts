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
import { reconstructPendingEffectLedger } from "../resume/pending-effect-ledger.js";
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
  readonly message: string | undefined;
  readonly sessionId: string;
}

function secrets(runtime: CliRuntime): readonly (string | undefined)[] {
  return [runtime.env.OPENAI_API_KEY, runtime.env.ANTHROPIC_API_KEY];
}

function redact(runtime: CliRuntime, value: string): string {
  return redactSensitiveText(value, secrets(runtime));
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
        lastRunId: session.lastRun.runId,
        model: session.lastRun.started.data.model,
        provider: session.lastRun.started.data.provider,
        runs: session.runs.length,
        schemaVersion: 1,
        sessionId: session.sessionId,
        status: session.status,
      });
      return 0;
    }
    io.stdout.write(`Session: ${session.sessionId}\n`);
    io.stdout.write(`Last run: ${session.lastRun.runId}\n`);
    io.stdout.write(`Status: ${session.status}\n`);
    io.stdout.write(
      `Backend: ${session.lastRun.started.data.provider}/${session.lastRun.started.data.model}\n`,
    );
    io.stdout.write(
      `Artifacts: ${session.artifacts.storedReferenceCount} references, ${session.artifacts.objects.length} objects, ${session.artifacts.budgetUsage.sessionBytes ?? 0} captured bytes, ${session.artifacts.truncatedCaptureEventCount} truncated\n`,
    );
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
  "artifact.capture.truncated",
  "artifact.stored",
  "backend.canonical_boundary.created",
  "backend.checkpoint.created",
  "context.compaction.failed",
  "context.compaction.started",
  "context.estimate.created",
  "context.plan.created",
  "model.request.encoded",
  "repository.rules.changed",
  "repository.rules.loaded",
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
        data: event.data,
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
): AgentCommandOptions | undefined {
  const started = session.lastRun.started.data;
  if (started.command !== "agent") return undefined;
  return {
    commandApproval: started.command_approval,
    commandTimeoutMs:
      started.command_timeout_ms === undefined
        ? undefined
        : String(started.command_timeout_ms),
    completionPolicy: started.completion_policy,
    editApproval: started.edit_approval,
    maxDurationMs: String(started.max_duration_ms),
    maxCommandOutputBytes:
      started.max_command_output_bytes === undefined
        ? undefined
        : String(started.max_command_output_bytes),
    maxSteps: String(started.max_steps),
    maxTokens: String(started.max_tokens),
    maxToolOutputBytes: String(started.max_tool_output_bytes),
    model: started.model,
    provider: started.provider,
    reportFormat: started.report_format,
    requireVerification: started.require_verification,
    requestTimeoutMs: String(started.request_timeout_ms),
    task,
    taskProfile: started.task_profile ?? "read-only",
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
): { readonly backend: ModelBackend; readonly options: AgentCommandOptions } | string {
  const config = resolveAgentConfig(options, runtime.env);
  if (!config.ok) return config.error;
  try {
    const backend = runtime.createModelBackend({
      ...(config.value.ollamaBaseURL === undefined
        ? {}
        : { endpoint: config.value.ollamaBaseURL }),
      model: config.value.model,
      provider: config.value.provider,
      requirement: {
        cancellation: true,
        completeUsageForReportedTokenCeiling: true,
        streaming: true,
        tools: true,
      },
    });
    return { backend, options };
  } catch (error) {
    return error instanceof Error ? error.message : "backend preflight failed";
  }
}

function blockedResumeMessage(plan: BlockedResumePlan): string {
  const reason = plan.reasons[0];
  if (reason === "pending_command_effect_unknown") {
    return "command effect is unknown and will not be rerun";
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
  let writer: V2SessionWriter | undefined;
  try {
    writer = await V2SessionWriter.openExisting(runtime.cwd, options.sessionId);
    runtime.observeSessionWriter?.(writer);
    const session = reconstructMultiRunSession(writer.events);
    const lastRun = session.lastRun;
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
    const agentOptions = historicalAgentOptions(session, userTurn);
    if (agentOptions === undefined) {
      return usageError(io, "chat sessions are not resumable by the Phase 9 agent CLI");
    }

    const ledger = reconstructPendingEffectLedger(
      legacyDomainEvents(session, lastRun),
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

    const selected = createBackend(agentOptions, runtime);
    if (typeof selected === "string") {
      return usageError(io, redact(runtime, selected));
    }
    const config = resolveAgentConfig(agentOptions, runtime.env);
    if (!config.ok) return usageError(io, config.error);
    const currentFingerprint = await buildWorkspaceResumeFingerprint({
      backend: selected.backend,
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
    return dataError(io, error instanceof Error ? error.message : "resume failed");
  } finally {
    await writer?.close().catch(() => undefined);
  }
}
