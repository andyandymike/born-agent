import { extname } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { RepositoryIndexRecords } from "./navigation-types.js";
import type { RepositorySourceSnapshotResult } from "./source-snapshot.js";

const relativePathSchema = z.string().min(1).max(4096);

export const repositoryChangeSetSchema = z
  .object({
    added: z.array(relativePathSchema),
    changeSetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    changed: z.array(relativePathSchema),
    deleted: z.array(relativePathSchema),
    renamed: z.array(z.object({ from: relativePathSchema, to: relativePathSchema }).strict()),
    unchangedCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      added: value.added,
      changed: value.changed,
      deleted: value.deleted,
      renamed: value.renamed,
      unchangedCount: value.unchangedCount,
    };
    if (sha256Canonical(unsigned) !== value.changeSetSha256) {
      context.addIssue({ code: "custom", message: "repository change-set hash mismatch" });
    }
    for (const paths of [value.added, value.changed, value.deleted]) {
      if ([...paths].sort().some((path, index) => path !== paths[index]) || new Set(paths).size !== paths.length) {
        context.addIssue({ code: "custom", message: "repository change paths must be sorted and unique" });
      }
    }
  });

export type RepositoryChangeSet = Readonly<z.infer<typeof repositoryChangeSetSchema>>;

export interface RepositoryIncrementalPlan {
  readonly changeSet: RepositoryChangeSet;
  readonly dependencyInvalidated: readonly string[];
  readonly directChanged: readonly string[];
  readonly reason: string;
  readonly reparsedUnits: readonly string[];
  readonly reusedUnits: readonly string[];
  readonly updateMode: "incremental" | "full_rebuild_required" | "reused";
  readonly updatePlanSha256: string;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort(ordinal));
}

export function createRepositoryChangeSet(
  oldSnapshot: RepositorySourceSnapshotResult,
  newSnapshot: RepositorySourceSnapshotResult,
  renameFacts: readonly { readonly from: string; readonly to: string }[] = [],
): RepositoryChangeSet {
  const oldByPath = new Map(oldSnapshot.snapshot.entries.map((entry) => [entry.relativePath, entry]));
  const newByPath = new Map(newSnapshot.snapshot.entries.map((entry) => [entry.relativePath, entry]));
  const added = new Set([...newByPath.keys()].filter((path) => !oldByPath.has(path)));
  const deleted = new Set([...oldByPath.keys()].filter((path) => !newByPath.has(path)));
  const renamed: { from: string; to: string }[] = [];
  if (oldSnapshot.snapshot.sourceKind === "git_worktree" && newSnapshot.snapshot.sourceKind === "git_worktree") {
    for (const fact of renameFacts) {
      const oldEntry = oldByPath.get(fact.from);
      const newEntry = newByPath.get(fact.to);
      if (
        added.has(fact.to) &&
        deleted.has(fact.from) &&
        oldEntry !== undefined &&
        newEntry !== undefined &&
        oldEntry.contentSha256 === newEntry.contentSha256
      ) {
        renamed.push({ from: fact.from, to: fact.to });
        added.delete(fact.to);
        deleted.delete(fact.from);
      }
    }
  }
  const changed = [...oldByPath.keys()].filter((path) => {
    const next = newByPath.get(path);
    return next !== undefined && oldByPath.get(path)!.contentSha256 !== next.contentSha256;
  });
  const unchangedCount = [...oldByPath.keys()].filter((path) => {
    const next = newByPath.get(path);
    return next !== undefined && oldByPath.get(path)!.contentSha256 === next.contentSha256;
  }).length;
  const unsigned = {
    added: sorted(added),
    changed: sorted(changed),
    deleted: sorted(deleted),
    renamed: Object.freeze(renamed.sort((left, right) => ordinal(`${left.from}:${left.to}`, `${right.from}:${right.to}`))),
    unchangedCount,
  };
  return repositoryChangeSetSchema.parse({ ...unsigned, changeSetSha256: sha256Canonical(unsigned) });
}

function isTypeScriptFamily(path: string): boolean {
  return [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(path).toLowerCase());
}

function moduleBounded(snapshot: RepositorySourceSnapshotResult, path: string): boolean | null {
  const bytes = snapshot.sourceBytes.get(path);
  if (bytes === undefined) return null;
  const source = Buffer.from(bytes).toString("utf8");
  return /\b(?:export|import)\b/u.test(source) &&
    !/\bdeclare\s+global\b|\brequire\s*\(|\bimport\s*\(|\/\/\/\s*<reference\b/u.test(source);
}

function containsUntrackedDependencySyntax(snapshot: RepositorySourceSnapshotResult): boolean {
  return snapshot.snapshot.entries.some((entry) => {
    if (!isTypeScriptFamily(entry.relativePath)) return false;
    const bytes = snapshot.sourceBytes.get(entry.relativePath);
    if (bytes === undefined) return false;
    return /\brequire\s*\(|\bimport\s*\(|\bdeclare\s+global\b|\/\/\/\s*<reference\b/u
      .test(Buffer.from(bytes).toString("utf8"));
  });
}

export function planRepositoryIncrementalUpdate(input: {
  readonly newSnapshot: RepositorySourceSnapshotResult;
  readonly oldRecords: RepositoryIndexRecords;
  readonly oldSnapshot: RepositorySourceSnapshotResult;
  readonly renameFacts?: readonly { readonly from: string; readonly to: string }[];
}): RepositoryIncrementalPlan {
  const changeSet = createRepositoryChangeSet(input.oldSnapshot, input.newSnapshot, input.renameFacts);
  const directChanged = sorted([
    ...changeSet.added,
    ...changeSet.changed,
    ...changeSet.deleted,
    ...changeSet.renamed.flatMap((entry) => [entry.from, entry.to]),
  ]);
  if (directChanged.length === 0) {
    const unsigned = {
      changeSet,
      dependencyInvalidated: [] as readonly string[],
      directChanged,
      reason: "source_snapshot_unchanged",
      reparsedUnits: [] as readonly string[],
      reusedUnits: sorted(input.newSnapshot.snapshot.entries.map((entry) => entry.relativePath)),
      updateMode: "reused" as const,
    };
    return Object.freeze({ ...unsigned, updatePlanSha256: sha256Canonical(unsigned) });
  }

  const hasTypeScriptChange = directChanged.some(isTypeScriptFamily);
  const unsafeGlobalChange = directChanged.some((path) => {
    if (!isTypeScriptFamily(path)) return false;
    const oldBounded = moduleBounded(input.oldSnapshot, path);
    const newBounded = moduleBounded(input.newSnapshot, path);
    return oldBounded === false || newBounded === false;
  }) || hasTypeScriptChange && (
    containsUntrackedDependencySyntax(input.oldSnapshot) || containsUntrackedDependencySyntax(input.newSnapshot)
  );
  if (unsafeGlobalChange) {
    const all = sorted(input.newSnapshot.snapshot.entries.filter((entry) => isTypeScriptFamily(entry.relativePath)).map((entry) => entry.relativePath));
    const unsigned = {
      changeSet,
      dependencyInvalidated: sorted(all.filter((path) => !directChanged.includes(path))),
      directChanged,
      reason: "global_script_dependency_scope_unknown",
      reparsedUnits: all,
      reusedUnits: sorted(input.newSnapshot.snapshot.entries.map((entry) => entry.relativePath).filter((path) => !all.includes(path))),
      updateMode: "full_rebuild_required" as const,
    };
    return Object.freeze({ ...unsigned, updatePlanSha256: sha256Canonical(unsigned) });
  }

  const reverse = new Map<string, Set<string>>();
  for (const record of input.oldRecords.imports) {
    if (record.resolvedPath === null) continue;
    const importers = reverse.get(record.resolvedPath) ?? new Set<string>();
    importers.add(record.sourcePath);
    reverse.set(record.resolvedPath, importers);
  }
  const invalidated = new Set<string>();
  if (changeSet.added.some(isTypeScriptFamily) || changeSet.renamed.some((entry) => isTypeScriptFamily(entry.to))) {
    // A previously unresolved relative import may become resolvable after an add/rename. Its
    // exact target is not present in the old dependency graph, so conservatively rebind that
    // importer and its reverse dependents.
    for (const record of input.oldRecords.imports) {
      if (record.resolvedPath === null && (record.specifier.startsWith("./") || record.specifier.startsWith("../"))) {
        invalidated.add(record.sourcePath);
      }
    }
  }
  const queue = [...directChanged, ...invalidated];
  while (queue.length > 0) {
    const changed = queue.shift()!;
    for (const importer of reverse.get(changed) ?? []) {
      if (directChanged.includes(importer) || invalidated.has(importer)) continue;
      invalidated.add(importer);
      queue.push(importer);
    }
  }
  const currentPaths = new Set(input.newSnapshot.snapshot.entries.map((entry) => entry.relativePath));
  const reparsedUnits = sorted([...directChanged, ...invalidated].filter((path) => currentPaths.has(path)));
  const reusedUnits = sorted([...currentPaths].filter((path) => !reparsedUnits.includes(path)));
  const unsigned = {
    changeSet,
    dependencyInvalidated: sorted(invalidated),
    directChanged,
    reason: "direct_and_dependency_invalidation",
    reparsedUnits,
    reusedUnits,
    updateMode: "incremental" as const,
  };
  return Object.freeze({ ...unsigned, updatePlanSha256: sha256Canonical(unsigned) });
}
