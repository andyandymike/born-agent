import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NestedAgentsLoader } from "../repository-rules/nested-agents-loader.js";
import { RepositoryRuleChangeDetector } from "../repository-rules/repository-rule-change-detector.js";
import type { NestedRepositoryRuleSet } from "../repository-rules/repository-rule-manifest.js";
import { RepositoryRuleScopeResolver } from "../repository-rules/repository-rule-scope.js";
import type { RepositoryRulesArtifactPort } from "../repository-rules/root-agents-loader.js";
import { loadAcceptedRepositoryEngineDecision, type AcceptedRepositoryEngineDecision } from "./engine-decision-loader.js";
import { TypeScriptLanguageServiceAdapter } from "./engines/typescript-language-service-adapter.js";
import { RepositorySourceFreshnessGuard } from "./freshness-guard.js";
import { RepositoryIndexBuilder } from "./index-builder.js";
import { RepositoryIndexLock } from "./index-lock.js";
import { RepositoryIndexStore, type StoredRepositoryIndex } from "./index-store.js";
import {
  RepositoryIndexV2Store,
  type RepositoryCacheRuntimeCountersV2,
  type RepositoryIndexV2ReadLease,
} from "./index-v2-store.js";
import type { RepositoryIncrementalPlan } from "./incremental-update-planner.js";
import { buildWithPersistentFacts } from "./persistent-fact-update.js";
import {
  decodeNavigationCursor,
  decodeSymbolId,
  encodeNavigationCursor,
  navigationQuerySha256,
  symbolId,
  type NavigationToolName,
} from "./navigation-cursor.js";
import {
  findReferencesQuerySchema,
  findSymbolQuerySchema,
  repositoryOutlineQuerySchema,
  type OutlineQuery,
  type ReferenceQuery,
  type SymbolQuery,
} from "./navigation-query-schema.js";
import {
  findReferencesResultSchema,
  findSymbolResultSchema,
  repositoryOutlineResultSchema,
  type OutlineResult,
  type ReferenceResult,
  type SymbolResult,
} from "./navigation-result-schema.js";
import { RepositoryNavigationSnippetReader } from "./navigation-snippet-reader.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { RepositoryIndexInvalidatedEventData, RepositoryIndexSelectedEventData } from "./repository-intelligence-event-schema.js";
import type { RepositorySourceSnapshotResult } from "./source-snapshot.js";
import { RepositorySourceSnapshotter } from "./source-snapshotter.js";
import { buildRepositoryStatusProjection, type RepositoryStatusProjection } from "./repository-status-projection.js";
import { loadOrCreateNavigationIntegrityKey, type NavigationIntegrityKey } from "./navigation-integrity-key.js";
import { loadOrMigrateNavigationIntegrityKeyV2 } from "./navigation-integrity-key-v2.js";
import {
  repositoryCachePersistentFactsEnabled,
  repositoryCacheStorageVersion,
  type RepositoryCacheStorageVersion,
} from "./repository-cache-version.js";

export type RepositoryIntelligenceStatus = RepositoryStatusProjection;

export interface StoredRepositoryIndexLike {
  readonly generation: StoredRepositoryIndex["generation"];
  readonly manifestSha256: string;
  readonly records: StoredRepositoryIndex["records"];
}

export interface CurrentGeneration {
  readonly buildMode: "cold" | "incremental" | "reused";
  readonly freshness: RepositorySourceFreshnessGuard;
  readonly incrementalPlan: RepositoryIncrementalPlan | null;
  readonly rules: NestedRepositoryRuleSet;
  readonly rulesDetector: RepositoryRuleChangeDetector;
  readonly rulesResolver: RepositoryRuleScopeResolver;
  readonly snapshot: RepositorySourceSnapshotResult;
  readonly stored: StoredRepositoryIndexLike;
}

export interface RepositoryNavigationService {
  status(): Promise<RepositoryIntelligenceStatus>;
  ensureCurrent(options: { readonly allowBuild: boolean; readonly signal: AbortSignal }): Promise<CurrentGeneration>;
  outline(query: OutlineQuery, signal: AbortSignal): Promise<OutlineResult>;
  findSymbols(query: SymbolQuery, signal: AbortSignal): Promise<SymbolResult>;
  findReferences(query: ReferenceQuery, signal: AbortSignal): Promise<ReferenceResult>;
}

export interface RepositoryNavigationEventSink {
  readonly indexInvalidated: (data: RepositoryIndexInvalidatedEventData) => Promise<void>;
  readonly indexSelected: (data: RepositoryIndexSelectedEventData) => Promise<void>;
}

type RepositoryStoreSelection =
  | { readonly store: RepositoryIndexStore; readonly version: "v1" }
  | { readonly store: RepositoryIndexV2Store; readonly version: "v2" };

interface RepositoryV2QueryContext {
  readonly freshness: RepositorySourceFreshnessGuard;
  readonly lease: RepositoryIndexV2ReadLease;
  readonly rules: NestedRepositoryRuleSet;
  readonly rulesDetector: RepositoryRuleChangeDetector;
  readonly rulesResolver: RepositoryRuleScopeResolver;
  readonly snapshot: RepositorySourceSnapshotResult;
}

function packageRootFromModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function artifactPort(): RepositoryRulesArtifactPort {
  return {
    storeRepositoryRules: async (input) => {
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      if (sha256 !== input.expectedSha256) throw new Error("repository rule content hash mismatch");
      return Object.freeze({
        artifactId: `sha256:${sha256}` as const,
        bytes: input.bytes.byteLength,
        relativeRef: `repository-rules/${sha256}`,
        sha256,
      });
    },
  };
}

function queryWithoutCursor<T extends { readonly cursor?: string | undefined }>(query: T): Omit<T, "cursor"> {
  const result: { -readonly [K in keyof T]: T[K] } = { ...query };
  delete result.cursor;
  return result;
}

function pageOffset(
  cursor: string | undefined,
  tool: NavigationToolName,
  generationSha256: string,
  canonicalQuerySha256: string,
  key: NavigationIntegrityKey,
): number {
  return cursor === undefined
    ? 0
    : decodeNavigationCursor(cursor, { canonicalQuerySha256, generationSha256, tool }, key).offset;
}

function nextCursor(
  tool: NavigationToolName,
  generationSha256: string,
  canonicalQuerySha256: string,
  nextOffset: number,
  total: number,
  key: NavigationIntegrityKey,
): string | null {
  return nextOffset < total
    ? encodeNavigationCursor({ canonicalQuerySha256, generationSha256, offset: nextOffset, schemaVersion: 1, tool }, key)
    : null;
}

function fuzzyScore(name: string, query: string): number | null {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName.includes(lowerQuery)) return lowerName.indexOf(lowerQuery);
  let cursor = 0;
  let gap = 0;
  for (const character of lowerQuery) {
    const found = lowerName.indexOf(character, cursor);
    if (found < 0) return null;
    gap += found - cursor;
    cursor = found + 1;
  }
  return 1000 + gap;
}

function symbolRank(name: string, qualifiedName: string, query: string): readonly [number, number] | null {
  if (qualifiedName === query) return [1, 0];
  if (name === query) return [2, 0];
  if (name.startsWith(query) || qualifiedName.startsWith(query)) return [3, 0];
  const fuzzy = fuzzyScore(name, query);
  return fuzzy === null ? null : [4, fuzzy];
}

function engineEnvelope(current: CurrentGeneration) {
  const status = buildRepositoryStatusProjection({
    buildPhase: null,
    coverage: current.stored.generation.coverage,
    engineId: "typescript-language-service",
    engineIdentitySha256: current.stored.generation.engineIdentitySha256,
    generationSha256: current.stored.generation.generationSha256,
    indexState: "ready",
    reason: null,
    ruleManifestSha256: current.stored.generation.ruleManifestSha256,
    schemaVersion: 1,
    sourceStateSha256: current.stored.generation.sourceStateSha256,
    watchState: "not_started",
  });
  return {
    coverage: current.stored.generation.coverage,
    engine: { id: "typescript-language-service", identitySha256: current.stored.generation.engineIdentitySha256 },
    freshness: "current" as const,
    generationSha256: current.stored.generation.generationSha256,
    repositoryStatusSha256: status.statusSha256,
    ruleManifestSha256: current.stored.generation.ruleManifestSha256,
    schemaVersion: 1 as const,
    sourceStateSha256: current.stored.generation.sourceStateSha256,
  };
}

export class DefaultRepositoryNavigationService implements RepositoryNavigationService {
  private constructor(
    private readonly workspace: string,
    private readonly decision: AcceptedRepositoryEngineDecision,
    private readonly snapshotter: RepositorySourceSnapshotter,
    private readonly storage: RepositoryStoreSelection,
    private readonly engine: TypeScriptLanguageServiceAdapter,
    private readonly navigationIntegrityKey: NavigationIntegrityKey,
    private readonly secrets: readonly string[],
    private readonly events: RepositoryNavigationEventSink | undefined,
    private readonly foregroundGcEnabled: boolean,
    private readonly persistentFactsEnabled: boolean,
  ) {}

  private readonly emittedGenerations = new Set<string>();

  /** Package-internal deterministic benchmark instrumentation; never enters a product schema or durable event. */
  resetRepositoryCacheRuntimeCounters(): void {
    if (this.storage.version === "v2") this.storage.store.resetCounters();
  }

  /** Package-internal deterministic benchmark instrumentation; null means the selected v1 store has no I/O port counters. */
  repositoryCacheRuntimeCounters(): RepositoryCacheRuntimeCountersV2 | null {
    return this.storage.version === "v2" ? this.storage.store.snapshotCounters() : null;
  }

  static async create(
    workspace: string,
    options: {
      readonly cacheStorageVersion?: RepositoryCacheStorageVersion;
      readonly events?: RepositoryNavigationEventSink;
      readonly packageRoot?: string;
      readonly persistentFactsEnabled?: boolean;
      readonly secrets?: readonly string[];
    } = {},
  ): Promise<DefaultRepositoryNavigationService> {
    const packageRoot = options.packageRoot ?? packageRootFromModule();
    const cacheStorageVersion = options.cacheStorageVersion ?? repositoryCacheStorageVersion;
    const [decision, snapshotter, store] = await Promise.all([
      loadAcceptedRepositoryEngineDecision(packageRoot),
      RepositorySourceSnapshotter.create(workspace),
      cacheStorageVersion === "v1" ? RepositoryIndexStore.create(workspace) : RepositoryIndexV2Store.create(workspace),
    ]);
    const engine = new TypeScriptLanguageServiceAdapter();
    if (engine.identity.identitySha256 !== decision.identity.identitySha256) {
      throw new RepositoryIntelligenceError("repository_engine_asset_invalid", "production engine identity differs from accepted decision", 3);
    }
    const storage = cacheStorageVersion === "v1"
      ? Object.freeze({ store: store as RepositoryIndexStore, version: "v1" as const })
      : Object.freeze({ store: store as RepositoryIndexV2Store, version: "v2" as const });
    const navigationIntegrityKey = storage.version === "v1"
      ? await loadOrCreateNavigationIntegrityKey(storage.store.paths)
      : await loadOrMigrateNavigationIntegrityKeyV2(storage.store.paths);
    return new DefaultRepositoryNavigationService(
      workspace,
      decision,
      snapshotter,
      storage,
      engine,
      navigationIntegrityKey,
      options.secrets ?? [],
      options.events,
      options.cacheStorageVersion === undefined && storage.version === "v2",
      options.persistentFactsEnabled ?? (options.cacheStorageVersion === undefined
        ? repositoryCachePersistentFactsEnabled
        : storage.version === "v2"),
    );
  }

  static async inspect(
    workspace: string,
    options: { readonly cacheStorageVersion?: RepositoryCacheStorageVersion; readonly packageRoot?: string } = {},
  ): Promise<RepositoryIntelligenceStatus> {
    const packageRoot = options.packageRoot ?? packageRootFromModule();
    const cacheStorageVersion = options.cacheStorageVersion ?? repositoryCacheStorageVersion;
    const [decision, snapshotter, store] = await Promise.all([
      loadAcceptedRepositoryEngineDecision(packageRoot),
      RepositorySourceSnapshotter.create(workspace),
      cacheStorageVersion === "v1" ? RepositoryIndexStore.openExisting(workspace) : RepositoryIndexV2Store.openExisting(workspace),
    ]);
    const snapshot = await snapshotter.snapshot();
    const loader = await NestedAgentsLoader.create(workspace, { artifactStore: artifactPort() });
    const rules = await loader.loadForRun(snapshot.snapshot.sourceStateSha256);
    const detector = new RepositoryRuleChangeDetector(loader, rules);
    let current: StoredRepositoryIndex | null = null;
    let corrupt = false;
    if (store !== null) {
      try {
        current = await store.readCurrent();
      } catch {
        corrupt = true;
      }
    }
    const rulesStale = (await detector.detect()).changed;
    const exact = current !== null && current.generation.engineIdentitySha256 === decision.identity.identitySha256 && current.generation.sourceStateSha256 === snapshot.snapshot.sourceStateSha256 && current.generation.ruleManifestSha256 === rules.manifest.manifestSha256 && !rulesStale;
    return buildRepositoryStatusProjection({
      buildPhase: null,
      coverage: current?.generation.coverage ?? null,
      generationSha256: current?.generation.generationSha256 ?? null,
      engineIdentitySha256: decision.identity.identitySha256,
      engineId: "typescript-language-service",
      indexState: corrupt ? "blocked" : current === null ? "idle" : exact ? "ready" : "dirty",
      reason: corrupt ? "cache_corrupt" : current === null || exact ? null : rulesStale ? "rules_changed" : "source_or_engine_changed",
      ruleManifestSha256: rules.manifest.manifestSha256,
      schemaVersion: 1 as const,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
      watchState: "not_started",
    });
  }

  async status(): Promise<RepositoryIntelligenceStatus> {
    const { snapshot, rules, detector } = await this.captureEnvelope();
    let current: StoredRepositoryIndex | null = null;
    let corrupt = false;
    try {
      current = await this.readCurrentStored();
    } catch {
      corrupt = true;
    }
    const rulesStale = (await detector.detect()).changed;
    const exact = current !== null &&
      current.generation.engineIdentitySha256 === this.decision.identity.identitySha256 &&
      current.generation.sourceStateSha256 === snapshot.snapshot.sourceStateSha256 &&
      current.generation.ruleManifestSha256 === rules.manifest.manifestSha256 &&
      !rulesStale;
    return buildRepositoryStatusProjection({
      buildPhase: null,
      coverage: current?.generation.coverage ?? null,
      generationSha256: current?.generation.generationSha256 ?? null,
      engineIdentitySha256: this.decision.identity.identitySha256,
      engineId: "typescript-language-service",
      indexState: corrupt ? "blocked" : current === null ? "idle" : exact ? "ready" : "dirty",
      reason: corrupt ? "cache_corrupt" : current === null || exact ? null : rulesStale ? "rules_changed" : "source_or_engine_changed",
      ruleManifestSha256: rules.manifest.manifestSha256,
      schemaVersion: 1 as const,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
      watchState: "not_started",
    });
  }

  async ensureCurrent(options: { readonly allowBuild: boolean; readonly signal: AbortSignal }): Promise<CurrentGeneration> {
    const envelope = await this.captureEnvelope();
    const existing = await this.readCurrentStored().catch((error: unknown) => {
      if (options.allowBuild) return null;
      throw error;
    });
    if (this.matches(existing, envelope.snapshot, envelope.rules)) {
      const selected = await this.current(existing!, envelope, "reused");
      await this.emitSelected(selected);
      return selected;
    }
    if (!options.allowBuild) throw new RepositoryIntelligenceError("repository_index_stale", "repository index is absent or stale", 8);

    const invalidation = existing === null ? null : this.invalidation(existing, envelope.snapshot, envelope.rules);
    await this.reclaimV2BeforePublish(options.signal);
    const lock = await RepositoryIndexLock.acquire(this.storage.store.paths, { signal: options.signal });
    let selected: CurrentGeneration;
    try {
      await this.storage.store.recoverOwnedTemps();
      let winner: StoredRepositoryIndexLike | null;
      try {
        winner = await this.readCurrentStored();
      } catch {
        if (this.storage.version !== "v2") {
          winner = null;
        } else {
          await this.storage.store.quarantineCorruptCurrent(lock);
          winner = null;
        }
      }
      if (this.matches(winner, envelope.snapshot, envelope.rules)) {
        selected = await this.current(winner!, envelope, "reused");
      } else {
        const persistentWinner = this.persistentFactsEnabled && this.storage.version === "v2" &&
          winner !== null && winner.generation.engineIdentitySha256 === this.engine.identity.identitySha256
          ? winner
          : null;
        const built = persistentWinner !== null
          ? await buildWithPersistentFacts({
            engine: this.engine,
            previousRecords: persistentWinner.records,
            ruleManifestSha256: envelope.rules.manifest.manifestSha256,
            signal: options.signal,
            snapshot: envelope.snapshot,
            workspace: this.workspace,
          })
          : await new RepositoryIndexBuilder(this.workspace, this.engine, this.snapshotter).build(
            envelope.snapshot,
            envelope.rules.manifest.manifestSha256,
            options.signal,
            winner?.generation.engineIdentitySha256 === this.engine.identity.identitySha256
              ? winner.records
              : undefined,
          );
        if (persistentWinner !== null) {
          const verifiedSource = await this.snapshotter.snapshot(options.signal);
          if (verifiedSource.snapshot.sourceStateSha256 !== envelope.snapshot.snapshot.sourceStateSha256) {
            throw new RepositoryIntelligenceError("repository_index_stale", "repository source changed during persistent fact build", 8);
          }
        }
        await envelope.detector.assertFresh();
        const stored = this.storage.version === "v2"
          ? await this.storage.store.publish(built, lock, { includeFactReceipts: this.persistentFactsEnabled })
          : await this.storage.store.publish(built, lock);
        selected = await this.current(stored, envelope, built.buildMode, built.incrementalPlan);
      }
    } finally {
      await lock.release().catch(() => undefined);
    }
    await this.reclaimV2AfterPublish();
    // PHASE17: cache work and the index lock finish before durable session append. If append
    // fails, the verified cache may remain reusable, but no tool result reaches the model.
    if (
      invalidation !== null &&
      existing !== null &&
      selected.stored.generation.generationSha256 !== existing.generation.generationSha256
    ) await this.events?.indexInvalidated(invalidation);
    await this.emitSelected(selected);
    return selected;
  }

  async rebuild(signal: AbortSignal): Promise<CurrentGeneration> {
    const envelope = await this.captureEnvelope();
    await this.reclaimV2BeforePublish(signal);
    const lock = await RepositoryIndexLock.acquire(this.storage.store.paths, { signal });
    let selected: CurrentGeneration;
    try {
      await this.storage.store.recoverOwnedTemps();
      if (this.storage.version === "v2") await this.storage.store.quarantineCorruptCurrent(lock);
      const built = await new RepositoryIndexBuilder(this.workspace, this.engine, this.snapshotter).build(
        envelope.snapshot,
        envelope.rules.manifest.manifestSha256,
        signal,
      );
      await envelope.detector.assertFresh();
      const stored = this.storage.version === "v2"
        ? await this.storage.store.publish(built, lock, { includeFactReceipts: this.persistentFactsEnabled })
        : await this.storage.store.publish(built, lock);
      selected = await this.current(stored, envelope, "cold", null);
    } finally {
      await lock.release().catch(() => undefined);
    }
    await this.reclaimV2AfterPublish();
    await this.emitSelected(selected);
    return selected;
  }

  async outline(queryInput: OutlineQuery, signal: AbortSignal): Promise<OutlineResult> {
    const query = repositoryOutlineQuerySchema.parse(queryInput);
    if (this.storage.version === "v2") return this.outlineV2(query, signal);
    const current = await this.ensureCurrent({ allowBuild: true, signal });
    const tool = "repository_outline" as const;
    const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
    const offset = pageOffset(query.cursor, tool, current.stored.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
    const prefix = query.path === undefined ? "" : `${query.path}/`;
    const entries = new Map<string, { indexStatus: "indexed" | "metadata_only" | "unsupported" | "failed"; kind: "directory" | "file"; language: string | null; relativePath: string }>();
    for (const unit of current.stored.records.units) {
      if (prefix !== "" && !unit.relativePath.startsWith(prefix)) continue;
      const remainder = prefix === "" ? unit.relativePath : unit.relativePath.slice(prefix.length);
      const parts = remainder.split("/");
      if (parts.length - 1 > query.max_depth) continue;
      for (let index = 1; index < parts.length; index += 1) {
        if (index > query.max_depth) break;
        const relativePath = `${prefix}${parts.slice(0, index).join("/")}`.replace(/\/$/u, "");
        entries.set(relativePath, { indexStatus: "metadata_only", kind: "directory", language: null, relativePath });
      }
      entries.set(unit.relativePath, { indexStatus: unit.parseStatus, kind: "file", language: unit.language, relativePath: unit.relativePath });
    }
    const all = [...entries.values()].sort((left, right) => left.kind === right.kind ? ordinal(left.relativePath, right.relativePath) : left.kind === "directory" ? -1 : 1).map((entry) => ({
      ...entry,
      topLevelSymbols: entry.kind === "directory" ? [] : current.stored.records.symbols
        .filter((symbol) => symbol.relativePath === entry.relativePath && !symbol.qualifiedName.includes("."))
        .slice(0, 8)
        .map((symbol) => ({ kind: symbol.kind, name: symbol.name, startLine: symbol.range.startLine, symbolId: symbolId(current.stored.generation.generationSha256, symbol.recordId) })),
    }));
    if (offset > all.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
    const result = all.slice(offset, offset + query.limit);
    const cursor = nextCursor(tool, current.stored.generation.generationSha256, canonicalQuerySha256, offset + result.length, all.length, this.navigationIntegrityKey);
    await this.assertCurrent(current);
    return repositoryOutlineResultSchema.parse({
      ...engineEnvelope(current),
      confirmedAbsent: all.length === 0 && current.stored.generation.coverage === "complete",
      evidenceLevel: "syntactic",
      nextCursor: cursor,
      result,
      truncated: cursor !== null,
    });
  }

  async findSymbols(queryInput: SymbolQuery, signal: AbortSignal): Promise<SymbolResult> {
    const query = findSymbolQuerySchema.parse(queryInput);
    if (this.storage.version === "v2") return this.findSymbolsV2(query, signal);
    const current = await this.ensureCurrent({ allowBuild: true, signal });
    const tool = "find_symbol" as const;
    const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
    const offset = pageOffset(query.cursor, tool, current.stored.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
    const ranked = current.stored.records.symbols.flatMap((symbol) => {
      if (query.path_prefix !== undefined && symbol.relativePath !== query.path_prefix && !symbol.relativePath.startsWith(`${query.path_prefix}/`)) return [];
      if (query.kinds !== undefined && !query.kinds.includes(symbol.kind)) return [];
      const rank = symbolRank(symbol.name, symbol.qualifiedName, query.query);
      return rank === null ? [] : [{ rank, symbol }];
    }).sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || ordinal(`${left.symbol.qualifiedName}:${left.symbol.relativePath}:${left.symbol.range.startByte}:${left.symbol.recordId}`, `${right.symbol.qualifiedName}:${right.symbol.relativePath}:${right.symbol.range.startByte}:${right.symbol.recordId}`));
    if (offset > ranked.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
    const selected = ranked.slice(offset, offset + query.limit);
    const snippets = await RepositoryNavigationSnippetReader.create(this.workspace, this.secrets);
    const unitByPath = new Map(current.stored.records.units.map((unit) => [unit.relativePath, unit]));
    const result = await Promise.all(selected.map(async ({ symbol }) => {
      const unit = unitByPath.get(symbol.relativePath)!;
      return {
        applicableRuleScopeSha256: current.rulesResolver.resolve(symbol.relativePath).scopeSha256,
        evidenceLevel: symbol.evidenceLevel,
        exported: symbol.exported,
        kind: symbol.kind,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        range: symbol.range,
        relativePath: symbol.relativePath,
        snippet: await snippets.read({ byteLength: unit.bytes, path: symbol.relativePath, range: symbol.range, sourceSha256: symbol.sourceSha256 }, { maxBytes: 8192, maxLines: 12, signal }),
        sourceSha256: symbol.sourceSha256,
        symbolId: symbolId(current.stored.generation.generationSha256, symbol.recordId),
      };
    }));
    const cursor = nextCursor(tool, current.stored.generation.generationSha256, canonicalQuerySha256, offset + result.length, ranked.length, this.navigationIntegrityKey);
    await current.freshness.verifyResultSources({ locations: selected.map(({ symbol }) => ({ path: symbol.relativePath, range: symbol.range, sourceSha256: symbol.sourceSha256 })) }, signal);
    await this.assertCurrent(current);
    return findSymbolResultSchema.parse({
      ...engineEnvelope(current),
      confirmedAbsent: ranked.length === 0 && current.stored.generation.coverage === "complete",
      evidenceLevel: "semantic",
      nextCursor: cursor,
      result,
      truncated: cursor !== null,
    });
  }

  async findReferences(queryInput: ReferenceQuery, signal: AbortSignal): Promise<ReferenceResult> {
    const query = findReferencesQuerySchema.parse(queryInput);
    if (this.storage.version === "v2") return this.findReferencesV2(query, signal);
    const current = await this.ensureCurrent({ allowBuild: true, signal });
    const recordId = decodeSymbolId(query.symbol_id, current.stored.generation.generationSha256);
    if (!current.stored.records.symbols.some((symbol) => symbol.recordId === recordId)) {
      throw new RepositoryIntelligenceError("repository_symbol_stale", "repository symbol is absent from the current generation", 8);
    }
    const tool = "find_references" as const;
    const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
    const offset = pageOffset(query.cursor, tool, current.stored.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
    const all = current.stored.records.references
      .filter((reference) => reference.targetSymbolRecordId === recordId && (query.relations === undefined || query.relations.includes(reference.relation)))
      .sort((left, right) => ordinal(`${left.sourcePath}:${String(left.range.startByte).padStart(16, "0")}:${left.relation}`, `${right.sourcePath}:${String(right.range.startByte).padStart(16, "0")}:${right.relation}`));
    if (offset > all.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
    const selected = all.slice(offset, offset + query.limit);
    const snippets = await RepositoryNavigationSnippetReader.create(this.workspace, this.secrets);
    const unitByPath = new Map(current.stored.records.units.map((unit) => [unit.relativePath, unit]));
    const result = await Promise.all(selected.map(async (reference) => {
      const unit = unitByPath.get(reference.sourcePath)!;
      return {
        evidenceLevel: reference.evidenceLevel,
        range: reference.range,
        relation: reference.relation,
        relativePath: reference.sourcePath,
        snippet: await snippets.read({ byteLength: unit.bytes, path: reference.sourcePath, range: reference.range, sourceSha256: reference.sourceSha256 }, { maxBytes: 4096, maxLines: 5, signal }),
        sourceSha256: reference.sourceSha256,
      };
    }));
    const cursor = nextCursor(tool, current.stored.generation.generationSha256, canonicalQuerySha256, offset + result.length, all.length, this.navigationIntegrityKey);
    await current.freshness.verifyResultSources({ locations: selected.map((reference) => ({ path: reference.sourcePath, range: reference.range, sourceSha256: reference.sourceSha256 })) }, signal);
    await this.assertCurrent(current);
    return findReferencesResultSchema.parse({
      ...engineEnvelope(current),
      confirmedAbsent: all.length === 0 && current.stored.generation.coverage === "complete",
      evidenceLevel: "semantic",
      nextCursor: cursor,
      result,
      truncated: cursor !== null,
    });
  }

  private async outlineV2(query: OutlineQuery, signal: AbortSignal): Promise<OutlineResult> {
    const context = await this.acquireV2QueryContext(signal);
    try {
      const [units, outlineSymbols] = await Promise.all([
        context.lease.readUnits(),
        context.lease.readOutlineSymbols(),
      ]);
      const current = this.v2Current(context, { imports: [], references: [], symbols: [], units });
      const tool = "repository_outline" as const;
      const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
      const offset = pageOffset(query.cursor, tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
      const prefix = query.path === undefined ? "" : `${query.path}/`;
      const entries = new Map<string, { indexStatus: "indexed" | "metadata_only" | "unsupported" | "failed"; kind: "directory" | "file"; language: string | null; relativePath: string }>();
      for (const unit of units) {
        if (prefix !== "" && !unit.relativePath.startsWith(prefix)) continue;
        const remainder = prefix === "" ? unit.relativePath : unit.relativePath.slice(prefix.length);
        const parts = remainder.split("/");
        if (parts.length - 1 > query.max_depth) continue;
        for (let index = 1; index < parts.length; index += 1) {
          if (index > query.max_depth) break;
          const relativePath = `${prefix}${parts.slice(0, index).join("/")}`.replace(/\/$/u, "");
          entries.set(relativePath, { indexStatus: "metadata_only", kind: "directory", language: null, relativePath });
        }
        entries.set(unit.relativePath, { indexStatus: unit.parseStatus, kind: "file", language: unit.language, relativePath: unit.relativePath });
      }
      const symbolsByPath = new Map<string, typeof outlineSymbols>();
      for (const symbol of outlineSymbols) {
        const values = symbolsByPath.get(symbol.relativePath) ?? [];
        symbolsByPath.set(symbol.relativePath, Object.freeze([...values, symbol]));
      }
      const all = [...entries.values()]
        .sort((left, right) => left.kind === right.kind ? ordinal(left.relativePath, right.relativePath) : left.kind === "directory" ? -1 : 1)
        .map((entry) => ({
          ...entry,
          topLevelSymbols: entry.kind === "directory" ? [] : (symbolsByPath.get(entry.relativePath) ?? [])
            .slice(0, 8)
            .map((symbol) => ({
              kind: symbol.kind,
              name: symbol.name,
              startLine: symbol.startLine,
              symbolId: symbolId(context.lease.root.generation.generationSha256, symbol.recordId),
            })),
        }));
      if (offset > all.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
      const result = all.slice(offset, offset + query.limit);
      const cursor = nextCursor(tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, offset + result.length, all.length, this.navigationIntegrityKey);
      await this.assertV2Current(context);
      return repositoryOutlineResultSchema.parse({
        ...engineEnvelope(current),
        confirmedAbsent: all.length === 0 && context.lease.root.generation.coverage === "complete",
        evidenceLevel: "syntactic",
        nextCursor: cursor,
        result,
        truncated: cursor !== null,
      });
    } finally {
      await context.lease.release().catch(() => undefined);
    }
  }

  private async findSymbolsV2(query: SymbolQuery, signal: AbortSignal): Promise<SymbolResult> {
    const context = await this.acquireV2QueryContext(signal);
    try {
      const directory = await context.lease.readSymbolSearchDirectory();
      const tool = "find_symbol" as const;
      const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
      const offset = pageOffset(query.cursor, tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
      const ranked = directory.flatMap((symbol) => {
        if (query.path_prefix !== undefined && symbol.relativePath !== query.path_prefix && !symbol.relativePath.startsWith(`${query.path_prefix}/`)) return [];
        if (query.kinds !== undefined && !query.kinds.includes(symbol.kind)) return [];
        const rank = symbolRank(symbol.name, symbol.qualifiedName, query.query);
        return rank === null ? [] : [{ rank, symbol }];
      }).sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || ordinal(
        `${left.symbol.qualifiedName}:${left.symbol.relativePath}:${left.symbol.recordId}`,
        `${right.symbol.qualifiedName}:${right.symbol.relativePath}:${right.symbol.recordId}`,
      ));
      if (offset > ranked.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
      const selectedDirectory = ranked.slice(offset, offset + query.limit);
      const payloadSymbols = await context.lease.readSymbolPayloads(
        Object.freeze([...new Set(selectedDirectory.map(({ symbol }) => symbol.payloadPartitionKey))].sort(ordinal)),
      );
      const payloadById = new Map(payloadSymbols.map((symbol) => [symbol.recordId, symbol]));
      const selected = selectedDirectory.map(({ symbol }) => {
        const payload = payloadById.get(symbol.recordId);
        if (payload === undefined) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "symbol search directory points to a missing payload");
        return payload;
      });
      const unitByPath = new Map(context.snapshot.snapshot.entries.map((entry) => [entry.relativePath, {
        bytes: entry.byteLength,
        sourceSha256: entry.contentSha256,
      }]));
      const snippets = await RepositoryNavigationSnippetReader.create(this.workspace, this.secrets);
      const result = await Promise.all(selected.map(async (symbol) => {
        const unit = unitByPath.get(symbol.relativePath);
        if (unit === undefined || unit.sourceSha256 !== symbol.sourceSha256) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "symbol payload is not bound to its unit directory");
        return {
          applicableRuleScopeSha256: context.rulesResolver.resolve(symbol.relativePath).scopeSha256,
          evidenceLevel: symbol.evidenceLevel,
          exported: symbol.exported,
          kind: symbol.kind,
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          range: symbol.range,
          relativePath: symbol.relativePath,
          snippet: await snippets.read({ byteLength: unit.bytes, path: symbol.relativePath, range: symbol.range, sourceSha256: symbol.sourceSha256 }, { maxBytes: 8192, maxLines: 12, signal }),
          sourceSha256: symbol.sourceSha256,
          symbolId: symbolId(context.lease.root.generation.generationSha256, symbol.recordId),
        };
      }));
      const cursor = nextCursor(tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, offset + result.length, ranked.length, this.navigationIntegrityKey);
      await context.freshness.verifyResultSources({ locations: selected.map((symbol) => ({ path: symbol.relativePath, range: symbol.range, sourceSha256: symbol.sourceSha256 })) }, signal);
      await this.assertV2Current(context);
      const current = this.v2Current(context, { imports: [], references: [], symbols: selected, units: [] });
      return findSymbolResultSchema.parse({
        ...engineEnvelope(current),
        confirmedAbsent: ranked.length === 0 && context.lease.root.generation.coverage === "complete",
        evidenceLevel: "semantic",
        nextCursor: cursor,
        result,
        truncated: cursor !== null,
      });
    } finally {
      await context.lease.release().catch(() => undefined);
    }
  }

  private async findReferencesV2(query: ReferenceQuery, signal: AbortSignal): Promise<ReferenceResult> {
    const context = await this.acquireV2QueryContext(signal);
    try {
      const recordId = decodeSymbolId(query.symbol_id, context.lease.root.generation.generationSha256);
      const directory = await context.lease.readSymbolSearchDirectory();
      if (!directory.some((symbol) => symbol.recordId === recordId)) {
        throw new RepositoryIntelligenceError("repository_symbol_stale", "repository symbol is absent from the current generation", 8);
      }
      const tool = "find_references" as const;
      const canonicalQuerySha256 = navigationQuerySha256(queryWithoutCursor(query));
      const offset = pageOffset(query.cursor, tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, this.navigationIntegrityKey);
      const postings = await context.lease.readReferencePosting(recordId);
      const all = postings
        .filter((reference) => query.relations === undefined || query.relations.includes(reference.relation))
        .sort((left, right) => ordinal(`${left.sourcePath}:${String(left.range.startByte).padStart(16, "0")}:${left.relation}`, `${right.sourcePath}:${String(right.range.startByte).padStart(16, "0")}:${right.relation}`));
      if (offset > all.length) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor offset exceeds the result", 2);
      const selected = all.slice(offset, offset + query.limit);
      const snippets = await RepositoryNavigationSnippetReader.create(this.workspace, this.secrets);
      const unitByPath = new Map(context.snapshot.snapshot.entries.map((entry) => [entry.relativePath, {
        bytes: entry.byteLength,
        sourceSha256: entry.contentSha256,
      }]));
      const result = await Promise.all(selected.map(async (reference) => {
        const unit = unitByPath.get(reference.sourcePath);
        if (unit === undefined || unit.sourceSha256 !== reference.sourceSha256) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "reference posting is not bound to its unit directory");
        return {
          evidenceLevel: reference.evidenceLevel,
          range: reference.range,
          relation: reference.relation,
          relativePath: reference.sourcePath,
          snippet: await snippets.read({ byteLength: unit.bytes, path: reference.sourcePath, range: reference.range, sourceSha256: reference.sourceSha256 }, { maxBytes: 4096, maxLines: 5, signal }),
          sourceSha256: reference.sourceSha256,
        };
      }));
      const cursor = nextCursor(tool, context.lease.root.generation.generationSha256, canonicalQuerySha256, offset + result.length, all.length, this.navigationIntegrityKey);
      await context.freshness.verifyResultSources({ locations: selected.map((reference) => ({ path: reference.sourcePath, range: reference.range, sourceSha256: reference.sourceSha256 })) }, signal);
      await this.assertV2Current(context);
      const current = this.v2Current(context, { imports: [], references: selected, symbols: [], units: [] });
      return findReferencesResultSchema.parse({
        ...engineEnvelope(current),
        confirmedAbsent: all.length === 0 && context.lease.root.generation.coverage === "complete",
        evidenceLevel: "semantic",
        nextCursor: cursor,
        result,
        truncated: cursor !== null,
      });
    } finally {
      await context.lease.release().catch(() => undefined);
    }
  }

  private async acquireV2QueryContext(signal: AbortSignal): Promise<RepositoryV2QueryContext> {
    if (this.storage.version !== "v2") throw new Error("repository v2 query context requested for v1 storage");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const envelope = await this.captureEnvelope();
      try {
        const lease = await this.storage.store.acquireCurrentLease({
          engineIdentitySha256: this.decision.identity.identitySha256,
          ruleManifestSha256: envelope.rules.manifest.manifestSha256,
          sourceStateSha256: envelope.snapshot.snapshot.sourceStateSha256,
        });
        if (lease !== null) {
          try {
            await envelope.detector.assertFresh();
            const freshness = await RepositorySourceFreshnessGuard.create(this.workspace, envelope.snapshot, this.snapshotter);
            const status = await freshness.verifyGeneration(lease.root.generation);
            if (status.status === "stale") throw new RepositoryIntelligenceError("repository_index_stale", "repository v2 generation is stale", 8);
            const context = Object.freeze({
              freshness,
              lease,
              rules: envelope.rules,
              rulesDetector: envelope.detector,
              rulesResolver: new RepositoryRuleScopeResolver(envelope.rules.manifest),
              snapshot: envelope.snapshot,
            });
            await this.emitSelected(this.v2Current(context, { imports: [], references: [], symbols: [], units: [] }));
            return context;
          } catch (error) {
            await lease.release().catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof RepositoryIntelligenceError) || error.code !== "repository_cache_storage_invalid" || attempt > 0) throw error;
      }
      if (attempt === 0) {
        await this.ensureCurrent({ allowBuild: true, signal });
        continue;
      }
    }
    throw new RepositoryIntelligenceError("repository_index_stale", "repository v2 cache could not select a current generation", 8);
  }

  private v2Current(context: RepositoryV2QueryContext, records: StoredRepositoryIndexLike["records"]): CurrentGeneration {
    return Object.freeze({
      buildMode: "reused",
      freshness: context.freshness,
      incrementalPlan: null,
      rules: context.rules,
      rulesDetector: context.rulesDetector,
      rulesResolver: context.rulesResolver,
      snapshot: context.snapshot,
      stored: Object.freeze({
        generation: context.lease.root.generation,
        manifestSha256: context.lease.root.storageManifestSha256,
        records,
      }),
    });
  }

  private async assertV2Current(context: RepositoryV2QueryContext): Promise<void> {
    if (this.storage.version !== "v2") throw new Error("repository v2 current check requested for v1 storage");
    const freshness = await context.freshness.verifyGeneration(context.lease.root.generation);
    if (freshness.status === "stale") throw new RepositoryIntelligenceError("repository_index_stale", "repository changed during v2 navigation query", 8);
    await context.rulesDetector.assertFresh();
    await this.storage.store.assertCurrentGeneration(context.lease.root.generation.generationSha256);
  }

  private async readCurrentStored(): Promise<StoredRepositoryIndexLike | null> {
    return this.storage.store.readCurrent();
  }

  private async reclaimV2BeforePublish(signal: AbortSignal): Promise<void> {
    if (!this.foregroundGcEnabled || this.storage.version !== "v2") return;
    try {
      const dryRun = await this.storage.store.collectGarbage({ dryRun: true, signal });
      if (dryRun.unreachableKnownEntries > 0) await this.storage.store.collectGarbage({ dryRun: false, signal });
    } catch (error) {
      // Corrupt current data is repaired under the writer/quarantine protocol;
      // preflight GC must not prevent that narrower recovery path.
      if (!(error instanceof RepositoryIntelligenceError) || ![
        "repository_cache_gc_blocked",
        "repository_cache_storage_invalid",
      ].includes(error.code)) throw error;
    }
  }

  private async reclaimV2AfterPublish(): Promise<void> {
    if (!this.foregroundGcEnabled || this.storage.version !== "v2") return;
    await this.storage.store.collectGarbage({ dryRun: false }).catch(() => undefined);
  }

  private async captureEnvelope(): Promise<{ readonly detector: RepositoryRuleChangeDetector; readonly rules: NestedRepositoryRuleSet; readonly snapshot: RepositorySourceSnapshotResult }> {
    const snapshot = await this.snapshotter.snapshot();
    const loader = await NestedAgentsLoader.create(this.workspace, { artifactStore: artifactPort() });
    const rules = await loader.loadForRun(snapshot.snapshot.sourceStateSha256);
    return Object.freeze({ detector: new RepositoryRuleChangeDetector(loader, rules), rules, snapshot });
  }

  private matches(stored: StoredRepositoryIndex | null, snapshot: RepositorySourceSnapshotResult, rules: NestedRepositoryRuleSet): boolean {
    return stored !== null &&
      stored.generation.engineIdentitySha256 === this.decision.identity.identitySha256 &&
      stored.generation.sourceStateSha256 === snapshot.snapshot.sourceStateSha256 &&
      stored.generation.ruleManifestSha256 === rules.manifest.manifestSha256;
  }

  private async current(
    stored: StoredRepositoryIndex,
    envelope: { readonly detector: RepositoryRuleChangeDetector; readonly rules: NestedRepositoryRuleSet; readonly snapshot: RepositorySourceSnapshotResult },
    buildMode: "cold" | "incremental" | "reused",
    incrementalPlan: RepositoryIncrementalPlan | null = null,
  ): Promise<CurrentGeneration> {
    await envelope.detector.assertFresh();
    const freshness = await RepositorySourceFreshnessGuard.create(this.workspace, envelope.snapshot, this.snapshotter);
    const status = await freshness.verifyGeneration(stored.generation);
    if (status.status === "stale") throw new RepositoryIntelligenceError("repository_index_stale", "repository index generation is stale", 8);
    return Object.freeze({
      buildMode,
      freshness,
      incrementalPlan,
      rules: envelope.rules,
      rulesDetector: envelope.detector,
      rulesResolver: new RepositoryRuleScopeResolver(envelope.rules.manifest),
      snapshot: envelope.snapshot,
      stored,
    });
  }

  private async assertCurrent(current: CurrentGeneration): Promise<void> {
    const freshness = await current.freshness.verifyGeneration(current.stored.generation);
    if (freshness.status === "stale") throw new RepositoryIntelligenceError("repository_index_stale", "repository changed during navigation query", 8);
    await current.rulesDetector.assertFresh();
  }

  private invalidation(
    existing: StoredRepositoryIndex,
    snapshot: RepositorySourceSnapshotResult,
    rules: NestedRepositoryRuleSet,
  ): RepositoryIndexInvalidatedEventData {
    const currentByPath = new Map(snapshot.snapshot.entries.map((entry) => [entry.relativePath, entry.contentSha256]));
    const oldByPath = new Map(existing.records.units.map((entry) => [entry.relativePath, entry.sourceSha256]));
    const changedPathCount = [...new Set([...currentByPath.keys(), ...oldByPath.keys()])].filter((path) => currentByPath.get(path) !== oldByPath.get(path)).length;
    const oldRuleEntries = existing.records.units
      .filter((entry) => entry.relativePath === "AGENTS.md" || entry.relativePath.endsWith("/AGENTS.md"))
      .map((entry) => ({ contentSha256: entry.sourceSha256, relativePath: entry.relativePath }))
      .sort((left, right) => ordinal(left.relativePath, right.relativePath));
    const currentRuleEntries = rules.manifest.entries
      .map((entry) => ({ contentSha256: entry.contentSha256, relativePath: entry.relativePath }))
      .sort((left, right) => ordinal(left.relativePath, right.relativePath));
    const ruleContentChanged = JSON.stringify(oldRuleEntries) !== JSON.stringify(currentRuleEntries);
    const reason = existing.generation.engineIdentitySha256 !== this.decision.identity.identitySha256
      ? "engine_changed" as const
      : ruleContentChanged
        ? "rules_changed" as const
        : "source_changed" as const;
    return Object.freeze({
      changed_path_count: changedPathCount,
      current_source_state_sha256: snapshot.snapshot.sourceStateSha256,
      old_generation_sha256: existing.generation.generationSha256,
      reason,
    });
  }

  private async emitSelected(current: CurrentGeneration): Promise<void> {
    if (this.events === undefined || this.emittedGenerations.has(current.stored.generation.generationSha256)) return;
    await this.events.indexSelected({
      build_mode: current.buildMode,
      cache_manifest_sha256: current.stored.manifestSha256,
      counts: current.stored.generation.counts,
      coverage: current.stored.generation.coverage,
      engine_id: "typescript-language-service",
      engine_identity_sha256: current.stored.generation.engineIdentitySha256,
      generation_sha256: current.stored.generation.generationSha256,
      rule_manifest_sha256: current.stored.generation.ruleManifestSha256,
      source_state_sha256: current.stored.generation.sourceStateSha256,
    });
    this.emittedGenerations.add(current.stored.generation.generationSha256);
  }
}
