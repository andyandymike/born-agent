import { sha256Canonical } from "../../completion/canonical-json.js";
import type { ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import type { SessionLedgerHeadSigner } from "../../control-plane/session-ledger-head.js";
import type { TaskStateProjection } from "../../coordination/task-state-types.js";
import type { ContextItem } from "../../context/context-item.js";
import type { ProjectedContextState } from "../../context/context-projector.js";
import { ProtectedFactLedger } from "../../context/protected-fact-ledger.js";
import {
  createWorkingStateSnapshotV1,
  workingFactRefV1Schema,
  type WorkingSessionRecordSourceRefV1,
  type WorkingStateSnapshotV1,
} from "./working-state-schema.js";

export class WorkingStateProjectionError extends Error {
  override readonly name = "WorkingStateProjectionError";

  constructor(
    readonly code:
      | "working_state_source_missing"
      | "working_state_user_turn_missing"
      | "working_state_projection_invalid",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function goalRef(taskState: TaskStateProjection): string | null {
  const active = taskState.goals.find(
    ({ content }) => content.goalId === taskState.activeGoalId,
  );
  return active === undefined
    ? null
    : `goal:${active.content.goalId}:revision:${String(active.content.revision)}`;
}

function planRef(taskState: TaskStateProjection): string | null {
  const active = taskState.currentApprovedPlan;
  return active === null
    ? null
    : [
        "plan",
        active.planId,
        "revision",
        String(active.revision),
        active.planSha256,
      ].join(":");
}

function groupId(item: ContextItem): string {
  if (item.pairing !== null) return `pair:${item.pairing.id}`;
  if (item.turnId !== null) return `turn:${item.turnId}`;
  return `item:${item.id}`;
}

function hotTail(state: ProjectedContextState): readonly string[] {
  const groups = new Map<string, number>();
  for (const item of state.items) {
    const id = groupId(item);
    groups.set(id, Math.max(groups.get(id) ?? 0, item.recency));
  }
  const active = new Set(state.activeEffectIds.map((id) => `pair:${id}`));
  const completed = [...groups]
    .filter(([id]) => !active.has(id))
    .sort(([leftId, left], [rightId, right]) =>
      right - left || leftId.localeCompare(rightId),
    )
    .slice(0, 3)
    .map(([id]) => id);
  return Object.freeze(
    [...new Set([...active, ...completed])]
      .sort((left, right) =>
        (groups.get(left) ?? 0) - (groups.get(right) ?? 0) ||
        left.localeCompare(right),
      ),
  );
}

export function buildWorkingStateSnapshotV1(input: Readonly<{
  readonly context: ProjectedContextState;
  readonly evidence: ExactSessionEvidenceV1;
  readonly signer: SessionLedgerHeadSigner;
  readonly taskState: TaskStateProjection;
}>): WorkingStateSnapshotV1 {
  const sourceHead = input.evidence.headAt(input.evidence.events, input.signer);
  const byEventId = new Map(
    input.evidence.events.map((event) => [event.eventId, event]),
  );
  const sourceRef = (eventId: string): WorkingSessionRecordSourceRefV1 => {
    const event = byEventId.get(eventId);
    if (event === undefined) {
      throw new WorkingStateProjectionError(
        "working_state_source_missing",
        `working state source event ${eventId} is unavailable`,
      );
    }
    return Object.freeze({
      artifact: null,
      kind: "session_record",
      record: input.evidence.reference(event) as WorkingSessionRecordSourceRefV1["record"],
      verifiedPrefixHead: sourceHead,
    });
  };
  const refsForItem = (item: ContextItem): readonly WorkingSessionRecordSourceRefV1[] =>
    Object.freeze(
      [...new Set(item.sourceEventIds)]
        .filter((eventId) => byEventId.has(eventId))
        .map(sourceRef)
        .sort((left, right) =>
          left.record.sequence - right.record.sequence ||
          left.record.recordId.localeCompare(right.record.recordId),
        ),
    );
  const fact = (item: ContextItem) => {
    const sourceRefs = refsForItem(item);
    if (sourceRefs.length === 0) return null;
    return workingFactRefV1Schema.parse({
      authority: item.authority,
      contentSha256: item.contentSha256,
      contextItemId: item.id,
      protectedCategory: item.protectedCategory,
      sourceRefs,
    });
  };
  const facts = (category: ContextItem["protectedCategory"]) =>
    input.context.items
      .filter((item) => item.protectedCategory === category)
      .map(fact)
      .filter((value) => value !== null)
      .sort((left, right) => left.contextItemId.localeCompare(right.contextItemId));

  const latestRawUser = [...input.context.items]
    .filter(({ kind, turnId }) => kind === "user_message" && turnId !== null)
    .sort((left, right) =>
      right.recency - left.recency || left.id.localeCompare(right.id),
    )[0];
  if (latestRawUser?.turnId === null || latestRawUser === undefined) {
    throw new WorkingStateProjectionError(
      "working_state_user_turn_missing",
      "working state requires one exact current user turn",
    );
  }

  const selectedPlanRef = input.taskState.currentApprovedPlan;
  const selectedPlan = selectedPlanRef === null
    ? null
    : input.taskState.plans.find((candidate) =>
        candidate.content.planId === selectedPlanRef.planId &&
        candidate.content.revision === selectedPlanRef.revision &&
        candidate.planSha256 === selectedPlanRef.planSha256,
      ) ?? null;
  const checklist = selectedPlan === null
    ? []
    : selectedPlan.items.map((item) => {
        const eventId = item.lastTransitionEventId ?? selectedPlan.createdEventId;
        return {
          contentSha256: sha256Canonical(item.content),
          itemId: item.content.id,
          sourceRefs: [sourceRef(eventId)],
          state: item.status,
        };
      }).sort((left, right) => left.itemId.localeCompare(right.itemId));

  const artifacts = new Map<string, WorkingStateSnapshotV1["changedArtifacts"][number]>();
  for (const item of input.context.items) {
    const firstSource = refsForItem(item)[0];
    if (firstSource === undefined) continue;
    for (const artifact of item.artifactRefs) {
      const candidate = {
        artifactId: artifact.artifactId,
        bytes: artifact.bytes,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        sourceRef: firstSource,
      };
      const prior = artifacts.get(candidate.artifactId);
      if (
        prior !== undefined &&
        sha256Canonical(prior) !== sha256Canonical(candidate)
      ) {
        throw new WorkingStateProjectionError(
          "working_state_projection_invalid",
          `artifact ${candidate.artifactId} has conflicting working references`,
        );
      }
      artifacts.set(candidate.artifactId, candidate);
    }
  }

  const protectedLedger = new ProtectedFactLedger().project({
    activeEffectIds: input.context.activeEffectIds,
    items: input.context.items,
  });
  try {
    return createWorkingStateSnapshotV1({
      activeGoalRevisionRef: goalRef(input.taskState),
      activePlanRevisionRef: planRef(input.taskState),
      activeProtectedItemIds: [...protectedLedger.protectedItemIds].sort(),
      changedArtifacts: [...artifacts.values()].sort((left, right) =>
        left.artifactId.localeCompare(right.artifactId),
      ),
      checklist,
      decisions: facts("user_instruction"),
      hotTailTurnGroupIds: [...hotTail(input.context)],
      latestRawUserTurnId: latestRawUser.turnId,
      pendingEffects: facts("pending_effects"),
      projectionVersion: "agent-memory-working-state-v1",
      schemaVersion: 1,
      sessionId: input.evidence.sessionId,
      sourceHead,
      supersededItemIds: [],
      unresolvedErrors: facts("unresolved_errors"),
      verificationState: facts("verification_state"),
    });
  } catch (error) {
    if (error instanceof WorkingStateProjectionError) throw error;
    throw new WorkingStateProjectionError(
      "working_state_projection_invalid",
      "working state exceeds its strict canonical schema",
      { cause: error },
    );
  }
}
