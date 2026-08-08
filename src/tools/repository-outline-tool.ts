import type { z } from "zod";

import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import { RepositoryIntelligenceError } from "../repository-intelligence/repository-intelligence-error.js";
import { toolError } from "./tool-errors.js";
import type { ToolDefinition, ToolRawResult } from "./tool-types.js";
import {
  REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS,
  repositoryOutlineToolInputSchema,
} from "./repository-navigation-tool-contract.js";

export { repositoryOutlineToolInputSchema } from "./repository-navigation-tool-contract.js";

export function repositoryNavigationToolFailure(error: unknown): ToolRawResult {
  if (error instanceof RepositoryIntelligenceError) {
    return {
      error: toolError(
        error.exitCode === 130 ? "cancelled" : error.code.includes("stale") ? "permission" : "tool",
        error.code,
        error.exitCode === 130 ? "repository navigation was cancelled" : "repository navigation could not return a current verified result",
        ["repository_index_busy", "repository_index_stale", "repository_cursor_stale", "repository_symbol_stale"].includes(error.code),
      ),
      ok: false,
    };
  }
  return { error: toolError("system", "repository_navigation_failed", "repository navigation failed"), ok: false };
}

export function createRepositoryOutlineTool(
  service: RepositoryNavigationService,
): ToolDefinition<z.infer<typeof repositoryOutlineToolInputSchema>> {
  return {
    capability: "read",
    description: REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS.repository_outline,
    execute: async (input, context) => {
      try {
        const result = await service.outline({
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          limit: input.limit,
          max_depth: input.max_depth,
          ...(input.path === null ? {} : { path: input.path }),
        }, context.signal);
        return { ok: true, truncated: result.truncated, value: { ...result } };
      } catch (error) {
        return repositoryNavigationToolFailure(error);
      }
    },
    inputSchema: repositoryOutlineToolInputSchema,
    name: "repository_outline",
  };
}
