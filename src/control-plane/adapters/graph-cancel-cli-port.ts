import type { CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { persistedTaskUserOrigin } from "../../coordination/task-control-plane.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type { ActiveForegroundGraphRegistryPortV1 } from "../active-owner-router.js";
import { ExactSessionEvidenceReader } from "../exact-session-evidence-reader.js";
import type { SessionLedgerHeadSigner } from "../session-ledger-head.js";
import type {
  GraphCancelOwnerCommitV1,
  GraphCancelOwnerPortV1,
} from "../use-cases/graph-cancel-action.js";

type OwnerInput = Parameters<GraphCancelOwnerPortV1["execute"]>[0];

export interface GraphCancelObservationEvidenceV1 {
  readonly events: readonly DecodedStoredEvent[];
  readonly rawSha256: ReadonlyMap<string, string>;
}

function data(event: DecodedStoredEvent): Readonly<Record<string, unknown>> {
  return typeof event.data === "object" && event.data !== null
    ? event.data as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function exactApplicationCommit(event: DecodedStoredEvent, input: OwnerInput): boolean {
  const origin = data(event).origin;
  if (typeof origin !== "object" || origin === null) return false;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  if (typeof commit !== "object" || commit === null) return false;
  const value = commit as Readonly<Record<string, unknown>>;
  return value.schema_version === 1 && value.action_kind === input.applicationCommit.actionKind &&
    value.operation_id === input.applicationCommit.operationId &&
    value.authorization_decision_sha256 === input.applicationCommit.authorizationDecisionSha256 &&
    value.prepared_action_sha256 === input.applicationCommit.preparedActionSha256 &&
    value.principal_id === input.applicationCommit.principalId;
}

function applicationOperationId(event: DecodedStoredEvent): string | null {
  const origin = data(event).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  if (typeof commit !== "object" || commit === null) return null;
  const operationId = (commit as Readonly<Record<string, unknown>>).operation_id;
  return typeof operationId === "string" ? operationId : null;
}

function applicationCommitValue(event: DecodedStoredEvent): Readonly<Record<string, unknown>> | null {
  const origin = data(event).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof commit === "object" && commit !== null
    ? commit as Readonly<Record<string, unknown>>
    : null;
}

async function readAppendOnlyEvidence(workspace: string, sessionId: string): Promise<GraphCancelObservationEvidenceV1> {
  const evidence = await new ExactSessionEvidenceReader().read({ sessionId, workspace });
  return Object.freeze({ events: evidence.events, rawSha256: evidence.rawSha256 });
}

function exactExpectedPrefix(evidence: GraphCancelObservationEvidenceV1, input: OwnerInput, signer: SessionLedgerHeadSigner): boolean {
  const expected = evidence.events.at(input.expectedHead.sequence - 1);
  return input.expectedHead.sequence > 0 && input.expectedHead.sessionId === input.sessionId &&
    expected?.eventId === input.expectedHead.eventId &&
    expected.sessionSeq === input.expectedHead.sequence && expected.sessionId === input.sessionId &&
    signer.verify(input.expectedHead, evidence.rawSha256.get(expected.eventId) ?? null);
}

function sessionReference(event: DecodedStoredEvent, rawSha256: ReadonlyMap<string, string>): DurableRecordReferenceV1 {
  const raw = rawSha256.get(event.eventId);
  if (raw === undefined) throw new Error("Graph cancel raw event identity is unavailable");
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session" as const,
    recordId: event.eventId,
    recordSha256: raw,
    sequence: event.sessionSeq,
  });
}

function exactCancel(event: DecodedStoredEvent, input: OwnerInput): boolean {
  const value = data(event);
  return event.type === "task_graph.cancel.requested" && exactApplicationCommit(event, input) &&
    value.graph_revision === input.payload.revision && value.graph_sha256 === input.payload.sha256 &&
    value.reason === input.payload.reason && value.request_id === input.applicationCommit.operationId &&
    sha256Canonical(value.origin) === sha256Canonical(persistedTaskUserOrigin(
      input.authenticatedMutation.surface.surface === "tui" ? "tui" : "cli",
      input.authenticatedMutation,
    ));
}

function exactTerminal(event: DecodedStoredEvent | undefined, cancel: DecodedStoredEvent, input: OwnerInput): event is DecodedStoredEvent {
  if (event === undefined || event.sessionSeq !== cancel.sessionSeq + 1 || event.type !== "task_graph.terminal") return false;
  const value = data(event);
  return value.graph_revision === input.payload.revision && value.graph_sha256 === input.payload.sha256 &&
    value.status === "cancelled" && value.reason === "cancelled before another attempt was admitted";
}

function exactActiveTerminal(
  evidence: GraphCancelObservationEvidenceV1,
  cancel: DecodedStoredEvent,
  input: OwnerInput,
  activeAttemptId: string,
): Readonly<{ readonly attemptTerminal: DecodedStoredEvent; readonly graphTerminal: DecodedStoredEvent }> | null {
  const after = evidence.events.filter((event) => event.sessionSeq > cancel.sessionSeq);
  const attemptTerminals = after.filter((event) => {
    const value = data(event);
    return event.type === "task_node.attempt.terminal" &&
      value.graph_revision === input.payload.revision && value.graph_sha256 === input.payload.sha256 &&
      value.attempt_id === activeAttemptId && value.terminal === "cancelled_clean";
  });
  if (attemptTerminals.length !== 1) return null;
  const attemptTerminal = attemptTerminals[0]!;
  const graphTerminals = after.filter((event) => {
    const value = data(event);
    return event.sessionSeq > attemptTerminal.sessionSeq && event.type === "task_graph.terminal" &&
      value.graph_revision === input.payload.revision && value.graph_sha256 === input.payload.sha256 &&
      value.status === "cancelled";
  });
  return graphTerminals.length === 1
    ? Object.freeze({ attemptTerminal, graphTerminal: graphTerminals[0]! })
    : null;
}

export class CliGraphCancelOwnerPort implements GraphCancelOwnerPortV1 {
  constructor(private readonly options: Readonly<{
    readonly foregroundGraphControls: ActiveForegroundGraphRegistryPortV1;
    readonly readObservationEvidence?: (sessionId: string) => Promise<GraphCancelObservationEvidenceV1>;
    readonly runtime: CliRuntime;
    readonly signer: SessionLedgerHeadSigner;
  }>) {}

  async execute(input: OwnerInput): Promise<GraphCancelOwnerCommitV1> {
    let activeCancellation: Readonly<{
      readonly activeAttemptId: string | null;
      readonly control: NonNullable<ReturnType<ActiveForegroundGraphRegistryPortV1["active"]>>;
      readonly cancel: DecodedStoredEvent;
      readonly requestReference: DurableRecordReferenceV1;
    }>;
    const writerFactory = this.options.runtime.delegationWriterFactory;
    const writer = writerFactory === undefined
      ? await V2SessionWriter.openExisting(this.options.runtime.cwd, input.sessionId, {
      createEventId: this.options.runtime.randomUUID,
      timestamp: this.options.runtime.timestamp,
      })
      : await writerFactory(Object.freeze({
          authenticatedApplication: input.authenticatedMutation,
          inputSurface: input.authenticatedMutation.surface.surface === "tui" ? "tui" as const : "cli" as const,
          now: () => this.options.runtime.timestamp(),
          randomUuid: () => this.options.runtime.randomUUID(),
          sessionId: input.sessionId,
          workspace: this.options.runtime.cwd,
        }));
    this.options.runtime.observeSessionWriter?.(writer);
    try {
      const tail = writer.events.at(-1);
      if (input.expectedHead.sessionId !== input.sessionId || writer.events.length !== input.expectedHead.sequence || tail?.eventId !== input.expectedHead.eventId ||
          !this.options.signer.verify(input.expectedHead, writer.readDurableEventIdentity(tail.eventId).rawEventSha256)) {
        throw new Error("Graph cancel expected session head is stale or unauthenticated");
      }
      const before = reconstructMultiRunSession(writer.events);
      const execution = before.taskExecution;
      if (execution === null || execution.graph.revision !== input.payload.revision ||
          execution.graph.graphSha256 !== input.payload.sha256 ||
          !["queued", "running", "waiting_for_user", "awaiting_integration"].includes(execution.status)) {
        throw new Error("Graph cancel selector does not exact-match an active Graph");
      }
      const background = before.background.current;
      if (background !== null && (background.status !== "running" || background.graphRevision !== input.payload.revision ||
          background.graphSha256 !== input.payload.sha256)) {
        throw new Error("Graph cancel background owner identity is stale");
      }
      const cancel = await writer.appendTaskGraphEvent("task_graph.cancel.requested", {
        active_attempt_id: execution.activeAttempt?.attemptId ?? null,
        graph_id: execution.graph.graphId,
        graph_revision: execution.graph.revision,
        graph_sha256: execution.graph.graphSha256,
        origin: persistedTaskUserOrigin(
          input.authenticatedMutation.surface.surface === "tui" ? "tui" : "cli",
          input.authenticatedMutation,
        ),
        reason: input.payload.reason,
        request_id: input.applicationCommit.operationId,
      });
      let terminal: DecodedStoredEvent | null = null;
      if (background === null && execution.activeAttempt === null) {
        terminal = await writer.appendTaskGraphEvent("task_graph.terminal", {
          graph_id: execution.graph.graphId,
          graph_revision: execution.graph.revision,
          graph_sha256: execution.graph.graphSha256,
          reason: "cancelled before another attempt was admitted",
          status: "cancelled",
        });
      }
      const cancelIdentity = writer.readDurableEventIdentity(cancel.eventId);
      const evidence = Object.freeze({
        events: Object.freeze([...writer.events]),
        rawSha256: new Map(writer.events.map((event) => [event.eventId, writer.readDurableEventIdentity(event.eventId).rawEventSha256])),
      });
      if (background !== null) {
        const queue = this.options.runtime.queueBackgroundWorkerCancel;
        if (queue === undefined) throw new Error("runtime has no exact background control capability");
        const queued = await queue({
          authenticatedMutation: input.authenticatedMutation,
          current: background,
          graphRevision: input.payload.revision,
          graphSha256: input.payload.sha256,
          reason: input.payload.reason,
          repositoryId: background.repositoryId,
          requestId: input.applicationCommit.operationId,
          requestedAt: cancel.timestamp,
          sessionCancel: {
            eventId: cancel.eventId,
            rawEventSha256: cancelIdentity.rawEventSha256,
            sessionSeq: cancel.sessionSeq,
          },
          sessionId: input.sessionId,
        });
        return this.backgroundCommit(input, cancel, evidence.rawSha256, execution.graph, background.operationId, queued.controlSha256, background.workerId);
      }
      const control = this.options.foregroundGraphControls.active(input.sessionId);
      const start = [...before.events].reverse().find((event) => {
        const value = data(event);
        return event.type === "task_graph.started" &&
          value.graph_revision === input.payload.revision && value.graph_sha256 === input.payload.sha256;
      });
      const ownerCommit = start === undefined ? null : applicationCommitValue(start);
      if (control === null) {
        if (execution.activeAttempt !== null) {
          throw new Error("active foreground Graph attempt has no process-local owner control");
        }
        return this.localCommit(input, cancel, terminal, evidence);
      }
      if (
        control.graphRevision !== input.payload.revision ||
        control.graphSha256 !== input.payload.sha256 || ownerCommit === null ||
        (ownerCommit.action_kind !== "graph.run" && ownerCommit.action_kind !== "graph.resume") ||
        ownerCommit.operation_id !== control.ownerApplicationOperationId ||
        ownerCommit.prepared_action_sha256 !== control.ownerPreparedActionSha256
      ) {
        throw new Error("active foreground Graph control is not exact-bound to its durable ApplicationService owner");
      }
      activeCancellation = Object.freeze({
        activeAttemptId: execution.activeAttempt?.attemptId ?? null,
        control,
        cancel,
        requestReference: sessionReference(cancel, evidence.rawSha256),
      });
    } finally {
      await writer.close().catch(() => undefined);
    }
    if (this.options.foregroundGraphControls.active(input.sessionId) !== activeCancellation.control) {
      throw new Error("active foreground Graph owner is unavailable after its durable cancel request");
    }
    await activeCancellation.control.requestCancel({ requestReference: activeCancellation.requestReference });
    const evidence = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    if (activeCancellation.activeAttemptId === null) {
      const terminal = evidence.events.at(activeCancellation.cancel.sessionSeq);
      if (!exactTerminal(terminal, activeCancellation.cancel, input)) {
        throw new Error("active foreground Graph did not preserve its exact pre-attempt terminal");
      }
      return this.localCommit(input, activeCancellation.cancel, terminal, evidence);
    }
    const terminal = exactActiveTerminal(evidence, activeCancellation.cancel, input, activeCancellation.activeAttemptId);
    if (terminal === null) throw new Error("active foreground Graph did not persist one exact cancelled terminal chain");
    return this.localCommit(
      input,
      activeCancellation.cancel,
      terminal.graphTerminal,
      evidence,
      Object.freeze([terminal.attemptTerminal]),
    );
  }

  async reconcile(input: OwnerInput): Promise<GraphCancelOwnerCommitV1 | null> {
    let evidence: GraphCancelObservationEvidenceV1;
    try {
      evidence = await (this.options.readObservationEvidence?.(input.sessionId) ??
        readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId));
    } catch {
      return null;
    }
    if (!exactExpectedPrefix(evidence, input, this.options.signer)) return null;
    const fresh = evidence.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
    if (fresh.some((event) =>
      applicationOperationId(event) === input.applicationCommit.operationId && !exactApplicationCommit(event, input)
    )) return null;
    const owned = fresh.filter((event) => exactApplicationCommit(event, input));
    const matches = owned.filter((event) => exactCancel(event, input));
    if (owned.length !== 1) return null;
    if (matches.length !== 1 || matches[0]!.sessionSeq !== input.expectedHead.sequence + 1) return null;
    const cancel = matches[0]!;
    let before;
    try {
      before = reconstructMultiRunSession(evidence.events.slice(0, input.expectedHead.sequence));
    } catch {
      return null;
    }
    const execution = before.taskExecution;
    if (execution === null || execution.graph.revision !== input.payload.revision || execution.graph.graphSha256 !== input.payload.sha256) return null;
    const background = before.background.current;
    if (background === null) {
      if (execution.activeAttempt === null) {
        const candidate = evidence.events.at(cancel.sessionSeq);
        if (!exactTerminal(candidate, cancel, input)) return null;
        return this.localCommit(input, cancel, candidate, evidence);
      }
      const activeTerminal = exactActiveTerminal(evidence, cancel, input, execution.activeAttempt.attemptId);
      if (activeTerminal === null) return null;
      return this.localCommit(
        input,
        cancel,
        activeTerminal.graphTerminal,
        evidence,
        Object.freeze([activeTerminal.attemptTerminal]),
      );
    }
    if (background.status !== "running" ||
        background.graphRevision !== input.payload.revision || background.graphSha256 !== input.payload.sha256) return null;
    const observe = this.options.runtime.observeBackgroundWorkerCancel;
    if (observe === undefined) return null;
    let observed;
    try {
      observed = await observe({
        backgroundOperationId: background.operationId,
        repositoryId: background.repositoryId,
        requestId: input.applicationCommit.operationId,
      });
    } catch {
      return null;
    }
    if (observed === null || observed.control.schemaVersion !== 2) return null;
    const control = observed.control;
    const expectedOrigin = persistedTaskUserOrigin(
      input.authenticatedMutation.surface.surface === "tui" ? "tui" : "cli",
      input.authenticatedMutation,
    );
    if (control.operationId !== background.operationId || control.repositoryId !== background.repositoryId ||
        control.sessionId !== input.sessionId || control.workerId !== background.workerId ||
        control.workerNonceSha256 !== background.workerNonceSha256 || control.graphId !== background.graphId ||
        control.graphRevision !== input.payload.revision || control.graphSha256 !== input.payload.sha256 ||
        control.reason !== input.payload.reason || control.requestId !== input.applicationCommit.operationId ||
        control.requestedAt !== cancel.timestamp ||
        control.sessionCancel.eventId !== cancel.eventId || control.sessionCancel.sessionSeq !== cancel.sessionSeq ||
        control.sessionCancel.rawEventSha256 !== evidence.rawSha256.get(cancel.eventId) ||
        observed.controlSha256 !== sha256Canonical(control) || sha256Canonical(control.origin) !== sha256Canonical(expectedOrigin)) return null;
    return this.backgroundCommit(input, cancel, evidence.rawSha256, execution.graph, background.operationId, observed.controlSha256, background.workerId);
  }

  private backgroundCommit(
    input: OwnerInput,
    cancel: DecodedStoredEvent,
    rawSha256: ReadonlyMap<string, string>,
    graph: NonNullable<ReturnType<typeof reconstructMultiRunSession>["taskExecution"]>["graph"],
    backgroundOperationId: string,
    controlSha256: string,
    workerId: string,
  ): GraphCancelOwnerCommitV1 {
    const primary = sessionReference(cancel, rawSha256);
    const head = this.options.signer.create({
      eventId: cancel.eventId,
      rawEventSha256: primary.recordSha256,
      sequence: cancel.sessionSeq,
      sessionId: input.sessionId,
    }).publicHead;
    return Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      domainRecordRefs: Object.freeze([primary]),
      primaryDomainRecord: primary,
      primaryEventType: "task_graph.cancel.requested",
      resolvedHead: head,
      result: Object.freeze({
        accepted: true,
        controlSha256,
        delivery: "background_control_queued",
        graph,
        operationId: backgroundOperationId,
        requestId: input.applicationCommit.operationId,
        terminal: false,
        workerId,
      }),
      underlyingOperationRefs: Object.freeze([Object.freeze({
        ledgerId: `background:${backgroundOperationId}`,
        ownerKind: "effect" as const,
        recordId: `cancel:${input.applicationCommit.operationId}`,
        recordSha256: controlSha256,
        sequence: null,
      })]),
    });
  }

  private localCommit(
    input: OwnerInput,
    cancel: DecodedStoredEvent,
    terminal: DecodedStoredEvent | null,
    evidence: GraphCancelObservationEvidenceV1,
    precedingUnderlying: readonly DecodedStoredEvent[] = Object.freeze([]),
  ): GraphCancelOwnerCommitV1 {
    const primary = sessionReference(cancel, evidence.rawSha256);
    const end = terminal ?? cancel;
    const endReference = sessionReference(end, evidence.rawSha256);
    const bounded = evidence.events.slice(0, end.sessionSeq);
    const execution = reconstructMultiRunSession(bounded).taskExecution;
    if (execution === null) throw new Error("Graph cancel result did not reconstruct");
    return Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      domainRecordRefs: Object.freeze([primary]),
      primaryDomainRecord: primary,
      primaryEventType: "task_graph.cancel.requested",
      resolvedHead: this.options.signer.create({
        eventId: end.eventId,
        rawEventSha256: endReference.recordSha256,
        sequence: end.sessionSeq,
        sessionId: input.sessionId,
      }).publicHead,
      result: Object.freeze({ delivery: "session_request", execution, graph: execution.graph }),
      underlyingOperationRefs: terminal === null
        ? Object.freeze([])
        : Object.freeze([
            ...precedingUnderlying.map((event) => sessionReference(event, evidence.rawSha256)),
            endReference,
          ]),
    });
  }
}
