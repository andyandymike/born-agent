import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { UpdatePlanInput } from "../plans/update-plan-input-schema.js";
import { createReadonlyToolDefinitions } from "./create-readonly-tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition, ToolRegistration } from "./tool-types.js";
import type { RepositoryRuleReadRuntime } from "../repository-rules/repository-rule-observation-binding.js";
import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";

export async function createPlanToolRegistry(
  workspace: string,
  updatePlan: ToolDefinition<UpdatePlanInput>,
  secrets: readonly (string | undefined)[] = [],
  artifacts?: ArtifactSessionRuntimeLike,
  repositoryRules?: RepositoryRuleReadRuntime,
  repositoryNavigation?: RepositoryNavigationService,
  additionalTools: readonly ToolRegistration<unknown>[] = [],
  delegationProposal?: ToolDefinition<unknown>,
): Promise<ToolRegistry> {
  if (updatePlan.name !== "update_plan") {
    throw new Error("Plan registry requires the package-owned update_plan tool");
  }
  const definitions = [
    ...(await createReadonlyToolDefinitions(workspace, artifacts, repositoryRules, repositoryNavigation)),
    ...additionalTools,
    ...(delegationProposal === undefined ? [] : [delegationProposal]),
    updatePlan as ToolDefinition<unknown>,
  ];
  if (additionalTools.some((tool) => tool.capability !== "read")) {
    throw new Error("Plan registry capability extensions must be read-only");
  }
  if (
    delegationProposal !== undefined &&
    (delegationProposal.name !== "propose_delegation" || delegationProposal.capability !== "mutation")
  ) {
    throw new Error("Plan registry delegation control tool is not the package-owned proposal capability");
  }
  const names = definitions.map((definition) => definition.name).sort();
  const expected = [
    "list_files",
    "read_file",
    "search",
    ...(repositoryNavigation === undefined ? [] : ["repository_outline", "find_symbol", "find_references"]),
    ...(artifacts === undefined ? [] : ["read_artifact"]),
    ...additionalTools.map((tool) => tool.name),
    ...(delegationProposal === undefined ? [] : ["propose_delegation"]),
    "update_plan",
  ].sort();
  if (names.join(",") !== expected.join(",")) {
    throw new Error("Plan registry tool catalog is not the exact allowlist");
  }
  const forbidden = new Set(["apply_patch", "finish_task", "run_command"]);
  if (definitions.some((definition) => forbidden.has(definition.name))) {
    throw new Error("Plan registry cannot contain workspace side-effect tools");
  }
  return new ToolRegistry(definitions, secrets, undefined, artifacts);
}
