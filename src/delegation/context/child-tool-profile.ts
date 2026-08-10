import { sha256Canonical } from "../../completion/canonical-json.js";
import { DelegationError } from "../delegation-errors.js";
import { DELEGATED_HARD_DENIED_TOOL_IDS } from "../delegable-authority.js";

export type DelegatedToolEffectClassV1 =
  | "read"
  | "patch"
  | "approved_command"
  | "completion"
  | "delegate"
  | "goal_plan_control"
  | "worktree_lifecycle"
  | "plugin_lifecycle"
  | "publish"
  | "daemon_remote"
  | "arbitrary_process";

export interface DelegatedToolCatalogEntryV1 {
  readonly id: string;
  readonly schemaSha256: string;
  readonly effectClass: DelegatedToolEffectClassV1;
}

export interface ChildToolProfileV1 {
  readonly profileId: "delegated_read_only_v1" | "delegated_coding_v1";
  readonly toolIds: readonly string[];
  readonly toolSchemaSha256: string;
  readonly hardDeniedToolIds: readonly string[];
  readonly profileSha256: string;
}

const READ_ONLY = new Set([
  "find_references",
  "find_symbol",
  "list_files",
  "read_artifact",
  "read_file",
  "repository_outline",
  "search",
]);
const CODING = new Set([...READ_ONLY, "apply_patch", "finish_task", "run_command"]);
const HARD_EFFECTS = new Set<DelegatedToolEffectClassV1>([
  "delegate",
  "goal_plan_control",
  "worktree_lifecycle",
  "plugin_lifecycle",
  "publish",
  "daemon_remote",
  "arbitrary_process",
]);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildChildToolProfile(input: {
  readonly taskProfile: "read-only" | "coding";
  readonly requestedToolIds: readonly string[];
  readonly policyToolIds: readonly string[];
  readonly parentDelegableToolIds: readonly string[];
  readonly catalog: readonly DelegatedToolCatalogEntryV1[];
}): ChildToolProfileV1 {
  const catalog = new Map(input.catalog.map((entry) => [entry.id, entry]));
  const policy = new Set(input.policyToolIds);
  const parent = new Set(input.parentDelegableToolIds);
  const allowedProfile = input.taskProfile === "read-only" ? READ_ONLY : CODING;
  const hardIds = new Set<string>(DELEGATED_HARD_DENIED_TOOL_IDS);
  const selected = [...input.requestedToolIds].sort(compare);
  for (const id of selected) {
    const entry = catalog.get(id);
    // PHASE20: aliases and capability-contributed tools are classified by
    // effect ownership, so renaming a delegate/promotion primitive cannot
    // restore a physically removed child capability.
    if (entry === undefined || hardIds.has(id) || HARD_EFFECTS.has(entry.effectClass)) {
      throw new DelegationError("delegation_authority_expansion", `tool ${id} is absent or hard-denied for delegated children`);
    }
    if (!policy.has(id) || !parent.has(id) || !allowedProfile.has(id)) {
      throw new DelegationError("delegation_authority_expansion", `tool ${id} is outside the strict delegated authority intersection`);
    }
    if (input.taskProfile === "read-only" && entry.effectClass !== "read") {
      throw new DelegationError("delegation_authority_expansion", `read-only child tool ${id} is effectful`);
    }
  }
  const toolSchemaSha256 = sha256Canonical(selected.map((id) => ({ id, schemaSha256: catalog.get(id)!.schemaSha256 })));
  const content = {
    profileId: input.taskProfile === "read-only" ? "delegated_read_only_v1" as const : "delegated_coding_v1" as const,
    toolIds: selected,
    toolSchemaSha256,
    hardDeniedToolIds: [...new Set([...DELEGATED_HARD_DENIED_TOOL_IDS])].sort(compare),
  };
  return Object.freeze({ ...content, profileSha256: sha256Canonical(content) });
}
