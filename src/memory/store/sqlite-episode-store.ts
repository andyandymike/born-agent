import { chmod } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { decodeMl1EpisodeRecord, encodeMl1EpisodeRecord } from "../core/ml1-episode-codec.js";
import {
  ML1_EPISODE_MAX_RECORDS,
  ML1_EPISODE_MAX_TOTAL_BYTES,
  ML1_EPISODE_PAGE_MAX,
  ml1MemoryScopeV1Schema,
  type Ml1EpisodeRecordV1,
  type Ml1MemoryScopeV1,
} from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import { createMl1MemoryStatePaths, type Ml1MemoryStatePaths } from "./memory-state-paths.js";

const SCHEMA_SQL = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE episode_records (
  record_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  application_repository_id TEXT NOT NULL,
  canonical_root_identity_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes > 0 AND canonical_bytes <= 8192),
  canonical_json BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX episode_scope_time_v1 ON episode_records (
  owner_principal_id,
  application_repository_id,
  canonical_root_identity_sha256,
  occurred_at DESC,
  record_id ASC
);
INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
`;

export interface Ml1EpisodeListPageV1 {
  readonly items: readonly Ml1EpisodeRecordV1[];
  readonly nextCursor: string | null;
}

export interface Ml1LogicalDumpV1 {
  readonly canonicalBytes: number;
  readonly count: number;
  readonly logicalSha256: string;
  readonly records: readonly Ml1EpisodeRecordV1[];
}

export type Ml1EpisodeIngestResultV1 =
  | Readonly<{ readonly status: "already_present" }>
  | Readonly<{ readonly status: "inserted" }>;

export interface Ml1EpisodeStorePort {
  getEpisode(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeRecordV1 | null>;
  ingestEpisode(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeIngestResultV1>;
  listEpisodes(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeListPageV1>;
  logicalDump(scope: Ml1MemoryScopeV1): Promise<Ml1LogicalDumpV1>;
}

interface CursorV1 {
  readonly occurredAt: string;
  readonly recordId: string;
  readonly schemaVersion: 1;
  readonly scopeSha256: string;
}

function sqliteCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapStoreError(error: unknown): never {
  if (error instanceof Ml1MemoryError) throw error;
  const code = sqliteCode(error);
  if (code?.includes("SQLITE_BUSY") === true || code?.includes("SQLITE_LOCKED") === true) {
    throw new Ml1MemoryError("memory_store_busy", "memory store is busy", { cause: error });
  }
  throw new Ml1MemoryError("memory_store_corrupt", "memory store operation failed closed", { cause: error });
}

function textColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Ml1MemoryError("memory_store_corrupt", "memory store row has an invalid text column");
  }
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory store row has an invalid numeric column");
  }
  return value;
}

function encodeCursor(scope: Ml1MemoryScopeV1, record: Ml1EpisodeRecordV1): string {
  const value: CursorV1 = {
    occurredAt: record.occurredAt,
    recordId: record.recordId,
    schemaVersion: 1,
    scopeSha256: sha256Canonical(scope),
  };
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function decodeCursor(scope: Ml1MemoryScopeV1, cursor: string): CursorV1 {
  try {
    if (cursor.length <= 0 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error("cursor encoding is invalid");
    }
    const source = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(source, "utf8").toString("base64url") !== cursor) {
      throw new Error("cursor encoding is not canonical");
    }
    const parsed = parseStrictJson(source);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "occurredAt,recordId,schemaVersion,scopeSha256"
    ) {
      throw new Error("cursor shape is invalid");
    }
    const value = parsed as unknown as CursorV1;
    if (
      canonicalJson(value) !== source || value.schemaVersion !== 1 ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)) ||
      typeof value.recordId !== "string" || !/^episode_[a-f0-9]{64}$/u.test(value.recordId) ||
      value.scopeSha256 !== sha256Canonical(scope)
    ) {
      throw new Error("cursor binding is invalid");
    }
    return value;
  } catch (error) {
    throw new Ml1MemoryError("memory_cursor_invalid", "memory cursor is invalid for this scope", { cause: error });
  }
}

function scopeArgs(scope: Ml1MemoryScopeV1): readonly [string, string, string] {
  const parsed = ml1MemoryScopeV1Schema.parse(scope);
  return [parsed.ownerPrincipalId, parsed.applicationRepositoryId, parsed.canonicalRootIdentitySha256];
}

export class SqliteEpisodeStore implements Ml1EpisodeStorePort {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    readonly paths: Ml1MemoryStatePaths,
    private readonly limits: Readonly<{ readonly maxRecords: number; readonly maxTotalBytes: number }>,
  ) {}

  static async create(input: Readonly<{
    readonly limits?: Readonly<{ readonly maxRecords?: number; readonly maxTotalBytes?: number }>;
    readonly stateRoot: string;
  }>): Promise<SqliteEpisodeStore> {
    const paths = await createMl1MemoryStatePaths(input.stateRoot);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(paths.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: 1_000,
      });
      database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      ).all().map((row) => textColumn(row, "name"));
      if (tables.length === 0 && paths.databaseExisted) {
        throw new Ml1MemoryError("memory_store_corrupt", "existing memory database has no ML1 schema");
      }
      if (tables.length === 0) {
        database.exec("BEGIN IMMEDIATE;");
        try {
          database.exec(SCHEMA_SQL);
          database.exec("COMMIT;");
        } catch (error) {
          database.exec("ROLLBACK;");
          throw error;
        }
      }
      const store = new SqliteEpisodeStore(database, paths, Object.freeze({
        maxRecords: Math.min(input.limits?.maxRecords ?? ML1_EPISODE_MAX_RECORDS, ML1_EPISODE_MAX_RECORDS),
        maxTotalBytes: Math.min(input.limits?.maxTotalBytes ?? ML1_EPISODE_MAX_TOTAL_BYTES, ML1_EPISODE_MAX_TOTAL_BYTES),
      }));
      store.validateSchema();
      if (process.platform !== "win32") await chmod(paths.databasePath, 0o600);
      return store;
    } catch (error) {
      try { database?.close(); } catch { /* preserve the primary failure */ }
      return mapStoreError(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async ingestEpisode(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeIngestResultV1> {
    try {
      this.assertOpen();
      const bytes = encodeMl1EpisodeRecord(record);
      const admissionScope = scopeArgs(record.scope);
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const existing = this.database.prepare(
          "SELECT record_sha256, canonical_json FROM episode_records WHERE record_id = ?",
        ).get(record.recordId);
        if (existing !== undefined) {
          const existingBytes = existing.canonical_json;
          if (
            textColumn(existing, "record_sha256") !== record.recordSha256 ||
            !(existingBytes instanceof Uint8Array) || !Buffer.from(existingBytes).equals(bytes)
          ) {
            throw new Ml1MemoryError("memory_store_corrupt", "episode identity already contains different canonical bytes");
          }
          this.database.exec("COMMIT;");
          return Object.freeze({ status: "already_present" });
        }
        const totals = this.database.prepare(
          "SELECT COUNT(*) AS record_count, COALESCE(SUM(canonical_bytes), 0) AS total_bytes FROM episode_records",
        ).get();
        if (
          totals === undefined ||
          numberColumn(totals, "record_count") >= this.limits.maxRecords ||
          numberColumn(totals, "total_bytes") + bytes.byteLength > this.limits.maxTotalBytes
        ) {
          throw new Ml1MemoryError("memory_capacity_reached", "memory store reached its hard capacity bound");
        }
        this.database.prepare(`
          INSERT INTO episode_records(
            record_id, owner_principal_id, application_repository_id,
            canonical_root_identity_sha256, occurred_at, record_sha256,
            canonical_bytes, canonical_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.recordId,
          admissionScope[0], admissionScope[1], admissionScope[2],
          record.occurredAt, record.recordSha256, bytes.byteLength, bytes,
        );
        this.database.exec("COMMIT;");
        return Object.freeze({ status: "inserted" });
      } catch (error) {
        try { this.database.exec("ROLLBACK;"); } catch { /* mapped below */ }
        throw error;
      }
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async getEpisode(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeRecordV1 | null> {
    try {
      // MEMORY-ML1: every read repeats all three scope predicates; record ID alone is never authority.
      this.assertOpen();
      const args = scopeArgs(input.scope);
      const row = this.database.prepare(`
        SELECT * FROM episode_records
        WHERE owner_principal_id = ? AND application_repository_id = ?
          AND canonical_root_identity_sha256 = ? AND record_id = ?
      `).get(...args, input.recordId);
      return row === undefined ? null : this.decodeRow(row, input.scope);
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async listEpisodes(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeListPageV1> {
    try {
      this.assertOpen();
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ML1_EPISODE_PAGE_MAX) {
        throw new Ml1MemoryError("memory_cursor_invalid", "memory list limit must be between 1 and 100");
      }
      const args = scopeArgs(input.scope);
      const cursor = input.cursor === undefined ? undefined : decodeCursor(input.scope, input.cursor);
      const rows = cursor === undefined
        ? this.database.prepare(`
            SELECT * FROM episode_records
            WHERE owner_principal_id = ? AND application_repository_id = ?
              AND canonical_root_identity_sha256 = ?
            ORDER BY occurred_at DESC, record_id ASC LIMIT ?
          `).all(...args, input.limit + 1)
        : this.database.prepare(`
            SELECT * FROM episode_records
            WHERE owner_principal_id = ? AND application_repository_id = ?
              AND canonical_root_identity_sha256 = ?
              AND (occurred_at < ? OR (occurred_at = ? AND record_id > ?))
            ORDER BY occurred_at DESC, record_id ASC LIMIT ?
          `).all(...args, cursor.occurredAt, cursor.occurredAt, cursor.recordId, input.limit + 1);
      const items = rows.slice(0, input.limit).map((row) => this.decodeRow(row, input.scope));
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: rows.length > input.limit && last !== undefined ? encodeCursor(input.scope, last) : null,
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async logicalDump(scope: Ml1MemoryScopeV1): Promise<Ml1LogicalDumpV1> {
    try {
      this.assertOpen();
      const args = scopeArgs(scope);
      const rows = this.database.prepare(`
        SELECT * FROM episode_records
        WHERE owner_principal_id = ? AND application_repository_id = ?
          AND canonical_root_identity_sha256 = ?
        ORDER BY occurred_at DESC, record_id ASC
      `).all(...args);
      const records = Object.freeze(rows.map((row) => this.decodeRow(row, scope)));
      const canonicalBytes = rows.reduce((total, row) => total + numberColumn(row, "canonical_bytes"), 0);
      return Object.freeze({
        canonicalBytes,
        count: records.length,
        logicalSha256: sha256Canonical({ records, schema_version: 1, scope }),
        records,
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Ml1MemoryError("memory_store_corrupt", "memory store is closed");
  }

  private validateSchema(): void {
    const quickCheck = this.database.prepare("PRAGMA quick_check").get();
    if (quickCheck === undefined || textColumn(quickCheck, "quick_check") !== "ok") {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database integrity check failed");
    }
    const tables = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
    ).all().map((row) => textColumn(row, "name"));
    if (tables.join(",") !== "episode_records,metadata") {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database schema contains unknown or missing tables");
    }
    const columnSignature = (table: "episode_records" | "metadata") => this.database
      .prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => [
        numberColumn(row, "cid"),
        textColumn(row, "name"),
        textColumn(row, "type"),
        numberColumn(row, "notnull"),
        row.dflt_value,
        numberColumn(row, "pk"),
      ]);
    const expectedMetadataColumns = [
      [0, "key", "TEXT", 1, null, 1],
      [1, "value", "TEXT", 1, null, 0],
    ];
    const expectedEpisodeColumns = [
      [0, "record_id", "TEXT", 1, null, 1],
      [1, "owner_principal_id", "TEXT", 1, null, 0],
      [2, "application_repository_id", "TEXT", 1, null, 0],
      [3, "canonical_root_identity_sha256", "TEXT", 1, null, 0],
      [4, "occurred_at", "TEXT", 1, null, 0],
      [5, "record_sha256", "TEXT", 1, null, 0],
      [6, "canonical_bytes", "INTEGER", 1, null, 0],
      [7, "canonical_json", "BLOB", 1, null, 0],
    ];
    if (
      canonicalJson(columnSignature("metadata")) !== canonicalJson(expectedMetadataColumns) ||
      canonicalJson(columnSignature("episode_records")) !== canonicalJson(expectedEpisodeColumns)
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database columns do not match ML1");
    }
    const metadata = this.database.prepare("SELECT key, value FROM metadata ORDER BY key ASC").all();
    if (
      metadata.length !== 1 || textColumn(metadata[0]!, "key") !== "schema_version" ||
      textColumn(metadata[0]!, "value") !== "1"
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database schema version is unsupported");
    }
    const indexes = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'episode_records' ORDER BY name ASC",
    ).all().map((row) => textColumn(row, "name"));
    // WITHOUT ROWID stores the primary key in the table b-tree, so SQLite does
    // not expose a separate sqlite_autoindex entry for it.
    if (indexes.join(",") !== "episode_scope_time_v1") {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database indexes are incomplete");
    }
    const indexSignature = this.database.prepare("PRAGMA index_xinfo(episode_scope_time_v1)").all()
      .map((row) => [
        numberColumn(row, "seqno"),
        textColumn(row, "name"),
        numberColumn(row, "desc"),
        numberColumn(row, "key"),
      ]);
    if (canonicalJson(indexSignature) !== canonicalJson([
      [0, "owner_principal_id", 0, 1],
      [1, "application_repository_id", 0, 1],
      [2, "canonical_root_identity_sha256", 0, 1],
      [3, "occurred_at", 1, 1],
      [4, "record_id", 0, 1],
    ])) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database scope index does not match ML1");
    }
  }

  private decodeRow(row: Record<string, unknown>, expectedScope: Ml1MemoryScopeV1): Ml1EpisodeRecordV1 {
    const stored = row.canonical_json;
    if (!(stored instanceof Uint8Array)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory record payload is not a blob");
    }
    const bytes = Buffer.from(stored);
    const record = decodeMl1EpisodeRecord(bytes);
    const scope = scopeArgs(expectedScope);
    if (
      textColumn(row, "record_id") !== record.recordId ||
      textColumn(row, "record_sha256") !== record.recordSha256 ||
      textColumn(row, "owner_principal_id") !== scope[0] ||
      textColumn(row, "application_repository_id") !== scope[1] ||
      textColumn(row, "canonical_root_identity_sha256") !== scope[2] ||
      textColumn(row, "occurred_at") !== record.occurredAt ||
      numberColumn(row, "canonical_bytes") !== bytes.byteLength ||
      canonicalJson(record.scope) !== canonicalJson(expectedScope)
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory row columns disagree with canonical episode bytes");
    }
    return record;
  }
}
