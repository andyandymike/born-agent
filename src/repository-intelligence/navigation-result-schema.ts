import { z } from "zod";

import { repositoryNavigationCursorSchema, repositoryRelativePathSchema, repositorySourceRangeSchema, repositorySymbolIdSchema, repositorySymbolKindSchema, sha256Schema } from "./navigation-types.js";

const snippetSchema = z.object({
  bytes: z.number().int().nonnegative().max(8192),
  endLine: z.number().int().positive(),
  sourceSha256: sha256Schema,
  startLine: z.number().int().positive(),
  text: z.string().max(8192),
  trust: z.literal("untrusted_repository_content"),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.text, "utf8") !== value.bytes) {
    context.addIssue({ code: "custom", message: "snippet byte count does not match text" });
  }
  if (value.endLine < value.startLine) {
    context.addIssue({ code: "custom", message: "snippet line range is not ordered" });
  }
});

export const outlineEntrySchema = z.object({
  indexStatus: z.enum(["indexed", "metadata_only", "unsupported", "failed"]),
  kind: z.enum(["directory", "file"]),
  language: z.string().nullable(),
  relativePath: repositoryRelativePathSchema,
  topLevelSymbols: z.array(z.object({
    kind: repositorySymbolKindSchema,
    name: z.string().min(1).max(256),
    startLine: z.number().int().positive(),
    symbolId: repositorySymbolIdSchema,
  }).strict()).max(8),
}).strict();

export const symbolCandidateSchema = z.object({
  applicableRuleScopeSha256: sha256Schema,
  evidenceLevel: z.enum(["semantic", "syntactic", "textual_fallback"]),
  exported: z.boolean(),
  kind: repositorySymbolKindSchema,
  name: z.string().min(1).max(256),
  qualifiedName: z.string().min(1).max(1024),
  range: repositorySourceRangeSchema,
  relativePath: repositoryRelativePathSchema,
  snippet: snippetSchema,
  sourceSha256: sha256Schema,
  symbolId: repositorySymbolIdSchema,
}).strict().superRefine((value, context) => {
  if (value.snippet.sourceSha256 !== value.sourceSha256) {
    context.addIssue({ code: "custom", message: "symbol snippet source identity does not match" });
  }
});

export const referenceCandidateSchema = z.object({
  evidenceLevel: z.enum(["semantic", "syntactic", "textual_fallback"]),
  range: repositorySourceRangeSchema,
  relation: z.enum(["read", "write", "call", "import", "type", "unknown"]),
  relativePath: repositoryRelativePathSchema,
  snippet: snippetSchema.safeExtend({ bytes: z.number().int().nonnegative().max(4096), text: z.string().max(4096) }),
  sourceSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.snippet.sourceSha256 !== value.sourceSha256) {
    context.addIssue({ code: "custom", message: "reference snippet source identity does not match" });
  }
});

function envelope<T extends z.ZodType>(result: T) {
  return z.object({
    confirmedAbsent: z.boolean(),
    coverage: z.enum(["complete", "partial", "unsupported"]),
    engine: z.object({ id: z.string().min(1).max(128), identitySha256: sha256Schema }).strict(),
    evidenceLevel: z.enum(["semantic", "syntactic", "textual_fallback"]),
    freshness: z.literal("current"),
    generationSha256: sha256Schema,
    nextCursor: repositoryNavigationCursorSchema.nullable(),
    result,
    repositoryStatusSha256: sha256Schema,
    ruleManifestSha256: sha256Schema,
    schemaVersion: z.literal(1),
    sourceStateSha256: sha256Schema,
    truncated: z.boolean(),
  }).strict().superRefine((value, context) => {
    const resultValues = (value as { readonly result: readonly unknown[] }).result;
    if (value.confirmedAbsent && (resultValues.length !== 0 || value.coverage !== "complete" || value.truncated)) {
      context.addIssue({ code: "custom", message: "confirmed absence requires a complete empty untruncated result" });
    }
    if ((value.nextCursor !== null) !== value.truncated) context.addIssue({ code: "custom", message: "truncation and next cursor must match" });
  });
}

export const repositoryOutlineResultSchema = envelope(z.array(outlineEntrySchema).max(500));
export const findSymbolResultSchema = envelope(z.array(symbolCandidateSchema).max(50));
export const findReferencesResultSchema = envelope(z.array(referenceCandidateSchema).max(100));

export type OutlineResult = Readonly<z.infer<typeof repositoryOutlineResultSchema>>;
export type SymbolResult = Readonly<z.infer<typeof findSymbolResultSchema>>;
export type ReferenceResult = Readonly<z.infer<typeof findReferencesResultSchema>>;
