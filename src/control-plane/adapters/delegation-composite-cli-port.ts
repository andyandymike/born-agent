import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  executeDelegationOwnerPrepare,
  executeDelegationOwnerResume,
  executeDelegationOwnerStart,
  openDelegationOwnerWriter,
  readDelegationOwnerEvidence,
  type DelegationOwnerInteractionPortV1,
  type DelegationOwnerExecutionV1,
  type DelegationOwnerRuntimePortV1,
} from "../../delegation/delegation-owner-execution-service.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  borrowedTaskMutationWriterFactory,
  taskUserOrigin,
  type TaskMutationContext,
} from "../../coordination/task-control-plane.js";
import { DelegationError } from "../../delegation/delegation-errors.js";
import { DelegationControlPlane } from "../../delegation/delegation-control-plane.js";
import { durableDelegationCancelSignalV1Schema } from "../../delegation/delegation-cancellation-signal.js";
import { preparedChildEnvelopeSchema } from "../../delegation/context/child-envelope-schema.js";
import { contextCapsuleSchema } from "../../delegation/context/context-capsule-schema.js";
import type { DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { SessionLockError } from "../../sessions/session-lock.js";
import { V2SessionWriter } from "../../sessions/v2-session-writer.js";
import { parseStrictJson } from "../../system/strict-json.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type {
  ActiveDelegationControlPortV1,
} from "../active-delegation-control-registry.js";
import type { ActiveDelegationRegistryPortV1 } from "../active-owner-router.js";
import type { ActiveSessionWriterObserverFactoryV1 } from "../local-control-plane.js";
import type { SessionLedgerHeadSigner } from "../session-ledger-head.js";
import type {
  DelegationCompositeResultV1,
  DelegationCompositeOwnerCommitV1,
  DelegationCompositeOwnerPortV1,
  DelegationCompositeOwnerRequestV1,
  DelegationGroupTerminalItemV1,
} from "../use-cases/delegation-composite-actions.js";
import { sessionEventReference } from "../use-cases/session-domain-action-support.js";

const START_COMMON_EVIDENCE = Object.freeze([
  "delegation.group.lease.acquired",
  "delegation.parent.barrier.requested",
  "delegation.parent.barrier.suspended",
  "delegation.actor_slot.claimed",
  "delegation.conflict_claim.granted",
  "delegation.budget.reserved",
  "delegation.child.launch_requested",
  "delegation.budget.settled",
  "delegation.conflict_claim.released",
  "delegation.actor_slot.released",
  "delegation.parent.barrier.released",
] as const);

function exactApplicationCommit(
  event: DecodedStoredEvent,
  binding: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
): boolean {
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Readonly<Record<string, unknown>>;
  const ownerCommit = data.owner_application_commit;
  const origin = data.origin;
  const commit = typeof ownerCommit === "object" && ownerCommit !== null
    ? ownerCommit
    : typeof origin === "object" && origin !== null
      ? (origin as Readonly<Record<string, unknown>>).application_commit
      : null;
  if (typeof commit !== "object" || commit === null) return false;
  const value = commit as Readonly<Record<string, unknown>>;
  return value.schema_version === 1 &&
    value.operation_id === binding.operationId &&
    value.action_kind === binding.actionKind &&
    value.prepared_action_sha256 === binding.preparedActionSha256 &&
    value.principal_id === binding.principalId &&
    value.authorization_decision_sha256 === binding.authorizationDecisionSha256;
}

function isTransientWriterHandoff(error: unknown): boolean {
  return (error instanceof SessionLockError && error.code === "active_session_lock") ||
    (error instanceof Error && error.message === "session writer is closed");
}

function eventReference(event: DecodedStoredEvent, rawSha256: ReadonlyMap<string, string>): DurableRecordReferenceV1 {
  const recordSha256 = rawSha256.get(event.eventId);
  if (recordSha256 === undefined) {
    throw new DelegationError("delegation_effect_reconciliation_required", "Delegation raw event identity is unavailable");
  }
  return Object.freeze({
    ledgerId: `session:${event.sessionId}`,
    ownerKind: "session" as const,
    recordId: event.eventId,
    recordSha256,
    sequence: event.sessionSeq,
  });
}

function resolvedHead(
  events: readonly DecodedStoredEvent[],
  rawSha256: ReadonlyMap<string, string>,
  signer: SessionLedgerHeadSigner,
) {
  const end = events.reduce((latest, event) => event.sessionSeq > latest.sessionSeq ? event : latest);
  const raw = rawSha256.get(end.eventId);
  if (raw === undefined) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation composite commit end raw identity is unavailable");
  return signer.create({ eventId: end.eventId, rawEventSha256: raw, sequence: end.sessionSeq, sessionId: end.sessionId }).publicHead;
}

type DelegationCompositeObservationEvidenceV1 = Awaited<ReturnType<typeof readDelegationOwnerEvidence>>;
type DelegationGroupTakeoverCompositeResultV1 = Extract<DelegationCompositeResultV1, { readonly kind: "group_takeover" }>;

function assertExpectedHead(
  events: readonly DecodedStoredEvent[],
  input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0],
  rawSha256: ReadonlyMap<string, string>,
  signer: SessionLedgerHeadSigner,
): void {
  const tail = events.at(-1);
  if (
    events.length !== input.expectedHead.sequence ||
    tail?.sessionSeq !== input.expectedHead.sequence ||
    tail.eventId !== input.expectedHead.eventId ||
    tail.sessionId !== input.expectedHead.sessionId ||
    !signer.verify(input.expectedHead, rawSha256.get(tail.eventId) ?? null)
  ) {
    throw new DelegationError("delegation_revision_conflict", "session changed before Delegation composite owner dispatch");
  }
}

function required(events: readonly DecodedStoredEvent[], type: string): DecodedStoredEvent {
  const event = events.find((candidate) => candidate.type === type);
  if (event === undefined) {
    throw new DelegationError("delegation_effect_reconciliation_required", `Delegation owner did not persist ${type}`);
  }
  return event;
}

function localSurface(input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0]): "cli" | "tui" {
  const surface = input.authenticatedMutation.surface.surface;
  if (surface !== "cli" && surface !== "tui") {
    throw new DelegationError("delegation_authority_expansion", "CLI Delegation owner received a non-local surface");
  }
  return surface;
}

function dataRecord(event: DecodedStoredEvent): Readonly<Record<string, unknown>> {
  return typeof event.data === "object" && event.data !== null
    ? event.data as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function dataValue(event: DecodedStoredEvent, name: string): unknown {
  return dataRecord(event)[name];
}

function applicationOperationId(event: DecodedStoredEvent): string | null {
  const ownerCommit = dataValue(event, "owner_application_commit");
  const origin = dataValue(event, "origin");
  const commit = typeof ownerCommit === "object" && ownerCommit !== null
    ? ownerCommit
    : typeof origin === "object" && origin !== null
      ? (origin as Readonly<Record<string, unknown>>).application_commit
      : null;
  if (typeof commit !== "object" || commit === null) return null;
  const value = (commit as Readonly<Record<string, unknown>>).operation_id;
  return typeof value === "string" ? value : null;
}

function authenticatedActionKind(event: DecodedStoredEvent, actionKind: string): boolean {
  const origin = dataValue(event, "origin");
  if (typeof origin !== "object" || origin === null ||
      (origin as Readonly<Record<string, unknown>>).kind !== "authenticated_surface") return false;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  return typeof commit === "object" && commit !== null &&
    (commit as Readonly<Record<string, unknown>>).schema_version === 1 &&
    (commit as Readonly<Record<string, unknown>>).action_kind === actionKind;
}

function samePersistedApplicationCommit(left: DecodedStoredEvent, right: DecodedStoredEvent): boolean {
  const read = (event: DecodedStoredEvent) => {
    const origin = dataValue(event, "origin");
    if (typeof origin !== "object" || origin === null) return null;
    const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
    return typeof commit === "object" && commit !== null ? commit as Readonly<Record<string, unknown>> : null;
  };
  const a = read(left);
  const b = read(right);
  if (a === null || b === null) return false;
  return a.schema_version === b.schema_version && a.operation_id === b.operation_id &&
    a.action_kind === b.action_kind && a.prepared_action_sha256 === b.prepared_action_sha256 &&
    a.principal_id === b.principal_id && a.authorization_decision_sha256 === b.authorization_decision_sha256;
}

function exactExpectedPrefix(
  events: readonly DecodedStoredEvent[],
  input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0],
  rawSha256: ReadonlyMap<string, string>,
  signer: SessionLedgerHeadSigner,
): boolean {
  const expected = events.at(input.expectedHead.sequence - 1);
  return input.expectedHead.sequence > 0 && expected?.sessionSeq === input.expectedHead.sequence &&
    expected.eventId === input.expectedHead.eventId && expected.sessionId === input.expectedHead.sessionId &&
    signer.verify(input.expectedHead, rawSha256.get(expected.eventId) ?? null);
}

function uniqueEvent(
  events: readonly DecodedStoredEvent[],
  type: string,
  predicate: (event: DecodedStoredEvent) => boolean = () => true,
): DecodedStoredEvent | null {
  const matches = events.filter((event) => event.type === type && predicate(event));
  return matches.length === 1 ? matches[0]! : null;
}

async function readExactPreparedArtifact(
  workspace: string,
  sessionId: string,
  reference: unknown,
): Promise<Readonly<{ readonly bytes: Buffer; readonly value: unknown }> | null> {
  if (typeof reference !== "object" || reference === null) return null;
  const value = reference as Readonly<Record<string, unknown>>;
  if (
    typeof value.artifact_id !== "string" || typeof value.object_ref !== "string" ||
    typeof value.sha256 !== "string" || typeof value.bytes !== "number" ||
    value.artifact_id !== `sha256:${value.sha256}` ||
    value.object_ref !== `artifacts/${sessionId}/objects/${value.sha256}`
  ) return null;
  const bytes = await readFile(resolve(workspace, ".bornagent", ...value.object_ref.split("/")));
  if (bytes.byteLength !== value.bytes || createHash("sha256").update(bytes).digest("hex") !== value.sha256) return null;
  return Object.freeze({ bytes, value: parseStrictJson(bytes.toString("utf8")) });
}

export class CliDelegationCompositeOwnerPort implements DelegationCompositeOwnerPortV1 {
  constructor(private readonly options: Readonly<{
    readonly activeDelegations: ActiveDelegationRegistryPortV1;
    readonly activeSessionWriterObserverFactory?: ActiveSessionWriterObserverFactoryV1;
    readonly interaction: DelegationOwnerInteractionPortV1;
    /** Test/embedded read port; production defaults to the strict raw JSONL reader above. */
    readonly readObservationEvidence?: (sessionId: string) => Promise<DelegationCompositeObservationEvidenceV1>;
    readonly runtime: DelegationOwnerRuntimePortV1;
    readonly signer: SessionLedgerHeadSigner;
  }>) {}

  async #runtimeForActiveSession(
    input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0],
    activeWriter: { current: V2SessionWriter | null },
  ): Promise<DelegationOwnerRuntimePortV1> {
    if (this.options.activeSessionWriterObserverFactory === undefined) {
      return this.options.runtime;
    }
    const observeActiveWriter = await this.options.activeSessionWriterObserverFactory({
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
    });
    const observed = new WeakSet<object>();
    const base = this.options.runtime;
    return Object.freeze({
      ...base,
      observeSessionWriter: (
        writer: Parameters<NonNullable<DelegationOwnerRuntimePortV1["observeSessionWriter"]>>[0],
      ) => {
        if (observed.has(writer)) return;
        base.observeSessionWriter?.(writer);
        if (!(writer instanceof V2SessionWriter)) {
          throw new DelegationError(
            "delegation_effect_reconciliation_required",
            "Delegation active projection requires the exact V2 session writer",
          );
        }
        observeActiveWriter(writer);
        if (activeWriter.current !== null && activeWriter.current !== writer) {
          throw new DelegationError(
            "delegation_effect_reconciliation_required",
            "Delegation owner exposed overlapping active session writers",
          );
        }
        activeWriter.current = writer;
        writer.subscribeClose(() => {
          if (activeWriter.current === writer) activeWriter.current = null;
        });
        observed.add(writer);
      },
    });
  }

  async execute(input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0]): Promise<DelegationCompositeOwnerCommitV1> {
    const activeWriter = { current: null as V2SessionWriter | null };
    const runtime = await this.#runtimeForActiveSession(input, activeWriter);
    const beforeEvidence = await readDelegationOwnerEvidence(
      runtime,
      input.sessionId,
      localSurface(input),
    );
    assertExpectedHead(beforeEvidence.events, input, beforeEvidence.rawSha256, this.options.signer);
    const cancellation = new AbortController();
    const authority: DelegationOwnerExecutionV1 = Object.freeze({
      authenticatedMutation: input.authenticatedMutation,
      cancellationSignal: cancellation.signal,
    });
    if (input.request.actionKind === "delegation.resume") {
      await this.#appendResumeFence(input, beforeEvidence.events, authority, runtime);
    }
    const options = Object.freeze({
      delegationId: input.request.payload.delegationId,
      inputSurface: localSurface(input),
      sessionId: input.sessionId,
    });
    const executeOwner = () => input.request.actionKind === "delegation.prepare"
      ? executeDelegationOwnerPrepare(options, runtime, this.options.interaction, authority)
      : input.request.actionKind === "delegation.start"
        ? executeDelegationOwnerStart(options, runtime, this.options.interaction, authority)
        : executeDelegationOwnerResume(options, runtime, this.options.interaction, authority);
    let releaseActive: (() => void) | null = null;
    if (input.request.actionKind !== "delegation.prepare") {
      releaseActive = this.options.activeDelegations.register(input.sessionId, Object.freeze({
        delegationId: input.request.payload.delegationId,
        ownerApplicationOperationId: input.applicationCommit.operationId,
        ownerPreparedActionSha256: input.applicationCommit.preparedActionSha256,
        requestCancel: (
          cancelInput: Parameters<ActiveDelegationControlPortV1["requestCancel"]>[0],
        ) => this.#requestCancelWithActiveWriter(
          activeWriter,
          runtime,
          cancelInput,
        ),
        requestPreEffectAbort: (
          cancel: Parameters<ActiveDelegationControlPortV1["requestPreEffectAbort"]>[0],
        ) => cancellation.abort(cancel),
        requestHostEmergencyStop: () => cancellation.abort("tui_surface_fatal"),
      }));
    }
    let outcome;
    try {
      outcome = await executeOwner();
    } finally {
      releaseActive?.();
    }
    // Cross-process typed cancellation has no process-local signal. The owner
    // returns only this bounded diagnostic; #appendPreEffectTerminal then
    // independently requires the unique authenticated durable cancel request
    // and proves that no group/child admission was appended.
    if (
      outcome.exitCode === 130 && outcome.result === null &&
      outcome.diagnostic?.code === "delegation_cancelled" &&
      input.request.actionKind !== "delegation.prepare"
    ) {
      outcome = Object.freeze({
        diagnostic: null,
        exitCode: 0 as const,
        result: await this.#appendPreEffectTerminal(input, authority, runtime),
      });
    }
    const exactKnownBlockedTerminal = outcome.exitCode === 8 &&
      outcome.result?.kind === "group_terminal" && outcome.result.terminalStatus === "blocked";
    if ((outcome.exitCode !== 0 && !exactKnownBlockedTerminal) || outcome.result === null) {
      throw new DelegationError(
        "delegation_effect_reconciliation_required",
        `Delegation owner did not reach an exact successful terminal predicate (exit ${String(outcome.exitCode)})`,
      );
    }
    const captured = outcome.result;
    const evidence = await readDelegationOwnerEvidence(
      runtime,
      input.sessionId,
      localSurface(input),
    );
    const fresh = evidence.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
    const owned = fresh.filter((event) => exactApplicationCommit(event, input.applicationCommit));
    const primaryType = captured.kind === "pre_effect_terminal"
      ? "delegation.owner.pre_effect.terminal"
      : input.request.actionKind === "delegation.prepare"
      ? "delegation.envelope.prepared"
      : input.request.actionKind === "delegation.start"
        ? "delegation.group.lease.acquired"
        : "delegation.resume.requested";
    const primary = required(owned, primaryType);
    const underlying = await this.#underlying(
      input.request,
      evidence.events,
      fresh,
      primary,
      captured,
    );
    if (owned.length === 0 || owned.length > 128 || underlying.length === 0 || underlying.length > 128) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation evidence is missing or exceeds the bounded link set");
    }
    const commitEvents = Object.freeze([...owned, ...underlying]);
    return Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      domainRecordRefs: Object.freeze(owned.map((event) => eventReference(event, evidence.rawSha256))),
      primaryDomainRecord: eventReference(primary, evidence.rawSha256),
      primaryEventType: primary.type,
      resolvedHead: resolvedHead(commitEvents, evidence.rawSha256, this.options.signer),
      result: captured,
      underlyingOperationRefs: Object.freeze(underlying.map((event) => eventReference(event, evidence.rawSha256))),
    });
  }

  async #requestCancelWithActiveWriter(
    activeWriter: { current: V2SessionWriter | null },
    runtime: DelegationOwnerRuntimePortV1,
    input: Parameters<ActiveDelegationControlPortV1["requestCancel"]>[0],
  ): ReturnType<ActiveDelegationControlPortV1["requestCancel"]> {
    const scope = input.context.resolvedTarget.resourceScope;
    const version = input.context.resolvedTarget.resourceVersion;
    if (scope.kind !== "session" || version.kind !== "session_ledger_head") {
      throw new DelegationError("delegation_revision_conflict", "active Delegation cancellation target is invalid");
    }
    const surface = input.context.call.surface.surface;
    if (surface !== "cli" && surface !== "tui") {
      throw new DelegationError("delegation_authority_expansion", "Delegation cancellation requires a local surface");
    }
    const baseMutationContext: TaskMutationContext = Object.freeze({
      authenticatedApplication: Object.freeze({
        actionIdentitySha256: sha256Canonical({
          application_commit: input.context.applicationCommit,
          resource_scope: scope,
          schema_version: 1,
        }),
        applicationCommit: input.context.applicationCommit,
        authenticationId: input.context.call.principal.authenticationId,
        requestId: input.context.requestId,
        surface: input.context.call.surface,
      }),
      inputSurface: surface,
      now: () => runtime.timestamp(),
      randomUuid: () => runtime.randomUUID(),
      sessionId: scope.sessionId,
      workspace: runtime.cwd,
    });
    const requestWithWriter = async (writer: V2SessionWriter) => {
      const tail = writer.readDurableTailIdentity();
      if (scope.sessionId !== tail.sessionId) {
        throw new DelegationError("delegation_revision_conflict", "active Delegation cancellation target is invalid");
      }
      const expectedIdentity = version.head.sequence === 0
        ? null
        : writer.readDurableEventIdentity(version.head.eventId!);
      const expectedRawSha256 = expectedIdentity?.rawEventSha256 ?? null;
      if (
        (expectedIdentity !== null && (
          expectedIdentity.sequence !== version.head.sequence ||
          expectedIdentity.sessionId !== version.head.sessionId
        )) ||
        !this.options.signer.verify(version.head, expectedRawSha256)
      ) {
        throw new DelegationError(
          "delegation_revision_conflict",
          "Delegation cancellation prepared head is not an exact durable prefix",
        );
      }
      // The commit already revalidated the prepared target. The active owner
      // may append progress between that check and dispatch, so a
      // safety-reducing cancellation binds the signed prepared prefix and then
      // appends at the exact current writer tail. Requiring tail equality here
      // creates a post-dispatch unknown-effect race under ordinary progress.
      const mutationContext: TaskMutationContext = Object.freeze({
        ...baseMutationContext,
        expectedSessionSeq: tail.sequence,
      });
    const operationEvents = writer.events.filter((event) => applicationOperationId(event) === input.context.operationId);
    if (
      operationEvents.length > 1 ||
      operationEvents.some((event) =>
        event.type !== "delegation.cancel.requested" ||
        !exactApplicationCommit(event, input.context.applicationCommit)
      )
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "active Delegation cancellation evidence is ambiguous");
    }
    if (operationEvents.length === 0 && input.reconcileOnly) return null;
    if (operationEvents.length === 0) {
      await new DelegationControlPlane(borrowedTaskMutationWriterFactory(writer)).cancel({
        context: mutationContext,
        delegationId: input.delegationId,
        reason: input.reason,
      });
    }
    const owned = writer.events.filter((event) => applicationOperationId(event) === input.context.operationId);
    const request = owned.length === 1 ? owned[0]! : null;
    if (
      request === null || request.type !== "delegation.cancel.requested" ||
      !exactApplicationCommit(request, input.context.applicationCommit)
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "active Delegation cancellation was not durable");
    }
    const delegationId = dataValue(request, "delegation_id");
    const delegationRevision = dataValue(request, "delegation_revision");
    const delegationSha256 = dataValue(request, "delegation_sha256");
    const projection = reconstructMultiRunSession(writer.events);
    const result = projection.delegations.revisions.find((candidate) =>
      candidate.delegationId === delegationId &&
      candidate.delegationRevision === delegationRevision &&
      candidate.delegationSha256 === delegationSha256
    );
    if (result === undefined || result.delegationId !== input.delegationId) {
      throw new DelegationError("delegation_effect_reconciliation_required", "active Delegation cancellation projection is unavailable");
    }
    const reference = sessionEventReference(writer, request);
    const identity = writer.readDurableEventIdentity(request.eventId);
    const execution = Object.freeze({
      domainRecordRefs: Object.freeze([reference]),
      primaryDomainRecord: reference,
      resolvedResourceScope: scope,
      resolvedResourceVersion: Object.freeze({
        head: this.options.signer.create(identity).publicHead,
        kind: "session_ledger_head" as const,
      }),
      result,
      underlyingOperationRefs: Object.freeze([]),
    });
    if (!input.reconcileOnly) {
      const active = this.options.activeDelegations.active(scope.sessionId);
      if (active === null || active.delegationId !== input.delegationId) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation owner disappeared after durable cancellation");
      }
      active.requestPreEffectAbort(durableDelegationCancelSignalV1Schema.parse({
        cancelRequestId: request.data.cancel_request_id,
        delegationId: request.data.delegation_id,
        delegationRevision: request.data.delegation_revision,
        delegationSha256: request.data.delegation_sha256,
        kind: "durable_delegation_cancel",
        parentActorId: request.data.parent_actor_id,
        parentRunId: request.data.parent_run_id,
        reason: request.data.reason,
        requestEventId: request.eventId,
        requestOperationId: input.context.operationId,
        schemaVersion: 1,
      }));
    }
      return execution;
    };
    for (let attempt = 0; attempt < 512; attempt += 1) {
      let writer = activeWriter.current;
      let closeWriter = false;
      try {
        if (writer === null || writer.isClosed()) {
          writer = await this.#openWriter(runtime, baseMutationContext);
          closeWriter = true;
        }
        return await requestWithWriter(writer);
      } catch (error) {
        if (!isTransientWriterHandoff(error) || attempt === 511) throw error;
      } finally {
        if (closeWriter && writer !== null) await writer.close().catch(() => undefined);
      }
      // A closing writer can lose only before the append gate. Re-acquiring the
      // exact session writer and scanning this Application operation id is safe:
      // an already-durable request is observed, never appended twice.
      await runtime.waitForRetry(10);
    }
    throw new DelegationError("delegation_effect_reconciliation_required", "Delegation cancellation writer handoff did not converge");
  }

  /** Observation-only response-loss recovery; no command or owner effect is invoked. */
  async reconcile(input: Parameters<NonNullable<DelegationCompositeOwnerPortV1["reconcile"]>>[0]): Promise<DelegationCompositeOwnerCommitV1 | null> {
    try {
      const evidence = await (this.options.readObservationEvidence?.(input.sessionId) ??
        readDelegationOwnerEvidence(
          this.options.runtime,
          input.sessionId,
          localSurface(input),
        ));
      if (!exactExpectedPrefix(evidence.events, input, evidence.rawSha256, this.options.signer)) return null;
      const fresh = evidence.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
      if (fresh.some((event) =>
        applicationOperationId(event) === input.applicationCommit.operationId &&
        !exactApplicationCommit(event, input.applicationCommit)
      )) return null;
      const owned = fresh.filter((event) => exactApplicationCommit(event, input.applicationCommit));
      if (owned.length === 0 || owned.length > 128) return null;
      const recovered = await this.#reconstruct(input, evidence.events, fresh, owned);
      if (recovered === null) return null;
      const primaryType = recovered.result.kind === "pre_effect_terminal"
        ? "delegation.owner.pre_effect.terminal"
        : input.request.actionKind === "delegation.resume"
        ? "delegation.resume.requested"
        : input.request.actionKind === "delegation.prepare"
          ? "delegation.envelope.prepared"
          : "delegation.group.lease.acquired";
      const primary = uniqueEvent(owned, primaryType, (event) =>
        input.request.actionKind === "delegation.start" ||
        dataValue(event, "delegation_id") === input.request.payload.delegationId
      );
      if (primary === null) return null;
      const underlying = await this.#underlying(
        input.request,
        evidence.events,
        fresh,
        primary,
        recovered.result,
      );
      if (owned.length === 0 || owned.length > 128 || underlying.length === 0 || underlying.length > 128) return null;
      const commitEvents = Object.freeze([...owned, ...underlying]);
      return Object.freeze({
        applicationOperationId: input.applicationCommit.operationId,
        domainRecordRefs: Object.freeze(owned.map((event) => eventReference(event, evidence.rawSha256))),
        primaryDomainRecord: eventReference(primary, evidence.rawSha256),
        primaryEventType: primary.type,
        resolvedHead: resolvedHead(commitEvents, evidence.rawSha256, this.options.signer),
        result: recovered.result,
        underlyingOperationRefs: Object.freeze(underlying.map((event) => eventReference(event, evidence.rawSha256))),
      });
    } catch {
      return null;
    }
  }

  async #reconstruct(
    input: Parameters<NonNullable<DelegationCompositeOwnerPortV1["reconcile"]>>[0],
    events: readonly DecodedStoredEvent[],
    fresh: readonly DecodedStoredEvent[],
    owned: readonly DecodedStoredEvent[],
  ): Promise<Readonly<{ readonly result: DelegationCompositeResultV1 }> | null> {
    const preEffectTerminal = uniqueEvent(owned, "delegation.owner.pre_effect.terminal", (event) =>
      dataValue(event, "delegation_id") === input.request.payload.delegationId &&
      dataValue(event, "outcome") === "cancelled"
    );
    if (preEffectTerminal !== null) {
      if (input.request.actionKind === "delegation.prepare" || owned.some((event) =>
        event.type === "delegation.group.lease.acquired" || event.sessionSeq > preEffectTerminal.sessionSeq
      )) return null;
      const cancelRequestEventId = dataValue(preEffectTerminal, "cancel_request_event_id");
      const cancelRequestId = dataValue(preEffectTerminal, "cancel_request_id");
      const requestEvent = uniqueEvent(fresh, "delegation.cancel.requested", (event) =>
        event.eventId === cancelRequestEventId && event.sessionSeq < preEffectTerminal.sessionSeq &&
        dataValue(event, "cancel_request_id") === cancelRequestId &&
        dataValue(event, "delegation_id") === input.request.payload.delegationId &&
        authenticatedActionKind(event, "delegation.cancel")
      );
      if (requestEvent === null ||
          typeof cancelRequestEventId !== "string" || typeof cancelRequestId !== "string") return null;
      return Object.freeze({
        result: Object.freeze({
          cancelRequestEventId,
          cancelRequestId,
          delegationId: input.request.payload.delegationId,
          kind: "pre_effect_terminal" as const,
          outcome: "cancelled" as const,
          terminalEventId: preEffectTerminal.eventId,
        }),
      });
    }
    if (input.request.actionKind === "delegation.prepare") {
      const prepared = uniqueEvent(owned, "delegation.envelope.prepared", (event) =>
        dataValue(event, "delegation_id") === input.request.payload.delegationId
      );
      return prepared === null ? null : this.#recoverPrepared(events, prepared);
    }
    if (input.request.actionKind === "delegation.start") {
      const lease = uniqueEvent(owned, "delegation.group.lease.acquired");
      return lease === null ? null : this.#recoverStarted(input.request.payload.delegationId, events, fresh, lease);
    }
    const resume = uniqueEvent(owned, "delegation.resume.requested", (event) =>
      dataValue(event, "delegation_id") === input.request.payload.delegationId
    );
    if (resume === null) return null;
    const later = fresh.filter((event) => event.sessionSeq > resume.sessionSeq);
    // Resume may prepare and then immediately start. The capture surface is
    // last-writer-wins, so a complete group terminal is the exact final result.
    const lease = uniqueEvent(owned, "delegation.group.lease.acquired", (event) => event.sessionSeq > resume.sessionSeq);
    if (lease !== null) return this.#recoverStarted(input.request.payload.delegationId, events, later, lease);
    const prepared = uniqueEvent(owned, "delegation.envelope.prepared", (event) =>
      event.sessionSeq > resume.sessionSeq && dataValue(event, "delegation_id") === input.request.payload.delegationId
    );
    if (prepared !== null) return this.#recoverPrepared(events, prepared);
    const takeover = await this.#recoverTakeover(input, events, later);
    if (takeover !== null) return Object.freeze({ result: takeover });
    const queued = uniqueEvent(owned, "delegation.queued", (event) =>
      event.sessionSeq > resume.sessionSeq && dataValue(event, "delegation_id") === input.request.payload.delegationId
    );
    if (queued === null) return null;
    const projection = reconstructMultiRunSession(events.slice(0, queued.sessionSeq));
    const revision = [...projection.delegations.revisions].reverse().find((candidate) =>
      candidate.delegationId === input.request.payload.delegationId
    );
    if (revision === undefined || revision.status !== "queued") return null;
    return Object.freeze({
      result: Object.freeze({
        delegation: this.#document(revision),
        kind: "queued" as const,
      }),
    });
  }

  async #recoverPrepared(
    events: readonly DecodedStoredEvent[],
    prepared: DecodedStoredEvent,
  ): Promise<Readonly<{ readonly result: DelegationCompositeResultV1 }> | null> {
    const capsuleStored = await readExactPreparedArtifact(
      this.options.runtime.cwd,
      prepared.sessionId,
      dataValue(prepared, "context_capsule_artifact"),
    );
    const envelopeStored = await readExactPreparedArtifact(
      this.options.runtime.cwd,
      prepared.sessionId,
      dataValue(prepared, "envelope_artifact"),
    );
    if (capsuleStored === null || envelopeStored === null) return null;
    const capsule = contextCapsuleSchema.parse(capsuleStored.value);
    const envelope = preparedChildEnvelopeSchema.parse(envelopeStored.value);
    if (
      capsule.capsuleSha256 !== dataValue(prepared, "context_capsule_sha256") ||
      envelope.envelopeSha256 !== dataValue(prepared, "envelope_sha256") ||
      envelope.contextCapsuleSha256 !== capsule.capsuleSha256 || dataValue(prepared, "executable") !== false
    ) return null;
    const projection = reconstructMultiRunSession(events.slice(0, prepared.sessionSeq));
    const revision = projection.delegations.revisions.find((candidate) =>
      candidate.delegationId === dataValue(prepared, "delegation_id") &&
      candidate.delegationRevision === dataValue(prepared, "delegation_revision") &&
      candidate.delegationSha256 === dataValue(prepared, "delegation_sha256")
    );
    if (revision === undefined || revision.envelope?.envelopeSha256 !== envelope.envelopeSha256) return null;
    return Object.freeze({
      result: Object.freeze({
        kind: "prepared" as const,
        childNotStarted: true,
        capsuleBytes: capsuleStored.bytes.byteLength,
        capsuleSha256: capsule.capsuleSha256,
        envelopeSha256: envelope.envelopeSha256,
        toolCount: envelope.effectiveAuthority.toolIds.length,
        capabilityCount: revision.content.authorityRequest.capabilityIds.length,
        model: envelope.model,
        workspace: envelope.workspace,
      }),
    });
  }

  #recoverStarted(
    selectedDelegationId: string,
    allEvents: readonly DecodedStoredEvent[],
    fresh: readonly DecodedStoredEvent[],
    lease: DecodedStoredEvent,
  ): Readonly<{ readonly result: DelegationCompositeResultV1 }> | null {
    const groupId = dataValue(lease, "group_id");
    if (typeof groupId !== "string") return null;
    const nextLease = fresh.find((event) => event.sessionSeq > lease.sessionSeq && event.type === "delegation.group.lease.acquired");
    const groupWindow = fresh.filter((event) =>
      event.sessionSeq >= lease.sessionSeq && (nextLease === undefined || event.sessionSeq < nextLease.sessionSeq)
    );
    const barrier = uniqueEvent(groupWindow, "delegation.parent.barrier.requested", (event) =>
      dataValue(event, "parent_actor_id") === dataValue(lease, "parent_actor_id") &&
      dataValue(event, "parent_run_id") === dataValue(lease, "parent_run_id")
    );
    if (barrier === null) return null;
    const requiredIds = dataValue(barrier, "required_delegation_ids") as readonly string[];
    if (!requiredIds.includes(selectedDelegationId) || requiredIds.length === 0 || requiredIds.length > 2) return null;
    const released = uniqueEvent(groupWindow, "delegation.parent.barrier.released", (event) =>
      dataValue(event, "barrier_id") === dataValue(barrier, "barrier_id")
    );
    const releasedStatus = released === null ? null : dataValue(released, "status");
    if (released === null || (releasedStatus !== "completed" && releasedStatus !== "cancelled" && releasedStatus !== "blocked")) return null;
    const before = reconstructMultiRunSession(allEvents.slice(0, lease.sessionSeq - 1));
    const readyIds = before.delegations.revisions.filter((candidate) =>
      candidate.status === "queued" && candidate.envelope !== null &&
      candidate.parentActorId === dataValue(lease, "parent_actor_id") &&
      candidate.parentRunId === dataValue(lease, "parent_run_id")
    ).sort((left, right) =>
      left.content.sequence - right.content.sequence || left.delegationId.localeCompare(right.delegationId, "en")
    ).map((candidate) => candidate.delegationId);
    if (readyIds.length !== requiredIds.length || readyIds.some((value, index) => value !== requiredIds[index])) return null;
    const receiptStatus = releasedStatus === "cancelled"
      ? "cancelled" as const
      : releasedStatus === "completed"
        ? "succeeded" as const
        : null;
    const results: DelegationGroupTerminalItemV1[] = [];
    for (const delegationId of requiredIds) {
      const reserved = uniqueEvent(groupWindow, "delegation.budget.reserved", (event) =>
        dataValue(event, "delegation_id") === delegationId);
      if (reserved === null) return null;
      const attemptId = dataValue(reserved, "child_attempt_id");
      const launch = uniqueEvent(groupWindow, "delegation.child.launch_requested", (event) =>
        dataValue(event, "delegation_id") === delegationId && dataValue(event, "child_attempt_id") === attemptId);
      if (launch === null || typeof attemptId !== "string") return null;
      const operationId = dataValue(launch, "operation_id");
      const preEffectTerminal = uniqueEvent(groupWindow, "delegation.owner.pre_effect.terminal", (event) =>
        dataValue(event, "delegation_id") === delegationId &&
        dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "operation_id") === operationId && dataValue(event, "outcome") === "cancelled");
      if (preEffectTerminal !== null) {
        const cancelRequestEventId = dataValue(preEffectTerminal, "cancel_request_event_id");
        const cancelRequestId = dataValue(preEffectTerminal, "cancel_request_id");
        const cancelRequest = uniqueEvent(groupWindow, "delegation.cancel.requested", (event) =>
          event.eventId === cancelRequestEventId && event.sessionSeq < preEffectTerminal.sessionSeq &&
          dataValue(event, "cancel_request_id") === cancelRequestId &&
          dataValue(event, "delegation_id") === delegationId);
        const settled = uniqueEvent(groupWindow, "delegation.budget.settled", (event) =>
          dataValue(event, "delegation_id") === delegationId && dataValue(event, "child_attempt_id") === attemptId &&
          dataValue(event, "reservation_id") === dataValue(reserved, "reservation_id"));
        const started = uniqueEvent(groupWindow, "delegation.child.started", (event) =>
          dataValue(event, "delegation_id") === delegationId && dataValue(event, "child_attempt_id") === attemptId);
        if (cancelRequest === null || settled === null || started !== null ||
            typeof cancelRequestEventId !== "string" || typeof cancelRequestId !== "string" ||
            typeof operationId !== "string") return null;
        results.push(Object.freeze({
          cancelRequestEventId,
          cancelRequestId,
          childAttemptId: attemptId,
          delegationId,
          operationId,
          status: "pre_effect_cancelled" as const,
          terminalEventId: preEffectTerminal.eventId,
        }));
        continue;
      }
      const started = uniqueEvent(groupWindow, "delegation.child.started", (event) => dataValue(event, "delegation_id") === delegationId);
      if (started === null) return null;
      const ready = uniqueEvent(groupWindow, "delegation.receipt.ready", (event) =>
        dataValue(event, "delegation_id") === delegationId &&
        (receiptStatus === null
          ? dataValue(event, "status") === "failed" || dataValue(event, "status") === "blocked"
          : dataValue(event, "status") === receiptStatus)
      );
      if (ready === null) return null;
      const accepted = uniqueEvent(groupWindow, "delegation.receipt.accepted", (event) =>
        dataValue(event, "delegation_id") === delegationId &&
        dataValue(event, "ready_event_id") === ready.eventId &&
        dataValue(event, "receipt_sha256") === dataValue(ready, "receipt_sha256")
      );
      if (accepted === null) return null;
      results.push(Object.freeze({
        delegationId,
        childRunId: dataValue(started, "child_run_id") as string,
        receiptSha256: dataValue(ready, "receipt_sha256") as string,
        status: dataValue(ready, "status") as "blocked" | "cancelled" | "failed" | "succeeded",
      }));
    }
    const releasedReceipts = dataValue(released, "receipt_sha256s") as readonly string[];
    const resultReceipts = results.flatMap((item) => "receiptSha256" in item ? [item.receiptSha256] : []);
    if (releasedReceipts.length !== resultReceipts.length ||
        releasedReceipts.some((value, index) => value !== resultReceipts[index])) return null;
    return Object.freeze({
      result: Object.freeze({
        deferred: Object.freeze([]),
        groupId,
        kind: "group_terminal" as const,
        results: Object.freeze(results),
        terminalStatus: releasedStatus,
      }),
    });
  }

  #document(revision: ReturnType<typeof reconstructMultiRunSession>["delegations"]["revisions"][number]) {
    return Object.freeze({
      artifact: revision.artifact,
      attempts: revision.attempts,
      authorityPreviewSha256: revision.authorityPreviewSha256,
      binding: revision.binding,
      blockerCodes: revision.blockerCodes,
      content: revision.content,
      createdEventId: revision.createdEventId,
      decisionEventId: revision.decisionEventId,
      delegationId: revision.delegationId,
      delegationRevision: revision.delegationRevision,
      delegationSha256: revision.delegationSha256,
      envelope: revision.envelope,
      envelopePreparationCount: revision.envelopePreparationCount,
      parentActorId: revision.parentActorId,
      parentRunId: revision.parentRunId,
      receipt: revision.receipt,
      status: revision.status,
      terminalEventId: revision.terminalEventId,
    });
  }

  async #appendResumeFence(
    input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0],
    events: readonly DecodedStoredEvent[],
    authority: DelegationOwnerExecutionV1,
    runtime: DelegationOwnerRuntimePortV1,
  ): Promise<void> {
    const context: TaskMutationContext = Object.freeze({
      authenticatedApplication: authority.authenticatedMutation,
      expectedSessionSeq: events.length,
      inputSurface: localSurface(input),
      now: () => runtime.timestamp(),
      randomUuid: () => runtime.randomUUID(),
      sessionId: input.sessionId,
      workspace: this.options.runtime.cwd,
    });
    const writer = await this.#openWriter(runtime, context);
    try {
      if (writer.events.length !== events.length || writer.events.at(-1)?.eventId !== events.at(-1)?.eventId) {
        throw new DelegationError("delegation_revision_conflict", "Delegation changed while recording resume dispatch");
      }
      const session = reconstructMultiRunSession(writer.events);
      const delegation = [...session.delegations.revisions].reverse().find((candidate) =>
        candidate.delegationId === input.request.payload.delegationId && !["rejected", "superseded"].includes(candidate.status)
      );
      if (delegation === undefined) {
        throw new DelegationError("delegation_revision_conflict", "Delegation resume target is unavailable");
      }
      await writer.appendDelegationEvent("delegation.resume.requested", {
        delegation_id: delegation.delegationId,
        delegation_revision: delegation.delegationRevision,
        delegation_sha256: delegation.delegationSha256,
        origin: taskUserOrigin(context),
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
        resume_request_id: runtime.randomUUID(),
      });
    } finally {
      await writer.close();
    }
  }

  async #appendPreEffectTerminal(
    input: Parameters<DelegationCompositeOwnerPortV1["execute"]>[0],
    authority: DelegationOwnerExecutionV1,
    runtime: DelegationOwnerRuntimePortV1,
  ): Promise<Extract<DelegationCompositeResultV1, { readonly kind: "pre_effect_terminal" }>> {
    const context: TaskMutationContext = Object.freeze({
      authenticatedApplication: authority.authenticatedMutation,
      inputSurface: localSurface(input),
      now: () => runtime.timestamp(),
      randomUuid: () => runtime.randomUUID(),
      sessionId: input.sessionId,
      workspace: this.options.runtime.cwd,
    });
    const writer = await this.#openWriter(runtime, context);
    try {
      const fresh = writer.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
      if (fresh.some((event) => exactApplicationCommit(event, input.applicationCommit) &&
        event.type === "delegation.group.lease.acquired")) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation cancellation arrived after child admission");
      }
      const session = reconstructMultiRunSession(writer.events);
      const delegation = [...session.delegations.revisions].reverse().find((candidate) =>
        candidate.delegationId === input.request.payload.delegationId && candidate.status === "cancelling"
      );
      if (delegation === undefined) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect cancellation has no exact cancelling revision");
      }
      const requests = fresh.filter((event) =>
        event.type === "delegation.cancel.requested" &&
        dataValue(event, "delegation_id") === delegation.delegationId &&
        dataValue(event, "delegation_revision") === delegation.delegationRevision &&
        dataValue(event, "delegation_sha256") === delegation.delegationSha256 &&
        authenticatedActionKind(event, "delegation.cancel")
      );
      if (requests.length !== 1) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect cancellation request is missing or ambiguous");
      }
      const requestEvent = requests[0]!;
      if (requestEvent.scope !== "session" || requestEvent.type !== "delegation.cancel.requested") {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation cancel request shape is unavailable");
      }
      if (requestEvent.data.origin.kind !== "authenticated_surface") {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation cancel request is not an authenticated surface action");
      }
      const cancelRequestId = dataValue(requestEvent, "cancel_request_id");
      if (typeof cancelRequestId !== "string") {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation cancel request identity is unavailable");
      }
      const ownerOrigin = taskUserOrigin(context);
      if (ownerOrigin.kind !== "authenticated_surface") {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation owner has no authenticated application commit");
      }
      await writer.appendDelegationEvent("delegation.owner.pre_effect.terminal", {
        cancel_request_event_id: requestEvent.eventId,
        cancel_request_id: cancelRequestId,
        delegation_id: delegation.delegationId,
        delegation_revision: delegation.delegationRevision,
        delegation_sha256: delegation.delegationSha256,
        origin: requestEvent.data.origin,
        owner_application_commit: ownerOrigin.application_commit,
        outcome: "cancelled",
        parent_actor_id: delegation.parentActorId,
        parent_run_id: delegation.parentRunId,
      });
      const terminal = writer.events.at(-1);
      if (terminal?.type !== "delegation.owner.pre_effect.terminal") {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect terminal append was not durable");
      }
      return Object.freeze({
        cancelRequestEventId: requestEvent.eventId,
        cancelRequestId,
        delegationId: delegation.delegationId,
        kind: "pre_effect_terminal",
        outcome: "cancelled",
        terminalEventId: terminal.eventId,
      });
    } finally {
      await writer.close();
    }
  }

  async #openWriter(
    runtime: DelegationOwnerRuntimePortV1,
    context: TaskMutationContext,
  ): Promise<V2SessionWriter> {
    return openDelegationOwnerWriter(runtime, context);
  }

  async #recoverTakeover(
    input: Parameters<NonNullable<DelegationCompositeOwnerPortV1["reconcile"]>>[0],
    allEvents: readonly DecodedStoredEvent[],
    fresh: readonly DecodedStoredEvent[],
  ): Promise<DelegationGroupTakeoverCompositeResultV1 | null> {
    if (!fresh.some((event) => event.type === "delegation.group.takeover")) return null;
    const evidence = await this.#takeoverEvidence({
      allEvents,
      expected: null,
      fresh,
      selectedDelegationId: input.request.payload.delegationId,
    });
    return Object.freeze({
      kind: "group_takeover",
      takeover: Object.freeze({
        changed: true,
        groupId: evidence.groupId,
        previousNonceSha256: evidence.previousNonceSha256,
        releasedLeaseSha256: evidence.releasedLeaseSha256,
        takeoverEventId: evidence.takeover.eventId,
      }),
    });
  }

  async #takeoverEvidence(input: Readonly<{
    readonly allEvents: readonly DecodedStoredEvent[];
    readonly expected: DelegationGroupTakeoverCompositeResultV1 | null;
    readonly fresh: readonly DecodedStoredEvent[];
    readonly selectedDelegationId: string;
  }>): Promise<Readonly<{
    readonly events: readonly DecodedStoredEvent[];
    readonly groupId: string;
    readonly previousNonceSha256: string;
    readonly releasedLeaseSha256: string;
    readonly takeover: DecodedStoredEvent;
  }>> {
    const candidates = input.fresh.filter((event) =>
      event.type === "delegation.group.takeover" &&
      (input.expected === null || event.eventId === input.expected.takeover.takeoverEventId)
    );
    const bound = candidates.filter((candidate) => {
      const groupId = dataValue(candidate, "group_id");
      if (typeof groupId !== "string") return false;
      const before = reconstructMultiRunSession(input.allEvents.slice(0, candidate.sessionSeq - 1));
      const revision = [...before.delegations.revisions].reverse().find((value) =>
        value.delegationId === input.selectedDelegationId
      );
      const actorId = revision?.attempts.at(-1)?.actorId;
      if (actorId === undefined || actorId === null) return false;
      const groups = new Set([
        ...before.delegations.activeActorSlots.filter((claim) => claim.actorId === actorId).map((claim) => claim.groupId),
        ...before.delegations.activeConflictClaims.filter((claim) => claim.actorId === actorId).map((claim) => claim.groupId),
      ]);
      return groups.size === 1 && groups.has(groupId);
    });
    if (bound.length !== 1) {
      throw new DelegationError(
        "delegation_effect_reconciliation_required",
        "Delegation takeover is not uniquely bound to the selected delegation group",
      );
    }
    const takeover = bound[0]!;
    const groupId = dataValue(takeover, "group_id");
    const previousNonceSha256 = dataValue(takeover, "previous_lease_nonce_sha256");
    const newNonceSha256 = dataValue(takeover, "new_lease_nonce_sha256");
    if (typeof groupId !== "string" || typeof previousNonceSha256 !== "string" || typeof newNonceSha256 !== "string") {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover identity is incomplete");
    }
    const before = reconstructMultiRunSession(input.allEvents.slice(0, takeover.sessionSeq - 1));
    const activeSlots = before.delegations.activeActorSlots.filter((claim) => claim.groupId === groupId);
    const activeClaims = before.delegations.activeConflictClaims.filter((claim) => claim.groupId === groupId);
    if (activeSlots.length === 0 || activeClaims.length === 0) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover has no admitted group claims");
    }
    const lease = uniqueEvent(input.allEvents.slice(0, takeover.sessionSeq - 1), "delegation.group.lease.acquired", (event) =>
      dataValue(event, "group_id") === groupId
    );
    const leaseRepositoryId = lease === null ? null : dataValue(lease, "repository_id");
    if (
      lease === null || typeof leaseRepositoryId !== "string" || !/^[a-f0-9]{64}$/u.test(leaseRepositoryId) ||
      typeof dataValue(lease, "parent_actor_id") !== "string" || typeof dataValue(lease, "parent_run_id") !== "string"
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover has no exact original group lease");
    }
    const priorNonceEvent = input.allEvents.filter((event) =>
      event.sessionSeq < takeover.sessionSeq && dataValue(event, "group_id") === groupId &&
      (event.type === "delegation.group.lease.acquired" || event.type === "delegation.group.takeover")
    ).at(-1);
    const priorNonce = priorNonceEvent?.type === "delegation.group.takeover"
      ? dataValue(priorNonceEvent, "new_lease_nonce_sha256")
      : priorNonceEvent?.type === "delegation.group.lease.acquired"
        ? dataValue(priorNonceEvent, "lease_nonce_sha256")
        : null;
    if (priorNonce !== previousNonceSha256) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover does not advance the exact prior nonce");
    }
    const after = input.fresh.filter((event) => event.sessionSeq > takeover.sessionSeq);
    const slotReleases = activeSlots.map((slot) => uniqueEvent(after, "delegation.actor_slot.released", (event) =>
      dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === slot.actorId &&
      dataValue(event, "claim_id") === slot.claimId && dataValue(event, "release_reason") === "reconciled"
    ));
    const claimReleases = activeClaims.map((claim) => uniqueEvent(after, "delegation.conflict_claim.released", (event) =>
      dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === claim.actorId &&
      dataValue(event, "claim_id") === claim.claimId
    ));
    if (slotReleases.some((event) => event === null) || claimReleases.some((event) => event === null)) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover claim release set is incomplete");
    }
    const barriers = before.delegations.barriers.filter((barrier) =>
      barrier.status === "suspended" && barrier.parentActorId === dataValue(lease, "parent_actor_id") &&
      barrier.parentRunId === dataValue(lease, "parent_run_id")
    );
    if (barriers.length !== 1) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover has no unique suspended parent barrier");
    }
    const barrierRelease = uniqueEvent(after, "delegation.parent.barrier.released", (event) =>
      dataValue(event, "barrier_id") === barriers[0]!.barrierId &&
      dataValue(event, "parent_actor_id") === barriers[0]!.parentActorId &&
      dataValue(event, "parent_run_id") === barriers[0]!.parentRunId
    );
    if (barrierRelease === null) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover parent barrier release is incomplete");
    }
    const finalProjection = reconstructMultiRunSession(input.allEvents);
    const finalBarrier = finalProjection.delegations.barriers.find((barrier) => barrier.barrierId === barriers[0]!.barrierId);
    if (
      finalProjection.delegations.activeActorSlots.some((claim) => claim.groupId === groupId) ||
      finalProjection.delegations.activeConflictClaims.some((claim) => claim.groupId === groupId) ||
      finalBarrier?.status !== "released"
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover did not close its exact group");
    }
    const durableLease = await (this.options.runtime.inspectDelegationGroupLease?.({
      groupId,
      repositoryId: leaseRepositoryId,
      sessionId: takeover.sessionId,
    }) ?? Promise.resolve(null));
    if (
      durableLease === null || durableLease.state !== "released" || durableLease.releaseReason !== "reconciled" ||
      durableLease.nonceSha256 !== newNonceSha256 || durableLease.groupId !== groupId ||
      durableLease.repositoryId !== leaseRepositoryId || durableLease.sessionId !== takeover.sessionId ||
      durableLease.parentActorId !== dataValue(lease, "parent_actor_id") ||
      durableLease.parentRunId !== dataValue(lease, "parent_run_id")
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover durable lease is not exactly released");
    }
    if (input.expected !== null && (
      input.expected.takeover.changed !== true || input.expected.takeover.groupId !== groupId ||
      input.expected.takeover.previousNonceSha256 !== previousNonceSha256 ||
      input.expected.takeover.releasedLeaseSha256 !== durableLease.leaseSha256 ||
      input.expected.takeover.takeoverEventId !== takeover.eventId
    )) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation takeover result does not match durable evidence");
    }
    const events = [takeover, ...claimReleases, ...slotReleases, barrierRelease]
      .filter((event): event is DecodedStoredEvent => event !== null)
      .sort((left, right) => left.sessionSeq - right.sessionSeq);
    return Object.freeze({
      events: Object.freeze(events),
      groupId,
      previousNonceSha256,
      releasedLeaseSha256: durableLease.leaseSha256,
      takeover,
    });
  }

  async #underlying(
    request: DelegationCompositeOwnerRequestV1,
    allEvents: readonly DecodedStoredEvent[],
    fresh: readonly DecodedStoredEvent[],
    primary: DecodedStoredEvent,
    result: DelegationCompositeResultV1,
  ): Promise<readonly DecodedStoredEvent[]> {
    if (result.kind === "pre_effect_terminal") {
      const requestEvent = uniqueEvent(fresh, "delegation.cancel.requested", (event) =>
        event.eventId === result.cancelRequestEventId &&
        dataValue(event, "cancel_request_id") === result.cancelRequestId &&
        dataValue(event, "delegation_id") === result.delegationId &&
        authenticatedActionKind(event, "delegation.cancel")
      );
      if (requestEvent === null || result.terminalEventId !== primary.eventId || requestEvent.sessionSeq >= primary.sessionSeq) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect terminal has no exact typed cancel request");
      }
      return Object.freeze([requestEvent]);
    }
    if (request.actionKind === "delegation.prepare") return Object.freeze([primary]);
    if (request.actionKind === "delegation.start") {
      return this.#startUnderlying(fresh, primary, result);
    }
    const outcomeEvents = fresh.filter((event) => event.eventId !== primary.eventId);
    if (result.kind === "prepared") {
      const prepared = uniqueEvent(outcomeEvents, "delegation.envelope.prepared", (event) =>
        dataValue(event, "delegation_id") === request.payload.delegationId && samePersistedApplicationCommit(event, primary)
      );
      if (prepared !== null) return Object.freeze([prepared]);
    }
    if (result.kind === "group_terminal") {
      const lease = uniqueEvent(outcomeEvents, "delegation.group.lease.acquired", (event) =>
        dataValue(event, "group_id") === result.groupId && samePersistedApplicationCommit(event, primary)
      );
      if (lease !== null) return this.#startUnderlying(outcomeEvents, lease, result);
    }
    if (result.kind === "queued" || result.kind === "group_takeover" || result.kind === "operation_recovery" ||
        result.kind === "pre_effect_recovery") {
      const queued = uniqueEvent(outcomeEvents, "delegation.queued", (event) =>
        dataValue(event, "delegation_id") === request.payload.delegationId && samePersistedApplicationCommit(event, primary)
      );
      if (queued !== null) return Object.freeze([queued]);
      if (result.kind === "group_takeover") {
        return (await this.#takeoverEvidence({
          allEvents,
          expected: result,
          fresh: outcomeEvents,
          selectedDelegationId: request.payload.delegationId,
        })).events;
      }
    }
    throw new DelegationError(
      "delegation_effect_reconciliation_required",
      "Delegation resume has no exact result-specific owner outcome",
    );
  }

  #startUnderlying(
    fresh: readonly DecodedStoredEvent[],
    lease: DecodedStoredEvent,
    result: DelegationCompositeResultV1,
  ): readonly DecodedStoredEvent[] {
    const groupId = dataValue(lease, "group_id");
    if (
      result.kind !== "group_terminal" || typeof groupId !== "string" || result.groupId !== groupId ||
      result.results.length === 0 || result.results.length > 2
    ) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation start result is not bound to one exact group");
    }
    const nextLease = fresh.find((event) => event.sessionSeq > lease.sessionSeq && event.type === "delegation.group.lease.acquired");
    const groupWindow = fresh.filter((event) =>
      event.sessionSeq >= lease.sessionSeq && (nextLease === undefined || event.sessionSeq < nextLease.sessionSeq)
    );
    const barrier = uniqueEvent(groupWindow, "delegation.parent.barrier.requested", (event) =>
      dataValue(event, "parent_actor_id") === dataValue(lease, "parent_actor_id") &&
      dataValue(event, "parent_run_id") === dataValue(lease, "parent_run_id")
    );
    if (barrier === null) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation group barrier is missing");
    const requiredIds = dataValue(barrier, "required_delegation_ids") as readonly string[];
    const resultIds = result.results.map((item) => item.delegationId);
    if (requiredIds.length !== resultIds.length || requiredIds.some((item, index) => item !== resultIds[index])) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation group result order does not match its barrier");
    }
    const suspended = uniqueEvent(groupWindow, "delegation.parent.barrier.suspended", (event) =>
      dataValue(event, "barrier_id") === dataValue(barrier, "barrier_id")
    );
    const released = uniqueEvent(groupWindow, "delegation.parent.barrier.released", (event) =>
      dataValue(event, "barrier_id") === dataValue(barrier, "barrier_id")
    );
    if (suspended === null || released === null) {
      throw new DelegationError("delegation_effect_reconciliation_required", "Delegation barrier lifecycle is incomplete");
    }
    const resultReceipts = result.results.flatMap((item) => "receiptSha256" in item ? [item.receiptSha256] : []);
    const releasedReceipts = dataValue(released, "receipt_sha256s") as readonly unknown[];
    if (
      dataValue(released, "status") !== result.terminalStatus ||
      releasedReceipts.length !== resultReceipts.length ||
      releasedReceipts.some((item, index) => item !== resultReceipts[index])
    ) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation barrier result does not match child receipts");
    const selected = new Set<string>([lease.eventId, barrier.eventId, suspended.eventId, released.eventId]);
    for (const item of result.results) {
      const reserved = uniqueEvent(groupWindow, "delegation.budget.reserved", (event) => dataValue(event, "delegation_id") === item.delegationId);
      if (reserved === null) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation budget reservation is missing");
      const attemptId = dataValue(reserved, "child_attempt_id");
      const launch = uniqueEvent(groupWindow, "delegation.child.launch_requested", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId
      );
      if (launch === null) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation child launch request is missing");
      const actorId = dataValue(launch, "child_actor_id");
      const slotClaim = uniqueEvent(groupWindow, "delegation.actor_slot.claimed", (event) =>
        dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === actorId
      );
      const conflictClaim = uniqueEvent(groupWindow, "delegation.conflict_claim.granted", (event) =>
        dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === actorId
      );
      const settled = uniqueEvent(groupWindow, "delegation.budget.settled", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "reservation_id") === dataValue(reserved, "reservation_id")
      );
      if (settled === null || slotClaim === null || conflictClaim === null) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation terminal accounting is incomplete");
      }
      const slotRelease = uniqueEvent(groupWindow, "delegation.actor_slot.released", (event) =>
        dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === actorId &&
        dataValue(event, "claim_id") === dataValue(slotClaim, "claim_id")
      );
      const conflictRelease = uniqueEvent(groupWindow, "delegation.conflict_claim.released", (event) =>
        dataValue(event, "group_id") === groupId && dataValue(event, "actor_id") === actorId &&
        dataValue(event, "claim_id") === dataValue(conflictClaim, "claim_id")
      );
      if (slotRelease === null || conflictRelease === null) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation admission claims were not released");
      }
      if (item.status === "pre_effect_cancelled") {
        if (item.childAttemptId !== attemptId || item.operationId !== dataValue(launch, "operation_id")) {
          throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect cancellation identity is stale");
        }
        const terminal = uniqueEvent(groupWindow, "delegation.owner.pre_effect.terminal", (event) =>
          event.eventId === item.terminalEventId && dataValue(event, "delegation_id") === item.delegationId &&
          dataValue(event, "child_attempt_id") === item.childAttemptId &&
          dataValue(event, "operation_id") === item.operationId &&
          dataValue(event, "cancel_request_event_id") === item.cancelRequestEventId &&
          dataValue(event, "cancel_request_id") === item.cancelRequestId && dataValue(event, "outcome") === "cancelled");
        const cancelRequest = uniqueEvent(groupWindow, "delegation.cancel.requested", (event) =>
          event.eventId === item.cancelRequestEventId && terminal !== null && event.sessionSeq < terminal.sessionSeq &&
          dataValue(event, "delegation_id") === item.delegationId &&
          dataValue(event, "cancel_request_id") === item.cancelRequestId);
        const started = uniqueEvent(groupWindow, "delegation.child.started", (event) =>
          dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId);
        if (terminal === null || cancelRequest === null || started !== null) {
          throw new DelegationError("delegation_effect_reconciliation_required", "Delegation pre-effect cancellation is incomplete");
        }
        for (const event of [reserved, launch, cancelRequest, terminal, settled, slotClaim, conflictClaim, slotRelease, conflictRelease]) {
          selected.add(event.eventId);
        }
        continue;
      }
      if (!("childRunId" in item) || !("receiptSha256" in item) ||
          !["blocked", "cancelled", "failed", "succeeded"].includes(item.status)) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation child result is not an exact terminal");
      }
      const started = uniqueEvent(groupWindow, "delegation.child.started", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "operation_id") === dataValue(launch, "operation_id") && dataValue(event, "child_run_id") === item.childRunId
      );
      const terminal = uniqueEvent(groupWindow, "delegation.child.terminal", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "operation_id") === dataValue(launch, "operation_id") && dataValue(event, "child_run_id") === item.childRunId
      );
      if (started === null || terminal === null) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation child lifecycle is incomplete");
      const ready = uniqueEvent(groupWindow, "delegation.receipt.ready", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "terminal_event_id") === terminal.eventId && dataValue(event, "receipt_sha256") === item.receiptSha256 &&
        dataValue(event, "status") === item.status
      );
      if (ready === null) throw new DelegationError("delegation_effect_reconciliation_required", "Delegation receipt is missing");
      const accepted = uniqueEvent(groupWindow, "delegation.receipt.accepted", (event) =>
        dataValue(event, "delegation_id") === item.delegationId && dataValue(event, "child_attempt_id") === attemptId &&
        dataValue(event, "ready_event_id") === ready.eventId && dataValue(event, "receipt_sha256") === item.receiptSha256
      );
      if (accepted === null || settled === null || slotClaim === null || conflictClaim === null) {
        throw new DelegationError("delegation_effect_reconciliation_required", "Delegation terminal accounting is incomplete");
      }
      for (const event of [reserved, launch, started, terminal, ready, accepted, settled, slotClaim, conflictClaim, slotRelease, conflictRelease]) {
        selected.add(event.eventId);
      }
    }
    const selectedEvents = groupWindow.filter((event) => selected.has(event.eventId));
    for (const type of START_COMMON_EVIDENCE) required(selectedEvents, type);
    return Object.freeze(selectedEvents);
  }
}
