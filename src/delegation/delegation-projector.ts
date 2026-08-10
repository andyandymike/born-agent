import { sha256Canonical } from "../completion/canonical-json.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { delegationApprovalIdentity, canonicalDelegationIdentity } from "./delegation-identity.js";
import { DelegationError } from "./delegation-errors.js";
import type {
  Phase20DelegationSessionEventData,
  Phase20DelegationSessionEventType,
} from "./delegation-event-schema.js";
import type {
  DelegationParentBindingV1,
  DelegationRevisionContentV1,
} from "./delegation-schema.js";

export type DelegationStatusV1 =
  | "draft"
  | "approved"
  | "queued"
  | "active"
  | "waiting_approval"
  | "cancelling"
  | "reconciling"
  | "receipt_ready"
  | "accepted"
  | "failed"
  | "blocked"
  | "cancelled"
  | "stale"
  | "rejected"
  | "superseded";

export interface DelegationArtifactRefV1 {
  readonly artifactId: string;
  readonly bytes: number;
  readonly objectRef: string;
  readonly sha256: string;
}

export interface DelegationAttemptProjectionV1 {
  readonly attemptId: string;
  readonly attemptNumber: number | null;
  readonly actorId: string | null;
  readonly childRunId: string | null;
  readonly executableEnvelopeSha256: string | null;
  readonly operationId: string | null;
  readonly reservationId: string;
  readonly budgetUsage: DelegationBudgetCountersProjectionV1 | null;
  readonly budgetSettlementEventId: string | null;
  readonly startedEventId: string | null;
  readonly terminalEventId: string | null;
  readonly terminal: "succeeded" | "known_failed" | "pre_effect_infrastructure_failure" | "cancelled_clean" | "blocked_unknown_effect" | null;
  readonly unresolvedEffectIds: readonly string[];
}

export interface DelegationClaimStatusProjectionV1 {
  readonly claimId: string;
  readonly status: "verified" | "unverified" | "stale";
}

export interface DelegationRevisionProjectionV1 {
  readonly artifact: DelegationArtifactRefV1;
  readonly attempts: readonly DelegationAttemptProjectionV1[];
  readonly authorityPreviewSha256: string;
  readonly binding: DelegationParentBindingV1;
  readonly content: DelegationRevisionContentV1;
  readonly createdEventId: string;
  readonly decisionEventId: string | null;
  readonly delegationId: string;
  readonly delegationRevision: number;
  readonly delegationSha256: string;
  readonly envelope: {
    readonly contextCapsule: DelegationArtifactRefV1;
    readonly contextCapsuleSha256: string;
    readonly envelope: DelegationArtifactRefV1;
    readonly envelopeSha256: string;
  } | null;
  readonly envelopePreparationCount: number;
  readonly parentActorId: string;
  readonly parentRunId: string;
  readonly receipt: {
    readonly acceptedEventId: string | null;
    readonly artifact: DelegationArtifactRefV1;
    readonly readyEventId: string;
    readonly sha256: string;
    readonly status: "succeeded" | "failed" | "blocked" | "cancelled";
    readonly claimStatuses: readonly DelegationClaimStatusProjectionV1[];
  } | null;
  readonly blockerCodes: readonly string[];
  readonly status: DelegationStatusV1;
  readonly terminalEventId: string | null;
}

export interface DelegationBarrierProjectionV1 {
  readonly barrierId: string;
  readonly parentActorId: string;
  readonly parentRunId: string;
  readonly requiredDelegationIds: readonly string[];
  readonly receiptSha256s: readonly string[];
  readonly status: "requested" | "suspended" | "released";
  readonly terminalStatus: "completed" | "blocked" | "cancelled" | null;
}

export interface DelegationApprovalProjectionV1 {
  readonly actionDigest: string;
  readonly actionKind: string;
  readonly approvalRequestId: string;
  readonly childActorId: string;
  readonly childAttemptId: string;
  readonly delegationId: string;
  readonly workspaceId: string | null;
}

export interface DelegationBudgetCountersProjectionV1 {
  readonly artifactBytes: number;
  readonly attempts: number;
  readonly changedBytes: number;
  readonly changedFiles: number;
  readonly commandExecutions: number;
  readonly commandOutputBytes: number;
  readonly durationMs: number;
  readonly modelSteps: number;
  readonly reportedTokens: number | null;
}

export interface DelegationActorSlotProjectionV1 {
  readonly actorId: string;
  readonly actorKind: "parent" | "child";
  readonly claimId: string;
  readonly groupId: string;
  readonly slot: 1 | 2;
}

export interface DelegationConflictClaimProjectionV1 {
  readonly access: "read" | "write";
  readonly actorId: string;
  readonly claimId: string;
  readonly groupId: string;
  readonly pathPrefixes: readonly string[];
  readonly repositoryId: string;
  readonly sourceLineageId: string;
  readonly sourceSnapshotSha256: string;
  readonly workspaceId: string | null;
}

export interface DelegationProjectionV1 {
  readonly trackingMode: "none" | "phase20";
  readonly revisions: readonly DelegationRevisionProjectionV1[];
  readonly activeActorSlots: readonly DelegationActorSlotProjectionV1[];
  readonly activeConflictClaims: readonly DelegationConflictClaimProjectionV1[];
  readonly barriers: readonly DelegationBarrierProjectionV1[];
  readonly budget: {
    readonly held: DelegationBudgetCountersProjectionV1;
    readonly released: DelegationBudgetCountersProjectionV1;
    readonly reserved: DelegationBudgetCountersProjectionV1;
    readonly used: DelegationBudgetCountersProjectionV1;
  };
  readonly maximumObservedActiveChildren: number;
  readonly takeoverCount: number;
  readonly waitingApprovals: readonly DelegationApprovalProjectionV1[];
  readonly workspaceConflictDeferrals: number;
  readonly lastSessionSeq: number;
}

interface MutableAttempt {
  attemptId: string;
  attemptNumber: number | null;
  actorId: string | null;
  childRunId: string | null;
  executableEnvelopeSha256: string | null;
  operationId: string | null;
  reservationId: string;
  budgetUsage: DelegationBudgetCountersProjectionV1 | null;
  budgetSettlementEventId: string | null;
  startedEventId: string | null;
  terminalEventId: string | null;
  terminal: DelegationAttemptProjectionV1["terminal"];
  unresolvedEffectIds: string[];
}

interface MutableRevision {
  artifact: DelegationArtifactRefV1;
  attempts: MutableAttempt[];
  blockerCodes: string[];
  authorityPreviewSha256: string;
  binding: DelegationParentBindingV1;
  content: DelegationRevisionContentV1;
  createdEventId: string;
  decisionEventId: string | null;
  delegationId: string;
  delegationRevision: number;
  delegationSha256: string;
  envelope: DelegationRevisionProjectionV1["envelope"];
  envelopePreparationCount: number;
  parentActorId: string;
  parentRunId: string;
  receipt: DelegationRevisionProjectionV1["receipt"];
  status: DelegationStatusV1;
  terminalEventId: string | null;
}

interface MutableBarrier {
  barrierId: string;
  parentActorId: string;
  parentRunId: string;
  requiredDelegationIds: string[];
  receiptSha256s: string[];
  status: "requested" | "suspended" | "released";
  terminalStatus: "completed" | "blocked" | "cancelled" | null;
}

const EVENT_TYPES = new Set<Phase20DelegationSessionEventType>([
  "delegation.revision.proposed",
  "delegation.revision.replaced",
  "delegation.decision.recorded",
  "delegation.queued",
  "delegation.cancel.requested",
  "delegation.cancelled",
  "delegation.stale",
  "delegation.envelope.prepared",
  "delegation.parent.barrier.requested",
  "delegation.parent.barrier.suspended",
  "delegation.parent.barrier.released",
  "delegation.budget.reserved",
  "delegation.child.launch_requested",
  "delegation.child.started",
  "delegation.child.approval_waiting",
  "delegation.child.terminal",
  "delegation.effect.reconciled",
  "delegation.receipt.ready",
  "delegation.receipt.accepted",
  "delegation.budget.settled",
  "delegation.actor_slot.claimed",
  "delegation.actor_slot.released",
  "delegation.conflict_claim.granted",
  "delegation.conflict_claim.released",
  "delegation.group.lease.acquired",
  "delegation.group.takeover",
  "delegation.blocked",
]);

function key(id: string, revision: number): string {
  return `${id}\0${String(revision)}`;
}

function artifact(value: {
  readonly artifact_id: string;
  readonly bytes: number;
  readonly object_ref: string;
  readonly sha256: string;
}): DelegationArtifactRefV1 {
  return Object.freeze({
    artifactId: value.artifact_id,
    bytes: value.bytes,
    objectRef: value.object_ref,
    sha256: value.sha256,
  });
}

function data<T extends Phase20DelegationSessionEventType>(
  event: DecodedStoredEvent,
  type: T,
): Phase20DelegationSessionEventData<T> {
  if (event.scope !== "session" || event.type !== type) {
    throw new DelegationError("delegation_invalid", "delegation projector received an inconsistent event type");
  }
  return event.data as Phase20DelegationSessionEventData<T>;
}

function sameBinding(left: DelegationParentBindingV1, right: DelegationParentBindingV1): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function prefixesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) =>
    a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function zeroBudgetCounters(): DelegationBudgetCountersProjectionV1 {
  return Object.freeze({
    artifactBytes: 0,
    attempts: 0,
    changedBytes: 0,
    changedFiles: 0,
    commandExecutions: 0,
    commandOutputBytes: 0,
    durationMs: 0,
    modelSteps: 0,
    reportedTokens: 0,
  });
}

function budgetCounters(value: {
  readonly artifact_bytes: number;
  readonly attempts: number;
  readonly changed_bytes: number;
  readonly changed_files: number;
  readonly command_executions: number;
  readonly command_output_bytes: number;
  readonly duration_ms: number;
  readonly model_steps: number;
  readonly reported_tokens: number | null;
}): DelegationBudgetCountersProjectionV1 {
  return Object.freeze({
    artifactBytes: value.artifact_bytes,
    attempts: value.attempts,
    changedBytes: value.changed_bytes,
    changedFiles: value.changed_files,
    commandExecutions: value.command_executions,
    commandOutputBytes: value.command_output_bytes,
    durationMs: value.duration_ms,
    modelSteps: value.model_steps,
    reportedTokens: value.reported_tokens,
  });
}

function addBudgetCounters(
  left: DelegationBudgetCountersProjectionV1,
  right: DelegationBudgetCountersProjectionV1,
): DelegationBudgetCountersProjectionV1 {
  return Object.freeze({
    artifactBytes: left.artifactBytes + right.artifactBytes,
    attempts: left.attempts + right.attempts,
    changedBytes: left.changedBytes + right.changedBytes,
    changedFiles: left.changedFiles + right.changedFiles,
    commandExecutions: left.commandExecutions + right.commandExecutions,
    commandOutputBytes: left.commandOutputBytes + right.commandOutputBytes,
    durationMs: left.durationMs + right.durationMs,
    modelSteps: left.modelSteps + right.modelSteps,
    reportedTokens: left.reportedTokens === null || right.reportedTokens === null
      ? null
      : left.reportedTokens + right.reportedTokens,
  });
}

function budgetCountersBalance(
  reserved: DelegationBudgetCountersProjectionV1,
  used: DelegationBudgetCountersProjectionV1,
  released: DelegationBudgetCountersProjectionV1,
  held: DelegationBudgetCountersProjectionV1,
): boolean {
  const exact = (key: Exclude<keyof DelegationBudgetCountersProjectionV1, "reportedTokens">) =>
    reserved[key] === used[key] + released[key] + held[key];
  if (!([
    "artifactBytes",
    "attempts",
    "changedBytes",
    "changedFiles",
    "commandExecutions",
    "commandOutputBytes",
    "durationMs",
    "modelSteps",
  ] as const).every(exact)) return false;
  if (reserved.reportedTokens === null) {
    return used.reportedTokens === null && released.reportedTokens === null && held.reportedTokens === null;
  }
  return used.reportedTokens !== null && released.reportedTokens !== null && held.reportedTokens !== null &&
    reserved.reportedTokens === used.reportedTokens + released.reportedTokens + held.reportedTokens;
}

function attemptProjection(value: MutableAttempt): DelegationAttemptProjectionV1 {
  return Object.freeze({
    attemptId: value.attemptId,
    attemptNumber: value.attemptNumber,
    actorId: value.actorId,
    childRunId: value.childRunId,
    executableEnvelopeSha256: value.executableEnvelopeSha256,
    operationId: value.operationId,
    reservationId: value.reservationId,
    budgetUsage: value.budgetUsage,
    budgetSettlementEventId: value.budgetSettlementEventId,
    startedEventId: value.startedEventId,
    terminalEventId: value.terminalEventId,
    terminal: value.terminal,
    unresolvedEffectIds: Object.freeze([...value.unresolvedEffectIds]),
  });
}

function revisionProjection(value: MutableRevision): DelegationRevisionProjectionV1 {
  return Object.freeze({
    artifact: value.artifact,
    attempts: Object.freeze(value.attempts.map(attemptProjection)),
    blockerCodes: Object.freeze([...value.blockerCodes]),
    authorityPreviewSha256: value.authorityPreviewSha256,
    binding: value.binding,
    content: value.content,
    createdEventId: value.createdEventId,
    decisionEventId: value.decisionEventId,
    delegationId: value.delegationId,
    delegationRevision: value.delegationRevision,
    delegationSha256: value.delegationSha256,
    envelope: value.envelope,
    envelopePreparationCount: value.envelopePreparationCount,
    parentActorId: value.parentActorId,
    parentRunId: value.parentRunId,
    receipt: value.receipt,
    status: value.status,
    terminalEventId: value.terminalEventId,
  });
}

export class DelegationProjector {
  static project(events: readonly DecodedStoredEvent[]): DelegationProjectionV1 {
    const revisions: MutableRevision[] = [];
    const byKey = new Map<string, MutableRevision>();
    const activeSlots = new Map<string, DelegationActorSlotProjectionV1>();
    const conflictClaims = new Map<string, DelegationConflictClaimProjectionV1>();
    const barriers = new Map<string, MutableBarrier>();
    const groupLeases = new Map<string, string>();
    const waitingApprovals = new Map<string, DelegationApprovalProjectionV1>();
    const reservations = new Map<string, DelegationBudgetCountersProjectionV1>();
    const settlements = new Map<string, {
      readonly held: DelegationBudgetCountersProjectionV1;
      readonly released: DelegationBudgetCountersProjectionV1;
      readonly used: DelegationBudgetCountersProjectionV1;
    }>();
    let maximumObservedActiveChildren = 0;
    let takeoverCount = 0;

    const exact = (event: DecodedStoredEvent): MutableRevision => {
      const target = event.data as {
        readonly delegation_id?: unknown;
        readonly delegation_revision?: unknown;
        readonly delegation_sha256?: unknown;
        readonly parent_actor_id?: unknown;
        readonly parent_run_id?: unknown;
      };
      if (
        typeof target.delegation_id !== "string" ||
        typeof target.delegation_revision !== "number" ||
        typeof target.delegation_sha256 !== "string"
      ) {
        throw new DelegationError("delegation_invalid", `${event.type} has no exact delegation target`);
      }
      const found = byKey.get(key(target.delegation_id, target.delegation_revision));
      if (
        found === undefined ||
        found.delegationSha256 !== target.delegation_sha256 ||
        found.parentActorId !== target.parent_actor_id ||
        found.parentRunId !== target.parent_run_id
      ) {
        throw new DelegationError("delegation_revision_conflict", `${event.type} targets an unknown or stale delegation revision`);
      }
      return found;
    };

    const exactAttempt = (revision: MutableRevision, attemptId: string): MutableAttempt => {
      const found = revision.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (found === undefined) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegation event targets an unknown child attempt");
      }
      return found;
    };

    for (const event of events) {
      if (event.scope !== "session" || !EVENT_TYPES.has(event.type as Phase20DelegationSessionEventType)) continue;
      switch (event.type) {
        case "delegation.revision.proposed": {
          const value = data(event, "delegation.revision.proposed");
          if (
            value.delegation_revision !== 1 ||
            byKey.has(key(value.delegation_id, value.delegation_revision)) ||
            revisions.some((candidate) => candidate.delegationId === value.delegation_id)
          ) {
            throw new DelegationError("delegation_revision_conflict", "delegation proposal identity is not a new revision one");
          }
          const identity = canonicalDelegationIdentity(value.content);
          if (
            identity.delegationSha256 !== value.delegation_sha256 ||
            identity.content.delegationId !== value.delegation_id ||
            !sameBinding(identity.content.binding, value.binding) ||
            value.binding.sessionId !== event.sessionId ||
            value.parent_actor_id !== value.binding.parentActorId ||
            value.parent_run_id !== value.binding.parentRunId ||
            value.artifact.sha256 !== value.delegation_sha256 ||
            value.artifact.bytes !== identity.byteLength
          ) {
            throw new DelegationError("delegation_artifact_invalid", "delegation proposal identity or artifact is inconsistent");
          }
          const sameParent = revisions.filter((candidate) => candidate.parentActorId === value.parent_actor_id);
          if (
            sameParent.length >= 8 ||
            sameParent.some((candidate) => candidate.content.sequence === identity.content.sequence)
          ) {
            throw new DelegationError("delegation_parallel_limit", "parent delegation count or sequence bound was exceeded");
          }
          const created: MutableRevision = {
            artifact: artifact(value.artifact),
            attempts: [],
            blockerCodes: [],
            authorityPreviewSha256: value.authority_preview_sha256,
            binding: identity.content.binding,
            content: identity.content,
            createdEventId: event.eventId,
            decisionEventId: null,
            delegationId: value.delegation_id,
            delegationRevision: value.delegation_revision,
            delegationSha256: value.delegation_sha256,
            envelope: null,
            envelopePreparationCount: 0,
            parentActorId: value.parent_actor_id,
            parentRunId: value.parent_run_id,
            receipt: null,
            status: "draft",
            terminalEventId: null,
          };
          revisions.push(created);
          byKey.set(key(created.delegationId, created.delegationRevision), created);
          break;
        }
        case "delegation.revision.replaced": {
          const value = data(event, "delegation.revision.replaced");
          const base = byKey.get(key(value.delegation_id, value.base_revision));
          if (
            base === undefined ||
            base.delegationSha256 !== value.base_sha256 ||
            base.status !== "draft" ||
            value.delegation_revision !== base.delegationRevision + 1 ||
            byKey.has(key(value.delegation_id, value.delegation_revision))
          ) {
            throw new DelegationError("delegation_revision_conflict", "delegation replacement base is stale or immutable");
          }
          const identity = canonicalDelegationIdentity(value.content);
          if (
            identity.delegationSha256 !== value.delegation_sha256 ||
            identity.content.delegationId !== base.delegationId ||
            !sameBinding(identity.content.binding, base.binding) ||
            !sameBinding(value.binding, base.binding) ||
            value.parent_actor_id !== base.parentActorId ||
            value.parent_run_id !== base.parentRunId ||
            value.artifact.sha256 !== value.delegation_sha256 ||
            value.artifact.bytes !== identity.byteLength
          ) {
            throw new DelegationError("delegation_binding_stale", "delegation replacement changed immutable identity or parent binding");
          }
          base.status = "superseded";
          const created: MutableRevision = {
            artifact: artifact(value.artifact),
            attempts: [],
            blockerCodes: [],
            authorityPreviewSha256: value.authority_preview_sha256,
            binding: identity.content.binding,
            content: identity.content,
            createdEventId: event.eventId,
            decisionEventId: null,
            delegationId: value.delegation_id,
            delegationRevision: value.delegation_revision,
            delegationSha256: value.delegation_sha256,
            envelope: null,
            envelopePreparationCount: 0,
            parentActorId: value.parent_actor_id,
            parentRunId: value.parent_run_id,
            receipt: null,
            status: "draft",
            terminalEventId: null,
          };
          revisions.push(created);
          byKey.set(key(created.delegationId, created.delegationRevision), created);
          break;
        }
        case "delegation.decision.recorded": {
          const value = data(event, "delegation.decision.recorded");
          const revision = exact(event);
          if (
            revision.status !== "draft" ||
            revision.decisionEventId !== null ||
            value.revision_event_id !== revision.createdEventId ||
            value.authority_preview_sha256 !== revision.authorityPreviewSha256
          ) {
            throw new DelegationError("delegation_decision_mismatch", "delegation decision does not bind the exact current draft");
          }
          const expected = delegationApprovalIdentity({
            approvalRequestId: value.decision_request_id,
            binding: revision.binding,
            delegationId: revision.delegationId,
            delegationRevision: revision.delegationRevision,
            delegationSha256: revision.delegationSha256,
            displaySha256: value.display_artifact.sha256,
          });
          if (expected !== value.approval_identity_sha256) {
            throw new DelegationError("delegation_decision_mismatch", "delegation approval identity does not match displayed bytes");
          }
          revision.decisionEventId = event.eventId;
          revision.status = value.decision === "approved" ? "approved" : "rejected";
          if (value.decision === "rejected") revision.terminalEventId = event.eventId;
          break;
        }
        case "delegation.queued": {
          const revision = exact(event);
          if (revision.status !== "approved") {
            throw new DelegationError("delegation_revision_conflict", "only an approved delegation may be queued");
          }
          revision.status = "queued";
          break;
        }
        case "delegation.envelope.prepared": {
          const value = data(event, "delegation.envelope.prepared");
          const revision = exact(event);
          const previousAttempt = revision.attempts.at(-1);
          const retryPreparation =
            revision.status === "queued" &&
            revision.envelope !== null &&
            revision.envelopePreparationCount === 1 &&
            previousAttempt?.terminal === "pre_effect_infrastructure_failure" &&
            previousAttempt.budgetSettlementEventId !== null &&
            revision.attempts.length < revision.content.retry.maxAttempts &&
            revision.content.retry.automaticOn.includes("pre_effect_infrastructure_failure");
          const initialPreparation =
            (["approved", "queued"] as const).includes(revision.status as "approved" | "queued") &&
            revision.envelope === null &&
            revision.envelopePreparationCount === 0;
          if (!initialPreparation && !retryPreparation) {
            throw new DelegationError("delegation_revision_conflict", "child envelope is neither an initial preparation nor an eligible durable retry");
          }
          if (
            retryPreparation &&
            (revision.envelope?.envelopeSha256 === value.envelope_sha256 ||
              revision.envelope?.contextCapsuleSha256 === value.context_capsule_sha256)
          ) {
            throw new DelegationError("delegation_binding_stale", "automatic retry must create a fresh capsule and envelope identity");
          }
          revision.envelope = Object.freeze({
            contextCapsule: artifact(value.context_capsule_artifact),
            contextCapsuleSha256: value.context_capsule_sha256,
            envelope: artifact(value.envelope_artifact),
            envelopeSha256: value.envelope_sha256,
          });
          revision.envelopePreparationCount += 1;
          break;
        }
        case "delegation.budget.reserved": {
          const value = data(event, "delegation.budget.reserved");
          const revision = exact(event);
          if (revision.status !== "queued" || revision.envelope === null || revision.attempts.length >= revision.content.retry.maxAttempts) {
            throw new DelegationError("delegation_budget_exhausted", "budget reservation is not admissible for this delegation");
          }
          if (revision.attempts.some((candidate) => candidate.terminal === null)) {
            throw new DelegationError("delegation_parallel_limit", "a delegation cannot have two active attempts");
          }
          if (reservations.has(value.reservation_id)) {
            throw new DelegationError("delegation_budget_exhausted", "budget reservation identity was reused");
          }
          reservations.set(value.reservation_id, budgetCounters(value.reserved));
          revision.attempts.push({
            attemptId: value.child_attempt_id,
            attemptNumber: null,
            actorId: null,
            childRunId: null,
            executableEnvelopeSha256: null,
            operationId: null,
            reservationId: value.reservation_id,
            budgetUsage: null,
            budgetSettlementEventId: null,
            startedEventId: null,
            terminalEventId: null,
            terminal: null,
            unresolvedEffectIds: [],
          });
          break;
        }
        case "delegation.child.launch_requested": {
          const value = data(event, "delegation.child.launch_requested");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          if (
            revision.status !== "queued" ||
            revision.envelope?.envelopeSha256 !== value.prepared_envelope_sha256 ||
            attempt.operationId !== null ||
            value.child_attempt_number !== revision.attempts.indexOf(attempt) + 1
          ) {
            throw new DelegationError("delegation_child_protocol_invalid", "child launch request does not match its reservation and envelope");
          }
          attempt.actorId = value.child_actor_id;
          attempt.attemptNumber = value.child_attempt_number;
          attempt.executableEnvelopeSha256 = value.envelope_sha256;
          attempt.operationId = value.operation_id;
          break;
        }
        case "delegation.child.started": {
          const value = data(event, "delegation.child.started");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          if (
            revision.status !== "queued" ||
            attempt.startedEventId !== null ||
            attempt.operationId !== value.operation_id ||
            attempt.actorId !== value.child_actor_id ||
            attempt.attemptNumber !== value.child_attempt_number ||
            attempt.executableEnvelopeSha256 !== value.envelope_sha256
          ) {
            throw new DelegationError("delegation_child_protocol_invalid", "child start does not match the sealed launch request");
          }
          attempt.childRunId = value.child_run_id;
          attempt.startedEventId = event.eventId;
          revision.status = "active";
          break;
        }
        case "delegation.child.approval_waiting": {
          const value = data(event, "delegation.child.approval_waiting");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          if (!["active", "waiting_approval"].includes(revision.status) || attempt.actorId !== value.child_actor_id || attempt.startedEventId === null) {
            throw new DelegationError("delegation_child_protocol_invalid", "approval wait does not target the active child");
          }
          if (waitingApprovals.has(value.approval_request_id)) {
            throw new DelegationError("delegation_decision_mismatch", "child approval request identity was reused");
          }
          waitingApprovals.set(value.approval_request_id, Object.freeze({
            actionDigest: value.action_digest,
            actionKind: value.action_kind,
            approvalRequestId: value.approval_request_id,
            childActorId: value.child_actor_id,
            childAttemptId: value.child_attempt_id,
            delegationId: value.delegation_id,
            workspaceId: value.workspace_id,
          }));
          revision.status = "waiting_approval";
          break;
        }
        case "delegation.cancel.requested": {
          const revision = exact(event);
          if (["accepted", "failed", "blocked", "cancelled", "stale", "rejected", "superseded"].includes(revision.status)) {
            throw new DelegationError("delegation_cancelled", "terminal delegation cannot be cancelled again");
          }
          revision.status = "cancelling";
          break;
        }
        case "delegation.child.terminal": {
          const value = data(event, "delegation.child.terminal");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          const usage = budgetCounters(value.budget_usage);
          const preEffect = value.terminal === "pre_effect_infrastructure_failure";
          if (preEffect) {
            const zeroExceptAttempt =
              usage.attempts === 1 && usage.artifactBytes === 0 && usage.changedBytes === 0 &&
              usage.changedFiles === 0 && usage.commandExecutions === 0 && usage.commandOutputBytes === 0 &&
              usage.durationMs === 0 && usage.modelSteps === 0 &&
              (usage.reportedTokens === 0 || usage.reportedTokens === null);
            if (
              revision.status !== "queued" || attempt.startedEventId !== null ||
              attempt.terminalEventId !== null || attempt.actorId !== value.child_actor_id ||
              attempt.childRunId !== null || attempt.operationId !== value.operation_id ||
              value.unresolved_effect_ids.length > 0 || !zeroExceptAttempt
            ) {
              throw new DelegationError("delegation_child_protocol_invalid", "pre-effect terminal is not a zero-effect launch failure");
            }
            attempt.childRunId = value.child_run_id;
          } else if (
            !["active", "waiting_approval", "cancelling", "reconciling"].includes(revision.status) ||
            attempt.startedEventId === null || attempt.terminalEventId !== null ||
            attempt.actorId !== value.child_actor_id || attempt.childRunId !== value.child_run_id ||
            attempt.operationId !== value.operation_id
          ) {
            throw new DelegationError("delegation_child_protocol_invalid", "child terminal is duplicate or does not match the active attempt");
          }
          attempt.terminal = value.terminal;
          attempt.terminalEventId = event.eventId;
          attempt.budgetUsage = usage;
          attempt.unresolvedEffectIds = [...value.unresolved_effect_ids];
          for (const [requestId, approval] of waitingApprovals) {
            if (approval.childAttemptId === value.child_attempt_id) waitingApprovals.delete(requestId);
          }
          revision.terminalEventId = event.eventId;
          const automaticRetryReady = preEffect &&
            revision.attempts.length < revision.content.retry.maxAttempts &&
            revision.content.retry.automaticOn.includes("pre_effect_infrastructure_failure");
          revision.status = automaticRetryReady
            ? "queued"
            : preEffect
              ? "failed"
              : value.terminal === "blocked_unknown_effect" || value.unresolved_effect_ids.length > 0
            ? "reconciling"
            : value.terminal === "cancelled_clean"
              ? "cancelled"
              : value.terminal === "known_failed"
                ? "failed"
                : "reconciling";
          break;
        }
        case "delegation.effect.reconciled": {
          const value = data(event, "delegation.effect.reconciled");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          if (attempt.terminalEventId === null || !attempt.unresolvedEffectIds.includes(value.effect_id)) {
            throw new DelegationError("delegation_effect_reconciliation_required", "effect reconciliation does not target an unresolved terminal effect");
          }
          if (value.observed !== "unknown") {
            attempt.unresolvedEffectIds = attempt.unresolvedEffectIds.filter((id) => id !== value.effect_id);
          }
          break;
        }
        case "delegation.receipt.ready": {
          const value = data(event, "delegation.receipt.ready");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          if (
            attempt.terminalEventId === null ||
            attempt.terminalEventId !== value.terminal_event_id ||
            (attempt.unresolvedEffectIds.length > 0 && value.status !== "blocked") ||
            revision.receipt !== null
          ) {
            throw new DelegationError("delegation_receipt_invalid", "receipt is early, duplicate, unresolved, or has a mismatched artifact");
          }
          revision.receipt = Object.freeze({
            acceptedEventId: null,
            artifact: artifact(value.receipt_artifact),
            claimStatuses: Object.freeze(value.claim_statuses.map((claim) => Object.freeze({
              claimId: claim.claim_id,
              status: claim.status,
            }))),
            readyEventId: event.eventId,
            sha256: value.receipt_sha256,
            status: value.status,
          });
          revision.status = "receipt_ready";
          break;
        }
        case "delegation.receipt.accepted": {
          const value = data(event, "delegation.receipt.accepted");
          const revision = exact(event);
          if (
            revision.status !== "receipt_ready" ||
            revision.receipt === null ||
            revision.receipt.readyEventId !== value.ready_event_id ||
            revision.receipt.artifact.artifactId !== value.receipt_artifact_id ||
            revision.receipt.sha256 !== value.receipt_sha256
          ) {
            throw new DelegationError("delegation_receipt_invalid", "receipt acceptance does not bind the exact ready receipt");
          }
          revision.receipt = Object.freeze({ ...revision.receipt, acceptedEventId: event.eventId });
          // Receipt acceptance proves the Host verified the artifact and its
          // lineage; it does not rewrite a failed, blocked, or cancelled child
          // into a successful delegation outcome.
          revision.status = revision.receipt.status === "succeeded"
            ? "accepted"
            : revision.receipt.status;
          break;
        }
        case "delegation.cancelled": {
          const revision = exact(event);
          if (!(["cancelling", "reconciling", "cancelled"] as const).includes(revision.status as "cancelling" | "reconciling" | "cancelled")) {
            throw new DelegationError("delegation_cancelled", "delegation cancellation terminal has no matching request");
          }
          revision.status = "cancelled";
          revision.terminalEventId = event.eventId;
          break;
        }
        case "delegation.stale": {
          const revision = exact(event);
          if (["accepted", "failed", "blocked", "cancelled", "rejected", "superseded"].includes(revision.status)) {
            throw new DelegationError("delegation_binding_stale", "terminal delegation cannot become stale");
          }
          revision.status = "stale";
          revision.terminalEventId = event.eventId;
          break;
        }
        case "delegation.blocked": {
          const value = data(event, "delegation.blocked");
          const revision = exact(event);
          if (["accepted", "failed", "blocked", "cancelled", "stale", "rejected", "superseded"].includes(revision.status)) {
            throw new DelegationError("delegation_revision_conflict", "terminal delegation cannot be blocked again");
          }
          revision.blockerCodes.push(value.blocker_code);
          revision.status = "blocked";
          revision.terminalEventId = event.eventId;
          break;
        }
        case "delegation.actor_slot.claimed": {
          const value = data(event, "delegation.actor_slot.claimed");
          if (
            activeSlots.size >= 2 ||
            activeSlots.has(value.claim_id) ||
            [...activeSlots.values()].some((claim) =>
              claim.groupId === value.group_id && (claim.slot === value.slot || claim.actorId === value.actor_id))
          ) {
            throw new DelegationError("delegation_parallel_limit", "delegation actor slot limit or identity is already claimed");
          }
          activeSlots.set(value.claim_id, Object.freeze({
            actorId: value.actor_id,
            actorKind: value.actor_kind,
            claimId: value.claim_id,
            groupId: value.group_id,
            slot: value.slot as 1 | 2,
          }));
          maximumObservedActiveChildren = Math.max(
            maximumObservedActiveChildren,
            [...activeSlots.values()].filter((slot) => slot.actorKind === "child").length,
          );
          break;
        }
        case "delegation.actor_slot.released": {
          const value = data(event, "delegation.actor_slot.released");
          const claimed = activeSlots.get(value.claim_id);
          if (claimed === undefined || claimed.actorId !== value.actor_id || claimed.groupId !== value.group_id) {
            throw new DelegationError("delegation_parallel_limit", "actor slot release does not match an active claim");
          }
          activeSlots.delete(value.claim_id);
          break;
        }
        case "delegation.conflict_claim.granted": {
          const value = data(event, "delegation.conflict_claim.granted");
          if (conflictClaims.has(value.claim_id)) {
            throw new DelegationError("delegation_workspace_conflict", "workspace conflict claim ID was reused");
          }
          const next: DelegationConflictClaimProjectionV1 = Object.freeze({
            access: value.access,
            actorId: value.actor_id,
            claimId: value.claim_id,
            groupId: value.group_id,
            pathPrefixes: Object.freeze([...value.path_prefixes]),
            repositoryId: value.repository_id,
            sourceLineageId: value.source_lineage_id,
            sourceSnapshotSha256: value.source_snapshot_sha256,
            workspaceId: value.workspace_id,
          });
          const collision = [...conflictClaims.values()].some((current) =>
            current.repositoryId === next.repositoryId &&
            current.sourceLineageId === next.sourceLineageId &&
            (current.access === "write" || next.access === "write") &&
            prefixesOverlap(current.pathPrefixes, next.pathPrefixes));
          if (collision) {
            throw new DelegationError("delegation_workspace_conflict", "parallel workspace path claims overlap");
          }
          conflictClaims.set(value.claim_id, next);
          break;
        }
        case "delegation.conflict_claim.released": {
          const value = data(event, "delegation.conflict_claim.released");
          const claimed = conflictClaims.get(value.claim_id);
          if (claimed === undefined || claimed.actorId !== value.actor_id || claimed.groupId !== value.group_id) {
            throw new DelegationError("delegation_workspace_conflict", "workspace conflict release does not match an active claim");
          }
          conflictClaims.delete(value.claim_id);
          break;
        }
        case "delegation.parent.barrier.requested": {
          const value = data(event, "delegation.parent.barrier.requested");
          if (barriers.has(value.barrier_id) || new Set(value.required_delegation_ids).size !== value.required_delegation_ids.length) {
            throw new DelegationError("delegation_revision_conflict", "parent barrier identity is duplicate or ambiguous");
          }
          barriers.set(value.barrier_id, {
            barrierId: value.barrier_id,
            parentActorId: value.parent_actor_id,
            parentRunId: value.parent_run_id,
            requiredDelegationIds: [...value.required_delegation_ids],
            receiptSha256s: [],
            status: "requested",
            terminalStatus: null,
          });
          break;
        }
        case "delegation.parent.barrier.suspended": {
          const value = data(event, "delegation.parent.barrier.suspended");
          const barrier = barriers.get(value.barrier_id);
          if (
            barrier?.status !== "requested" ||
            barrier.parentActorId !== value.parent_actor_id ||
            barrier.parentRunId !== value.parent_run_id
          ) {
            throw new DelegationError("delegation_revision_conflict", "parent barrier cannot be suspended from its current state");
          }
          barrier.status = "suspended";
          break;
        }
        case "delegation.parent.barrier.released": {
          const value = data(event, "delegation.parent.barrier.released");
          const barrier = barriers.get(value.barrier_id);
          if (
            barrier?.status !== "suspended" ||
            barrier.parentActorId !== value.parent_actor_id ||
            barrier.parentRunId !== value.parent_run_id
          ) {
            throw new DelegationError("delegation_revision_conflict", "parent barrier release has no suspended barrier");
          }
          const required = barrier.requiredDelegationIds.map((delegationId) =>
            [...revisions].reverse().find((revision) => revision.delegationId === delegationId));
          if (
            required.some((revision) => revision === undefined) ||
            value.status === "completed" && required.some((revision) => revision?.status !== "accepted") ||
            value.receipt_sha256s.some((digest) => !required.some((revision) => revision?.receipt?.sha256 === digest))
          ) {
            throw new DelegationError("delegation_receipt_invalid", "parent barrier release is not backed by its required delegation receipts");
          }
          barrier.receiptSha256s = [...value.receipt_sha256s];
          barrier.status = "released";
          barrier.terminalStatus = value.status;
          break;
        }
        case "delegation.group.lease.acquired": {
          const value = data(event, "delegation.group.lease.acquired");
          if (groupLeases.has(value.group_id)) {
            throw new DelegationError("delegation_lease_busy", "delegation group already has a coordinator lease");
          }
          groupLeases.set(value.group_id, value.lease_nonce_sha256);
          break;
        }
        case "delegation.group.takeover": {
          const value = data(event, "delegation.group.takeover");
          if (groupLeases.get(value.group_id) !== value.previous_lease_nonce_sha256) {
            throw new DelegationError("delegation_lease_busy", "delegation takeover does not bind the current lease");
          }
          groupLeases.set(value.group_id, value.new_lease_nonce_sha256);
          takeoverCount += 1;
          break;
        }
        case "delegation.budget.settled": {
          const value = data(event, "delegation.budget.settled");
          const revision = exact(event);
          const attempt = exactAttempt(revision, value.child_attempt_id);
          const reserved = reservations.get(value.reservation_id);
          const used = budgetCounters(value.used);
          const released = budgetCounters(value.released);
          const held = budgetCounters(value.held);
          if (
            attempt.reservationId !== value.reservation_id || attempt.terminalEventId === null ||
            reserved === undefined || settlements.has(value.reservation_id) ||
            !budgetCountersBalance(reserved, used, released, held)
          ) {
            throw new DelegationError("delegation_budget_exhausted", "budget settlement has no exact terminal reservation");
          }
          settlements.set(value.reservation_id, Object.freeze({ held, released, used }));
          attempt.budgetSettlementEventId = event.eventId;
          break;
        }
      }
    }

    // PHASE20: every delegated run proves its lineage through the durable
    // launch/start transaction. Event adjacency and OS parentage are not
    // authority because both can survive only partially across a crash.
    for (const event of events) {
      if (event.scope !== "run" || event.type !== "run.started" || event.data.delegated_child_binding === undefined) continue;
      const binding = event.data.delegated_child_binding;
      const started = events.find((candidate) =>
        candidate.scope === "session" &&
        candidate.type === "delegation.child.started" &&
        candidate.sessionSeq < event.sessionSeq &&
        candidate.data.delegation_id === binding.delegation_id &&
        candidate.data.delegation_revision === binding.delegation_revision &&
        candidate.data.delegation_sha256 === binding.delegation_sha256 &&
        candidate.data.child_actor_id === binding.actor_id &&
        candidate.data.child_attempt_id === binding.child_attempt_id &&
        candidate.data.child_attempt_number === binding.child_attempt_number &&
        candidate.data.child_run_id === event.runId &&
        candidate.data.parent_actor_id === binding.parent_actor_id &&
        candidate.data.parent_run_id === binding.parent_run_id &&
        candidate.data.envelope_sha256 === binding.envelope_sha256);
      if (started?.scope !== "session" || started.type !== "delegation.child.started") {
        throw new DelegationError("delegation_child_protocol_invalid", "delegated run.started has no exact durable start lineage");
      }
      const launch = events.find((candidate) =>
        candidate.scope === "session" &&
        candidate.type === "delegation.child.launch_requested" &&
        candidate.sessionSeq < started.sessionSeq &&
        candidate.data.operation_id === started.data.operation_id &&
        candidate.data.child_attempt_id === binding.child_attempt_id &&
        candidate.data.operation_nonce_sha256 === binding.operation_nonce_sha256);
      if (launch === undefined) {
        throw new DelegationError("delegation_child_protocol_invalid", "delegated run.started has no exact durable launch/start lineage");
      }
    }

    let reserved = zeroBudgetCounters();
    let used = zeroBudgetCounters();
    let released = zeroBudgetCounters();
    let held = zeroBudgetCounters();
    for (const [reservationId, reservation] of reservations) {
      reserved = addBudgetCounters(reserved, reservation);
      const settlement = settlements.get(reservationId);
      if (settlement === undefined) {
        held = addBudgetCounters(held, reservation);
      } else {
        used = addBudgetCounters(used, settlement.used);
        released = addBudgetCounters(released, settlement.released);
        held = addBudgetCounters(held, settlement.held);
      }
    }

    return Object.freeze({
      trackingMode: revisions.length === 0 ? "none" : "phase20",
      revisions: Object.freeze(revisions.map(revisionProjection)),
      activeActorSlots: Object.freeze([...activeSlots.values()]),
      activeConflictClaims: Object.freeze([...conflictClaims.values()]),
      barriers: Object.freeze([...barriers.values()].map((barrier) => Object.freeze({
        barrierId: barrier.barrierId,
        parentActorId: barrier.parentActorId,
        parentRunId: barrier.parentRunId,
        receiptSha256s: Object.freeze([...barrier.receiptSha256s]),
        requiredDelegationIds: Object.freeze([...barrier.requiredDelegationIds]),
        status: barrier.status,
        terminalStatus: barrier.terminalStatus,
      }))),
      budget: Object.freeze({ held, released, reserved, used }),
      maximumObservedActiveChildren,
      takeoverCount,
      waitingApprovals: Object.freeze([...waitingApprovals.values()]),
      workspaceConflictDeferrals: 0,
      lastSessionSeq: events.at(-1)?.sessionSeq ?? 0,
    });
  }
}

export function delegationProjectionSha256(projection: DelegationProjectionV1): string {
  return sha256Canonical(projection);
}
