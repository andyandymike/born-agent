import { createListFilesTool } from "./list-files-tool.js";
import { createReadFileTool } from "./read-file-tool.js";
import { RipgrepRunner } from "./ripgrep-runner.js";
import { createSearchTool } from "./search-tool.js";
import { SensitivePathPolicy } from "./sensitive-path-policy.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-types.js";
import { WorkspacePathPolicy } from "./workspace-path-policy.js";

export async function createReadonlyToolRegistry(
  workspace: string,
  secrets: readonly (string | undefined)[] = [],
): Promise<ToolRegistry> {
  const sensitive = new SensitivePathPolicy();
  const paths = await WorkspacePathPolicy.create(workspace, { sensitive });
  const runner = new RipgrepRunner();
  const definitions: ToolDefinition<unknown>[] = [
    createReadFileTool(paths) as ToolDefinition<unknown>,
    createSearchTool(paths, runner, sensitive) as ToolDefinition<unknown>,
    createListFilesTool(paths, runner, sensitive) as ToolDefinition<unknown>,
  ];
  return new ToolRegistry(definitions, secrets);
}
