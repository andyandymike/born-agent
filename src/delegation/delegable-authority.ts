import { sha256Canonical } from "../completion/canonical-json.js";
import type { TaskGraphBudgetV1 } from "../task-graph/task-graph-schema.js";
import type {
  DelegationAuthorityRequestV1,
  DelegationWorkspaceRequestV1,
} from "./delegation-schema.js";

export const DELEGATED_HARD_DENIED_TOOL_IDS = Object.freeze([
  "approve_delegation",
  "cleanup_worktree",
  "create_worktree",
  "install_plugin",
  "promote_worktree",
  "propose_delegation",
  "remove_plugin",
  "update_plan",
  "update_task_graph",
] as const);

export interface DelegableAuthorityCeilingV1 {
  readonly taskProfiles: readonly ("read-only" | "coding")[];
  readonly toolIds: readonly string[];
  readonly capabilityIds: readonly string[];
  readonly modelProfileIds: readonly string[];
  readonly workspaceModes: readonly ("origin_read_only" | "managed_worktree")[];
  readonly maximumBudget: TaskGraphBudgetV1;
  readonly maximumContextBytes: number;
  readonly maximumAttempts: 1 | 2;
  readonly authoritySha256: string;
}

export interface DelegationAuthorityDenialV1 {
  readonly kind: "budget" | "capability" | "context" | "model" | "profile" | "retry" | "tool" | "workspace";
  readonly id: string;
  readonly reason: string;
}

export interface DelegationAuthorityDecisionV1 {
  readonly eligible: boolean;
  readonly effectiveTaskProfile: "read-only" | "coding" | null;
  readonly effectiveToolIds: readonly string[];
  readonly effectiveCapabilityIds: readonly string[];
  readonly effectiveModelProfileId: string | null;
  readonly effectiveWorkspaceMode: "origin_read_only" | "managed_worktree" | null;
  readonly effectiveBudget: TaskGraphBudgetV1;
  readonly effectiveMaximumContextBytes: number;
  readonly effectiveMaximumAttempts: 1 | 2;
  readonly denied: readonly DelegationAuthorityDenialV1[];
  readonly inputAuthoritySha256s: readonly string[];
  readonly decisionSha256: string;
}

const budgetKeys = Object.freeze([
  "maxAttempts",
  "maxDurationMs",
  "maxModelSteps",
  "maxCommandExecutions",
  "maxCommandOutputBytes",
  "maxChangedFiles",
  "maxChangedBytes",
  "maxArtifactBytes",
  "maxReportedTokens",
] as const satisfies readonly (keyof TaskGraphBudgetV1)[]);

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ceilingContains<T extends string>(ceilings: readonly DelegableAuthorityCeilingV1[], key: keyof DelegableAuthorityCeilingV1, value: T): boolean {
  return ceilings.every((ceiling) => (ceiling[key] as readonly T[]).includes(value));
}

function minimumBudget(ceilings: readonly DelegableAuthorityCeilingV1[]): TaskGraphBudgetV1 {
  const numeric = (key: Exclude<keyof TaskGraphBudgetV1, "maxReportedTokens">): number =>
    Math.min(...ceilings.map((ceiling) => ceiling.maximumBudget[key]));
  const reported = ceilings.map((ceiling) => ceiling.maximumBudget.maxReportedTokens);
  return Object.freeze({
    maxAttempts: numeric("maxAttempts"),
    maxDurationMs: numeric("maxDurationMs"),
    maxModelSteps: numeric("maxModelSteps"),
    maxCommandExecutions: numeric("maxCommandExecutions"),
    maxCommandOutputBytes: numeric("maxCommandOutputBytes"),
    maxChangedFiles: numeric("maxChangedFiles"),
    maxChangedBytes: numeric("maxChangedBytes"),
    maxArtifactBytes: numeric("maxArtifactBytes"),
    maxReportedTokens: reported.some((value) => value === null)
      ? reported.filter((value): value is number => value !== null).reduce<number | null>(
        (lowest, value) => lowest === null ? value : Math.min(lowest, value),
        null,
      )
      : Math.min(...reported as number[]),
  });
}

function budgetExceeds(requested: TaskGraphBudgetV1, ceiling: TaskGraphBudgetV1): readonly string[] {
  return budgetKeys.flatMap((key) => {
    const request = requested[key];
    const limit = ceiling[key];
    if (key === "maxReportedTokens") {
      if (request === null) return limit === null ? [] : [key];
      return limit !== null && request > limit ? [key] : [];
    }
    return (request as number) > (limit as number) ? [key] : [];
  });
}

export function delegationAuthorityCeiling(
  value: Omit<DelegableAuthorityCeilingV1, "authoritySha256">,
): DelegableAuthorityCeilingV1 {
  const canonical = {
    ...value,
    taskProfiles: [...value.taskProfiles].sort(codePointCompare),
    toolIds: [...value.toolIds].sort(codePointCompare),
    capabilityIds: [...value.capabilityIds].sort(codePointCompare),
    modelProfileIds: [...value.modelProfileIds].sort(codePointCompare),
    workspaceModes: [...value.workspaceModes].sort(codePointCompare),
  };
  return Object.freeze({
    ...canonical,
    authoritySha256: sha256Canonical(canonical),
  });
}

export function computeDelegationAuthority(input: {
  readonly request: DelegationAuthorityRequestV1;
  readonly workspace: DelegationWorkspaceRequestV1;
  readonly requestedBudget: TaskGraphBudgetV1;
  readonly requestedContextBytes: number;
  readonly requestedMaximumAttempts: 1 | 2;
  readonly requestedModelProfileId: string;
  readonly ceilings: readonly DelegableAuthorityCeilingV1[];
}): DelegationAuthorityDecisionV1 {
  if (input.ceilings.length === 0) throw new TypeError("delegation authority requires at least one Host ceiling");
  const denied: DelegationAuthorityDenialV1[] = [];
  const hardDenied = new Set<string>(DELEGATED_HARD_DENIED_TOOL_IDS);
  const toolIds = [...input.request.toolIds].sort(codePointCompare);
  const capabilityIds = [...input.request.capabilityIds].sort(codePointCompare);

  if (!ceilingContains(input.ceilings, "taskProfiles", input.request.taskProfile)) {
    denied.push({ kind: "profile", id: input.request.taskProfile, reason: "task profile is not delegable by every authority ceiling" });
  }
  if (!ceilingContains(input.ceilings, "workspaceModes", input.workspace.mode)) {
    denied.push({ kind: "workspace", id: input.workspace.mode, reason: "workspace mode is not delegable by every authority ceiling" });
  }
  for (const id of toolIds) {
    if (hardDenied.has(id)) {
      denied.push({ kind: "tool", id, reason: "tool is hard-denied for delegated children" });
    } else if (!ceilingContains(input.ceilings, "toolIds", id)) {
      denied.push({ kind: "tool", id, reason: "tool is not present in every authority ceiling" });
    }
  }
  for (const id of capabilityIds) {
    if (!ceilingContains(input.ceilings, "capabilityIds", id)) {
      denied.push({ kind: "capability", id, reason: "capability is not present in every authority ceiling" });
    }
  }
  if (!ceilingContains(input.ceilings, "modelProfileIds", input.requestedModelProfileId)) {
    denied.push({ kind: "model", id: input.requestedModelProfileId, reason: "model profile is not present in every authority ceiling" });
  }
  const maximumBudget = minimumBudget(input.ceilings);
  for (const field of budgetExceeds(input.requestedBudget, maximumBudget)) {
    denied.push({ kind: "budget", id: field, reason: "requested budget exceeds an authority ceiling" });
  }
  const maximumContextBytes = Math.min(...input.ceilings.map((ceiling) => ceiling.maximumContextBytes));
  if (input.requestedContextBytes > maximumContextBytes) {
    denied.push({ kind: "context", id: "maximumCapsuleBytes", reason: "requested context exceeds an authority ceiling" });
  }
  const maximumAttempts = Math.min(...input.ceilings.map((ceiling) => ceiling.maximumAttempts)) as 1 | 2;
  if (input.requestedMaximumAttempts > maximumAttempts) {
    denied.push({ kind: "retry", id: "maxAttempts", reason: "requested attempts exceed an authority ceiling" });
  }

  const canonicalDenied = denied.sort((left, right) =>
    codePointCompare(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`));
  const eligible = canonicalDenied.length === 0;
  // PHASE20: capability eligibility is a strict intersection. Parent approvals,
  // secrets, leases, and successful effects are deliberately not inputs here.
  const withoutHash = {
    eligible,
    effectiveTaskProfile: eligible ? input.request.taskProfile : null,
    effectiveToolIds: eligible ? toolIds : [],
    effectiveCapabilityIds: eligible ? capabilityIds : [],
    effectiveModelProfileId: eligible ? input.requestedModelProfileId : null,
    effectiveWorkspaceMode: eligible ? input.workspace.mode : null,
    effectiveBudget: input.requestedBudget,
    effectiveMaximumContextBytes: Math.min(input.requestedContextBytes, maximumContextBytes),
    effectiveMaximumAttempts: Math.min(input.requestedMaximumAttempts, maximumAttempts) as 1 | 2,
    denied: canonicalDenied,
    inputAuthoritySha256s: input.ceilings.map((ceiling) => ceiling.authoritySha256).sort(codePointCompare),
  } as const;
  return Object.freeze({ ...withoutHash, decisionSha256: sha256Canonical(withoutHash) });
}
