import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value !== "." &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "path must be a canonical relative POSIX path",
  );

export const repositorySourceEntrySchema = z
  .object({
    byteLength: z.number().int().nonnegative(),
    contentSha256: sha256Schema,
    languageHint: z.enum([
      "c",
      "cpp",
      "csharp",
      "css",
      "go",
      "html",
      "java",
      "javascript",
      "json",
      "kotlin",
      "markdown",
      "python",
      "ruby",
      "rust",
      "shell",
      "sql",
      "swift",
      "toml",
      "typescript",
      "unknown",
      "xml",
      "yaml",
    ]),
    parseEligibility: z.enum(["eligible", "binary", "unsupported"]),
    relativePath: relativePathSchema,
    textEncoding: z.enum(["utf8", "binary"]),
  })
  .strict();

export type RepositorySourceEntry = Readonly<z.infer<typeof repositorySourceEntrySchema>>;

export const repositorySourceSnapshotSchema = z
  .object({
    coverage: z.enum(["complete", "partial"]),
    entries: z.array(repositorySourceEntrySchema),
    entriesSha256: sha256Schema,
    gitHeadOid: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable(),
    gitIndexSha256: sha256Schema.nullable(),
    inventoryPolicySha256: sha256Schema,
    schemaVersion: z.literal(1),
    skipped: z.record(z.string().min(1), z.number().int().positive()),
    sourceKind: z.enum(["git_worktree", "filesystem"]),
    sourceStateSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const sorted = [...value.entries].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    if (sorted.some((entry, index) => entry.relativePath !== value.entries[index]?.relativePath)) {
      context.addIssue({ code: "custom", message: "entries must be sorted by canonical path" });
    }
    if (new Set(value.entries.map((entry) => entry.relativePath)).size !== value.entries.length) {
      context.addIssue({ code: "custom", message: "entry paths must be unique" });
    }
    if (value.coverage === "complete" && Object.keys(value.skipped).length > 0) {
      context.addIssue({ code: "custom", message: "complete snapshots cannot contain skipped entries" });
    }
  });

export type RepositorySourceSnapshotV1 = Readonly<z.infer<typeof repositorySourceSnapshotSchema>>;

export interface RepositorySourceSnapshotResult {
  readonly snapshot: RepositorySourceSnapshotV1;
  /** Ephemeral bytes keyed by snapshot path. Never persisted in the manifest. */
  readonly sourceBytes: ReadonlyMap<string, Uint8Array>;
}
