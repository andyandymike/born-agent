import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import {
  memoryRecordRevisionId,
  memoryRecordSearchTitle,
} from "../core/memory-record-v1.js";
import { inspectMemoryAdmission } from "../episodes/memory-admission.js";
import type { MemoryLogicalDumpV1 } from "../store/sqlite-episode-store.js";
import { ML2_SEARCH_MAX_CANDIDATES } from "./ml2-search-contract.js";

const FTS5_SCHEMA_SQL = `
CREATE TABLE projection_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE records_fts USING fts5(
  record_id UNINDEXED,
  revision_id UNINDEXED,
  occurred_at UNINDEXED,
  title,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO projection_metadata(key, value) VALUES
  ('canonical_logical_sha256', ''),
  ('record_count', '0'),
  ('schema_version', '2'),
  ('scope_sha256', '');
`;

const EXPECTED_TABLES = [
  "projection_metadata",
  "records_fts",
  "records_fts_config",
  "records_fts_content",
  "records_fts_data",
  "records_fts_docsize",
  "records_fts_idx",
] as const;

export interface Ml2Fts5ProjectionPaths {
  readonly databaseExisted: boolean;
  readonly databasePath: string;
  readonly projectionRoot: string;
  readonly retrievalRoot: string;
  readonly scopeSha256: string;
}

export interface Ml2Fts5CandidateV1 {
  readonly lexicalBm25: number;
  readonly occurredAt: string;
  readonly recordId: string;
  readonly revisionId: string;
}

export interface Ml2Fts5SearchResultV1 {
  readonly action: "rebuilt" | "reused";
  readonly candidates: readonly Ml2Fts5CandidateV1[];
  readonly scopeSha256: string;
  readonly truncated: boolean;
}

function pathKey(value: string): string {
  const normalized = value.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Ml1MemoryError("memory_projection_failed", "memory projection path is not a real directory");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function createProjectionPaths(
  stateRootInput: string,
  scope: Ml1MemoryScopeV1,
): Promise<Ml2Fts5ProjectionPaths> {
  if (!isAbsolute(stateRootInput)) {
    throw new Ml1MemoryError("memory_projection_failed", "memory projection state root must be absolute");
  }
  const requestedRoot = resolve(stateRootInput);
  await ensurePrivateDirectory(requestedRoot);
  const canonicalStateRoot = await realpath(requestedRoot);
  const retrievalRoot = join(canonicalStateRoot, "memory", "v1", "retrieval");
  const projectionRoot = join(retrievalRoot, "fts5-v2");
  for (const directory of [
    join(canonicalStateRoot, "memory"),
    join(canonicalStateRoot, "memory", "v1"),
    retrievalRoot,
    projectionRoot,
  ]) {
    if (!contained(canonicalStateRoot, directory)) {
      throw new Ml1MemoryError("memory_projection_failed", "memory projection path escaped its state root");
    }
    await ensurePrivateDirectory(directory);
    if (!contained(canonicalStateRoot, await realpath(directory))) {
      throw new Ml1MemoryError("memory_projection_failed", "memory projection path escaped through a link or junction");
    }
  }
  const scopeSha256 = sha256Canonical(scope);
  const databasePath = join(projectionRoot, `${scopeSha256}.sqlite3`);
  let databaseExisted = true;
  try {
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Ml1MemoryError("memory_projection_failed", "memory projection database is not a regular file");
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      databaseExisted = false;
    } else {
      throw error;
    }
  }
  return Object.freeze({ databaseExisted, databasePath, projectionRoot, retrievalRoot, scopeSha256 });
}

function sqliteCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapProjectionError(error: unknown): never {
  if (error instanceof Ml1MemoryError) throw error;
  const code = sqliteCode(error);
  const message = error instanceof Error ? error.message : "";
  if (code?.includes("SQLITE_BUSY") === true || code?.includes("SQLITE_LOCKED") === true) {
    throw new Ml1MemoryError("memory_store_busy", "memory retrieval projection is busy", { cause: error });
  }
  if (/no such module:\s*fts5/iu.test(message)) {
    throw new Ml1MemoryError("memory_fts_unavailable", "this runtime does not provide SQLite FTS5", { cause: error });
  }
  throw new Ml1MemoryError("memory_projection_failed", "memory retrieval projection failed closed", { cause: error });
}

function textColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`projection column ${name} is not text`);
  return value;
}

function finiteNumberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`projection column ${name} is not finite`);
  }
  return value;
}

function metadataMap(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database.prepare("SELECT key, value FROM projection_metadata ORDER BY key ASC").all();
  return new Map(rows.map((row) => [textColumn(row, "key"), textColumn(row, "value")] as const));
}

function validateProjection(
  database: DatabaseSync,
  expectedScopeSha256: string,
  readOnly = false,
): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  if (quickCheck === undefined || textColumn(quickCheck, "quick_check") !== "ok") {
    throw new Error("projection quick_check failed");
  }
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
  ).all().map((row) => textColumn(row, "name"));
  if (canonicalJson(tables) !== canonicalJson(EXPECTED_TABLES)) {
    throw new Error("projection tables do not match ML4");
  }
  const columns = database.prepare("PRAGMA table_info(records_fts)").all().map((row) => [
    row.cid, row.name, row.type, row.notnull, row.dflt_value, row.pk,
  ]);
  if (canonicalJson(columns) !== canonicalJson([
    [0, "record_id", "", 0, null, 0],
    [1, "revision_id", "", 0, null, 0],
    [2, "occurred_at", "", 0, null, 0],
    [3, "title", "", 0, null, 0],
    [4, "text", "", 0, null, 0],
  ])) {
    throw new Error("projection columns do not match ML4");
  }
  const metadata = metadataMap(database);
  if (
    metadata.size !== 4 || metadata.get("schema_version") !== "2" ||
    metadata.get("scope_sha256") !== expectedScopeSha256 ||
    metadata.get("canonical_logical_sha256") === undefined ||
    !/^[0-9]+$/u.test(metadata.get("record_count") ?? "")
  ) {
    throw new Error("projection metadata does not match ML4");
  }
  if (!readOnly) {
    database.prepare("INSERT INTO records_fts(records_fts) VALUES (?)").run("integrity-check");
  }
}

function assertLogicalDump(dump: MemoryLogicalDumpV1, scope: Ml1MemoryScopeV1): void {
  const expected = sha256Canonical({
    active_revision_ids: dump.activeRevisionIds,
    operations: dump.operations,
    revisions: dump.revisions,
    schema_version: 2,
    scope,
  });
  if (dump.logicalSha256 !== expected || dump.records.length !== dump.count) {
    throw new Ml1MemoryError("memory_projection_failed", "canonical logical dump does not match retrieval scope");
  }
}

function rebuildProjection(
  database: DatabaseSync,
  dump: MemoryLogicalDumpV1,
  scopeSha256: string,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("DELETE FROM records_fts").run();
    const insert = database.prepare(
      "INSERT INTO records_fts(record_id, revision_id, occurred_at, title, text) VALUES (?, ?, ?, ?, ?)",
    );
    for (const record of dump.records) {
      const title = memoryRecordSearchTitle(record);
      if (!inspectMemoryAdmission([title, record.text]).admitted) {
        throw new Ml1MemoryError("memory_projection_failed", "canonical memory failed FTS sensitive-content admission");
      }
      insert.run(record.recordId, memoryRecordRevisionId(record), record.occurredAt, title, record.text);
    }
    const update = database.prepare("UPDATE projection_metadata SET value = ? WHERE key = ?");
    update.run(dump.logicalSha256, "canonical_logical_sha256");
    update.run(String(dump.count), "record_count");
    update.run(scopeSha256, "scope_sha256");
    database.exec("COMMIT;");
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* preserve primary failure */ }
    throw error;
  }
  const count = database.prepare("SELECT COUNT(*) AS count FROM records_fts").get();
  if (count === undefined || finiteNumberColumn(count, "count") !== dump.count) {
    throw new Error("projection rebuild record count mismatch");
  }
  database.prepare("INSERT INTO records_fts(records_fts) VALUES (?)").run("integrity-check");
}

async function removeDatabaseFiles(root: string, databasePath: string): Promise<void> {
  for (const path of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!contained(root, path)) {
      throw new Ml1MemoryError("memory_projection_failed", "derived projection removal escaped its root");
    }
    await rm(path, { force: true });
  }
}

export class Fts5EpisodeProjection {
  private constructor(
    readonly stateRoot: string,
    private readonly scope: Ml1MemoryScopeV1,
    public paths: Ml2Fts5ProjectionPaths,
  ) {}

  static async create(input: Readonly<{
    readonly scope: Ml1MemoryScopeV1;
    readonly stateRoot: string;
  }>): Promise<Fts5EpisodeProjection> {
    const paths = await createProjectionPaths(input.stateRoot, input.scope);
    return new Fts5EpisodeProjection(input.stateRoot, input.scope, paths);
  }

  async search(input: Readonly<{
    readonly candidateLimit?: number;
    readonly dump: MemoryLogicalDumpV1;
    readonly ftsExpression: string;
  }>): Promise<Ml2Fts5SearchResultV1> {
    const candidateLimit = input.candidateLimit ?? ML2_SEARCH_MAX_CANDIDATES;
    if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > ML2_SEARCH_MAX_CANDIDATES) {
      throw new Ml1MemoryError("memory_query_invalid", "memory lexical candidate limit is invalid");
    }
    assertLogicalDump(input.dump, this.scope);
    return this.withProjection(input.dump, (database, action, paths) => {
      const rows = database.prepare(`
        SELECT record_id, revision_id, occurred_at,
          bm25(records_fts, 0.0, 0.0, 0.0, 3.0, 1.0) AS lexical_score
        FROM records_fts
        WHERE records_fts MATCH ?
        ORDER BY lexical_score ASC, occurred_at DESC, record_id ASC, revision_id ASC
        LIMIT ?
      `).all(input.ftsExpression, candidateLimit + 1);
      const candidates = rows.slice(0, candidateLimit).map((row) => {
        const recordId = textColumn(row, "record_id");
        const revisionId = textColumn(row, "revision_id");
        const occurredAt = textColumn(row, "occurred_at");
        if (
          !/^(?:episode|memory)_[a-f0-9]{64}$/u.test(recordId) ||
          !/^(?:episode|revision)_[a-f0-9]{64}$/u.test(revisionId) ||
          !Number.isFinite(Date.parse(occurredAt))
        ) {
          throw new Error("projection candidate identity is invalid");
        }
        return Object.freeze({
          lexicalBm25: Number(finiteNumberColumn(row, "lexical_score").toFixed(12)),
          occurredAt,
          recordId,
          revisionId,
        });
      });
      return Object.freeze({
        action,
        candidates: Object.freeze(candidates),
        scopeSha256: paths.scopeSha256,
        truncated: rows.length > candidateLimit,
      });
    });
  }

  async invalidate(): Promise<Readonly<{ readonly removed: boolean }>> {
    const paths = await createProjectionPaths(this.stateRoot, this.scope);
    await removeDatabaseFiles(paths.projectionRoot, paths.databasePath);
    const legacyRoot = join(paths.retrievalRoot, "fts5-v1");
    const legacyPath = join(legacyRoot, `${paths.scopeSha256}.sqlite3`);
    if (contained(paths.retrievalRoot, legacyPath)) await removeDatabaseFiles(legacyRoot, legacyPath);
    this.paths = Object.freeze({ ...paths, databaseExisted: false });
    return Object.freeze({ removed: paths.databaseExisted });
  }

  async rebuild(dump: MemoryLogicalDumpV1): Promise<Readonly<{
    readonly action: "rebuilt";
    readonly recordCount: number;
    readonly schemaVersion: 2;
  }>> {
    assertLogicalDump(dump, this.scope);
    await this.invalidate();
    const materialized = await this.withProjection(dump, (_database, action) => action);
    if (materialized !== "rebuilt") {
      throw new Ml1MemoryError("memory_projection_failed", "forced memory projection rebuild was unexpectedly reused");
    }
    return Object.freeze({ action: "rebuilt", recordCount: dump.count, schemaVersion: 2 });
  }

  async doctor(dump: MemoryLogicalDumpV1): Promise<Readonly<{
    readonly action: "corrupt" | "missing" | "stale" | "verified";
    readonly recordCount: number;
    readonly schemaVersion: 2;
    readonly status: "ok" | "warning";
  }>> {
    assertLogicalDump(dump, this.scope);
    const paths = await createProjectionPaths(this.stateRoot, this.scope);
    this.paths = paths;
    if (!paths.databaseExisted) {
      return Object.freeze({
        action: "missing",
        recordCount: dump.count,
        schemaVersion: 2,
        status: "warning",
      });
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(paths.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        readOnly: true,
        timeout: 1_000,
      });
      validateProjection(database, paths.scopeSha256, true);
      const metadata = metadataMap(database);
      const current = metadata.get("canonical_logical_sha256") === dump.logicalSha256 &&
        metadata.get("record_count") === String(dump.count);
      return Object.freeze({
        action: current ? "verified" : "stale",
        recordCount: dump.count,
        schemaVersion: 2,
        status: current ? "ok" : "warning",
      });
    } catch {
      return Object.freeze({
        action: "corrupt",
        recordCount: dump.count,
        schemaVersion: 2,
        status: "warning",
      });
    } finally {
      try { database?.close(); } catch { /* diagnostic is already materialized */ }
    }
  }

  private async withProjection<T>(
    dump: MemoryLogicalDumpV1,
    execute: (
      database: DatabaseSync,
      action: "rebuilt" | "reused",
      paths: Ml2Fts5ProjectionPaths,
    ) => T,
  ): Promise<T> {
    let paths = await createProjectionPaths(this.stateRoot, this.scope);
    this.paths = paths;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(paths.databasePath, {
          allowExtension: false,
          enableDoubleQuotedStringLiterals: false,
          enableForeignKeyConstraints: true,
          timeout: 1_000,
        });
        database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;");
        if (!paths.databaseExisted) {
          database.exec(FTS5_SCHEMA_SQL);
          database.prepare("UPDATE projection_metadata SET value = ? WHERE key = 'scope_sha256'")
            .run(paths.scopeSha256);
        }
        validateProjection(database, paths.scopeSha256);
        const metadata = metadataMap(database);
        const reusable = metadata.get("canonical_logical_sha256") === dump.logicalSha256 &&
          metadata.get("record_count") === String(dump.count);
        if (!reusable) rebuildProjection(database, dump, paths.scopeSha256);
        const action = reusable ? "reused" as const : "rebuilt" as const;
        if (process.platform !== "win32") await chmod(paths.databasePath, 0o600);
        this.paths = Object.freeze({ ...paths, databaseExisted: true });
        return execute(database, action, paths);
      } catch (error) {
        try { database?.close(); } catch { /* preserve primary failure */ }
        database = undefined;
        if (attempt === 0 && paths.databaseExisted) {
          await removeDatabaseFiles(paths.projectionRoot, paths.databasePath);
          paths = Object.freeze({ ...paths, databaseExisted: false });
          continue;
        }
        return mapProjectionError(error);
      } finally {
        try { database?.close(); } catch { /* result is already materialized */ }
      }
    }
    throw new Ml1MemoryError("memory_projection_failed", "memory retrieval projection retry was exhausted");
  }
}
