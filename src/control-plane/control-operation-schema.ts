import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import {
  applicationActionTargetV1Schema,
  artifactReferenceV1Schema,
  expectedResourceVersionV1Schema,
  resourceScopeV1Schema,
  sessionLedgerHeadV1Schema,
} from "./application-protocol.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);

export const durableRecordReferenceV1Schema = z.object({
  ledgerId: z.string().min(1).max(256),
  ownerKind: z.enum(["catalog", "session", "control", "interaction", "remote", "team", "effect"]),
  recordId: z.string().min(1).max(256),
  recordSha256: sha256,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();

export type DurableRecordReferenceV1 = Readonly<z.infer<typeof durableRecordReferenceV1Schema>>;

export const controlOperationOwnerClaimV1Schema = z.object({
  acquiredAt: timestamp,
  claimEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: timestamp,
  processStartIdentitySha256: sha256,
}).strict();

export type ControlOperationOwnerClaimV1 = Readonly<z.infer<typeof controlOperationOwnerClaimV1Schema>>;

export const controlOperationStateSchema = z.enum([
  "accepted",
  "authority_validated",
  "reserved",
  "domain_append_started",
  "domain_records_linked",
  "result_built",
  "completed",
  "rejected_known_not_started",
  "blocked_stale",
  "blocked_unknown_effect",
  "failed_internal",
]);

export type ControlOperationStateV1 = z.infer<typeof controlOperationStateSchema>;

export const controlOperationRecordContentV1Schema = z.object({
  actionKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  domainRecordRefs: z.array(durableRecordReferenceV1Schema).max(128),
  errorCode: z.string().regex(/^[a-z0-9_]{1,128}$/u).nullable(),
  idempotencyKeySha256: sha256,
  idempotencyNamespace: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  operationId: z.string().uuid(),
  operationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerClaim: controlOperationOwnerClaimV1Schema.nullable(),
  preparedActionId: z.string().uuid(),
  preparedActionSha256: sha256,
  previousOperationRecordSha256: sha256.nullable(),
  primaryDomainRecord: durableRecordReferenceV1Schema.nullable(),
  requestIdentitySha256: sha256,
  resolvedResourceScope: resourceScopeV1Schema.nullable(),
  resolvedResourceVersion: expectedResourceVersionV1Schema.nullable(),
  resultArtifact: artifactReferenceV1Schema.nullable(),
  resultProjectionIdentity: z.object({
    disclosureProfileSha256: sha256,
    ledgerHead: sessionLedgerHeadV1Schema,
    projectionSha256: sha256,
    projectorId: z.string().min(1).max(128),
    projectorVersion: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
  }).strict().nullable(),
  state: controlOperationStateSchema,
  target: applicationActionTargetV1Schema,
  underlyingOperationRefs: z.array(durableRecordReferenceV1Schema).max(128),
}).strict();

export const controlOperationRecordV1Schema = controlOperationRecordContentV1Schema.extend({
  recordSha256: sha256,
}).strict().superRefine((value, context) => {
  const { recordSha256, ...content } = value;
  if (sha256Canonical(content) !== recordSha256) {
    context.addIssue({ code: "custom", message: "control operation record hash mismatch" });
  }
  const primaryIsLinked = value.primaryDomainRecord !== null &&
    value.domainRecordRefs.some((reference) =>
      reference.ownerKind === value.primaryDomainRecord?.ownerKind &&
      reference.ledgerId === value.primaryDomainRecord.ledgerId &&
      reference.recordId === value.primaryDomainRecord.recordId &&
      reference.recordSha256 === value.primaryDomainRecord.recordSha256 &&
      reference.sequence === value.primaryDomainRecord.sequence
    );
  if (value.state === "domain_records_linked") {
    if (
      !primaryIsLinked ||
      value.resolvedResourceScope === null ||
      value.resolvedResourceVersion === null ||
      value.resultArtifact !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "domain-records-linked operation must contain exact refs and no result artifact",
      });
    }
  }
  if (["result_built", "completed"].includes(value.state) && (
    !primaryIsLinked ||
    value.resolvedResourceScope === null ||
    value.resolvedResourceVersion === null ||
    value.resultArtifact === null
  )) {
    context.addIssue({ code: "custom", message: "built operation result predicate is incomplete" });
  }
});

export type ControlOperationRecordV1 = Readonly<z.infer<typeof controlOperationRecordV1Schema>>;

export function createControlOperationRecord(
  content: z.input<typeof controlOperationRecordContentV1Schema>,
): ControlOperationRecordV1 {
  const parsed = controlOperationRecordContentV1Schema.parse(content);
  return Object.freeze(controlOperationRecordV1Schema.parse({
    ...parsed,
    recordSha256: sha256Canonical(parsed),
  }));
}

const TERMINAL = new Set<ControlOperationStateV1>([
  "blocked_stale",
  "blocked_unknown_effect",
  "completed",
  "failed_internal",
  "rejected_known_not_started",
]);

const FORWARD: Readonly<Record<ControlOperationStateV1, readonly ControlOperationStateV1[]>> = {
  accepted: ["authority_validated", "blocked_stale", "failed_internal", "rejected_known_not_started"],
  authority_validated: ["reserved", "domain_append_started", "blocked_stale", "failed_internal", "rejected_known_not_started"],
  reserved: ["domain_append_started", "blocked_stale", "blocked_unknown_effect", "failed_internal", "rejected_known_not_started"],
  domain_append_started: ["domain_records_linked", "blocked_unknown_effect", "failed_internal"],
  domain_records_linked: ["result_built", "blocked_unknown_effect", "failed_internal"],
  result_built: ["completed", "blocked_unknown_effect", "failed_internal"],
  completed: [],
  rejected_known_not_started: [],
  blocked_stale: [],
  blocked_unknown_effect: [],
  failed_internal: [],
};

export function assertControlOperationTransition(
  current: ControlOperationStateV1,
  next: ControlOperationStateV1,
): void {
  if (TERMINAL.has(current) || !FORWARD[current].includes(next)) {
    throw new TypeError(`invalid control operation transition ${current} -> ${next}`);
  }
}

function immutableOperationIdentity(record: ControlOperationRecordV1): unknown {
  return {
    actionKind: record.actionKind,
    idempotencyKeySha256: record.idempotencyKeySha256,
    idempotencyNamespace: record.idempotencyNamespace,
    operationId: record.operationId,
    preparedActionId: record.preparedActionId,
    preparedActionSha256: record.preparedActionSha256,
    requestIdentitySha256: record.requestIdentitySha256,
    target: record.target,
  };
}

function sameStateContentWithoutOwner(record: ControlOperationRecordV1): unknown {
  const content: Record<string, unknown> = { ...record };
  delete content.operationRevision;
  delete content.ownerClaim;
  delete content.previousOperationRecordSha256;
  delete content.recordSha256;
  return content;
}

function assertSameStateOwnerTransition(
  current: ControlOperationOwnerClaimV1 | null,
  next: ControlOperationOwnerClaimV1 | null,
): void {
  if (current === null || next === null) return;
  if (next.claimEpoch < current.claimEpoch) {
    throw new TypeError("control operation owner epoch moved backwards");
  }
  if (next.claimEpoch === current.claimEpoch) {
    if (
      next.processStartIdentitySha256 !== current.processStartIdentitySha256 ||
      next.acquiredAt !== current.acquiredAt ||
      Date.parse(next.expiresAt) < Date.parse(current.expiresAt)
    ) {
      throw new TypeError("control operation owner renewal changed claim identity");
    }
    return;
  }
  if (Date.parse(next.acquiredAt) < Date.parse(current.acquiredAt)) {
    throw new TypeError("control operation owner takeover predates its predecessor");
  }
}

/**
 * PHASE21: a durable driver lease is represented by a same-state revision.
 * Same-state revisions may only change the owner claim; all semantic operation
 * facts remain immutable until a canonical state transition is appended.
 */
export function assertControlOperationRecordTransition(
  current: ControlOperationRecordV1,
  next: ControlOperationRecordV1,
): void {
  if (
    next.operationId !== current.operationId ||
    next.operationRevision !== current.operationRevision + 1 ||
    next.previousOperationRecordSha256 !== current.recordSha256 ||
    sha256Canonical(immutableOperationIdentity(next)) !== sha256Canonical(immutableOperationIdentity(current))
  ) {
    throw new TypeError("control operation revision changed immutable identity");
  }
  if (next.state === current.state) {
    if (
      sha256Canonical(sameStateContentWithoutOwner(next)) !==
      sha256Canonical(sameStateContentWithoutOwner(current))
    ) {
      throw new TypeError("same-state control operation revision changed non-owner facts");
    }
    if (sha256Canonical(next.ownerClaim) === sha256Canonical(current.ownerClaim)) {
      throw new TypeError("same-state control operation revision did not change owner claim");
    }
    assertSameStateOwnerTransition(current.ownerClaim, next.ownerClaim);
    return;
  }
  assertControlOperationTransition(current.state, next.state);
  if (TERMINAL.has(next.state) && next.ownerClaim !== null) {
    throw new TypeError("terminal control operation retained a driver claim");
  }
  if (next.ownerClaim === null) {
    if (!["blocked_stale", "blocked_unknown_effect", "completed", "failed_internal", "rejected_known_not_started"].includes(next.state)) {
      if (current.ownerClaim !== null) throw new TypeError("non-terminal operation transition dropped its driver claim");
    }
  } else if (
    current.ownerClaim === null ||
    next.ownerClaim.claimEpoch !== current.ownerClaim.claimEpoch ||
    next.ownerClaim.processStartIdentitySha256 !== current.ownerClaim.processStartIdentitySha256 ||
    next.ownerClaim.acquiredAt !== current.ownerClaim.acquiredAt ||
    Date.parse(next.ownerClaim.expiresAt) < Date.parse(current.ownerClaim.expiresAt)
  ) {
    throw new TypeError("operation transition changed its durable driver identity");
  }
}
