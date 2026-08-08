import { z } from "zod";

import {
  repositoryNavigationCursorSchema,
  repositoryNavigationQueryTextSchema,
  repositoryRelativePathSchema,
  repositorySymbolIdSchema,
  repositorySymbolKindSchema,
} from "./navigation-types.js";

export const repositoryOutlineQuerySchema = z
  .object({
    cursor: repositoryNavigationCursorSchema.optional(),
    limit: z.number().int().min(1).max(500).default(100),
    max_depth: z.number().int().min(0).max(4).default(2),
    path: repositoryRelativePathSchema.optional(),
  })
  .strict();

export type OutlineQuery = Readonly<z.infer<typeof repositoryOutlineQuerySchema>>;

export const findSymbolQuerySchema = z
  .object({
    cursor: repositoryNavigationCursorSchema.optional(),
    kinds: z.array(repositorySymbolKindSchema).min(1).max(8).refine((value) => new Set(value).size === value.length, "symbol kinds must be unique").optional(),
    limit: z.number().int().min(1).max(50).default(20),
    path_prefix: repositoryRelativePathSchema.optional(),
    query: repositoryNavigationQueryTextSchema,
  })
  .strict();

export type SymbolQuery = Readonly<z.infer<typeof findSymbolQuerySchema>>;

export const findReferencesQuerySchema = z
  .object({
    cursor: repositoryNavigationCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    relations: z.array(z.enum(["read", "write", "call", "import", "type", "unknown"])).min(1).max(6).refine((value) => new Set(value).size === value.length, "reference relations must be unique").optional(),
    symbol_id: repositorySymbolIdSchema,
  })
  .strict();

export type ReferenceQuery = Readonly<z.infer<typeof findReferencesQuerySchema>>;

export const navigationQuerySchemas = Object.freeze({
  find_references: findReferencesQuerySchema,
  find_symbol: findSymbolQuerySchema,
  repository_outline: repositoryOutlineQuerySchema,
});
