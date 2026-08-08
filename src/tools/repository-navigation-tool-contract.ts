import { z } from "zod";

import type { ModelToolDefinition } from "../model/model-backend.js";
import {
  repositoryNavigationCursorSchema,
  repositoryNavigationQueryTextSchema,
  repositoryRelativePathSchema,
  repositorySymbolIdSchema,
  repositorySymbolKindSchema,
} from "../repository-intelligence/navigation-types.js";
import { ZodToolValidator } from "./validators/zod-tool-validator.js";

export const repositoryOutlineToolInputSchema = z.object({
  cursor: repositoryNavigationCursorSchema.nullable(),
  limit: z.number().int().min(1).max(500),
  max_depth: z.number().int().min(0).max(4),
  path: repositoryRelativePathSchema.nullable(),
}).strict();

export const findSymbolToolInputSchema = z.object({
  cursor: repositoryNavigationCursorSchema.nullable(),
  kinds: z.array(repositorySymbolKindSchema).max(8).nullable(),
  limit: z.number().int().min(1).max(50),
  path_prefix: repositoryRelativePathSchema.nullable(),
  query: repositoryNavigationQueryTextSchema,
}).strict();

const relationSchema = z.enum(["read", "write", "call", "import", "type", "unknown"]);

export const findReferencesToolInputSchema = z.object({
  cursor: repositoryNavigationCursorSchema.nullable(),
  limit: z.number().int().min(1).max(100),
  relations: z.array(relationSchema).max(6).nullable(),
  symbol_id: repositorySymbolIdSchema,
}).strict();

export const REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS = Object.freeze({
  find_references: "Find bounded references for a generation-bound repository symbol ID with current-source snippets. All fields are required; use null for relations or cursor when unused.",
  find_symbol: "Find bounded ranked symbols in the current repository generation with current-source snippets and evidence level. All fields are required; use null for unused filters or cursor.",
  repository_outline: "Return a bounded structured repository outline from the current verified index. All fields are required; use null for path or cursor when unused.",
});

function modelDefinition(
  name: keyof typeof REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS,
  schema: z.ZodType,
): ModelToolDefinition {
  const validator = new ZodToolValidator(schema);
  return Object.freeze({
    description: REPOSITORY_NAVIGATION_TOOL_DESCRIPTIONS[name],
    name,
    parameters: validator.modelSchema,
    strict: true,
  });
}

// PHASE17: production registries and model qualification consume these same
// Zod contracts, so any navigation schema change invalidates old evidence.
export const REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS = Object.freeze([
  modelDefinition("find_references", findReferencesToolInputSchema),
  modelDefinition("find_symbol", findSymbolToolInputSchema),
  modelDefinition("repository_outline", repositoryOutlineToolInputSchema),
]);
