import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import type { UpdatePlanInput } from "../plans/update-plan-input-schema.js";
import { createReadonlyToolDefinitions } from "./create-readonly-tool-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-types.js";

export async function createPlanToolRegistry(
  workspace: string,
  updatePlan: ToolDefinition<UpdatePlanInput>,
  secrets: readonly (string | undefined)[] = [],
  artifacts?: ArtifactSessionRuntimeLike,
): Promise<ToolRegistry> {
  if (updatePlan.name !== "update_plan") {
    throw new Error("Plan registry requires the package-owned update_plan tool");
  }
  const definitions = [
    ...(await createReadonlyToolDefinitions(workspace, artifacts)),
    updatePlan as ToolDefinition<unknown>,
  ];
  const names = definitions.map((definition) => definition.name).sort();
  const expected = [
    "list_files",
    "read_file",
    "search",
    ...(artifacts === undefined ? [] : ["read_artifact"]),
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
