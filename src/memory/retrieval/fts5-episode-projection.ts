import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import type { Ml1LogicalDumpV1 } from "../store/sqlite-episode-store.js";
import type { Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import { ML2_SEARCH_MAX_CANDIDATES } from "./ml2-search-contract.js";

const FTS5_SCHEMA_SQL = `
CREATE TABLE projection_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  record_id UNINDEXED,
  occurred_at UNINDEXED,
  task_preview,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO projection_metadata(key, value) VALUES
  ('canonical_logical_sha256', ''),
  ('record_count', '0'),
  ('schema_version', '1'),
  ('scope_sha256', '');
`;

const EXPECTED_TABLES = [
  "episodes_fts",
  "episodes_fts_config",
  "episodes_fts_content",
  "episodes_fts_data",
  "episodes_fts_docsize",
  "episodes_fts_idx",
  "projection_metadata",
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
  const projectionRoot = join(retrievalRoot, "fts5-v1");
  for (const directory of [join(canonicalStateRoot, "memory"), join(canonicalStateRoot, "memory", "v1"), retrievalRoot, projectionRoot]) {
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
  const entries = rows.map((row) => [textColumn(row, "key"), textColumn(row, "value")] as const);
  return new Map(entries);
}

function validateProjection(database: DatabaseSync, expectedScopeSha256: string): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  if (quickCheck === undefined || textColumn(quickCheck, "quick_check") !== "ok") {
    throw new Error("projection quick_check failed");
  }
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
  ).all().map((row) => textColumn(row, "name"));
  if (canonicalJson(tables) !== canonicalJson(EXPECTED_TABLES)) {
    throw new Error("projection tables do not match ML2");
  }
  const columns = database.prepare("PRAGMA table_info(episodes_fts)").all().map((row) => [
    row.cid,
    row.name,
    row.type,
    row.notnull,
    row.dflt_value,
    row.pk,
  ]);
  if (canonicalJson(columns) !== canonicalJson([
    [0, "record_id", "", 0, null, 0],
    [1, "occurred_at", "", 0, null, 0],
    [2, "task_preview", "", 0, null, 0],
    [3, "text", "", 0, null, 0],
  ])) {
    throw new Error("projection columns do not match ML2");
  }
  const metadata = metadataMap(database);
  if (
    metadata.size !== 4 || metadata.get("schema_version") !== "1" ||
    metadata.get("scope_sha256") !== expectedScopeSha256 ||
    metadata.get("canonical_logical_sha256") === undefined ||
    !/^[0-9]+$/u.test(metadata.get("record_count") ?? "")
  ) {
    throw new Error("projection metadata does not match ML2");
  }
  database.prepare("INSERT INTO episodes_fts(episodes_fts) VALUES (?)").run("integrity-check");
}

function rebuildProjection(
  database: DatabaseSync,
  dump: Ml1LogicalDumpV1,
  scopeSha256: string,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("DELETE FROM episodes_fts").run();
    const insert = database.prepare(
      "INSERT INTO episodes_fts(record_id, occurred_at, task_preview, text) VALUES (?, ?, ?, ?)",
    );
    for (const record of dump.records) {
      insert.run(record.recordId, record.occurredAt, record.taskPreview, record.text);
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
  const count = database.prepare("SELECT COUNT(*) AS count FROM episodes_fts").get();
  if (count === undefined || finiteNumberColumn(count, "count") !== dump.count) {
    throw new Error("projection rebuild record count mismatch");
  }
  database.prepare("INSERT INTO episodes_fts(episodes_fts) VALUES (?)").run("integrity-check");
}

async function removeDerivedDatabase(paths: Ml2Fts5ProjectionPaths): Promise<void> {
  for (const path of [paths.databasePath, `${paths.databasePath}-journal`, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
    if (!contained(paths.projectionRoot, path)) {
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
    return new Fts5EpisodeProjection(
      input.stateRoot,
      input.scope,
      paths,
    );
  }

  async search(input: Readonly<{
    readonly candidateLimit?: number;
    readonly dump: Ml1LogicalDumpV1;
    readonly ftsExpression: string;
  }>): Promise<Ml2Fts5SearchResultV1> {
    const candidateLimit = input.candidateLimit ?? ML2_SEARCH_MAX_CANDIDATES;
    if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > ML2_SEARCH_MAX_CANDIDATES) {
      throw new Ml1MemoryError("memory_query_invalid", "memory lexical candidate limit is invalid");
    }
    if (input.dump.logicalSha256 !== sha256Canonical({
      records: input.dump.records,
      schema_version: 1,
      scope: this.scope,
    })) {
      throw new Ml1MemoryError("memory_projection_failed", "canonical logical dump does not match retrieval scope");
    }

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
        const reusable = metadata.get("canonical_logical_sha256") === input.dump.logicalSha256 &&
          metadata.get("record_count") === String(input.dump.count);
        if (!reusable) rebuildProjection(database, input.dump, paths.scopeSha256);
        const rows = database.prepare(`
          SELECT record_id, occurred_at,
            bm25(episodes_fts, 0.0, 0.0, 3.0, 1.0) AS lexical_score
          FROM episodes_fts
          WHERE episodes_fts MATCH ?
          ORDER BY lexical_score ASC, occurred_at DESC, record_id ASC
          LIMIT ?
        `).all(input.ftsExpression, candidateLimit + 1);
        const candidates = rows.slice(0, candidateLimit).map((row) => {
          const recordId = textColumn(row, "record_id");
          const occurredAt = textColumn(row, "occurred_at");
          if (!/^episode_[a-f0-9]{64}$/u.test(recordId) || !Number.isFinite(Date.parse(occurredAt))) {
            throw new Error("projection candidate identity is invalid");
          }
          const rawScore = finiteNumberColumn(row, "lexical_score");
          const lexicalBm25 = Number(rawScore.toFixed(12));
          return Object.freeze({ lexicalBm25, occurredAt, recordId });
        });
        if (process.platform !== "win32") await chmod(paths.databasePath, 0o600);
        this.paths = Object.freeze({ ...paths, databaseExisted: true });
        return Object.freeze({
          action: reusable ? "reused" : "rebuilt",
          candidates: Object.freeze(candidates),
          scopeSha256: paths.scopeSha256,
          truncated: rows.length > candidateLimit,
        });
      } catch (error) {
        try { database?.close(); } catch { /* preserve primary failure */ }
        database = undefined;
        if (attempt === 0 && paths.databaseExisted) {
          await removeDerivedDatabase(paths);
          paths = Object.freeze({ ...paths, databaseExisted: false });
          continue;
        }
        return mapProjectionError(error);
      } finally {
        try { database?.close(); } catch { /* query result is already materialized */ }
      }
    }
    throw new Ml1MemoryError("memory_projection_failed", "memory retrieval projection retry was exhausted");
  }
}
