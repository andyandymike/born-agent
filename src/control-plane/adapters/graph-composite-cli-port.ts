import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CliIO, CliRuntime } from "../../cli/types.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  taskUserOrigin,
  type AuthenticatedTaskMutationBindingV1,
  type TaskMutationContext,
} from "../../coordination/task-control-plane.js";
import { decodeStoredEvents, type DecodedStoredEvent } from "../../events/event-decoder-registry.js";
import { DeterministicTaskScheduler } from "../../scheduling/deterministic-task-scheduler.js";
import { TaskExecutionControlPlane } from "../../scheduling/task-execution-control-plane.js";
import { SessionCatalog } from "../../sessions/session-catalog.js";
import { reconstructMultiRunSession } from "../../sessions/reconstruct-multi-run-session.js";
import { SessionPathPolicy } from "../../sessions/session-path-policy.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { BackgroundError } from "../../background/background-errors.js";
import { TaskGraphError } from "../../task-graph/task-graph-errors.js";
import type { ManagedWorkspaceHandleV1 } from "../../worktrees/managed-worktree-manager.js";
import type { OriginVerificationResultV1 } from "../../worktrees/origin-verification-runtime.js";
import type { PromotionResultV1 } from "../../worktrees/promotion-runtime.js";
import { WorktreeError } from "../../worktrees/worktree-errors.js";
import type { DurableRecordReferenceV1 } from "../control-operation-schema.js";
import type {
  ActiveOwnerCompositeControlRegistry,
  OwnerInternalCompositeActionKindV1,
} from "../active-owner-composite-control-registry.js";
import type { ForegroundGraphControlRegistry } from "../foreground-graph-control-registry.js";
import type { SessionLedgerHeadSigner } from "../session-ledger-head.js";
import type {
  GraphCompositeOwnerCommitV1,
  GraphCompositeOwnerPortV1,
  GraphCompositeOwnerRequestV1,
  GraphCompositeOwnerResultV1,
  GraphCompositePreEffectTerminalResultV1,
  GraphRunCompositeResultV1,
  WorktreeAllocateCompositeResultV1,
} from "../use-cases/graph-composite-actions.js";
import { taskMutationContext, taskWriterFactory } from "../../commands/task-control-plane-command.js";

const UNDERLYING_EVENT_TYPES: Readonly<Record<GraphCompositeOwnerRequestV1["actionKind"], ReadonlySet<string>>> = Object.freeze({
  "graph.resume": new Set([
    "task_scheduler.lease.acquired",
    "task_graph.started",
    "task_node.attempt.requested",
    "task_node.attempt.terminal",
    "task_graph.waiting_for_user",
    "task_graph.terminal",
    "task_worker.started",
  ]),
  "graph.run": new Set([
    "task_scheduler.lease.acquired",
    "task_node.attempt.requested",
    "task_node.attempt.terminal",
    "task_graph.waiting_for_user",
    "task_graph.terminal",
    "task_worker.started",
  ]),
  "graph.retry": new Set<string>(),
  "promotion.apply": new Set([
    "task_worktree.promotion.approved",
    "task_worktree.promotion.requested",
    "task_worktree.promotion.applied",
    "task_origin_verification.completed",
  ]),
  "promotion.verify_origin": new Set([
    "task_origin_verification.approved",
    "task_origin_verification.completed",
  ]),
  "worktree.allocate": new Set([
    "task_worktree.allocation.approved",
    "task_worktree.create.requested",
    "task_worktree.created",
    "task_worktree.baseline.seeded",
    "task_worktree.reconciled",
  ]),
  "worktree.cleanup": new Set([
    "task_worktree.cleanup.completed",
    "task_worktree.reconciled",
  ]),
});

function exactApplicationCommit(event: DecodedStoredEvent, binding: GraphCompositeOwnerPortV1 extends never ? never : Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"]): boolean {
  if (typeof event.data !== "object" || event.data === null) return false;
  const origin = (event.data as Readonly<Record<string, unknown>>).origin;
  if (typeof origin !== "object" || origin === null) return false;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  if (typeof commit !== "object" || commit === null) return false;
  const value = commit as Readonly<Record<string, unknown>>;
  return value.schema_version === 1 &&
    value.operation_id === binding.operationId &&
    value.action_kind === binding.actionKind &&
    value.prepared_action_sha256 === binding.preparedActionSha256 &&
    value.principal_id === binding.principalId &&
    value.authorization_decision_sha256 === binding.authorizationDecisionSha256;
}

function eventReference(event: DecodedStoredEvent, rawSha256: ReadonlyMap<string, string>): DurableRecordReferenceV1 {
  const recordSha256 = rawSha256.get(event.eventId);
  if (recordSha256 === undefined) {
    throw new TaskGraphError("task_effect_reconciliation_required", "Graph composite raw event identity is unavailable");
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
  if (raw === undefined) throw new TaskGraphError("task_effect_reconciliation_required", "Graph composite commit end raw identity is unavailable");
  return signer.create({ eventId: end.eventId, rawEventSha256: raw, sequence: end.sessionSeq, sessionId: end.sessionId }).publicHead;
}

async function readAppendOnlyEvidence(workspace: string, sessionId: string) {
  const paths = await (await SessionPathPolicy.create(workspace)).inspectExistingSession(sessionId);
  const bytes = await readFile(paths.sessionFilePath);
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new TaskGraphError("task_effect_reconciliation_required", "Graph owner session evidence has no complete durable tail");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.slice(0, -1).split("\n");
  const events = decodeStoredEvents(lines.map((line) => parseStrictJson(line)));
  const rawSha256 = new Map<string, string>();
  events.forEach((event, index) => {
    const line = lines[index];
    if (line === undefined || event.sessionSeq !== index + 1) {
      throw new TaskGraphError("task_effect_reconciliation_required", "Graph owner session evidence sequence is inconsistent");
    }
    rawSha256.set(event.eventId, createHash("sha256").update(line, "utf8").digest("hex"));
  });
  return Object.freeze({ projection: reconstructMultiRunSession(events), rawSha256 });
}

type GraphCompositeObservationEvidenceV1 = Awaited<ReturnType<typeof readAppendOnlyEvidence>>;

function operationId(event: DecodedStoredEvent): string | null {
  if (typeof event.data !== "object" || event.data === null) return null;
  const value = (event.data as Readonly<Record<string, unknown>>).operation_id;
  return typeof value === "string" ? value : null;
}

function dataValue(event: DecodedStoredEvent, name: string): unknown {
  return typeof event.data === "object" && event.data !== null
    ? (event.data as Readonly<Record<string, unknown>>)[name]
    : undefined;
}

function dataRecord(event: DecodedStoredEvent): Readonly<Record<string, unknown>> {
  return typeof event.data === "object" && event.data !== null
    ? event.data as Readonly<Record<string, unknown>>
    : Object.freeze({});
}

function exactExpectedPrefix(
  events: readonly DecodedStoredEvent[],
  input: Parameters<GraphCompositeOwnerPortV1["execute"]>[0],
  rawSha256: ReadonlyMap<string, string>,
  signer: SessionLedgerHeadSigner,
): boolean {
  const expected = events.at(input.expectedHead.sequence - 1);
  return input.expectedHead.sequence > 0 && expected?.sessionSeq === input.expectedHead.sequence &&
    expected.eventId === input.expectedHead.eventId && expected.sessionId === input.expectedHead.sessionId &&
    signer.verify(input.expectedHead, rawSha256.get(expected.eventId) ?? null);
}

function applicationOperationId(event: DecodedStoredEvent): string | null {
  const origin = dataRecord(event).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const commit = (origin as Readonly<Record<string, unknown>>).application_commit;
  if (typeof commit !== "object" || commit === null) return null;
  const value = (commit as Readonly<Record<string, unknown>>).operation_id;
  return typeof value === "string" ? value : null;
}

function exactGraphEvent(
  event: DecodedStoredEvent,
  payload: { readonly revision: number; readonly sha256: string },
): boolean {
  return dataValue(event, "graph_revision") === payload.revision && dataValue(event, "graph_sha256") === payload.sha256;
}

function isPreEffectTerminal(
  value: unknown,
): value is GraphCompositePreEffectTerminalResultV1 {
  return typeof value === "object" && value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "pre_effect_terminal";
}

function preEffectTargetIdentity(request: GraphCompositeOwnerRequestV1): string {
  return sha256Canonical({
    action_kind: request.actionKind,
    payload: request.payload,
    schema_version: 1,
  });
}

function effectWasAdmitted(
  request: GraphCompositeOwnerRequestV1,
  fresh: readonly DecodedStoredEvent[],
): boolean {
  if (request.actionKind === "worktree.allocate") {
    return fresh.some((event) => exactGraphEvent(event, request.payload) &&
      (event.type === "task_worktree.allocation.approved" || event.type === "task_worktree.create.requested"));
  }
  if (request.actionKind === "promotion.apply") {
    return fresh.some((event) => exactGraphEvent(event, request.payload) &&
      (event.type === "task_worktree.promotion.approved" || event.type === "task_worktree.promotion.requested"));
  }
  if (request.actionKind === "promotion.verify_origin") {
    return fresh.some((event) => exactGraphEvent(event, request.payload) &&
      dataValue(event, "promotion_operation_id") === request.payload.promotionOperationId &&
      (event.type === "task_origin_verification.approved" || event.type === "task_origin_verification.requested"));
  }
  if (request.actionKind === "worktree.cleanup") {
    return fresh.some((event) => exactGraphEvent(event, request.payload) &&
      event.type === "task_worktree.cleanup.requested");
  }
  return true;
}

class OwnerCompositeCancelledError extends Error {
  override readonly name = "OwnerCompositeCancelledError";
  constructor(
    readonly reason: "user" | "tui_surface_fatal",
    options: ErrorOptions = {},
  ) {
    super("owner composite was cancelled", options);
  }
}

function uniqueEvent(
  events: readonly DecodedStoredEvent[],
  type: string,
  predicate: (event: DecodedStoredEvent) => boolean = () => true,
): DecodedStoredEvent | null {
  const matches = events.filter((event) => event.type === type && predicate(event));
  return matches.length === 1 ? matches[0]! : null;
}

function verificationResult(event: DecodedStoredEvent): OriginVerificationResultV1 {
  const value = dataRecord(event);
  return Object.freeze({
    actionSha256: value.action_sha256 as string,
    commandSha256: value.command_sha256 as string,
    completedEventId: event.eventId,
    receiptArtifactId: value.receipt_artifact_id as string,
    receiptSha256: value.receipt_sha256 as string,
    status: value.status as OriginVerificationResultV1["status"],
    verificationId: value.verification_id as string,
    verificationNodeId: value.verification_node_id as string,
  });
}

function authenticatedContext(
  runtime: CliRuntime,
  sessionId: string,
  expectedSequence: number,
  binding: AuthenticatedTaskMutationBindingV1,
): TaskMutationContext {
  const inputSurface = localInputSurface(binding);
  return Object.freeze({
    ...taskMutationContext(runtime, sessionId, inputSurface, expectedSequence),
    authenticatedApplication: binding,
  });
}

function localInputSurface(binding: AuthenticatedTaskMutationBindingV1): "cli" | "tui" {
  if (binding.surface.surface !== "cli" && binding.surface.surface !== "tui") {
    throw new TaskGraphError("task_graph_schema_invalid", "CLI Graph owner received a non-local application surface");
  }
  return binding.surface.surface;
}

function assertExpectedHead(
  events: readonly DecodedStoredEvent[],
  input: Readonly<{
    readonly expectedHead: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["expectedHead"];
    readonly sessionId: string;
  }>,
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
    throw new TaskGraphError("task_graph_revision_conflict", "session changed before Graph composite owner dispatch");
  }
}

function findRequiredEvent(
  events: readonly DecodedStoredEvent[],
  type: string,
  predicate: (event: DecodedStoredEvent) => boolean = () => true,
): DecodedStoredEvent {
  const event = events.find((candidate) => candidate.type === type && predicate(candidate));
  if (event === undefined) {
    throw new TaskGraphError("task_effect_reconciliation_required", `Graph composite owner did not persist ${type}`);
  }
  return event;
}

export class CliGraphCompositeOwnerPort implements GraphCompositeOwnerPortV1 {
  constructor(private readonly options: Readonly<{
    readonly activeOwnerComposites: ActiveOwnerCompositeControlRegistry;
    readonly foregroundGraphControls: ForegroundGraphControlRegistry;
    readonly io: CliIO;
    /** Test/embedded read port; production defaults to the strict raw JSONL reader above. */
    readonly readObservationEvidence?: (sessionId: string) => Promise<GraphCompositeObservationEvidenceV1>;
    readonly runtime: CliRuntime;
    readonly signer: SessionLedgerHeadSigner;
  }>) {}

  async preflight(input: Parameters<GraphCompositeOwnerPortV1["preflight"]>[0]): Promise<void> {
    const evidence = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    assertExpectedHead(evidence.projection.events, input, evidence.rawSha256, this.options.signer);
    if (input.request.actionKind !== "graph.retry") return;

    const payload = input.request.payload;
    const execution = evidence.projection.taskExecution;
    if (
      execution === null || !["failed", "cancelled"].includes(execution.status) || execution.activeAttempt !== null ||
      execution.graph.revision !== payload.revision || execution.graph.graphSha256 !== payload.sha256
    ) {
      throw new TaskGraphError(
        "task_graph_revision_conflict",
        "manual retry requires one exact failed or cancelled Graph with no active attempt",
      );
    }
    const node = execution.nodes.find((candidate) => candidate.nodeId === payload.nodeId);
    const attempt = node?.attempts.at(payload.attemptNumber - 1);
    const expectedNodeStatus = payload.attemptTerminal === "cancelled_clean" ? "cancelled" : "failed";
    if (
      node === undefined || attempt === undefined || attempt.attemptNumber !== payload.attemptNumber ||
      attempt.terminalEventId !== payload.terminalEventId || attempt.status !== "terminal" ||
      attempt.terminal !== payload.attemptTerminal || node.status !== expectedNodeStatus ||
      node.attempts.length >= node.node.budget.maxAttempts
    ) {
      throw new TaskGraphError(
        "task_graph_revision_conflict",
        "manual retry selector is stale, is not a known failed/cancelled attempt, or exceeds the approved ceiling",
      );
    }
  }

  async execute(input: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]): Promise<GraphCompositeOwnerCommitV1> {
    const before = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    assertExpectedHead(before.projection.events, input, before.rawSha256, this.options.signer);
    const context = authenticatedContext(
      this.options.runtime,
      input.sessionId,
      input.expectedHead.sequence,
      input.authenticatedMutation,
    );
    let result: GraphCompositeOwnerResultV1;
    try {
      result = await this.#dispatch(
        input.request,
        context,
        input.authenticatedMutation,
        input.applicationCommit,
      );
    } catch (error) {
      if (error instanceof OwnerCompositeCancelledError && error.reason === "tui_surface_fatal") {
        throw new TaskGraphError(
          "task_effect_reconciliation_required",
          "TUI surface failed during an exact owner-internal composite; outcome is intentionally unresolved",
          { cause: error },
        );
      }
      const outcome = error instanceof OwnerCompositeCancelledError
        ? "cancelled" as const
        : error instanceof WorktreeError && error.code === "worktree_approval_denied"
          ? "denied" as const
          : null;
      if (outcome === null) throw error;
      result = await this.#recordPreEffectTerminal(input, context, outcome);
    }
    const evidence = await readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId);
    const after = evidence.projection;
    const fresh = after.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
    const owned = fresh.filter((event) => exactApplicationCommit(event, input.applicationCommit));
    const primary = this.#primary(input.request, result, fresh, owned);
    const underlying = this.#underlying(input.request, result, fresh, owned);
    if (owned.length === 0 || owned.length > 128 || underlying.length > 128) {
      throw new TaskGraphError("task_effect_reconciliation_required", "Graph composite evidence is missing or exceeds the bounded link set");
    }
    const commitEvents = Object.freeze([...owned, ...underlying]);
    return Object.freeze({
      applicationOperationId: input.applicationCommit.operationId,
      domainRecordRefs: Object.freeze(owned.map((event) => eventReference(event, evidence.rawSha256))),
      primaryDomainRecord: eventReference(primary, evidence.rawSha256),
      primaryEventType: primary.type,
      resolvedHead: resolvedHead(commitEvents, evidence.rawSha256, this.options.signer),
      result,
      underlyingOperationRefs: Object.freeze(underlying.map((event) => eventReference(event, evidence.rawSha256))),
    });
  }

  /** Observation-only response-loss recovery; this path never dispatches. */
  async reconcile(input: Parameters<NonNullable<GraphCompositeOwnerPortV1["reconcile"]>>[0]): Promise<GraphCompositeOwnerCommitV1 | null> {
    try {
      const evidence = await (this.options.readObservationEvidence?.(input.sessionId) ??
        readAppendOnlyEvidence(this.options.runtime.cwd, input.sessionId));
      const events = evidence.projection.events;
      if (!exactExpectedPrefix(events, input, evidence.rawSha256, this.options.signer)) return null;
      const fresh = events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
      if (fresh.some((event) =>
        applicationOperationId(event) === input.applicationCommit.operationId &&
        !exactApplicationCommit(event, input.applicationCommit)
      )) return null;
      const owned = fresh.filter((event) => exactApplicationCommit(event, input.applicationCommit));
      if (owned.length === 0 || owned.length > 128) return null;
      const recovered = this.#reconstruct(input.request, events, fresh, owned);
      if (recovered === null) return null;
      const primary = this.#primary(input.request, recovered.result, fresh, owned);
      const underlying = this.#underlying(input.request, recovered.result, fresh, owned);
      if (owned.length === 0 || owned.length > 128 || underlying.length > 128) return null;
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

  #reconstruct(
    request: GraphCompositeOwnerRequestV1,
    events: readonly DecodedStoredEvent[],
    fresh: readonly DecodedStoredEvent[],
    owned: readonly DecodedStoredEvent[],
  ): Readonly<{ readonly result: GraphCompositeOwnerResultV1 }> | null {
    if (
      request.actionKind === "worktree.allocate" ||
      request.actionKind === "promotion.apply" ||
      request.actionKind === "promotion.verify_origin" ||
      request.actionKind === "worktree.cleanup"
    ) {
      const targetIdentitySha256 = preEffectTargetIdentity(request);
      const terminal = uniqueEvent(owned, "task_effect.admission.terminal", (event) =>
        exactGraphEvent(event, request.payload) &&
        dataValue(event, "action_kind") === request.actionKind &&
        dataValue(event, "target_identity_sha256") === targetIdentitySha256 &&
        ["cancelled", "denied"].includes(String(dataValue(event, "outcome")))
      );
      if (terminal !== null) {
        if (
          effectWasAdmitted(request, fresh) ||
          owned.some((event) => event.sessionSeq > terminal.sessionSeq)
        ) return null;
        return Object.freeze({
          result: Object.freeze({
            actionKind: request.actionKind,
            kind: "pre_effect_terminal" as const,
            outcome: dataValue(terminal, "outcome") as "cancelled" | "denied",
            targetIdentitySha256,
          }),
        });
      }
    }
    const graphAt = (through: number) => {
      const projection = reconstructMultiRunSession(events.slice(0, through));
      return projection.taskGraph.revisions.find((candidate) =>
        candidate.revision === request.payload.revision && candidate.graphSha256 === request.payload.sha256
      ) ?? null;
    };
    if (request.actionKind === "graph.retry") {
      const primary = uniqueEvent(owned, "task_node.retry.requested", (event) => exactGraphEvent(event, request.payload));
      if (primary === null) return null;
      const projection = reconstructMultiRunSession(events.slice(0, primary.sessionSeq));
      if (projection.taskExecution === null) return null;
      return Object.freeze({
        result: Object.freeze({ deduplicated: false, execution: projection.taskExecution, graph: projection.taskExecution.graph }),
      });
    }
    if (request.actionKind === "graph.run" || request.actionKind === "graph.resume") {
      const primaryType = request.actionKind === "graph.run"
        ? request.payload.execution === "background" ? "task_worker.spawn.requested" : "task_graph.started"
        : request.payload.takeover ? "task_worker.spawn.requested" : "task_graph.enqueued";
      const primary = uniqueEvent(owned, primaryType, (event) => exactGraphEvent(event, request.payload));
      if (primary === null) return null;
      if (request.payload.execution === "background") {
        const spawn = primary.type === "task_worker.spawn.requested"
          ? primary
          : uniqueEvent(owned, "task_worker.spawn.requested", (event) => exactGraphEvent(event, request.payload));
        if (spawn === null) return null;
        const started = uniqueEvent(fresh, "task_worker.started", (event) =>
          event.sessionSeq > spawn.sessionSeq && exactGraphEvent(event, request.payload) &&
          operationId(event) === operationId(spawn) && dataValue(event, "worker_id") === dataValue(spawn, "worker_id")
        );
        if (started === null) return null;
        const graph = graphAt(started.sessionSeq);
        if (graph === null || operationId(spawn) === null) return null;
        return Object.freeze({
          result: Object.freeze({
            execution: "background" as const,
            graph,
            launch: Object.freeze({
              accepted: true as const,
              operationId: operationId(spawn)!,
              startedEventId: started.eventId,
              workerId: dataValue(spawn, "worker_id") as string,
            }),
          }),
        });
      }
      const stop = fresh.find((event) =>
        event.sessionSeq > primary.sessionSeq && exactGraphEvent(event, request.payload) &&
        (event.type === "task_graph.terminal" || event.type === "task_graph.waiting_for_user")
      );
      if (stop === undefined) return null;
      const projection = reconstructMultiRunSession(events.slice(0, stop.sessionSeq));
      if (projection.taskExecution === null) return null;
      const status = projection.taskExecution.status;
      const stopReason = status === "completed" ? "completed" as const
        : status === "cancelled" ? "cancelled" as const
          : status === "failed" ? "failed" as const
            : status === "waiting_for_user" ? "waiting_for_user" as const
              : "blocked" as const;
      const startedAttempts = fresh.filter((event) =>
        event.sessionSeq > primary.sessionSeq && event.sessionSeq <= stop.sessionSeq &&
        event.type === "task_node.attempt.requested" && exactGraphEvent(event, request.payload)
      ).length;
      return Object.freeze({
        result: Object.freeze({
          execution: "foreground" as const,
          run: Object.freeze({ execution: projection.taskExecution, startedAttempts, stopReason }),
        }),
      });
    }
    if (request.actionKind === "worktree.allocate") {
      const primary = uniqueEvent(owned, "task_worktree.allocation.prepared", (event) => exactGraphEvent(event, request.payload));
      if (primary === null) return null;
      const plan = dataValue(primary, "allocation_plan") as Readonly<{ readonly nodeIds: readonly string[]; readonly workspaceId: string }>;
      const planSha256 = dataValue(primary, "allocation_plan_sha256");
      const approved = uniqueEvent(fresh, "task_worktree.allocation.approved", (event) =>
        event.sessionSeq > primary.sessionSeq && dataValue(event, "workspace_id") === plan.workspaceId &&
        dataValue(event, "allocation_plan_sha256") === planSha256
      );
      const requested = uniqueEvent(fresh, "task_worktree.create.requested", (event) =>
        event.sessionSeq > primary.sessionSeq && dataValue(event, "workspace_id") === plan.workspaceId &&
        dataValue(event, "allocation_plan_sha256") === planSha256
      );
      if (approved === null || requested === null || approved.sessionSeq >= requested.sessionSeq) return null;
      const created = uniqueEvent(fresh, "task_worktree.created", (event) =>
        event.sessionSeq > requested.sessionSeq && operationId(event) === operationId(requested)
      );
      const seeded = uniqueEvent(fresh, "task_worktree.baseline.seeded", (event) =>
        event.sessionSeq > requested.sessionSeq && dataValue(event, "workspace_id") === plan.workspaceId
      );
      if (created === null || seeded === null) return null;
      const identity = dataValue(created, "identity") as ManagedWorkspaceHandleV1["identity"];
      const baseline = dataValue(seeded, "baseline") as Readonly<{ readonly manifestSha256: string }>;
      if (identity.workspaceId !== plan.workspaceId || identity.allocationPlanSha256 !== planSha256) return null;
      return Object.freeze({
        result: Object.freeze({ baselineManifestSha256: baseline.manifestSha256, identity, nodeIds: Object.freeze([...plan.nodeIds]) }),
      });
    }
    if (request.actionKind === "promotion.apply") {
      const primary = uniqueEvent(owned, "task_worktree.promotion.proposed", (event) => exactGraphEvent(event, request.payload));
      if (primary === null) return null;
      const bundle = dataValue(primary, "bundle") as PromotionResultV1["bundle"];
      const approved = uniqueEvent(fresh, "task_worktree.promotion.approved", (event) =>
        event.sessionSeq > primary.sessionSeq && dataValue(event, "bundle_sha256") === bundle.bundleSha256 &&
        dataValue(event, "target_snapshot_sha256") === bundle.targetSnapshotSha256
      );
      if (approved === null) return null;
      const requested = uniqueEvent(fresh, "task_worktree.promotion.requested", (event) =>
        event.sessionSeq > approved.sessionSeq && dataValue(event, "bundle_sha256") === bundle.bundleSha256 &&
        dataValue(event, "target_snapshot_sha256") === bundle.targetSnapshotSha256 &&
        dataValue(event, "approval_request_id") === dataValue(approved, "approval_request_id")
      );
      if (requested === null) return null;
      const applied = uniqueEvent(fresh, "task_worktree.promotion.applied", (event) =>
        event.sessionSeq > requested.sessionSeq && operationId(event) === operationId(requested) &&
        dataValue(event, "bundle_sha256") === bundle.bundleSha256
      );
      if (applied === null) return null;
      const graph = graphAt(primary.sessionSeq);
      if (graph === null) return null;
      const requiresVerification = graph.content.nodes.some((candidate) => candidate.kind === "verification");
      const completed = uniqueEvent(fresh, "task_origin_verification.completed", (event) =>
        event.sessionSeq > applied.sessionSeq && dataValue(event, "promotion_operation_id") === operationId(requested)
      );
      if (requiresVerification && completed === null) return null;
      return Object.freeze({
        result: Object.freeze({
          bundle,
          changedPaths: Object.freeze([...(dataValue(applied, "changed_paths") as readonly string[])]),
          operationId: operationId(requested)!,
          originSourceSnapshotSha256: dataValue(applied, "origin_source_snapshot_sha256") as string,
          originVerification: completed === null ? null : verificationResult(completed),
          resultSnapshotSha256: dataValue(applied, "result_snapshot_sha256") as string,
        }),
      });
    }
    if (request.actionKind === "promotion.verify_origin") {
      const primary = uniqueEvent(owned, "task_origin_verification.requested", (event) =>
        exactGraphEvent(event, request.payload) && dataValue(event, "promotion_operation_id") === request.payload.promotionOperationId
      );
      if (primary === null) return null;
      const approved = uniqueEvent(fresh, "task_origin_verification.approved", (event) =>
        event.sessionSeq < primary.sessionSeq && exactGraphEvent(event, request.payload) &&
        dataValue(event, "approval_request_id") === dataValue(primary, "approval_request_id") &&
        dataValue(event, "verification_id") === dataValue(primary, "verification_id") &&
        dataValue(event, "action_sha256") === dataValue(primary, "action_sha256") &&
        dataValue(event, "command_sha256") === dataValue(primary, "command_sha256") &&
        dataValue(event, "promotion_operation_id") === request.payload.promotionOperationId
      );
      if (approved === null) return null;
      const completed = uniqueEvent(fresh, "task_origin_verification.completed", (event) =>
        event.sessionSeq > primary.sessionSeq &&
        dataValue(event, "verification_id") === dataValue(primary, "verification_id") &&
        dataValue(event, "promotion_operation_id") === request.payload.promotionOperationId
      );
      return completed === null ? null : Object.freeze({ result: verificationResult(completed) });
    }
    const primary = uniqueEvent(owned, "task_worktree.cleanup.requested", (event) => exactGraphEvent(event, request.payload));
    if (primary === null) return null;
    const completed = uniqueEvent(fresh, "task_worktree.cleanup.completed", (event) =>
      event.sessionSeq > primary.sessionSeq && operationId(event) === operationId(primary) &&
      dataValue(event, "workspace_id") === dataValue(primary, "workspace_id")
    );
    const status = completed === null ? null : dataValue(completed, "status");
    if (completed === null || (status !== "archived" && status !== "removed")) return null;
    return Object.freeze({
      result: Object.freeze({
        archiveSha256: dataValue(primary, "archive_sha256") as string | null,
        status,
        workspaceId: dataValue(primary, "workspace_id") as string,
      }),
    });
  }

  async #dispatch(
    request: GraphCompositeOwnerRequestV1,
    context: TaskMutationContext,
    binding: AuthenticatedTaskMutationBindingV1,
    applicationCommit: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
  ) {
    switch (request.actionKind) {
      case "graph.run":
        return this.#run(request.payload, context, binding, applicationCommit);
      case "graph.resume":
        return this.#resume(request.payload, context, binding, applicationCommit);
      case "graph.retry":
        return new TaskExecutionControlPlane(taskWriterFactory(this.options.runtime)).retry({
          attemptNumber: request.payload.attemptNumber,
          attemptTerminal: request.payload.attemptTerminal,
          context,
          graphRevision: request.payload.revision,
          graphSha256: request.payload.sha256,
          nodeId: request.payload.nodeId,
          terminalEventId: request.payload.terminalEventId,
        });
      case "worktree.allocate":
        return this.#withCancellation(request.actionKind, context.sessionId, applicationCommit, async (signal) => {
          const manager = await this.options.runtime.createManagedWorktreeManager?.({
            authenticatedMutation: binding,
            inputSurface: localInputSurface(binding),
            io: this.options.io,
            sessionId: context.sessionId,
          });
          if (manager === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no managed worktree authority");
          const handle = await manager.allocate({
            allowDirty: request.payload.allowDirty,
            graphRevision: request.payload.revision,
            graphSha256: request.payload.sha256,
            signal,
            sourceNodeId: request.payload.sourceNodeId,
          });
          return Object.freeze({
            baselineManifestSha256: handle.baselineManifestSha256,
            identity: handle.identity,
            nodeIds: handle.nodeIds,
          } satisfies WorktreeAllocateCompositeResultV1);
        });
      case "promotion.apply":
        return this.#withCancellation(request.actionKind, context.sessionId, applicationCommit, async (signal) => {
          const promotion = await this.options.runtime.createWorktreePromotionRuntime?.({
            authenticatedMutation: binding,
            inputSurface: localInputSurface(binding),
            io: this.options.io,
            sessionId: context.sessionId,
          });
          if (promotion === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no worktree promotion authority");
          return promotion.promote({
            attemptId: request.payload.attemptId,
            graphRevision: request.payload.revision,
            graphSha256: request.payload.sha256,
            nodeId: request.payload.nodeId,
            signal,
          });
        });
      case "promotion.verify_origin":
        return this.#withCancellation(request.actionKind, context.sessionId, applicationCommit, async (signal) => {
          const promotion = await this.options.runtime.createWorktreePromotionRuntime?.({
            authenticatedMutation: binding,
            inputSurface: localInputSurface(binding),
            io: this.options.io,
            sessionId: context.sessionId,
          });
          if (promotion === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no origin verification authority");
          return promotion.verifyOrigin({
            graphRevision: request.payload.revision,
            graphSha256: request.payload.sha256,
            promotionOperationId: request.payload.promotionOperationId,
            signal,
          });
        });
      case "worktree.cleanup":
        return this.#withCancellation(request.actionKind, context.sessionId, applicationCommit, async (signal) => {
          const manager = await this.options.runtime.createManagedWorktreeManager?.({
            authenticatedMutation: binding,
            inputSurface: localInputSurface(binding),
            io: this.options.io,
            sessionId: context.sessionId,
          });
          if (manager === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no managed worktree cleanup authority");
          return manager.cleanup({
            archiveAndRemove: request.payload.archiveAndRemove,
            graphId: request.payload.graphId,
            graphRevision: request.payload.revision,
            graphSha256: request.payload.sha256,
            nodeId: request.payload.nodeId,
            signal,
          });
        });
    }
  }

  async #run(
    payload: Extract<GraphCompositeOwnerRequestV1, { readonly actionKind: "graph.run" }>["payload"],
    context: TaskMutationContext,
    binding: AuthenticatedTaskMutationBindingV1,
    applicationCommit: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
  ): Promise<GraphRunCompositeResultV1> {
    const session = await new SessionCatalog(this.options.runtime.cwd).read(context.sessionId);
    const current = session.taskExecution;
    if (
      current === null || current.status !== "queued" ||
      current.graph.revision !== payload.revision || current.graph.graphSha256 !== payload.sha256 ||
      current.enqueue.requestedExecution !== payload.execution
    ) {
      throw new TaskGraphError("task_graph_revision_conflict", "run selector does not exact-match one queued Graph");
    }
    if (payload.execution === "background") {
      const launcher = this.options.runtime.createBackgroundWorkerLauncher?.({
        authenticatedMutation: binding,
        inputSurface: localInputSurface(binding),
        sessionId: context.sessionId,
      });
      if (launcher === undefined) throw new BackgroundError("background_executable_unsealed", "runtime has no sealed background worker launcher");
      const launch = await launcher.launch();
      return Object.freeze({ execution: "background", graph: current.graph, launch });
    }
    return this.#foreground(current.enqueue.runtimeProfileId, context, payload, applicationCommit);
  }

  async #resume(
    payload: Extract<GraphCompositeOwnerRequestV1, { readonly actionKind: "graph.resume" }>["payload"],
    context: TaskMutationContext,
    binding: AuthenticatedTaskMutationBindingV1,
    applicationCommit: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
  ): Promise<GraphRunCompositeResultV1> {
    if (payload.takeover && payload.execution !== "background") {
      throw new BackgroundError("worker_control_stale", "takeover may only launch a fresh background owner");
    }
    if (payload.takeover) {
      const reconcile = this.options.runtime.reconcileBackgroundWorkerTakeover;
      if (reconcile === undefined) throw new BackgroundError("background_executable_unsealed", "runtime has no bounded takeover reconciler");
      await reconcile({ graphRevision: payload.revision, graphSha256: payload.sha256, sessionId: context.sessionId });
    } else {
      const before = await new SessionCatalog(this.options.runtime.cwd).read(context.sessionId);
      if (
        before.taskExecution === null || before.taskExecution.status !== "waiting_for_user" ||
        before.taskExecution.graph.revision !== payload.revision ||
        before.taskExecution.graph.graphSha256 !== payload.sha256 || before.background.current !== null
      ) {
        throw new BackgroundError("worker_waiting_for_user", "resume requires one exact waiting Graph with no active worker owner");
      }
      await new TaskExecutionControlPlane(taskWriterFactory(this.options.runtime)).enqueue({
        context,
        requestedExecution: payload.execution,
        revision: payload.revision,
        runtimeProfileId: before.taskExecution.enqueue.runtimeProfileId,
        sha256: payload.sha256,
      });
    }
    const enqueued = await new SessionCatalog(this.options.runtime.cwd).read(context.sessionId);
    if (
      enqueued.taskExecution === null || enqueued.taskExecution.status !== "queued" ||
      enqueued.taskExecution.graph.revision !== payload.revision ||
      enqueued.taskExecution.graph.graphSha256 !== payload.sha256 ||
      enqueued.taskExecution.enqueue.requestedExecution !== payload.execution || enqueued.background.current !== null
    ) {
      throw new BackgroundError("worker_reconciliation_required", "resume did not produce one clean queued Graph");
    }
    if (payload.execution === "background") {
      const launcher = this.options.runtime.createBackgroundWorkerLauncher?.({
        authenticatedMutation: binding,
        inputSurface: localInputSurface(binding),
        sessionId: context.sessionId,
      });
      if (launcher === undefined) throw new BackgroundError("background_executable_unsealed", "runtime has no sealed background worker launcher");
      const launch = await launcher.launch();
      return Object.freeze({ execution: "background", graph: enqueued.taskExecution.graph, launch });
    }
    return this.#foreground(
      enqueued.taskExecution.enqueue.runtimeProfileId,
      {
        ...context,
        expectedSessionSeq: enqueued.events.length,
      },
      payload,
      applicationCommit,
    );
  }

  async #foreground(
    runtimeProfileId: string,
    context: TaskMutationContext,
    graph: Readonly<{ readonly revision: number; readonly sha256: string }>,
    applicationCommit: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
  ): Promise<GraphRunCompositeResultV1> {
    const executor = this.options.runtime.createTaskAttemptExecutor?.({
      io: this.options.io,
      runtimeProfileId,
      sessionId: context.sessionId,
      writerFactory: taskWriterFactory(this.options.runtime),
    });
    if (executor === undefined) throw new TaskGraphError("task_workspace_mode_unavailable", "runtime has no Graph attempt executor");
    const controller = new AbortController();
    let markComplete: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => { markComplete = resolve; });
    const release = this.options.foregroundGraphControls.register(context.sessionId, Object.freeze({
      graphRevision: graph.revision,
      graphSha256: graph.sha256,
      ownerApplicationOperationId: applicationCommit.operationId,
      ownerPreparedActionSha256: applicationCommit.preparedActionSha256,
      requestCancel: async ({ requestReference }: Readonly<{ readonly requestReference: DurableRecordReferenceV1 }>) => {
        if (
          requestReference.ownerKind !== "session" ||
          requestReference.ledgerId !== `session:${context.sessionId}` ||
          requestReference.sequence === null || requestReference.sequence < 1
        ) {
          throw new TaskGraphError("task_effect_reconciliation_required", "foreground Graph signal lacks an exact durable session cancel request");
        }
        controller.abort();
        await completion;
      },
      requestHostEmergencyStop: () => controller.abort("tui_surface_fatal"),
    }));
    try {
      const run = await new DeterministicTaskScheduler({
        context,
        executor,
        repositoryId: sha256Canonical({ workspace: this.options.runtime.cwd }),
        writerFactory: taskWriterFactory(this.options.runtime),
      }).run(controller.signal);
      return Object.freeze({ execution: "foreground", run });
    } finally {
      markComplete?.();
      release();
    }
  }

  #primary(
    request: GraphCompositeOwnerRequestV1,
    _result: unknown,
    _fresh: readonly DecodedStoredEvent[],
    owned: readonly DecodedStoredEvent[],
  ): DecodedStoredEvent {
    if (isPreEffectTerminal(_result)) {
      return findRequiredEvent(owned, "task_effect.admission.terminal", (event) =>
        dataValue(event, "action_kind") === _result.actionKind &&
        dataValue(event, "target_identity_sha256") === _result.targetIdentitySha256 &&
        dataValue(event, "outcome") === _result.outcome
      );
    }
    const expected = request.actionKind === "graph.run"
      ? request.payload.execution === "background" ? "task_worker.spawn.requested" : "task_graph.started"
      : request.actionKind === "graph.resume"
        ? request.payload.takeover ? "task_worker.spawn.requested" : "task_graph.enqueued"
        : request.actionKind === "graph.retry" ? "task_node.retry.requested"
        : request.actionKind === "worktree.allocate" ? "task_worktree.allocation.prepared"
          : request.actionKind === "promotion.apply" ? "task_worktree.promotion.proposed"
            : request.actionKind === "promotion.verify_origin" ? "task_origin_verification.requested"
              : "task_worktree.cleanup.requested";
    return findRequiredEvent(owned, expected);
  }

  #underlying(
    request: GraphCompositeOwnerRequestV1,
    result: unknown,
    fresh: readonly DecodedStoredEvent[],
    owned: readonly DecodedStoredEvent[],
  ): readonly DecodedStoredEvent[] {
    if (isPreEffectTerminal(result)) return Object.freeze([]);
    const ownedIds = new Set(owned.map((event) => event.eventId));
    const candidates = fresh.filter((event) => !ownedIds.has(event.eventId) && UNDERLYING_EVENT_TYPES[request.actionKind].has(event.type));
    if (request.actionKind === "graph.retry") {
      return Object.freeze([]);
    }
    if ((request.actionKind === "graph.run" || request.actionKind === "graph.resume") && request.payload.execution === "background") {
      const launch = (result as Extract<GraphRunCompositeResultV1, { readonly execution: "background" }>).launch;
      const started = findRequiredEvent(candidates, "task_worker.started", (event) =>
        event.eventId === launch.startedEventId && operationId(event) === launch.operationId
      );
      return Object.freeze([started]);
    } else if (request.actionKind === "graph.run" || request.actionKind === "graph.resume") {
      const run = (result as Extract<GraphRunCompositeResultV1, { readonly execution: "foreground" }>).run;
      const graphCandidates = candidates.filter((event) => exactGraphEvent(event, request.payload));
      const terminalTypes = new Set(["task_graph.terminal", "task_graph.waiting_for_user"]);
      const stop = graphCandidates.find((event) => terminalTypes.has(event.type));
      if (stop === undefined || !["blocked", "cancelled", "completed", "failed", "waiting_for_user"].includes(run.stopReason)) {
        throw new TaskGraphError("task_effect_reconciliation_required", "foreground scheduler returned without an exact stop predicate");
      }
      return Object.freeze(graphCandidates.filter((event) => event.sessionSeq <= stop.sessionSeq));
    } else if (request.actionKind === "worktree.allocate") {
      const allocation = result as WorktreeAllocateCompositeResultV1;
      const approved = findRequiredEvent(candidates, "task_worktree.allocation.approved", (event) =>
        dataValue(event, "workspace_id") === allocation.identity.workspaceId &&
        dataValue(event, "allocation_plan_sha256") === allocation.identity.allocationPlanSha256
      );
      const requested = findRequiredEvent(candidates, "task_worktree.create.requested", (event) => dataValue(event, "workspace_id") === allocation.identity.workspaceId);
      const created = findRequiredEvent(candidates, "task_worktree.created", (event) => operationId(event) === operationId(requested));
      const seeded = findRequiredEvent(candidates, "task_worktree.baseline.seeded", (event) => dataValue(event, "workspace_id") === allocation.identity.workspaceId);
      return Object.freeze([approved, requested, created, seeded]);
    } else if (request.actionKind === "promotion.apply") {
      const promoted = result as { readonly bundle: { readonly bundleSha256: string }; readonly operationId: string };
      const approved = findRequiredEvent(candidates, "task_worktree.promotion.approved", (event) =>
        dataValue(event, "bundle_sha256") === promoted.bundle.bundleSha256
      );
      const requested = findRequiredEvent(candidates, "task_worktree.promotion.requested", (event) =>
        operationId(event) === promoted.operationId &&
        dataValue(event, "approval_request_id") === dataValue(approved, "approval_request_id")
      );
      const applied = findRequiredEvent(candidates, "task_worktree.promotion.applied", (event) =>
        operationId(event) === promoted.operationId && dataValue(event, "bundle_sha256") === promoted.bundle.bundleSha256
      );
      const completed = candidates.filter((event) =>
        event.type === "task_origin_verification.completed" && dataValue(event, "promotion_operation_id") === promoted.operationId
      );
      if (completed.length > 1) throw new TaskGraphError("task_effect_reconciliation_required", "promotion has ambiguous verification terminals");
      return Object.freeze([approved, requested, applied, ...completed]);
    } else if (request.actionKind === "promotion.verify_origin") {
      const verified = result as { readonly completedEventId: string; readonly verificationId: string };
      const approved = findRequiredEvent(candidates, "task_origin_verification.approved", (event) =>
        dataValue(event, "verification_id") === verified.verificationId
      );
      const completed = findRequiredEvent(candidates, "task_origin_verification.completed", (event) =>
        event.eventId === verified.completedEventId && dataValue(event, "verification_id") === verified.verificationId
      );
      return Object.freeze([approved, completed]);
    } else {
      const cleaned = result as { readonly workspaceId: string };
      const requested = findRequiredEvent(owned, "task_worktree.cleanup.requested", (event) => dataValue(event, "workspace_id") === cleaned.workspaceId);
      const completed = findRequiredEvent(candidates, "task_worktree.cleanup.completed", (event) => operationId(event) === operationId(requested));
      return Object.freeze([completed]);
    }
  }

  async #withCancellation<T>(
    actionKind: OwnerInternalCompositeActionKindV1,
    sessionId: string,
    applicationCommit: Parameters<GraphCompositeOwnerPortV1["execute"]>[0]["applicationCommit"],
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const release = this.options.activeOwnerComposites.register(sessionId, Object.freeze({
      actionKind,
      ownerApplicationOperationId: applicationCommit.operationId,
      ownerPreparedActionSha256: applicationCommit.preparedActionSha256,
      requestAbort: () => controller.abort("user"),
      requestHostEmergencyStop: () => controller.abort("tui_surface_fatal"),
    }));
    const stop = this.options.runtime.onCancel(() => controller.abort("user"));
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OwnerCompositeCancelledError(
          controller.signal.reason === "tui_surface_fatal" ? "tui_surface_fatal" : "user",
          { cause: error },
        );
      }
      throw error;
    } finally {
      stop();
      release();
    }
  }

  async #recordPreEffectTerminal(
    input: Parameters<GraphCompositeOwnerPortV1["execute"]>[0],
    context: TaskMutationContext,
    outcome: GraphCompositePreEffectTerminalResultV1["outcome"],
  ): Promise<GraphCompositePreEffectTerminalResultV1> {
    const request = input.request;
    if (
      request.actionKind === "graph.run" ||
      request.actionKind === "graph.resume" ||
      request.actionKind === "graph.retry"
    ) {
      throw new TaskGraphError("task_effect_reconciliation_required", "Graph execution cancellation requires its typed Graph terminal");
    }
    const targetIdentitySha256 = preEffectTargetIdentity(request);
    const writer = await taskWriterFactory(this.options.runtime)(context);
    try {
      const fresh = writer.events.filter((event) => event.sessionSeq > input.expectedHead.sequence);
      if (
        effectWasAdmitted(request, fresh) ||
        fresh.some((event) =>
          applicationOperationId(event) === input.applicationCommit.operationId &&
          !exactApplicationCommit(event, input.applicationCommit)
        )
      ) {
        throw new TaskGraphError("task_effect_reconciliation_required", "owner cancellation arrived after effect admission or with conflicting authority");
      }
      const ownedTerminals = fresh.filter((event) =>
        event.type === "task_effect.admission.terminal" &&
        exactApplicationCommit(event, input.applicationCommit)
      );
      if (ownedTerminals.length > 1) {
        throw new TaskGraphError("task_effect_reconciliation_required", "owner has ambiguous pre-effect terminal evidence");
      }
      if (ownedTerminals.length === 1) {
        const terminal = ownedTerminals[0]!;
        if (
          !exactGraphEvent(terminal, request.payload) ||
          dataValue(terminal, "action_kind") !== request.actionKind ||
          dataValue(terminal, "outcome") !== outcome ||
          dataValue(terminal, "target_identity_sha256") !== targetIdentitySha256
        ) {
          throw new TaskGraphError("task_effect_reconciliation_required", "owner pre-effect terminal does not exact-match its action target");
        }
      } else {
        await writer.appendTaskGraphEvent("task_effect.admission.terminal", {
          action_kind: request.actionKind,
          graph_id: (() => {
            const graph = reconstructMultiRunSession(writer.events).taskGraph.revisions.find((candidate) =>
              candidate.revision === request.payload.revision && candidate.graphSha256 === request.payload.sha256
            );
            if (graph === undefined) {
              throw new TaskGraphError("task_graph_revision_conflict", "pre-effect cancellation target Graph is unavailable");
            }
            return graph.graphId;
          })(),
          graph_revision: request.payload.revision,
          graph_sha256: request.payload.sha256,
          origin: taskUserOrigin(context),
          outcome,
          target_identity_sha256: targetIdentitySha256,
        });
      }
      return Object.freeze({
        actionKind: request.actionKind,
        kind: "pre_effect_terminal",
        outcome,
        targetIdentitySha256,
      });
    } finally {
      await writer.close();
    }
  }
}
