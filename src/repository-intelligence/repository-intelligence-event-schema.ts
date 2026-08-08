import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const countsSchema = z.object({
  failed: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  references: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
}).strict();

export const repositorySourceSnapshotCapturedDataSchema = z.object({
  coverage: z.enum(["complete", "partial"]),
  entries_sha256: sha256Schema,
  file_count: z.number().int().nonnegative(),
  inventory_policy_sha256: sha256Schema,
  skipped_count: z.number().int().nonnegative(),
  source_kind: z.enum(["git_worktree", "filesystem"]),
  source_state_sha256: sha256Schema,
}).strict();

export const repositoryIndexSelectedDataSchema = z.object({
  build_mode: z.enum(["cold", "incremental", "reused"]),
  cache_manifest_sha256: sha256Schema,
  counts: countsSchema,
  coverage: z.enum(["complete", "partial"]),
  engine_id: z.literal("typescript-language-service"),
  engine_identity_sha256: sha256Schema,
  generation_sha256: sha256Schema,
  rule_manifest_sha256: sha256Schema,
  source_state_sha256: sha256Schema,
}).strict();

export const repositoryIndexInvalidatedDataSchema = z.object({
  changed_path_count: z.number().int().nonnegative(),
  current_source_state_sha256: sha256Schema,
  old_generation_sha256: sha256Schema,
  reason: z.enum(["engine_changed", "rules_changed", "source_changed", "cache_corrupt"]),
}).strict();

export const phase17RepositoryIntelligenceRunEventDataSchemas = {
  "repository.index.invalidated": repositoryIndexInvalidatedDataSchema,
  "repository.index.selected": repositoryIndexSelectedDataSchema,
  "repository.source.snapshot.captured": repositorySourceSnapshotCapturedDataSchema,
} as const;

export type RepositoryIndexSelectedEventData = Readonly<z.infer<typeof repositoryIndexSelectedDataSchema>>;
export type RepositoryIndexInvalidatedEventData = Readonly<z.infer<typeof repositoryIndexInvalidatedDataSchema>>;

export type Phase17RepositoryIntelligenceRunEventType = keyof typeof phase17RepositoryIntelligenceRunEventDataSchemas;
