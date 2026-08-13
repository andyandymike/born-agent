import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AgentExitCode } from "../../agent/agent-types.js";
import type { CliIO, CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { decodeStoredEvents, type DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { SessionPathPolicy } from "../../sessions/session-path-policy.js";
import { parseStrictJson } from "../../system/strict-json.js";
import type { ApplicationEnvelopeV1 } from "../application-protocol.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import { loadExistingHostControlAuthority } from "../host-control-identity.js";
import { SessionLedgerHeadSigner } from "../session-ledger-head.js";
import type {
  SessionResumeOwnerCommitV1,
  SessionResumeOwnerPortV1,
  SessionResumeOwnerResultV1,
} from "../use-cases/session-resume-action.js";
import {
  adoptLegacySessionThroughApplicationService,
  commitCliApplicationActionWithTypedCancellation,
  contextForRuntime,
  planeForRuntime,
  registerCurrentRepository,
} from "./agent-cli-adapter.js";
import {
  preparedReviewFailure,
  reviewPreparedApplicationAction,
} from "./prepared-action-reviewer.js";

const TERMINALS = new Set<SessionResumeOwnerResultV1["terminal"]>([
  "run.budget_exceeded",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.incomplete",
]);

class SessionResumeOwnerError extends Error {
  constructor(readonly code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SessionResumeOwnerError";
  }
}

export type SessionResumeOwnerDispatchV1 = (
  input: Parameters<SessionResumeOwnerPortV1["execute"]>[0],
) => Promise<number>;

interface AppendOnlyEvidenceV1 {
  readonly events: readonly DecodedStoredEvent[];
  readonly rawSha256: ReadonlyMap<string, string>;
}

async function readAppendOnlyEvidence(workspace: string, sessionId: string): Promise<AppendOnlyEvidenceV1> {
  const path = (await (await SessionPathPolicy.create(workspace)).inspectExistingSession(sessionId)).sessionFilePath;
  const before = await readFile(path);
  if (before.byteLength === 0 || before.at(-1) !== 0x0a) {
    throw new SessionResumeOwnerError("resume_effect_reconciliation_required", "resume session evidence has an incomplete durable tail");
  }
  const after = await readFile(path);
  if (!before.equals(after)) {
    throw new SessionResumeOwnerError("resume_owner_active", "resume session changed during stable evidence read");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
  const lines = text.slice(0, -1).split("\n");
  const events = decodeStoredEvents(lines.map((line) => parseStrictJson(line)));
  const rawSha256 = new Map<string, string>();
  events.forEach((event, index) => {
    const line = lines[index];
    if (line === undefined || event.sessionSeq !== index + 1) {
      throw new SessionResumeOwnerError("resume_effect_reconciliation_required", "resume evidence sequence is inconsistent");
    }
    rawSha256.set(event.eventId, createHash("sha256").update(line, "utf8").digest("hex"));
  });
  return Object.freeze({ events, rawSha256 });
}

function exactApplicationCommit(
  event: DecodedStoredEvent,
  binding: Parameters<SessionResumeOwnerPortV1["execute"]>[0]["applicationCommit"],
): boolean {
  if (typeof event.data !== "object" || event.data === null) return false;
  const commit = (event.data as Readonly<Record<string, unknown>>).application_commit;
  if (typeof commit !== "object" || commit === null) return false;
  const value = commit as Readonly<Record<string, unknown>>;
  return value.schema_version === 1 &&
    value.action_kind === binding.actionKind &&
    value.authorization_decision_sha256 === binding.authorizationDecisionSha256 &&
    value.operation_id === binding.operationId &&
    value.prepared_action_sha256 === binding.preparedActionSha256 &&
    value.principal_id === binding.principalId;
}

function eventReference(event: DecodedStoredEvent, evidence: AppendOnlyEvidenceV1): DurableRecordReferenceV1 {
  const recordSha256 = evidence.rawSha256.get(event.eventId);
  if (recordSha256 === undefined) {
    throw new SessionResumeOwnerError("resume_effect_reconciliation_required", "resume raw event identity is unavailable");
  }
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session" as const,
    recordId: event.eventId,
    recordSha256,
    sequence: event.sessionSeq,
  });
}

function assertExpectedHead(
  evidence: AppendOnlyEvidenceV1,
  input: Parameters<SessionResumeOwnerPortV1["execute"]>[0],
  signer: SessionLedgerHeadSigner,
): void {
  // PHASE21: seq/event ID is only a public position. Dispatch authority also
  // requires the opaque token to authenticate the exact raw durable tail.
  const tail = evidence.events.at(-1);
  const rawEventSha256 = tail === undefined ? null : evidence.rawSha256.get(tail.eventId) ?? null;
  if (
    evidence.events.length !== input.expectedHead.sequence ||
    tail?.sessionSeq !== input.expectedHead.sequence ||
    tail.eventId !== input.expectedHead.eventId ||
    tail.sessionId !== input.expectedHead.sessionId ||
    !signer.verify(input.expectedHead, rawEventSha256)
  ) {
    throw new SessionResumeOwnerError("resume_stale_projection", "session changed before resume owner dispatch");
  }
}

function assertNoOrphanApplicationResume(evidence: AppendOnlyEvidenceV1): void {
  for (const event of evidence.events) {
    if (event.scope !== "session" || event.type !== "session.resume.requested") continue;
    const data = event.data;
    if (data.application_commit === undefined || data.new_run_id === undefined) continue;
    const started = evidence.events.some((candidate) =>
      candidate.scope === "run" &&
      candidate.type === "run.started" &&
      candidate.runId === data.new_run_id &&
      candidate.sessionSeq > event.sessionSeq &&
      candidate.data.resume_of_run_id === data.source_run_id
    );
    if (!started) {
      throw new SessionResumeOwnerError(
        "resume_request_without_start",
        "an earlier authenticated resume request has no exact owner start; reconcile that operation before retry",
      );
    }
  }
}

function recoveredExitCode(terminal: SessionResumeOwnerResultV1["terminal"]): AgentExitCode {
  if (terminal === "run.completed") return 0;
  if (terminal === "run.cancelled") return 130;
  if (terminal === "run.budget_exceeded" || terminal === "run.incomplete") return 8;
  return 1;
}

function buildCommit(
  evidence: AppendOnlyEvidenceV1,
  input: Parameters<SessionResumeOwnerPortV1["execute"]>[0],
  observedExitCode?: number,
): SessionResumeOwnerCommitV1 {
  const requests = evidence.events.filter((event) =>
    event.scope === "session" &&
    event.type === "session.resume.requested" &&
    event.eventId === input.applicationCommit.operationId &&
    exactApplicationCommit(event, input.applicationCommit)
  );
  if (requests.length !== 1) {
    throw new SessionResumeOwnerError(
      requests.length === 0 ? "resume_request_missing" : "resume_effect_reconciliation_required",
      requests.length === 0
        ? "resume owner returned without its exact durable request"
        : "resume operation has duplicate durable requests",
    );
  }
  const request = requests[0]!;
  if (request.type !== "session.resume.requested") throw new TypeError("resume request narrowed incorrectly");
  const data = request.data;
  if (
    data.application_commit === undefined ||
    data.new_run_id === undefined ||
    data.approval_request_ids === undefined ||
    data.source_run_id !== input.sourceRunId
  ) {
    throw new SessionResumeOwnerError("resume_effect_reconciliation_required", "resume request has no exact application branch binding");
  }
  const approvalExpiries = data.approval_request_ids.map((approvalRequestId) => {
    const matches = evidence.events.filter((event) =>
      event.scope === "session" &&
      event.type === "approval.expired" &&
      event.sessionSeq > request.sessionSeq &&
      event.data.approval_request_id === approvalRequestId &&
      event.data.source_run_id === input.sourceRunId
    );
    if (matches.length !== 1) {
      throw new SessionResumeOwnerError("resume_effect_reconciliation_required", "resume approval expiry evidence is incomplete");
    }
    return matches[0]!;
  }).sort((left, right) => left.sessionSeq - right.sessionSeq);
  const startedMatches = evidence.events.filter((event) =>
    event.scope === "run" &&
    event.type === "run.started" &&
    event.runId === data.new_run_id &&
    event.sessionSeq > (approvalExpiries.at(-1)?.sessionSeq ?? request.sessionSeq) &&
    event.data.resume_of_run_id === input.sourceRunId &&
    exactApplicationCommit(event, input.applicationCommit)
  );
  if (startedMatches.length !== 1) {
    throw new SessionResumeOwnerError(
      startedMatches.length === 0 ? "resume_request_without_start" : "resume_effect_reconciliation_required",
      "durable resume request has no one exact owner start",
    );
  }
  const started = startedMatches[0]!;
  const terminals = evidence.events.filter((event): event is Extract<DecodedStoredEvent, { readonly scope: "run" }> =>
    event.scope === "run" &&
    event.runId === data.new_run_id &&
    event.sessionSeq > started.sessionSeq &&
    TERMINALS.has(event.type as SessionResumeOwnerResultV1["terminal"])
  );
  if (terminals.length !== 1 || !TERMINALS.has(terminals[0]!.type as SessionResumeOwnerResultV1["terminal"])) {
    throw new SessionResumeOwnerError("resume_owner_incomplete", "resumed run has no one exact terminal fact");
  }
  const terminal = terminals[0]!;
  const terminalType = terminal.type as SessionResumeOwnerResultV1["terminal"];
  return Object.freeze({
    applicationOperationId: input.applicationCommit.operationId,
    approvalExpiryReferences: Object.freeze(approvalExpiries.map((event) => eventReference(event, evidence))),
    primaryDomainRecord: eventReference(request, evidence),
    requestEventType: "session.resume.requested",
    result: Object.freeze({
      exitCode: observedExitCode ?? recoveredExitCode(terminalType),
      newRunId: data.new_run_id,
      resumeMode: data.requested_mode,
      sourceRunId: data.source_run_id,
      terminal: terminalType,
    }),
    runStartedEventType: "run.started",
    runStartedReference: eventReference(started, evidence),
    terminalEventType: terminalType,
    terminalReference: eventReference(terminal, evidence),
  });
}

export class CliSessionResumeOwnerPort implements SessionResumeOwnerPortV1 {
  private nonCompositeOwnerExitCode: AgentExitCode | null = null;

  constructor(private readonly options: Readonly<{
    readonly dispatch: SessionResumeOwnerDispatchV1;
    readonly runtime: CliRuntime;
  }>) {}

  takeNonCompositeOwnerExitCode(): AgentExitCode | null {
    const exitCode = this.nonCompositeOwnerExitCode;
    this.nonCompositeOwnerExitCode = null;
    return exitCode;
  }

  async execute(input: Parameters<SessionResumeOwnerPortV1["execute"]>[0]): Promise<SessionResumeOwnerCommitV1> {
    this.nonCompositeOwnerExitCode = null;
    const before = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    const prior = before.events.some((event) =>
      event.type === "session.resume.requested" && exactApplicationCommit(event, input.applicationCommit)
    );
    if (prior) return buildCommit(before, input);
    assertNoOrphanApplicationResume(before);
    if (this.options.runtime.controlPlaneStateRoot === undefined) {
      throw new SessionResumeOwnerError("resume_stale_projection", "resume owner has no Host control authority");
    }
    const authority = await loadExistingHostControlAuthority({ root: this.options.runtime.controlPlaneStateRoot });
    assertExpectedHead(before, input, new SessionLedgerHeadSigner(authority.integrityKey));
    const exitCode = await this.options.dispatch(input);
    const after = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    if (!after.events.some((event) =>
      event.type === "session.resume.requested" && exactApplicationCommit(event, input.applicationCommit)
    )) {
      // Phase 9 can return a fully rendered validation/recovery outcome before
      // it owns a resume request. Preserve that surface result, while the
      // ApplicationService still fails closed because no composite predicate
      // exists and therefore cannot claim a resume completed.
      if ([0, 1, 2, 3, 4, 5, 6, 7, 8, 130].includes(exitCode)) {
        this.nonCompositeOwnerExitCode = exitCode as AgentExitCode;
      }
    }
    return buildCommit(after, input, exitCode);
  }
}

export interface SessionResumeApplicationOptionsV1 {
  readonly allowDegradedResume: boolean;
  readonly continueApprovedPlan?: boolean | undefined;
  readonly expectedSessionSeq?: number | undefined;
  readonly inputSurface?: "cli" | "tui";
  readonly message: string | undefined;
  readonly mode?: string | undefined;
  readonly modeSource?: "explicit_cli" | "explicit_tui" | "tui_default";
  readonly planRevision?: string | undefined;
  readonly planSha256?: string | undefined;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly sessionId: string;
}

export interface SessionResumeApplicationDiagnosticV1 {
  readonly code: string;
  readonly message: string;
}

/**
 * Surface-neutral result of the authenticated resume composite. Presentation
 * adapters may render `diagnostic`, but do not need to infer authority or
 * failure semantics from CLI text.
 */
export interface SessionResumeApplicationResultV1 {
  readonly diagnostic: SessionResumeApplicationDiagnosticV1 | null;
  readonly envelope: ApplicationEnvelopeV1<SessionResumeOwnerResultV1>;
  readonly exitCode: AgentExitCode;
}

function failureExit(envelope: ApplicationEnvelopeV1<unknown>): AgentExitCode {
  const code = envelope.error?.code ?? "control_operation_corrupt";
  if (["control_operation_busy", "control_resync_required", "control_stale_projection"].includes(code)) return 8;
  if (["control_authentication_failed", "control_authorization_denied", "control_payload_invalid", "control_session_not_started", "control_target_invalid", "control_unknown_action"].includes(code)) return 2;
  return 1;
}

function applicationResult(
  envelope: ApplicationEnvelopeV1<SessionResumeOwnerResultV1>,
  exitCode: AgentExitCode = failureExit(envelope),
  diagnostic: SessionResumeApplicationDiagnosticV1 | null = envelope.error ?? Object.freeze({
    code: "control_operation_corrupt",
    message: "application control failed without a typed error",
  }),
): SessionResumeApplicationResultV1 {
  return Object.freeze({ diagnostic, envelope, exitCode });
}

function payloadFromOptions(options: SessionResumeApplicationOptionsV1): unknown {
  const modeSelection = options.mode === undefined
    ? undefined
    : options.modeSource === "tui_default" ? "surface_default" : "explicit";
  return Object.freeze(Object.fromEntries(Object.entries({
    allowDegradedResume: options.allowDegradedResume,
    continueApprovedPlan: options.continueApprovedPlan === true ? true : undefined,
    message: options.message?.trim() || undefined,
    mode: options.mode,
    modeSelection,
    planRevision: options.planRevision,
    planSha256: options.planSha256,
    policyConfig: options.policyConfig,
    policyProfile: options.policyProfile,
  }).filter((entry) => entry[1] !== undefined)));
}

export async function executeSessionResumeThroughApplicationServiceResult(
  options: SessionResumeApplicationOptionsV1,
  runtime: CliRuntime,
  io: CliIO,
  owner: SessionResumeOwnerPortV1,
): Promise<SessionResumeApplicationResultV1> {
  if (runtime.controlPlaneStateRoot === undefined) {
    throw new TypeError("session resume application adapter requires a Host control state root");
  }
  const plane = await planeForRuntime(runtime, io, owner);
  const surface = options.inputSurface ?? "cli";
  const context = contextForRuntime(plane, runtime, surface);
  const repository = await registerCurrentRepository(plane, context, runtime, io);
  if (!("repositoryId" in repository)) {
    return applicationResult(repository as unknown as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>);
  }
  const adopted = await adoptLegacySessionThroughApplicationService(
    plane,
    context,
    runtime,
    repository.repositoryId,
    options.sessionId,
    io,
  );
  if ("status" in adopted) {
    return applicationResult(adopted as unknown as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>);
  }
  const snapshot = await plane.sessionProjection.read({
    repositoryId: repository.repositoryId,
    requestedHead: null,
    sessionId: options.sessionId,
  });
  if (
    options.expectedSessionSeq !== undefined &&
    snapshot.head.publicHead.sequence !== options.expectedSessionSeq
  ) {
    const diagnostic = Object.freeze({
      code: "control_stale_projection",
      message: `expected session sequence ${String(options.expectedSessionSeq)}, current ${String(snapshot.head.publicHead.sequence)}`,
    });
    return applicationResult(Object.freeze({
      deliveryCursor: null,
      error: diagnostic,
      ledgerHead: snapshot.head.publicHead,
      liveObservation: null,
      operationId: null,
      projectionIdentity: snapshot.projection.identity,
      requestId: runtime.randomUUID(),
      resourceScope: snapshot.resourceScope,
      resourceVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" as const },
      result: null,
      schemaVersion: 1 as const,
      sessionId: options.sessionId,
      status: "rejected" as const,
      warnings: Object.freeze([]),
    }), 2, diagnostic);
  }
  const payload = payloadFromOptions(options);
  const semantic = sha256Canonical({
    action_kind: "session.resume",
    payload,
    resource_scope: snapshot.resourceScope,
    resource_version: snapshot.head.publicHead,
    schema_version: 1,
  });
  const prepared = await plane.actions.prepare(context, {
    actionKind: "session.resume",
    payload,
    payloadSha256: sha256Canonical(payload),
    prepareIdempotencyKey: surface === "tui"
      ? `session.resume.prepare.v1.${runtime.randomUUID()}`
      : `session.resume.prepare.v1.${semantic}`,
    requestId: runtime.randomUUID(),
    schemaVersion: 1,
    target: {
      expectedVersion: { head: snapshot.head.publicHead, kind: "session_ledger_head" },
      kind: "existing_resource",
      resourceScope: snapshot.resourceScope,
    },
  });
  if (prepared.status !== "ok" || prepared.result === null) {
    return applicationResult(prepared as unknown as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>);
  }
  const reviewDecision = await reviewPreparedApplicationAction({
    io,
    prepared: prepared.result,
    runtime,
    surface,
  });
  if (reviewDecision !== "confirmed") {
    const failure = preparedReviewFailure(reviewDecision);
    return applicationResult(Object.freeze({
      ...prepared,
      error: Object.freeze({ code: failure.code, message: failure.message }),
      result: null,
      status: "rejected" as const,
    }) as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>, failure.exitCode, failure);
  }
  if (Date.parse(prepared.result.prepared.expiresAt) <= Date.parse(runtime.timestamp())) {
    const failure = preparedReviewFailure("expired");
    return applicationResult(Object.freeze({
      ...prepared,
      error: Object.freeze({ code: failure.code, message: failure.message }),
      result: null,
      status: "rejected" as const,
    }) as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>, failure.exitCode, failure);
  }
  const current = await plane.sessionProjection.read({
    repositoryId: repository.repositoryId,
    requestedHead: null,
    sessionId: options.sessionId,
  });
  if (sha256Canonical(current.head.publicHead) !== sha256Canonical(snapshot.head.publicHead)) {
    const failure = preparedReviewFailure("stale");
    return applicationResult(Object.freeze({
      ...prepared,
      error: Object.freeze({ code: failure.code, message: failure.message }),
      ledgerHead: current.head.publicHead,
      projectionIdentity: current.projection.identity,
      resourceVersion: { head: current.head.publicHead, kind: "session_ledger_head" as const },
      result: null,
      status: "rejected" as const,
    }) as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>, failure.exitCode, failure);
  }
  const commitRequest = Object.freeze({
    idempotencyKey: `session.resume.commit.v1.${semantic}`,
    preparedActionId: prepared.result.prepared.preparedActionId,
    preparedActionSha256: prepared.result.prepared.preparedActionSha256,
    requestId: runtime.randomUUID(),
  });
  const committed = surface === "cli"
    ? await commitCliApplicationActionWithTypedCancellation({
        actionKind: "session.resume",
        context,
        io,
        plane,
        repositoryId: repository.repositoryId,
        runtime,
        sessionId: options.sessionId,
        ...commitRequest,
      })
    : await plane.actions.commit(context, {
        ...commitRequest,
        schemaVersion: 1,
      });
  if (committed.status !== "ok" || committed.result === null) {
    const ownerExitCode = owner instanceof CliSessionResumeOwnerPort
      ? owner.takeNonCompositeOwnerExitCode()
      : null;
    const envelope = committed as unknown as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>;
    return ownerExitCode === null
      ? applicationResult(envelope)
      : applicationResult(envelope, ownerExitCode, Object.freeze({
          code: "session_resume_owner_rejected",
          message: "the Phase 9 resume owner rejected the request before acquiring durable resume authority",
        }));
  }
  const result = committed.result as Readonly<{ readonly exitCode?: unknown }>;
  const envelope = committed as unknown as ApplicationEnvelopeV1<SessionResumeOwnerResultV1>;
  if (typeof result.exitCode === "number" && [0, 1, 2, 3, 4, 5, 6, 7, 8, 130].includes(result.exitCode)) {
    return applicationResult(envelope, result.exitCode as AgentExitCode, null);
  }
  return applicationResult(envelope, 1, Object.freeze({
    code: "control_operation_corrupt",
    message: "session resume completed without a valid owner exit code",
  }));
}

/** Compatibility facade for CLI callers that still consume process exit codes. */
export async function executeSessionResumeThroughApplicationService(
  options: SessionResumeApplicationOptionsV1,
  runtime: CliRuntime,
  io: CliIO,
  owner: SessionResumeOwnerPortV1,
): Promise<AgentExitCode> {
  const result = await executeSessionResumeThroughApplicationServiceResult(options, runtime, io, owner);
  if (result.diagnostic !== null && result.diagnostic.code !== "session_resume_owner_rejected") {
    io.stderr.write(`${result.diagnostic.code}: ${result.diagnostic.message}\n`);
  }
  return result.exitCode;
}
