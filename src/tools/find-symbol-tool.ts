import type { z } from "zod";

import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import { repositoryNavigationToolFailure } from "./repository-outline-tool.js";
import type { ToolDefinition } from "./tool-types.js";
import {
  findSymbolToolInputSchema,
  REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS,
} from "./repository-navigation-tool-contract.js";

export { findSymbolToolInputSchema } from "./repository-navigation-tool-contract.js";

export function createFindSymbolTool(service: RepositoryNavigationService): ToolDefinition<z.infer<typeof findSymbolToolInputSchema>> {
  return {
    capability: "read",
    description: REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS.find_symbol,
    execute: async (input, context) => {
      try {
        const result = await service.findSymbols({
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          ...(input.kinds === null ? {} : { kinds: input.kinds }),
          limit: input.limit,
          ...(input.path_prefix === null ? {} : { path_prefix: input.path_prefix }),
          query: input.query,
        }, context.signal);
        return { ok: true, truncated: result.truncated, value: { ...result } };
      } catch (error) {
        return repositoryNavigationToolFailure(error);
      }
    },
    inputSchema: findSymbolToolInputSchema,
    name: "find_symbol",
  };
}
