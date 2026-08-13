import { sha256Canonical } from "../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import type { ApplicationCancelRequestBindingV1 } from "../events/phase21-run-control-event-schema.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import { ApplicationControlError } from "./application-errors.js";
import type { ApplicationCommitBindingV1, SessionLedgerHeadV1 } from "./application-protocol.js";
import type { ApplicationRecurringTaskPortV1 } from "./application-host-runtime.js";
import type { DurableRecordReferenceV1 } from "./control-operation-schema.js";
import type { ActiveSessionReadPortV1, SessionOwnerBroker } from "./session-owner-broker.js";
import type { RunLifecycleRegistryV1 } from "./session-registry-ports.js";

export interface RunApplicationCancellationV1 {
  readonly hostEmergencyReason: () => "tui_surface_fatal" | undefined;
  readonly signal: AbortSignal;
  readonly terminalBinding: () => ApplicationCancelRequestBindingV1 | undefined;
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

function persistedApplicationCommit(event: DecodedStoredEvent): Readonly<Record<string, unknown>> | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const data = event.data as Readonly<Record<string, unknown>>;
  const direct = data.application_commit;
  if (typeof direct === "object" && direct !== null) return direct as Readonly<Record<string, unknown>>;
  const origin = data.origin;
  if (typeof origin !== "object" || origin === null || !("application_commit" in origin)) return null;
  const nested = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof nested === "object" && nested !== null ? nested as Readonly<Record<string, unknown>> : null;
}

function exactApplicationCommit(event: DecodedStoredEvent, binding: ApplicationCommitBindingV1): boolean {
  const value = persistedApplicationCommit(event);
  return value !== null &&
    value.schema_version === 1 &&
    value.operation_id === binding.operationId &&
    value.action_kind === binding.actionKind &&
    value.prepared_action_sha256 === binding.preparedActionSha256 &&
    value.principal_id === binding.principalId &&
    value.authorization_decision_sha256 === binding.authorizationDecisionSha256;
}

function applicationOperationId(event: DecodedStoredEvent): string | null {
  const value = persistedApplicationCommit(event)?.operation_id;
  return typeof value === "string" ? value : null;
}

export async function validateAndCloseAuthenticatedRunCancellation(input: Readonly<{
  readonly expectedTerminalReference?: DurableRecordReferenceV1;
  readonly repositoryId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessions: RunLifecycleRegistryV1;
  readonly terminal: DecodedStoredEvent;
  readonly writer: V2SessionWriter;
}>): Promise<void> {
  if (input.terminal.scope !== "run" || input.terminal.runId !== input.runId || input.terminal.type !== "run.cancelled") {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated run cancellation terminal is not exact",
    );
  }
  const terminalReference = eventReference(input.writer, input.terminal);
  if (
    input.expectedTerminalReference !== undefined &&
    sha256Canonical(input.expectedTerminalReference) !== sha256Canonical(terminalReference)
  ) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated run cancellation terminal reference is not exact",
    );
  }
  if (!("application_cancel_request" in input.terminal.data)) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated run cancellation has no exact application request binding",
    );
  }
  const terminalBinding = input.terminal.data.application_cancel_request;
  const requests = input.writer.events.filter((event) =>
    event.scope === "run" && event.runId === input.runId && event.type === "run.cancel.requested"
  );
  if (requests.length !== 1 || requests[0]!.type !== "run.cancel.requested") {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated run cancellation does not have one exact request fact",
    );
  }
  const request = requests[0]!;
  const requestReference = eventReference(input.writer, request);
  const barrier = await input.sessions.readRunCancelBarrier(input.repositoryId, input.sessionId, input.runId);
  if (
    request.eventId !== terminalBinding.request_event_id ||
    requestReference.recordSha256 !== terminalBinding.request_event_sha256 ||
    request.data.target_run_id !== input.runId ||
    request.data.target_owner_generation_sha256 !== terminalBinding.target_owner_generation_sha256 ||
    applicationOperationId(request) !== terminalBinding.request_event_id ||
    input.terminal.sessionSeq <= request.sessionSeq ||
    barrier.owner?.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    barrier.request === null ||
    barrier.request.fact.applicationCommit.operationId !== terminalBinding.request_event_id ||
    barrier.request.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    barrier.request.fact.repositoryId !== input.repositoryId ||
    barrier.request.fact.runId !== input.runId ||
    barrier.request.fact.sessionId !== input.sessionId ||
    barrier.request.fact.reason !== "user" ||
    !exactApplicationCommit(request, barrier.request.fact.applicationCommit) ||
    barrier.binding?.fact.cancelOperationId !== terminalBinding.request_event_id ||
    barrier.binding.fact.ownerGenerationSha256 !== terminalBinding.target_owner_generation_sha256 ||
    sha256Canonical(barrier.binding.fact.sessionRequestReference) !== sha256Canonical(requestReference) ||
    sha256Canonical(barrier.binding.fact.terminalBinding) !== sha256Canonical(terminalBinding)
  ) {
    throw new ApplicationControlError(
      "control_session_history_missing_or_corrupt",
      "authenticated run cancellation is not bound to its exact durable registry barrier",
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

export class RunCancellationLifecycle {
  private activated = false;
  private cancelProcessing: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private finished = false;
  private hostReason: "tui_surface_fatal" | undefined;
  private pollTask: Promise<void> = Promise.resolve();
  private releaseBroker: (() => void) | null = null;
  private stopPolling: (() => Promise<void>) | null = null;
  private terminalBindingValue: ApplicationCancelRequestBindingV1 | undefined;

  readonly applicationCancellation: RunApplicationCancellationV1;

  constructor(private readonly input: Readonly<{
    readonly activeRead: ActiveSessionReadPortV1;
    readonly acceptsObservedHead: (head: SessionLedgerHeadV1) => boolean;
    readonly broker: SessionOwnerBroker;
    readonly ownerApplicationOperationId: string;
    readonly ownerRegistryOperationId: string;
    readonly recurringTasks: ApplicationRecurringTaskPortV1;
    readonly repositoryId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly sessions: RunLifecycleRegistryV1;
    readonly writer: V2SessionWriter;
  }>) {
    this.applicationCancellation = Object.freeze({
      hostEmergencyReason: () => this.hostReason,
      signal: this.controller.signal,
      terminalBinding: () => this.terminalBindingValue,
    });
    this.releaseBroker = input.broker.register(input.sessionId, Object.freeze({
      ...input.activeRead,
      runControl: Object.freeze({
        acceptsObservedHead: input.acceptsObservedHead,
        ownerApplicationOperationId: input.ownerApplicationOperationId,
        ownerGenerationSha256: input.writer.lockNonceSha256,
        requestCancel: (request: Readonly<{
          readonly applicationCommit: ApplicationCommitBindingV1;
          readonly reason: "user";
        }>) => this.processDurableCancel(request),
        requestHostEmergencyStop: (request: Readonly<{ readonly reason: "tui_surface_fatal" }>) => {
          this.hostReason ??= request.reason;
          this.controller.abort();
        },
        runId: input.runId,
      }),
    }));
  }

  async activate(initialObservedHead: SessionLedgerHeadV1): Promise<void> {
    if (this.activated) throw new ApplicationControlError("control_operation_busy", "run cancellation lifecycle activated twice");
    await this.input.sessions.registerRunOwner({
      initialObservedHead,
      ownerGenerationSha256: this.input.writer.lockNonceSha256,
      ownerOperationId: this.input.ownerRegistryOperationId,
      repositoryId: this.input.repositoryId,
      runId: this.input.runId,
      sessionId: this.input.sessionId,
    });
    this.activated = true;
    const poll = async () => {
      const barrier = await this.input.sessions.readRunCancelBarrier(
        this.input.repositoryId,
        this.input.sessionId,
        this.input.runId,
      );
      if (
        barrier.owner?.fact.ownerGenerationSha256 !== this.input.writer.lockNonceSha256 ||
        barrier.terminal !== null ||
        !barrier.observations.some((observation) => observation.observationKind === "started")
      ) return;
      const snapshot = await this.input.activeRead.readStableSnapshot();
      const observed = await this.input.sessions.observeRunOwner({
        observationKind: "progress",
        observedHead: snapshot.head.publicHead,
        ownerGenerationSha256: this.input.writer.lockNonceSha256,
        repositoryId: this.input.repositoryId,
        runId: this.input.runId,
        sessionId: this.input.sessionId,
      });
      if (observed.request !== null) {
        await this.processDurableCancel({
          applicationCommit: observed.request.fact.applicationCommit,
          reason: observed.request.fact.reason,
        });
      }
    };
    this.stopPolling = this.input.recurringTasks.startRecurringTask(25, async () => {
      this.pollTask = this.pollTask.then(poll).catch(() => undefined);
      await this.pollTask;
    });
  }

  async observeStarted(): Promise<void> {
    const snapshot = await this.input.activeRead.readStableSnapshot();
    await this.input.sessions.observeRunOwner({
      observationKind: "started",
      observedHead: snapshot.head.publicHead,
      ownerGenerationSha256: this.input.writer.lockNonceSha256,
      repositoryId: this.input.repositoryId,
      runId: this.input.runId,
      sessionId: this.input.sessionId,
    });
  }

  async validateTerminal(terminal: DecodedStoredEvent): Promise<void> {
    if (terminal.type !== "run.cancelled") return;
    await validateAndCloseAuthenticatedRunCancellation({
      repositoryId: this.input.repositoryId,
      runId: this.input.runId,
      sessionId: this.input.sessionId,
      sessions: this.input.sessions,
      terminal,
      writer: this.input.writer,
    });
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.stopPolling !== null) await this.stopPolling();
    await this.pollTask;
    this.releaseBroker?.();
    this.releaseBroker = null;
  }

  private processDurableCancel(request: Readonly<{
    readonly applicationCommit: ApplicationCommitBindingV1;
    readonly reason: "user";
  }>) {
    const result = this.cancelProcessing.then(async () => {
      const barrier = await this.input.sessions.readRunCancelBarrier(
        this.input.repositoryId,
        this.input.sessionId,
        this.input.runId,
      );
      if (
        barrier.owner?.fact.ownerGenerationSha256 !== this.input.writer.lockNonceSha256 ||
        barrier.request?.fact.applicationCommit.operationId !== request.applicationCommit.operationId ||
        sha256Canonical(barrier.request.fact.applicationCommit) !== sha256Canonical(request.applicationCommit)
      ) {
        throw new ApplicationControlError("control_operation_busy", "exact durable cancel request is unavailable for this owner");
      }
      const events = this.input.writer.events;
      const started = events.find((event) =>
        event.scope === "run" && event.runId === this.input.runId && event.type === "run.started"
      );
      if (started === undefined) throw new ApplicationControlError("control_operation_busy", "run owner has not published its durable start");
      const prior = events.filter((event) =>
        event.scope === "run" && event.runId === this.input.runId && event.type === "run.cancel.requested"
      );
      const owned = prior.find((event) => exactApplicationCommit(event, request.applicationCommit));
      if (owned === undefined && prior.length > 0) {
        throw new ApplicationControlError("control_operation_busy", "run already has another durable cancel request");
      }
      const cancelEvent = owned ?? await this.input.writer.appendPhase21RunControlEvent(
        this.input.runId,
        request.applicationCommit.operationId,
        "run.cancel.requested",
        {
          application_commit: {
            action_kind: request.applicationCommit.actionKind,
            authorization_decision_sha256: request.applicationCommit.authorizationDecisionSha256,
            operation_id: request.applicationCommit.operationId,
            prepared_action_sha256: request.applicationCommit.preparedActionSha256,
            principal_id: request.applicationCommit.principalId,
            schema_version: 1,
          },
          reason: request.reason,
          target_owner_generation_sha256: this.input.writer.lockNonceSha256,
          target_run_id: this.input.runId,
        },
      );
      const reference = eventReference(this.input.writer, cancelEvent);
      this.terminalBindingValue = Object.freeze({
        request_event_id: cancelEvent.eventId,
        request_event_sha256: reference.recordSha256,
        target_owner_generation_sha256: this.input.writer.lockNonceSha256,
      });
      await this.input.sessions.bindRunCancelRequest({
        cancelOperationId: request.applicationCommit.operationId,
        ownerGenerationSha256: this.input.writer.lockNonceSha256,
        repositoryId: this.input.repositoryId,
        runId: this.input.runId,
        sessionId: this.input.sessionId,
        sessionRequestReference: reference,
        terminalBinding: this.terminalBindingValue,
      });
      const snapshot = await this.input.activeRead.readStableSnapshot();
      this.controller.abort();
      return Object.freeze({
        head: snapshot.head,
        recordReference: reference,
        terminalBinding: this.terminalBindingValue,
      });
    });
    this.cancelProcessing = result.then(() => undefined, () => undefined);
    return result;
  }
}
