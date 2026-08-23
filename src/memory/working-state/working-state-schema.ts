import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { sessionLedgerHeadV1Schema } from "../../control-plane/application-protocol.js";
import { durableRecordReferenceV1Schema } from "../../control-plane/control-operation-schema.js";
import { planItemStatusSchema } from "../../plans/plan-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const contextItemId = z.string().regex(/^ctx:[a-f0-9]{64}$/u);
const boundedId = z.string().min(1).max(512);
const protectedCategory = z.enum([
  "approval_history",
  "backend_budget_epoch",
  "change_journal",
  "dirty_baseline",
  "pending_effects",
  "repository_rules",
  "repository_state",
  "system_policy",
  "unresolved_errors",
  "user_instruction",
  "verification_state",
]);

export const workingSessionRecordSourceRefV1Schema = z.object({
  artifact: z.null(),
  kind: z.literal("session_record"),
  record: durableRecordReferenceV1Schema.extend({
    ownerKind: z.literal("session"),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  verifiedPrefixHead: sessionLedgerHeadV1Schema,
}).strict().superRefine((value, context) => {
  if (
    value.record.ledgerId !== `session:${value.verifiedPrefixHead.sessionId}` ||
    value.record.sequence > value.verifiedPrefixHead.sequence
  ) {
    context.addIssue({
      code: "custom",
      message: "working source reference is outside its verified session prefix",
    });
  }
});

export type WorkingSessionRecordSourceRefV1 = Readonly<
  z.infer<typeof workingSessionRecordSourceRefV1Schema>
>;

export const workingFactRefV1Schema = z.object({
  authority: z.enum([
    "authoritative",
    "historical_only",
    "narrative",
    "untrusted_content",
  ]),
  contentSha256: sha256,
  contextItemId,
  protectedCategory: protectedCategory.nullable(),
  sourceRefs: z.array(workingSessionRecordSourceRefV1Schema).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (!sortedUniqueBy(
    value.sourceRefs,
    ({ record }) => `${String(record.sequence).padStart(16, "0")}:${record.recordId}`,
  )) {
    context.addIssue({ code: "custom", message: "working fact refs are not canonical" });
  }
});

export const workingChecklistItemV1Schema = z.object({
  contentSha256: sha256,
  itemId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  sourceRefs: z.array(workingSessionRecordSourceRefV1Schema).min(1).max(8),
  state: planItemStatusSchema,
}).strict().superRefine((value, context) => {
  if (!sortedUniqueBy(
    value.sourceRefs,
    ({ record }) => `${String(record.sequence).padStart(16, "0")}:${record.recordId}`,
  )) {
    context.addIssue({ code: "custom", message: "working checklist refs are not canonical" });
  }
});

export const workingArtifactRefV1Schema = z.object({
  artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative().max(64 * 1024 * 1024),
  mediaType: z.string().min(1).max(256),
  sha256,
  sourceRef: workingSessionRecordSourceRefV1Schema,
}).strict().superRefine((value, context) => {
  if (value.artifactId !== `sha256:${value.sha256}`) {
    context.addIssue({
      code: "custom",
      message: "working artifact identity does not match its hash",
    });
  }
});

function sortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  const keys = values.map(key);
  return keys.every((value, index) => index === 0 || keys[index - 1]! < value);
}

const workingStateSnapshotContentV1Schema = z.object({
  activeGoalRevisionRef: boundedId.nullable(),
  activePlanRevisionRef: boundedId.nullable(),
  activeProtectedItemIds: z.array(contextItemId).max(1_024),
  changedArtifacts: z.array(workingArtifactRefV1Schema).max(256),
  checklist: z.array(workingChecklistItemV1Schema).max(32),
  decisions: z.array(workingFactRefV1Schema).max(256),
  hotTailTurnGroupIds: z.array(boundedId).max(1_024),
  latestRawUserTurnId: boundedId,
  pendingEffects: z.array(workingFactRefV1Schema).max(256),
  projectionVersion: z.literal("agent-memory-working-state-v1"),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  sourceHead: sessionLedgerHeadV1Schema,
  supersededItemIds: z.array(contextItemId).max(1_024),
  unresolvedErrors: z.array(workingFactRefV1Schema).max(256),
  verificationState: z.array(workingFactRefV1Schema).max(256),
}).strict();

export const workingStateSnapshotV1Schema = workingStateSnapshotContentV1Schema.extend({
  snapshotSha256: sha256,
}).strict().superRefine((value, context) => {
  const { snapshotSha256, ...content } = value;
  const sourceHeadSha256 = sha256Canonical(value.sourceHead);
  const sourceRefs = [
    ...value.checklist.flatMap(({ sourceRefs: refs }) => refs),
    ...value.decisions.flatMap(({ sourceRefs: refs }) => refs),
    ...value.pendingEffects.flatMap(({ sourceRefs: refs }) => refs),
    ...value.unresolvedErrors.flatMap(({ sourceRefs: refs }) => refs),
    ...value.verificationState.flatMap(({ sourceRefs: refs }) => refs),
    ...value.changedArtifacts.map(({ sourceRef }) => sourceRef),
  ];
  if (sha256Canonical(content) !== snapshotSha256) {
    context.addIssue({ code: "custom", message: "working snapshot hash mismatch" });
  }
  if (
    value.sourceHead.sessionId !== value.sessionId ||
    !sortedUniqueBy(value.activeProtectedItemIds, (entry) => entry) ||
    !sortedUniqueBy(value.supersededItemIds, (entry) => entry) ||
    !sortedUniqueBy(value.checklist, ({ itemId }) => itemId) ||
    !sortedUniqueBy(value.decisions, ({ contextItemId }) => contextItemId) ||
    !sortedUniqueBy(value.pendingEffects, ({ contextItemId }) => contextItemId) ||
    !sortedUniqueBy(value.unresolvedErrors, ({ contextItemId }) => contextItemId) ||
    !sortedUniqueBy(value.verificationState, ({ contextItemId }) => contextItemId) ||
    !sortedUniqueBy(value.changedArtifacts, ({ artifactId }) => artifactId) ||
    new Set(value.hotTailTurnGroupIds).size !== value.hotTailTurnGroupIds.length ||
    sourceRefs.some(
      ({ verifiedPrefixHead }) =>
        sha256Canonical(verifiedPrefixHead) !== sourceHeadSha256,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "working snapshot collections are not canonical sorted unique sets",
    });
  }
});

export type WorkingStateSnapshotV1 = Readonly<
  z.infer<typeof workingStateSnapshotV1Schema>
>;

export const workingSnapshotRefV1Schema = z.object({
  bytes: z.number().int().positive().max(256 * 1024),
  projectionVersion: z.literal("agent-memory-working-state-v1"),
  snapshotSha256: sha256,
  sourceHead: sessionLedgerHeadV1Schema,
}).strict();

const workingSnapshotPointerContentV1Schema = z.object({
  current: workingSnapshotRefV1Schema,
  previous: workingSnapshotRefV1Schema.nullable(),
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
}).strict();

export const workingSnapshotPointerV1Schema = workingSnapshotPointerContentV1Schema.extend({
  pointerSha256: sha256,
}).strict().superRefine((value, context) => {
  const { pointerSha256, ...content } = value;
  if (
    sha256Canonical(content) !== pointerSha256 ||
    value.current.sourceHead.sessionId !== value.sessionId ||
    (value.previous !== null &&
      (
        value.previous.sourceHead.sessionId !== value.sessionId ||
        value.previous.sourceHead.sequence >= value.current.sourceHead.sequence ||
        value.previous.snapshotSha256 === value.current.snapshotSha256
      ))
  ) {
    context.addIssue({ code: "custom", message: "working snapshot pointer is invalid" });
  }
});

export type WorkingSnapshotRefV1 = Readonly<
  z.infer<typeof workingSnapshotRefV1Schema>
>;
export type WorkingSnapshotPointerV1 = Readonly<
  z.infer<typeof workingSnapshotPointerV1Schema>
>;

export function createWorkingStateSnapshotV1(
  content: z.input<typeof workingStateSnapshotContentV1Schema>,
): WorkingStateSnapshotV1 {
  const parsed = workingStateSnapshotContentV1Schema.parse(content);
  return workingStateSnapshotV1Schema.parse({
    ...parsed,
    snapshotSha256: sha256Canonical(parsed),
  });
}

export function createWorkingSnapshotPointerV1(
  content: z.input<typeof workingSnapshotPointerContentV1Schema>,
): WorkingSnapshotPointerV1 {
  const parsed = workingSnapshotPointerContentV1Schema.parse(content);
  return workingSnapshotPointerV1Schema.parse({
    ...parsed,
    pointerSha256: sha256Canonical(parsed),
  });
}
