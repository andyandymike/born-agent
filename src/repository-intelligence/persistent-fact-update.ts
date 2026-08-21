import { extname } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { RepositoryIndexEngine } from "./engines/typescript-language-service-adapter.js";
import { buildIndexGeneration, canonicalizeIndexRecords } from "./index-generation.js";
import {
  repositoryChangeSetSchema,
  type RepositoryChangeSet,
  type RepositoryIncrementalPlan,
} from "./incremental-update-planner.js";
import type { RepositoryIndexRecords } from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { RepositorySourceSnapshotResult } from "./source-snapshot.js";

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort(ordinal));
}

function isTypeScriptFamily(path: string): boolean {
  return [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(path).toLowerCase());
}

function newSourceIsUnsafe(snapshot: RepositorySourceSnapshotResult, path: string): boolean {
  if (!isTypeScriptFamily(path)) return false;
  const bytes = snapshot.sourceBytes.get(path);
  if (bytes === undefined) return true;
  const source = Buffer.from(bytes).toString("utf8");
  return !/\b(?:export|import)\b/u.test(source) ||
    /\bdeclare\s+global\b|\brequire\s*\(|\bimport\s*\(|\/\/\/\s*<reference\b/u.test(source);
}

function oldUnitIsUnsafe(records: RepositoryIndexRecords, path: string): boolean {
  if (!isTypeScriptFamily(path)) return false;
  const hasModuleSurface = records.symbols.some((entry) => entry.relativePath === path && entry.exported) ||
    records.imports.some((entry) => entry.sourcePath === path);
  return !hasModuleSurface || records.imports.some((entry) =>
    entry.sourcePath === path && entry.resolvedPath === null && (entry.specifier.startsWith("./") || entry.specifier.startsWith("../"))
  );
}

function changeSet(previous: RepositoryIndexRecords, next: RepositorySourceSnapshotResult): RepositoryChangeSet {
  const oldByPath = new Map(previous.units.map((unit) => [unit.relativePath, unit.sourceSha256]));
  const newByPath = new Map(next.snapshot.entries.map((entry) => [entry.relativePath, entry.contentSha256]));
  const unsigned = {
    added: sorted([...newByPath.keys()].filter((path) => !oldByPath.has(path))),
    changed: sorted([...oldByPath].filter(([path, sha256]) => newByPath.has(path) && newByPath.get(path) !== sha256).map(([path]) => path)),
    deleted: sorted([...oldByPath.keys()].filter((path) => !newByPath.has(path))),
    renamed: Object.freeze([]),
    unchangedCount: [...oldByPath].filter(([path, sha256]) => newByPath.get(path) === sha256).length,
  };
  return repositoryChangeSetSchema.parse({ ...unsigned, changeSetSha256: sha256Canonical(unsigned) });
}

function createPlan(input: Omit<RepositoryIncrementalPlan, "updatePlanSha256">): RepositoryIncrementalPlan {
  return Object.freeze({ ...input, updatePlanSha256: sha256Canonical(input) });
}

export function planPersistentFactUpdate(
  previous: RepositoryIndexRecords,
  next: RepositorySourceSnapshotResult,
): RepositoryIncrementalPlan {
  const changes = changeSet(previous, next);
  const directChanged = sorted([...changes.added, ...changes.changed, ...changes.deleted]);
  if (directChanged.length === 0) {
    return createPlan({
      changeSet: changes,
      dependencyInvalidated: [],
      directChanged,
      reason: "persistent_fact_authority_unchanged",
      reparsedUnits: [],
      reusedUnits: sorted(next.snapshot.entries.map((entry) => entry.relativePath)),
      updateMode: "reused",
    });
  }

  const unsafe = directChanged.some((path) => newSourceIsUnsafe(next, path) || oldUnitIsUnsafe(previous, path)) ||
    changes.added.some(isTypeScriptFamily) && previous.imports.some((entry) =>
      entry.resolvedPath === null && (entry.specifier.startsWith("./") || entry.specifier.startsWith("../"))
    );
  if (unsafe) {
    const allTypeScript = sorted(next.snapshot.entries.map((entry) => entry.relativePath).filter(isTypeScriptFamily));
    return createPlan({
      changeSet: changes,
      dependencyInvalidated: sorted(allTypeScript.filter((path) => !directChanged.includes(path))),
      directChanged,
      reason: "persistent_fact_dependency_scope_unknown",
      reparsedUnits: allTypeScript,
      reusedUnits: sorted(next.snapshot.entries.map((entry) => entry.relativePath).filter((path) => !allTypeScript.includes(path))),
      updateMode: "full_rebuild_required",
    });
  }

  const reverse = new Map<string, Set<string>>();
  for (const record of previous.imports) {
    if (record.resolvedPath === null) continue;
    const importers = reverse.get(record.resolvedPath) ?? new Set<string>();
    importers.add(record.sourcePath);
    reverse.set(record.resolvedPath, importers);
  }
  const invalidated = new Set<string>();
  const queue = [...directChanged];
  while (queue.length > 0) {
    const changed = queue.shift()!;
    for (const importer of reverse.get(changed) ?? []) {
      if (directChanged.includes(importer) || invalidated.has(importer)) continue;
      invalidated.add(importer);
      queue.push(importer);
    }
  }
  const currentPaths = new Set(next.snapshot.entries.map((entry) => entry.relativePath));
  const reparsedUnits = sorted([...directChanged, ...invalidated].filter((path) => currentPaths.has(path)));
  return createPlan({
    changeSet: changes,
    dependencyInvalidated: sorted(invalidated),
    directChanged,
    reason: "persistent_fact_exact_dependency_closure",
    reparsedUnits,
    reusedUnits: sorted([...currentPaths].filter((path) => !reparsedUnits.includes(path))),
    updateMode: "incremental",
  });
}

function mergeRecords(
  previous: RepositoryIndexRecords,
  clean: RepositoryIndexRecords,
  plan: RepositoryIncrementalPlan,
): RepositoryIndexRecords {
  const reused = new Set(plan.reusedUnits);
  const oldUnits = new Map(previous.units.map((entry) => [entry.relativePath, entry]));
  const cleanUnits = new Map(clean.units.map((entry) => [entry.relativePath, entry]));
  const unit = (path: string) => reused.has(path) && oldUnits.has(path) ? oldUnits.get(path)! : cleanUnits.get(path)!;
  const paths = sorted(clean.units.map((entry) => entry.relativePath));
  const select = <T>(oldValues: readonly T[], cleanValues: readonly T[], path: (value: T) => string): readonly T[] => paths.flatMap((relativePath) =>
    (reused.has(relativePath) ? oldValues : cleanValues).filter((entry) => path(entry) === relativePath)
  );
  return canonicalizeIndexRecords({
    imports: select(previous.imports, clean.imports, (entry) => entry.sourcePath),
    references: select(previous.references, clean.references, (entry) => entry.sourcePath),
    symbols: select(previous.symbols, clean.symbols, (entry) => entry.relativePath),
    units: paths.map(unit),
  });
}

export async function buildWithPersistentFacts(input: {
  readonly engine: RepositoryIndexEngine;
  readonly previousRecords: RepositoryIndexRecords;
  readonly ruleManifestSha256: string;
  readonly signal: AbortSignal;
  readonly snapshot: RepositorySourceSnapshotResult;
  readonly workspace: string;
}): Promise<{
  readonly buildMode: "cold" | "incremental" | "reused";
  readonly generation: ReturnType<typeof buildIndexGeneration>["generation"];
  readonly incrementalPlan: RepositoryIncrementalPlan;
  readonly records: RepositoryIndexRecords;
}> {
  if (input.signal.aborted) throw new RepositoryIntelligenceError("repository_navigation_cancelled", "persistent fact build was cancelled", 130);
  const plan = planPersistentFactUpdate(input.previousRecords, input.snapshot);
  if (plan.updateMode === "reused") {
    const reused = buildIndexGeneration({
      engineIdentitySha256: input.engine.identity.identitySha256,
      records: input.previousRecords,
      ruleManifestSha256: input.ruleManifestSha256,
      sourceCoverage: input.snapshot.snapshot.coverage,
      sourceStateSha256: input.snapshot.snapshot.sourceStateSha256,
    });
    return Object.freeze({ buildMode: "reused", generation: reused.generation, incrementalPlan: plan, records: reused.records });
  }

  const cleanRecords = await input.engine.build(input.workspace, input.snapshot, input.signal);
  const clean = buildIndexGeneration({
    engineIdentitySha256: input.engine.identity.identitySha256,
    records: cleanRecords,
    ruleManifestSha256: input.ruleManifestSha256,
    sourceCoverage: input.snapshot.snapshot.coverage,
    sourceStateSha256: input.snapshot.snapshot.sourceStateSha256,
  });
  if (plan.updateMode === "full_rebuild_required") {
    return Object.freeze({ buildMode: "cold", generation: clean.generation, incrementalPlan: plan, records: clean.records });
  }

  const mergedRecords = mergeRecords(input.previousRecords, clean.records, plan);
  const merged = buildIndexGeneration({
    engineIdentitySha256: input.engine.identity.identitySha256,
    records: mergedRecords,
    ruleManifestSha256: input.ruleManifestSha256,
    sourceCoverage: input.snapshot.snapshot.coverage,
    sourceStateSha256: input.snapshot.snapshot.sourceStateSha256,
  });
  if (merged.generation.generationSha256 !== clean.generation.generationSha256) {
    const fallback = createPlan({
      changeSet: plan.changeSet,
      dependencyInvalidated: plan.dependencyInvalidated,
      directChanged: plan.directChanged,
      reason: "persistent_fact_clean_oracle_mismatch_fallback",
      reparsedUnits: sorted(input.snapshot.snapshot.entries.map((entry) => entry.relativePath)),
      reusedUnits: [],
      updateMode: "full_rebuild_required",
    });
    return Object.freeze({ buildMode: "cold", generation: clean.generation, incrementalPlan: fallback, records: clean.records });
  }
  return Object.freeze({ buildMode: "incremental", generation: merged.generation, incrementalPlan: plan, records: merged.records });
}
