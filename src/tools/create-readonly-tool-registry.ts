import type { ArtifactSessionRuntimeLike } from "../artifacts/artifact-session-runtime.js";
import { createListFilesTool } from "./list-files-tool.js";
import { createReadArtifactTool } from "./read-artifact-tool.js";
import { createReadFileTool } from "./read-file-tool.js";
import { RipgrepRunner } from "./ripgrep-runner.js";
import { createSearchTool } from "./search-tool.js";
import { SensitivePathPolicy } from "./sensitive-path-policy.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition, ToolRegistration } from "./tool-types.js";
import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import { createRepositoryOutlineTool } from "./repository-outline-tool.js";
import { createFindSymbolTool } from "./find-symbol-tool.js";
import { createFindReferencesTool } from "./find-references-tool.js";
import { WorkspacePathPolicy } from "./workspace-path-policy.js";
import {
  bindRepositoryRuleObservations,
  type RepositoryRuleReadRuntime,
} from "../repository-rules/repository-rule-observation-binding.js";

export async function createReadonlyToolDefinitions(
  workspace: string,
  artifacts?: ArtifactSessionRuntimeLike,
  repositoryRules?: RepositoryRuleReadRuntime,
  repositoryNavigation?: RepositoryNavigationService,
): Promise<readonly ToolDefinition<unknown>[]> {
  // PHASE3: 三个工具共享同一份 canonical workspace 与敏感路径策略，防止各自实现出不同边界。
  const sensitive = new SensitivePathPolicy();
  const paths = await WorkspacePathPolicy.create(workspace, { sensitive });
  const runner = new RipgrepRunner();
  const definitions: ToolDefinition<unknown>[] = [
    // PHASE3: 工具集合在本阶段固定，不做动态发现、插件或任意 shell 注册。
    createReadFileTool(paths) as ToolDefinition<unknown>,
    createSearchTool(paths, runner, sensitive) as ToolDefinition<unknown>,
    createListFilesTool(paths, runner, sensitive) as ToolDefinition<unknown>,
    ...(repositoryNavigation === undefined
      ? []
      : [
          createRepositoryOutlineTool(repositoryNavigation) as ToolDefinition<unknown>,
          createFindSymbolTool(repositoryNavigation) as ToolDefinition<unknown>,
          createFindReferencesTool(repositoryNavigation) as ToolDefinition<unknown>,
        ]),
    ...(artifacts === undefined
      ? []
      : [
          createReadArtifactTool(artifacts.reader) as ToolDefinition<unknown>,
        ]),
  ];
  if (definitions.some((definition) => definition.capability !== "read")) {
    throw new Error("read-only registry cannot contain mutation tools");
  }
  return repositoryRules === undefined
    ? definitions
    : definitions.map((definition) =>
        bindRepositoryRuleObservations(definition, repositoryRules),
      );
}

export async function createReadonlyToolRegistry(
  workspace: string,
  secrets: readonly (string | undefined)[] = [],
  artifacts?: ArtifactSessionRuntimeLike,
  additionalTools: readonly ToolRegistration<unknown>[] = [],
  repositoryRules?: RepositoryRuleReadRuntime,
  repositoryNavigation?: RepositoryNavigationService,
): Promise<ToolRegistry> {
  const definitions = await createReadonlyToolDefinitions(
    workspace,
    artifacts,
    repositoryRules,
    repositoryNavigation,
  );
  return new ToolRegistry(
    [...definitions, ...additionalTools],
    secrets,
    undefined,
    artifacts,
  );
}
