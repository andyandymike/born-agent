import { canonicalDelegationIdentity, delegationAuthorityRequestPreviewIdentity } from "../src/delegation/delegation-identity.js";
import type { DelegationProjectionV1, DelegationRevisionProjectionV1, DelegationStatusV1 } from "../src/delegation/delegation-projector.js";
import { normalizeDelegationRevision, type DelegationRevisionContentV1 } from "../src/delegation/delegation-schema.js";
import type { TaskGraphBudgetV1 } from "../src/task-graph/task-graph-schema.js";

export const IDS = Object.freeze({
  session: "10000000-0000-4000-8000-000000000020",
  parent: "20000000-0000-4000-8000-000000000020",
  goal: "30000000-0000-4000-8000-000000000020",
  plan: "40000000-0000-4000-8000-000000000020",
  delegation: "50000000-0000-4000-8000-000000000020",
  delegation2: "50000000-0000-4000-8000-000000000021",
  delegation3: "50000000-0000-4000-8000-000000000022",
  actor: "60000000-0000-4000-8000-000000000020",
  attempt: "70000000-0000-4000-8000-000000000020",
  run: "80000000-0000-4000-8000-000000000020",
  workspace: "90000000-0000-4000-8000-000000000020",
});

export const SHA = "a".repeat(64);

export function phase20Budget(overrides: Partial<TaskGraphBudgetV1> = {}): TaskGraphBudgetV1 {
  return Object.freeze({
    maxArtifactBytes: 4096,
    maxAttempts: 1,
    maxChangedBytes: 0,
    maxChangedFiles: 0,
    maxCommandExecutions: 0,
    maxCommandOutputBytes: 0,
    maxDurationMs: 60_000,
    maxModelSteps: 4,
    maxReportedTokens: 4096,
    ...overrides,
  });
}

export function phase20Content(input: {
  readonly coding?: boolean;
  readonly delegationId?: string;
  readonly retry?: boolean;
  readonly sequence?: number;
} = {}): DelegationRevisionContentV1 {
  const coding = input.coding === true;
  return normalizeDelegationRevision({
    schemaVersion: 1,
    sequence: input.sequence ?? 1,
    title: coding ? "Implement bounded child change" : "Inspect bounded child facts",
    objective: coding ? "Change only src/safe.ts and return a verified bundle." : "Inspect the exact source snapshot and return evidence.",
    expectedReceipt: coding
      ? {
          kind: "change",
          requiredClaims: [{ claimId: "change", kind: "change_bundle", description: "Exact scoped change bundle", required: true }],
        }
      : {
          kind: "analysis",
          requiredClaims: [{ claimId: "answer", kind: "answer", description: "Evidence-backed answer", required: true }],
        },
    contextRequest: {
      includeGoal: true,
      includeApprovedPlanItems: [],
      includeParentFacts: [],
      requestedPaths: ["src"],
      maximumCapsuleBytes: 32 * 1024,
    },
    authorityRequest: {
      taskProfile: coding ? "coding" : "read-only",
      toolIds: coding ? ["apply_patch", "finish_task", "read_file"] : ["read_file", "search"],
      capabilityIds: [],
    },
    budget: phase20Budget({
      ...(coding ? { maxChangedBytes: 4096, maxChangedFiles: 1 } : {}),
      ...(input.retry === true ? { maxAttempts: 2 } : {}),
    }),
    workspace: coding
      ? { mode: "managed_worktree", sourceSnapshotSha256: SHA, managedWorkspaceId: IDS.workspace, declaredPathPrefixes: ["src"] }
      : { mode: "origin_read_only", sourceSnapshotSha256: SHA, managedWorkspaceId: null, declaredPathPrefixes: ["src"] },
    model: { strategy: "same_as_parent", exactProfileId: null, exactProviderId: null, exactModelId: null },
    retry: input.retry === true
      ? { maxAttempts: 2, automaticOn: ["pre_effect_infrastructure_failure"] }
      : { maxAttempts: 1, automaticOn: [] },
    delegationId: input.delegationId ?? IDS.delegation,
    binding: {
      sessionId: IDS.session,
      parentRunId: IDS.parent,
      parentActorId: IDS.parent,
      goalId: IDS.goal,
      goalRevision: 1,
      planId: IDS.plan,
      planRevision: 1,
      planSha256: SHA,
      graphId: null,
      graphRevision: null,
      graphSha256: null,
      nodeId: null,
      nodeAttemptId: null,
      parentWorkspaceLineageId: SHA,
    },
  });
}

export function phase20Revision(input: {
  readonly coding?: boolean;
  readonly delegationId?: string;
  readonly envelope?: boolean;
  readonly retry?: boolean;
  readonly sequence?: number;
  readonly status?: DelegationStatusV1;
} = {}): DelegationRevisionProjectionV1 {
  const content = phase20Content(input);
  const identity = canonicalDelegationIdentity(content);
  const artifact = { artifactId: `sha256:${identity.delegationSha256}`, bytes: 512, objectRef: `sha256:${identity.delegationSha256}`, sha256: identity.delegationSha256 };
  return Object.freeze({
    artifact,
    attempts: [],
    authorityPreviewSha256: delegationAuthorityRequestPreviewIdentity(content),
    binding: content.binding,
    content,
    createdEventId: "a0000000-0000-4000-8000-000000000020",
    decisionEventId: "a0000000-0000-4000-8000-000000000021",
    delegationId: content.delegationId,
    delegationRevision: 1,
    delegationSha256: identity.delegationSha256,
    envelope: input.envelope === true ? {
      contextCapsule: artifact,
      contextCapsuleSha256: identity.delegationSha256,
      envelope: artifact,
      envelopeSha256: identity.delegationSha256,
    } : null,
    envelopePreparationCount: input.envelope === true ? 1 : 0,
    parentActorId: IDS.parent,
    parentRunId: IDS.parent,
    receipt: null,
    blockerCodes: [],
    status: input.status ?? "approved",
    terminalEventId: null,
  });
}

const zeroCounters = Object.freeze({
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

export function phase20Projection(revisions: readonly DelegationRevisionProjectionV1[]): DelegationProjectionV1 {
  return Object.freeze({
    trackingMode: "phase20",
    revisions,
    activeActorSlots: [],
    activeConflictClaims: [],
    barriers: [],
    budget: { held: zeroCounters, released: zeroCounters, reserved: zeroCounters, used: zeroCounters },
    maximumObservedActiveChildren: 0,
    takeoverCount: 0,
    waitingApprovals: [],
    workspaceConflictDeferrals: 0,
    lastSessionSeq: 1,
  });
}
