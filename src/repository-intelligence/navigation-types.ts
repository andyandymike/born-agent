import { z } from "zod";
import { isAbsolute } from "node:path";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4096, "repository path exceeds its UTF-8 byte bound")
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !isAbsolute(value) &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "repository path must be canonical and workspace-relative",
  );

export const repositoryNavigationQueryTextSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024, "navigation query is too large")
  .refine(
    (value) => [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && codePoint !== 127;
    }),
    "navigation query contains control characters",
  );

export const repositoryNavigationCursorSchema = z.string().regex(/^navcur_v1_[A-Za-z0-9_-]{16,512}$/u);
export const repositorySymbolIdSchema = z.string().regex(/^sym_v1_[A-Za-z0-9_-]{16,160}$/u);

export const repositorySourceRangeSchema = z
  .object({
    endByte: z.number().int().nonnegative(),
    endColumnUtf16: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startByte: z.number().int().nonnegative(),
    startColumnUtf16: z.number().int().positive(),
    startLine: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endByte < value.startByte) {
      context.addIssue({ code: "custom", message: "source range must be half-open and ordered" });
    }
    if (
      value.endLine < value.startLine ||
      (value.endLine === value.startLine && value.endColumnUtf16 < value.startColumnUtf16)
    ) {
      context.addIssue({ code: "custom", message: "display source range must be ordered" });
    }
  });

export type SourceRange = Readonly<z.infer<typeof repositorySourceRangeSchema>>;

export const repositorySymbolKindSchema = z.enum([
  "class",
  "constant",
  "constructor",
  "enum",
  "function",
  "interface",
  "method",
  "module",
  "property",
  "type",
  "variable",
]);

export type RepositorySymbolKind = z.infer<typeof repositorySymbolKindSchema>;

export const indexedSourceUnitSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    diagnosticCode: z.string().min(1).max(128).nullable(),
    language: z.string().min(1).max(64),
    parseStatus: z.enum(["indexed", "metadata_only", "unsupported", "failed"]),
    relativePath: repositoryRelativePathSchema,
    sourceSha256: sha256Schema,
    unitSha256: sha256Schema,
  })
  .strict();

export type IndexedSourceUnit = Readonly<z.infer<typeof indexedSourceUnitSchema>>;

export const indexedSymbolSchema = z
  .object({
    evidenceLevel: z.enum(["semantic", "syntactic"]),
    exported: z.boolean(),
    kind: repositorySymbolKindSchema,
    name: z.string().min(1).max(256),
    qualifiedName: z.string().min(1).max(1024),
    range: repositorySourceRangeSchema,
    recordId: sha256Schema,
    relativePath: repositoryRelativePathSchema,
    sourceSha256: sha256Schema,
  })
  .strict();

export type IndexedSymbol = Readonly<z.infer<typeof indexedSymbolSchema>>;

export const indexedReferenceSchema = z
  .object({
    evidenceLevel: z.enum(["semantic", "syntactic", "textual_fallback"]),
    range: repositorySourceRangeSchema,
    relation: z.enum(["read", "write", "call", "import", "type", "unknown"]),
    sourcePath: repositoryRelativePathSchema,
    sourceSha256: sha256Schema,
    targetSymbolRecordId: sha256Schema.nullable(),
    unresolvedName: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.targetSymbolRecordId === null) === (value.unresolvedName === null)) {
      context.addIssue({
        code: "custom",
        message: "reference must have exactly one resolved target or unresolved name",
      });
    }
  });

export type IndexedReference = Readonly<z.infer<typeof indexedReferenceSchema>>;

export const indexedImportSchema = z
  .object({
    evidenceLevel: z.enum(["semantic", "syntactic"]),
    range: repositorySourceRangeSchema,
    resolvedPath: repositoryRelativePathSchema.nullable(),
    sourcePath: repositoryRelativePathSchema,
    sourceSha256: sha256Schema,
    specifier: z.string().min(1).max(1024),
  })
  .strict();

export type IndexedImport = Readonly<z.infer<typeof indexedImportSchema>>;

export interface RepositoryIndexRecords {
  readonly imports: readonly IndexedImport[];
  readonly references: readonly IndexedReference[];
  readonly symbols: readonly IndexedSymbol[];
  readonly units: readonly IndexedSourceUnit[];
}
