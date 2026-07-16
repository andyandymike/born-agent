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
  // PHASE3: 三个工具共享同一份 canonical workspace 与敏感路径策略，防止各自实现出不同边界。
  const sensitive = new SensitivePathPolicy();
  const paths = await WorkspacePathPolicy.create(workspace, { sensitive });
  const runner = new RipgrepRunner();
  const definitions: ToolDefinition<unknown>[] = [
    // PHASE3: 工具集合在本阶段固定，不做动态发现、插件或任意 shell 注册。
    createReadFileTool(paths) as ToolDefinition<unknown>,
    createSearchTool(paths, runner, sensitive) as ToolDefinition<unknown>,
    createListFilesTool(paths, runner, sensitive) as ToolDefinition<unknown>,
  ];
  return new ToolRegistry(definitions, secrets);
}
