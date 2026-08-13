import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { AuthenticatedTaskMutationBindingV1 } from "../../coordination/task-control-plane.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import type { ApplicationCancelRequestBindingV1 } from "../../events/phase21-run-control-event-schema.js";
import type { RunEvent } from "../../events/run-event.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import type {
  ApplicationActionDefinitionV1,
  ApplicationActionExecutionContextV1,
  ApplicationActionExecutionResultV1,
} from "../application-action-registry.js";
import { ApplicationControlError } from "../application-errors.js";
import {
  createStrictCodec,
  type ApplicationActionTargetV1,
  type ApplicationCommitBindingV1,
  type SessionLedgerHeadV1,
} from "../application-protocol.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type { ApplicationRecurringTaskPortV1 } from "../application-host-runtime.js";
import type { RepositoryRegistry } from "../repository-registry.js";
import type { SessionOwnerBroker } from "../session-owner-broker.js";
import type { SessionProjectionService } from "../session-projection-service.js";
import type { SessionRegistry } from "../session-registry.js";
import { sessionResumeResultCodec } from "./action-result-codecs.js";

const boundedOption = z.string().min(1).max(4_096).optional();
export const sessionResumePayloadV1Schema = z.object({
  allowDegradedResume: z.boolean(),
  continueApprovedPlan: z.boolean().optional(),
  message: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024).optional(),
  mode: z.enum(["plan", "build"]).optional(),
  modeSelection: z.enum(["explicit", "surface_default"]).optional(),
  planRevision: boundedOption,
  planSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  policyConfig: boundedOption,
  policyProfile: boundedOption,
}).strict();

export type SessionResumePayloadV1 = Readonly<z.infer<typeof sessionResumePayloadV1Schema>>;

export interface SessionResumeOwnerResultV1 {
  readonly exitCode: number;
  readonly newRunId: string;
  readonly resumeMode: "canonical_degraded" | "exact";
  readonly sourceRunId: string;
  readonly terminal: "run.budget_exceeded" | "run.cancelled" | "run.completed" | "run.failed" | "run.incomplete";
}

export interface SessionResumeOwnerCommitV1 {
  readonly applicationOperationId: string;
  readonly approvalExpiryReferences: readonly DurableRecordReferenceV1[];
  readonly primaryDomainRecord: DurableRecordReferenceV1;
  readonly requestEventType: "session.resume.requested";
  readonly result: SessionResumeOwnerResultV1;
  readonly runStartedEventType: "run.started";
  readonly runStartedReference: DurableRecordReferenceV1;
  readonly terminalEventType: SessionResumeOwnerResultV1["terminal"];
  readonly terminalReference: DurableRecordReferenceV1;
}

export interface SessionResumeOwnerPortV1 {
  /**
   * The Phase 9 owner remains responsible for planning, credentials, pending
   * effects, workspace fingerprints, reconciliation, and actual launch. This
   * bridge carries typed authority and returns only exact durable evidence.
   */
  execute(input: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly authenticatedMutation: AuthenticatedTaskMutationBindingV1;
    readonly expectedHead: SessionLedgerHeadV1;
    readonly payload: SessionResumePayloadV1;
    readonly repositoryId: string;
    readonly runLifecycle: SessionResumeRunLifecyclePortV1;
    readonly sessionId: string;
    readonly sourceRunId: string;
  }>): Promise<SessionResumeOwnerCommitV1>;
}

export interface SessionResumeActiveRunV1 {
  readonly applicationCancellation: Readonly<{
    readonly hostEmergencyReason?: () => "tui_surface_fatal" | undefined;
    readonly signal: AbortSignal;
    readonly terminalBinding: () => ApplicationCancelRequestBindingV1 | undefined;
  }>;
  readonly finish: () => Promise<void>;
  readonly onRunStarted: (
    event: Extract<RunEvent, { readonly type: "run.started" }>,
  ) => Promise<void>;
}

export interface SessionResumeRunLifecyclePortV1 {
  readonly activate: (input: Readonly<{
    readonly runId: string;
    readonly writer: V2SessionWriter;
  }>) => Promise<SessionResumeActiveRunV1>;
}

const SESSION_RESUME_TERMINALS = new Set<SessionResumeOwnerResultV1["terminal"]>([
  "run.budget_exceeded",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.incomplete",
]);

function hasExactApplicationCommit(
  event: DecodedStoredEvent,
  binding: ApplicationCommitBindingV1,
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

function eventReference(writer: V2SessionWriter, event: DecodedStoredEvent): DurableRecordReferenceV1 {
  const identity = writer.readDurableEventIdentity(event.eventId);
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session" as const,
    recordId: event.eventId,
    recordSha256: identity.rawEventSha256,
    sequence: event.sessionSeq,
  });
}

async function validateAndCloseResumeCancellation(input: Readonly<{
  readonly expectedTerminalReference?: DurableRecordReferenceV1;
  readonly repositoryId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessions: SessionRegistry;
  readonly writer: V2SessionWriter;
}>): Promise<void> {
  const terminals = input.writer.events.filter((event) =>
    event.scope === "run" && event.runId === input.runId && event.type === "run.cancelled"
  );
  if (terminals.length !== 1 || terminals[0]!.type !== "run.cancelled") {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "resumed run cancellation terminal is ambiguous",
    );
  }
  const terminal = terminals[0]!;
  const terminalReference = eventReference(input.writer, terminal);
  if (
    input.expectedTerminalReference !== undefined &&
    sha256Canonical(input.expectedTerminalReference) !== sha256Canonical(terminalReference)
  ) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "resumed run cancellation terminal reference is not exact",
    );
  }
  if (!("application_cancel_request" in terminal.data)) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated resumed run cancellation has no request binding",
    );
  }
  const terminalBinding = terminal.data.application_cancel_request;
  const requests = input.writer.events.filter((event) =>
    event.scope === "run" && event.runId === input.runId && event.type === "run.cancel.requested"
  );
  if (requests.length !== 1 || requests[0]!.type !== "run.cancel.requested") {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "resumed run cancellation does not have one exact request",
    );
  }
  const request = requests[0]!;
  const requestReference = eventReference(input.writer, request);
  if (
    request.eventId !== terminalBinding.request_event_id ||
    requestReference.recordSha256 !== terminalBinding.request_event_sha256 ||
    request.data.target_run_id !== input.runId ||
    request.data.target_owner_generation_sha256 !== terminalBinding.target_owner_generation_sha256 ||
    terminal.sessionSeq <= request.sessionSeq
  ) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "resumed run cancellation request and terminal binding disagree",
    );
  }
  const barrier = await input.sessions.readRunCancelBarrier(
    input.repositoryId,
    input.sessionId,
    input.runId,
  );
  if (
    barrier.owner?.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    barrier.request === null ||
    barrier.request.fact.applicationCommit.operationId !== terminalBinding.request_event_id ||
    barrier.request.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    barrier.request.fact.repositoryId !== input.repositoryId ||
    barrier.request.fact.sessionId !== input.sessionId ||
    barrier.request.fact.runId !== input.runId ||
    barrier.request.fact.reason !== "user" ||
    !hasExactApplicationCommit(request, barrier.request.fact.applicationCommit) ||
    barrier.binding?.fact.cancelOperationId !== terminalBinding.request_event_id ||
    barrier.binding.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    sha256Canonical(barrier.binding.fact.sessionRequestReference) !== sha256Canonical(requestReference) ||
    sha256Canonical(barrier.binding.fact.terminalBinding) !== sha256Canonical(terminalBinding)
  ) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "resumed run cancellation is not bound to its exact registry barrier",
    );
  }
  await input.sessions.closeRunCancelBarrier({
    cancelOperationId: terminalBinding.request_event_id,
    ownerGenerationSha256: terminalBinding.target_owner_generation_sha256,
    repositoryId: input.repositoryId,
    runId: input.runId,
    sessionId: input.sessionId,
    terminalBinding,
    terminalReference,
  });
}

function recoveredExitCode(terminal: SessionResumeOwnerResultV1["terminal"]): number {
  if (terminal === "run.completed") return 0;
  if (terminal === "run.cancelled") return 130;
  if (terminal === "run.budget_exceeded" || terminal === "run.incomplete") return 8;
  return 1;
}

/**
 * Observe one complete application-owned resume predicate. Missing suffixes
 * return null: observation never grants authority to repeat the Phase 9 owner.
 */
function observeResumeCommit(input: Readonly<{
  context: ApplicationActionExecutionContextV1;
  sourceRunId: string;
  writer: V2SessionWriter;
}>): SessionResumeOwnerCommitV1 | null {
  const requests = input.writer.events.filter((event) =>
    event.scope === "session" &&
    event.type === "session.resume.requested" &&
    event.eventId === input.context.operationId &&
    hasExactApplicationCommit(event, input.context.applicationCommit)
  );
  if (requests.length === 0) return null;
  if (requests.length !== 1) {
    throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume operation has duplicate durable requests");
  }
  const request = requests[0]!;
  if (request.type !== "session.resume.requested") throw new TypeError("resume request narrowed incorrectly");
  const data = request.data;
  const version = input.context.resolvedTarget.resourceVersion;
  if (version.kind !== "session_ledger_head") {
    throw new ApplicationControlError("control_target_invalid", "resume reconciliation requires a ledger target");
  }
  if (
    data.application_commit === undefined ||
    data.approval_request_ids === undefined ||
    data.new_run_id === undefined ||
    data.source_run_id !== input.sourceRunId ||
    request.sessionSeq <= version.head.sequence
  ) {
    throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume request does not match its exact prepared source");
  }
  const approvalExpiries: DecodedStoredEvent[] = [];
  for (const approvalRequestId of data.approval_request_ids) {
    const matches = input.writer.events.filter((event) =>
      event.scope === "session" &&
      event.type === "approval.expired" &&
      event.sessionSeq > request.sessionSeq &&
      event.data.approval_request_id === approvalRequestId &&
      event.data.source_run_id === input.sourceRunId
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
      throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume approval expiry evidence is ambiguous");
    }
    approvalExpiries.push(matches[0]!);
  }
  approvalExpiries.sort((left, right) => left.sessionSeq - right.sessionSeq);
  const started = input.writer.events.filter((event) =>
    event.scope === "run" &&
    event.type === "run.started" &&
    event.runId === data.new_run_id &&
    event.sessionSeq > (approvalExpiries.at(-1)?.sessionSeq ?? request.sessionSeq) &&
    event.data.resume_of_run_id === input.sourceRunId &&
    hasExactApplicationCommit(event, input.context.applicationCommit)
  );
  if (started.length === 0) return null;
  if (started.length !== 1) {
    throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume run start evidence is ambiguous");
  }
  const startedEvent = started[0]!;
  const terminals = input.writer.events.filter((event): event is Extract<DecodedStoredEvent, { readonly scope: "run" }> =>
    event.scope === "run" &&
    event.runId === data.new_run_id &&
    event.sessionSeq > startedEvent.sessionSeq &&
    SESSION_RESUME_TERMINALS.has(event.type as SessionResumeOwnerResultV1["terminal"])
  );
  if (terminals.length === 0) return null;
  if (terminals.length !== 1 || !SESSION_RESUME_TERMINALS.has(terminals[0]!.type as SessionResumeOwnerResultV1["terminal"])) {
    throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume terminal evidence is ambiguous");
  }
  const terminal = terminals[0]!;
  const terminalType = terminal.type as SessionResumeOwnerResultV1["terminal"];
  return Object.freeze({
    applicationOperationId: input.context.operationId,
    approvalExpiryReferences: Object.freeze(approvalExpiries.map((event) => eventReference(input.writer, event))),
    primaryDomainRecord: eventReference(input.writer, request),
    requestEventType: "session.resume.requested" as const,
    result: Object.freeze({
      exitCode: recoveredExitCode(terminalType),
      newRunId: data.new_run_id,
      resumeMode: data.requested_mode,
      sourceRunId: data.source_run_id,
      terminal: terminalType,
    }),
    runStartedEventType: "run.started" as const,
    runStartedReference: eventReference(input.writer, startedEvent),
    terminalEventType: terminalType,
    terminalReference: eventReference(input.writer, terminal),
  });
}

function sessionContract() {
  return Object.freeze({
    acceptedExpectedVersionKinds: Object.freeze(["session_ledger_head"] as const),
    resourceKinds: Object.freeze(["session"] as const),
    targetKind: "existing_resource" as const,
  });
}

function targetSourceRunId(targetIdentity: unknown): string {
  if (
    typeof targetIdentity !== "object" ||
    targetIdentity === null ||
    !("source_run_id" in targetIdentity) ||
    typeof targetIdentity.source_run_id !== "string"
  ) {
    throw new ApplicationControlError("control_target_invalid", "resume source run identity is unavailable");
  }
  return targetIdentity.source_run_id;
}

function authenticatedMutation(context: ApplicationActionExecutionContextV1): AuthenticatedTaskMutationBindingV1 {
  return Object.freeze({
    actionIdentitySha256: sha256Canonical({
      application_commit: context.applicationCommit,
      resource_scope: context.resolvedTarget.resourceScope,
      schema_version: 1,
    }),
    applicationCommit: context.applicationCommit,
    authenticationId: context.call.principal.authenticationId,
    requestId: context.requestId,
    surface: context.call.surface,
  });
}

async function assertNoPendingCancel(input: {
  readonly repositoryId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessions: SessionRegistry;
}): Promise<void> {
  const barrier = await input.sessions.readRunCancelBarrier(input.repositoryId, input.sessionId, input.runId);
  if (barrier.request !== null && barrier.terminal === null) {
    throw new ApplicationControlError(
      "control_operation_busy",
      "run_cancel_pending: durable cancellation must reach its exact terminal before resume",
    );
  }
}

function validateOwnerCommit(input: {
  readonly commit: SessionResumeOwnerCommitV1;
  readonly context: ApplicationActionExecutionContextV1;
  readonly sourceRunId: string;
}): void {
  const scope = input.context.resolvedTarget.resourceScope;
  if (scope.kind !== "session") throw new ApplicationControlError("control_target_invalid", "resume target is not a session");
  const required = [
    input.commit.primaryDomainRecord,
    ...input.commit.approvalExpiryReferences,
    input.commit.runStartedReference,
    input.commit.terminalReference,
  ];
  if (
    input.commit.applicationOperationId !== input.context.operationId ||
    input.commit.primaryDomainRecord.recordId !== input.context.operationId ||
    input.commit.requestEventType !== "session.resume.requested" ||
    input.commit.runStartedEventType !== "run.started" ||
    input.commit.result.sourceRunId !== input.sourceRunId ||
    input.commit.result.newRunId === input.sourceRunId ||
    input.commit.runStartedReference.recordId === input.commit.terminalReference.recordId ||
    input.commit.terminalEventType !== input.commit.result.terminal ||
    required.length > 132
  ) {
    throw new ApplicationControlError("control_operation_busy", "resume owner returned an incomplete composite commit predicate");
  }
  if (required.some((reference) =>
    reference.ownerKind !== "session" || reference.ledgerId !== `session:${scope.sessionId}`
  )) {
    throw new ApplicationControlError("control_operation_busy", "resume owner returned a cross-resource durable reference");
  }
  const sequences = required.map((reference) => reference.sequence);
  if (
    sequences.some((sequence) => sequence === null) ||
    !sequences.every((sequence, index) => index === 0 || sequence! > sequences[index - 1]!)
  ) {
    throw new ApplicationControlError("control_operation_busy", "resume composite references are not strictly ordered");
  }
}

function translateOwnerError(error: unknown): ApplicationControlError {
  if (error instanceof ApplicationControlError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "resume owner operation failed";
  if (/busy|active|effect_unknown|reconciliation|required|resume_request_without_start/u.test(code)) {
    return new ApplicationControlError("control_operation_busy", message, { cause: error });
  }
  if (/stale|conflict|not_found|identity/u.test(code)) {
    return new ApplicationControlError("control_stale_projection", message, { cause: error });
  }
  if (/invalid|unsupported|unavailable|schema|policy|confirmation/u.test(code)) {
    return new ApplicationControlError("control_target_invalid", message, { cause: error });
  }
  return new ApplicationControlError("control_operation_busy", message, { cause: error });
}

export function createSessionResumeAction(input: Readonly<{
  readonly broker: SessionOwnerBroker;
  readonly owner: SessionResumeOwnerPortV1;
  readonly recurringTasks: ApplicationRecurringTaskPortV1;
  readonly repositories: RepositoryRegistry;
  readonly sessionProjection: SessionProjectionService;
  readonly sessions: SessionRegistry;
}>): ApplicationActionDefinitionV1<SessionResumePayloadV1, SessionResumeOwnerResultV1> {
  const runLifecycle = (
    context: ApplicationActionExecutionContextV1,
    repositoryId: string,
    sessionId: string,
  ): Readonly<{
    readonly assertCancelledTerminalValidated: (runId: string) => void;
    readonly port: SessionResumeRunLifecyclePortV1;
  }> => {
    let activated = false;
    let validatedCancelledRunId: string | null = null;
    const port: SessionResumeRunLifecyclePortV1 = Object.freeze({
      activate: async ({ runId, writer }: Readonly<{ readonly runId: string; readonly writer: V2SessionWriter }>) => {
        if (activated) {
          throw new ApplicationControlError("control_operation_busy", "resume owner attempted to activate more than one run");
        }
        activated = true;
        const request = writer.events.find((event: DecodedStoredEvent) =>
          event.scope === "session" &&
          event.type === "session.resume.requested" &&
          event.eventId === context.operationId &&
          hasExactApplicationCommit(event, context.applicationCommit)
        );
        if (
          request?.type !== "session.resume.requested" ||
          request.data.new_run_id !== runId ||
          writer.readDurableTailIdentity().sessionId !== sessionId
        ) {
          throw new ApplicationControlError(
            "control_session_history_missing_or_corrupt",
            "resume run activation does not match its exact durable request",
          );
        }
        const catalog = await input.sessions.project(repositoryId);
        const entry = catalog.entries.find((candidate) => candidate.sessionId === sessionId);
        if (entry === undefined) {
          throw new ApplicationControlError("control_authorization_denied", "resume session is unavailable");
        }
        const activeRead = input.sessionProjection.activeReadPort({ entry, writer });
        const initial = await activeRead.readStableSnapshot();
          const cancellationController = new AbortController();
          let terminalBinding: ApplicationCancelRequestBindingV1 | undefined;
          let hostEmergencyReason: "tui_surface_fatal" | undefined;
        let cancelProcessing: Promise<void> = Promise.resolve();
        const processDurableCancel = (cancel: Readonly<{
          readonly applicationCommit: ApplicationCommitBindingV1;
          readonly reason: "user";
        }>) => {
          const processing = cancelProcessing.then(async () => {
            const barrier = await input.sessions.readRunCancelBarrier(repositoryId, sessionId, runId);
            if (
              barrier.owner?.fact.ownerGenerationSha256 !== writer.lockNonceSha256 ||
              barrier.request?.fact.applicationCommit.operationId !== cancel.applicationCommit.operationId ||
              sha256Canonical(barrier.request.fact.applicationCommit) !== sha256Canonical(cancel.applicationCommit)
            ) {
              throw new ApplicationControlError("control_operation_busy", "exact durable resume-run cancel is unavailable");
            }
            const prior = writer.events.filter((event: DecodedStoredEvent) =>
              event.scope === "run" && event.runId === runId && event.type === "run.cancel.requested"
            );
            const owned = prior.find((event: DecodedStoredEvent) =>
              hasExactApplicationCommit(event, cancel.applicationCommit)
            );
            if (owned === undefined && prior.length > 0) {
              throw new ApplicationControlError("control_operation_busy", "resume run already has another cancel request");
            }
            const cancelEvent = owned ?? await writer.appendPhase21RunControlEvent(
              runId,
              cancel.applicationCommit.operationId,
              "run.cancel.requested",
              {
                application_commit: {
                  action_kind: cancel.applicationCommit.actionKind,
                  authorization_decision_sha256: cancel.applicationCommit.authorizationDecisionSha256,
                  operation_id: cancel.applicationCommit.operationId,
                  prepared_action_sha256: cancel.applicationCommit.preparedActionSha256,
                  principal_id: cancel.applicationCommit.principalId,
                  schema_version: 1,
                },
                reason: cancel.reason,
                target_owner_generation_sha256: writer.lockNonceSha256,
                target_run_id: runId,
              },
            );
            const reference = eventReference(writer, cancelEvent);
            terminalBinding = Object.freeze({
              request_event_id: cancelEvent.eventId,
              request_event_sha256: reference.recordSha256,
              target_owner_generation_sha256: writer.lockNonceSha256,
            });
            await input.sessions.bindRunCancelRequest({
              cancelOperationId: cancel.applicationCommit.operationId,
              ownerGenerationSha256: writer.lockNonceSha256,
              repositoryId,
              runId,
              sessionId,
              sessionRequestReference: reference,
              terminalBinding,
            });
            cancellationController.abort();
          });
          cancelProcessing = processing.then(() => undefined, () => undefined);
          return processing;
        };
        const release = input.broker.register(sessionId, Object.freeze({
          ...activeRead,
          runControl: Object.freeze({
            acceptsObservedHead: (head: SessionLedgerHeadV1) =>
              input.sessionProjection.verifyOwnerObservedHead(writer, head),
            ownerApplicationOperationId: context.operationId,
            ownerGenerationSha256: writer.lockNonceSha256,
            requestCancel: async (cancel: Readonly<{
              readonly applicationCommit: ApplicationCommitBindingV1;
              readonly reason: "user";
            }>) => {
              await processDurableCancel(cancel);
              const snapshot = await activeRead.readStableSnapshot();
              if (terminalBinding === undefined) throw new TypeError("resume cancel binding disappeared");
              const event = writer.events.find((candidate: DecodedStoredEvent) =>
                candidate.type === "run.cancel.requested" && candidate.eventId === terminalBinding!.request_event_id
              );
              if (event === undefined) throw new TypeError("resume cancel request disappeared");
              return Object.freeze({
                head: snapshot.head,
                recordReference: eventReference(writer, event),
                terminalBinding,
              });
            },
            requestHostEmergencyStop: (input: Readonly<{ readonly reason: "tui_surface_fatal" }>) => {
              hostEmergencyReason ??= input.reason;
              cancellationController.abort();
            },
            runId,
          }),
        }));
        try {
          await input.sessions.registerRunOwner({
            initialObservedHead: initial.head.publicHead,
            ownerGenerationSha256: writer.lockNonceSha256,
            ownerOperationId: runId,
            repositoryId,
            runId,
            sessionId,
          });
        } catch (error) {
          release();
          throw error;
        }
        let pollTask: Promise<void> = Promise.resolve();
        const pollDurableCancel = async () => {
          const barrier = await input.sessions.readRunCancelBarrier(repositoryId, sessionId, runId);
          if (
            barrier.owner?.fact.ownerGenerationSha256 !== writer.lockNonceSha256 ||
            barrier.terminal !== null ||
            !barrier.observations.some((observation) => observation.observationKind === "started")
          ) return;
          const snapshot = await activeRead.readStableSnapshot();
          const observed = await input.sessions.observeRunOwner({
            observationKind: "progress",
            observedHead: snapshot.head.publicHead,
            ownerGenerationSha256: writer.lockNonceSha256,
            repositoryId,
            runId,
            sessionId,
          });
          if (observed.request !== null) {
            await processDurableCancel({
              applicationCommit: observed.request.fact.applicationCommit,
              reason: observed.request.fact.reason,
            });
          }
        };
        const stopPolling = input.recurringTasks.startRecurringTask(25, async () => {
          pollTask = pollTask.then(pollDurableCancel).catch(() => undefined);
          await pollTask;
        });
        let finished = false;
        return Object.freeze({
          applicationCancellation: Object.freeze({
            hostEmergencyReason: () => hostEmergencyReason,
            signal: cancellationController.signal,
            terminalBinding: () => terminalBinding,
          }),
          finish: async () => {
            if (finished) return;
            finished = true;
            await stopPolling();
            await pollTask;
            try {
              const terminal = writer.events.find((event: DecodedStoredEvent) =>
                event.scope === "run" &&
                event.runId === runId &&
                SESSION_RESUME_TERMINALS.has(event.type as SessionResumeOwnerResultV1["terminal"])
              );
              if (terminal?.type === "run.cancelled") {
                await validateAndCloseResumeCancellation({
                  expectedTerminalReference: eventReference(writer, terminal),
                  repositoryId,
                  runId,
                  sessionId,
                  sessions: input.sessions,
                  writer,
                });
                validatedCancelledRunId = runId;
              }
            } finally {
              release();
            }
          },
          onRunStarted: async (event: Extract<RunEvent, { readonly type: "run.started" }>) => {
            if (event.run_id !== runId || event.session_id !== sessionId) {
              throw new ApplicationControlError(
                "control_session_history_missing_or_corrupt",
                "resumed run start does not match its activated owner",
              );
            }
            const snapshot = await activeRead.readStableSnapshot();
            await input.sessions.observeRunOwner({
              observationKind: "started",
              observedHead: snapshot.head.publicHead,
              ownerGenerationSha256: writer.lockNonceSha256,
              repositoryId,
              runId,
              sessionId,
            });
          },
        });
      },
    });
    return Object.freeze({
      assertCancelledTerminalValidated: (runId: string) => {
        if (validatedCancelledRunId !== runId) {
          throw new ApplicationControlError(
            "control_session_history_missing_or_corrupt",
            "authenticated resumed run cancelled without its exact lifecycle proof",
          );
        }
      },
      port,
    });
  };

  const resolveTarget = async (target: ApplicationActionTargetV1) => {
    if (
      target.kind !== "existing_resource" ||
      target.resourceScope.kind !== "session" ||
      target.expectedVersion.kind !== "session_ledger_head"
    ) {
      throw new ApplicationControlError("control_target_invalid", "session resume target is invalid");
    }
    const snapshot = await input.sessionProjection.read({
      repositoryId: target.resourceScope.repositoryId,
      requestedHead: target.expectedVersion.head,
      sessionId: target.resourceScope.sessionId,
    });
    const source = snapshot.projection.projection.runs.at(-1);
    if (source === undefined) {
      throw new ApplicationControlError("control_session_not_started", "session has no historical run to resume");
    }
    await assertNoPendingCancel({
      repositoryId: target.resourceScope.repositoryId,
      runId: source.runId,
      sessionId: target.resourceScope.sessionId,
      sessions: input.sessions,
    });
    const targetIdentity = Object.freeze({
      projection_identity: snapshot.projection.identity,
      session_id: target.resourceScope.sessionId,
      source_run_id: source.runId,
      source_status: source.status,
    });
    return Object.freeze({
      resourceScope: snapshot.resourceScope,
      resourceVersion: Object.freeze({ head: snapshot.head.publicHead, kind: "session_ledger_head" as const }),
      targetIdentity,
      targetIdentitySha256: sha256Canonical(targetIdentity),
    });
  };

  const definition: ApplicationActionDefinitionV1<SessionResumePayloadV1, SessionResumeOwnerResultV1> = {
    actionKind: "session.resume",
    confirmation: "show_before_commit",
    display: (resolved, payload) => Object.freeze({
      summary: `Resume session ${resolved.resourceScope.kind === "session" ? resolved.resourceScope.sessionId : "unknown"} from its exact durable head.`,
      warnings: Object.freeze([
        payload.allowDegradedResume
          ? "Canonical degradation is explicitly allowed if the Phase 9 owner verifies that exact resume is unavailable."
          : "No degraded resume is authorized.",
      ]),
    }),
    effectClass: "runtime_effect",
    execute: async (context, payload): Promise<ApplicationActionExecutionResultV1<SessionResumeOwnerResultV1>> => {
      const scope = context.resolvedTarget.resourceScope;
      const version = context.resolvedTarget.resourceVersion;
      if (scope.kind !== "session" || version.kind !== "session_ledger_head") {
        throw new ApplicationControlError("control_target_invalid", "session resume requires a ledger target");
      }
      const sourceRunId = targetSourceRunId(context.resolvedTarget.targetIdentity);
      await assertNoPendingCancel({
        repositoryId: scope.repositoryId,
        runId: sourceRunId,
        sessionId: scope.sessionId,
        sessions: input.sessions,
      });
      try {
        const lifecycle = runLifecycle(context, scope.repositoryId, scope.sessionId);
        const commit = await input.owner.execute({
          applicationCommit: context.applicationCommit,
          authenticatedMutation: authenticatedMutation(context),
          expectedHead: version.head,
          payload,
          repositoryId: scope.repositoryId,
          runLifecycle: lifecycle.port,
          sessionId: scope.sessionId,
          sourceRunId,
        });
        validateOwnerCommit({ commit, context, sourceRunId });
        if (commit.terminalEventType === "run.cancelled") {
          lifecycle.assertCancelledTerminalValidated(commit.result.newRunId);
        }
        const snapshot = await input.sessionProjection.read({
          repositoryId: scope.repositoryId,
          requestedHead: null,
          sessionId: scope.sessionId,
        });
        return Object.freeze({
          domainRecordRefs: Object.freeze([commit.primaryDomainRecord]),
          primaryDomainRecord: commit.primaryDomainRecord,
          resolvedResourceScope: scope,
          resolvedResourceVersion: Object.freeze({ head: snapshot.head.publicHead, kind: "session_ledger_head" as const }),
          result: commit.result,
          underlyingOperationRefs: Object.freeze([
            ...commit.approvalExpiryReferences,
            commit.runStartedReference,
            commit.terminalReference,
          ]),
        });
      } catch (error) {
        throw translateOwnerError(error);
      }
    },
    reconcile: async (context, _payload, prepared) => {
      const scope = context.resolvedTarget.resourceScope;
      if (
        scope.kind !== "session" ||
        prepared.target.kind !== "existing_resource" ||
        prepared.target.resourceScope.kind !== "session" ||
        prepared.target.expectedVersion.kind !== "session_ledger_head" ||
        prepared.target.resourceScope.repositoryId !== scope.repositoryId ||
        prepared.target.resourceScope.sessionId !== scope.sessionId
      ) {
        throw new ApplicationControlError("control_target_invalid", "resume reconciliation target is invalid");
      }
      const expectedHead = prepared.target.expectedVersion.head;
      return input.broker.serialize(scope.sessionId, async () => {
        // Reconciliation owns no launch authority. An active owner or writer
        // lock remains busy; only a stable, exclusively opened ledger is read.
        if (input.broker.activePort(scope.sessionId) !== null) {
          throw new ApplicationControlError("control_operation_busy", "session already has an active in-process owner");
        }
        const catalog = await input.sessions.project(scope.repositoryId);
        const entry = catalog.entries.find((candidate) => candidate.sessionId === scope.sessionId);
        if (entry === undefined) {
          throw new ApplicationControlError("control_authorization_denied", "session is unavailable");
        }
        const repository = await input.repositories.get(scope.repositoryId);
        if (repository === null || repository.status !== "active") {
          throw new ApplicationControlError("control_authorization_denied", "repository is unavailable");
        }
        const root = await input.repositories.readRoot(repository);
        const writer = await V2SessionWriter.openExisting(root, scope.sessionId);
        const activeRead = input.sessionProjection.activeReadPort({ entry, writer });
        const release = input.broker.register(scope.sessionId, activeRead);
        try {
          if (!input.sessionProjection.verifyOwnerObservedHead(writer, expectedHead)) {
            throw new ApplicationControlError(
              "control_session_history_missing_or_corrupt",
              "resume prepared head no longer matches its exact durable prefix",
            );
          }
          const source = reconstructMultiRunSession(writer.events.slice(0, expectedHead.sequence)).lastRun;
          if (source === null) {
            throw new ApplicationControlError("control_session_history_missing_or_corrupt", "resume prepared prefix has no source run");
          }
           const commit = observeResumeCommit({ context, sourceRunId: source.runId, writer });
           if (commit === null) return null;
           validateOwnerCommit({ commit, context, sourceRunId: source.runId });
           if (commit.terminalEventType === "run.cancelled") {
             await validateAndCloseResumeCancellation({
               expectedTerminalReference: commit.terminalReference,
               repositoryId: scope.repositoryId,
               runId: commit.result.newRunId,
               sessionId: scope.sessionId,
               sessions: input.sessions,
               writer,
             });
           }
           const stable = await activeRead.readStableSnapshot();
          const tail = writer.readDurableTailIdentity();
          if (stable.head.publicHead.sequence !== tail.sequence) {
            throw new ApplicationControlError(
              "control_session_history_missing_or_corrupt",
              "resume reconciliation projection lagged the durable ledger",
            );
          }
          return Object.freeze({
            domainRecordRefs: Object.freeze([commit.primaryDomainRecord]),
            primaryDomainRecord: commit.primaryDomainRecord,
            resolvedResourceScope: scope,
            resolvedResourceVersion: Object.freeze({
              head: stable.head.publicHead,
              kind: "session_ledger_head" as const,
            }),
            result: commit.result,
            underlyingOperationRefs: Object.freeze([
              ...commit.approvalExpiryReferences,
              commit.runStartedReference,
              commit.terminalReference,
            ]),
          });
        } finally {
          release();
          await writer.close().catch(() => undefined);
        }
      });
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 80 * 1024,
      schema: sessionResumePayloadV1Schema,
      schemaId: "phase21a.session.resume.payload.v1",
    }),
    resultCodec: sessionResumeResultCodec,
    requiredPrincipalKind: "human",
    requiredScopes: Object.freeze(["session.mutate"]),
    resolveTarget,
    targetContracts: Object.freeze([sessionContract()]),
    zeroHeadPolicy: "deny",
  };
  return Object.freeze(definition);
}
