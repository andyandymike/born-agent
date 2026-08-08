import type { z } from "zod";

import type { RepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import { repositoryNavigationToolFailure } from "./repository-outline-tool.js";
import type { ToolDefinition } from "./tool-types.js";
import {
  findReferencesToolInputSchema,
  REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS,
} from "./repository-navigation-tool-contract.js";

export { findReferencesToolInputSchema } from "./repository-navigation-tool-contract.js";

export function createFindReferencesTool(service: RepositoryNavigationService): ToolDefinition<z.infer<typeof findReferencesToolInputSchema>> {
  return {
    capability: "read",
    description: REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS.find_references,
    execute: async (input, context) => {
      try {
        const result = await service.findReferences({
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          limit: input.limit,
          ...(input.relations === null ? {} : { relations: input.relations }),
          symbol_id: input.symbol_id,
        }, context.signal);
        return { ok: true, truncated: result.truncated, value: { ...result } };
      } catch (error) {
        return repositoryNavigationToolFailure(error);
      }
    },
    inputSchema: findReferencesToolInputSchema,
    name: "find_references",
  };
}
