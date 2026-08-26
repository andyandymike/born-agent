import { chmod, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256Canonical } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { decodeMl1EpisodeRecord } from "../core/ml1-episode-codec.js";
import {
  ML1_EPISODE_MAX_RECORDS,
  ML1_EPISODE_MAX_TOTAL_BYTES,
  ML1_EPISODE_PAGE_MAX,
  ml1MemoryScopeV1Schema,
  type Ml1EpisodeRecordV1,
  type Ml1MemoryScopeV1,
} from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import {
  MEMORY_MAX_OPERATION_BYTES,
  MEMORY_MAX_OPERATIONS,
  createMemoryOperationV1,
  decodeMemoryOperationV1,
  encodeMemoryOperationV1,
  type MemoryOperationV1,
} from "../core/memory-operation-v1.js";
import {
  decodeMemoryRecordV1,
  encodeMemoryRecordV1,
  memoryRecordRevision,
  memoryRecordRevisionId,
  sameMemoryScope,
  type ExplicitMemoryRecordV1,
  type MemoryRecordV1,
} from "../core/memory-record-v1.js";
import { inspectMemoryAdmission } from "../episodes/memory-admission.js";
import { createMl1MemoryStatePaths, type Ml1MemoryStatePaths } from "./memory-state-paths.js";

export const MEMORY_STORE_SCHEMA_VERSION = 2;

const V2_TABLE_SQL = `
CREATE TABLE memory_records (
  revision_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('episode', 'fact', 'preference', 'decision', 'constraint')),
  owner_principal_id TEXT NOT NULL,
  application_repository_id TEXT NOT NULL,
  canonical_root_identity_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes > 0 AND canonical_bytes <= 8192),
  canonical_json BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX memory_record_logical_revision_v2 ON memory_records(record_id, revision);
CREATE INDEX memory_record_scope_time_v2 ON memory_records (
  owner_principal_id,
  application_repository_id,
  canonical_root_identity_sha256,
  occurred_at DESC,
  record_id ASC,
  revision DESC
);
CREATE TABLE memory_operations (
  operation_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('ADD', 'SUPERSEDE', 'RETRACT')),
  new_revision_id TEXT,
  target_revision_id TEXT,
  owner_principal_id TEXT NOT NULL,
  application_repository_id TEXT NOT NULL,
  canonical_root_identity_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes > 0 AND canonical_bytes <= 4096),
  canonical_json BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX memory_operation_sequence_v2 ON memory_operations(sequence);
CREATE INDEX memory_operation_record_sequence_v2 ON memory_operations(record_id, sequence DESC);
CREATE INDEX memory_operation_scope_sequence_v2 ON memory_operations (
  owner_principal_id,
  application_repository_id,
  canonical_root_identity_sha256,
  sequence ASC
);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
${V2_TABLE_SQL}
INSERT INTO metadata(key, value) VALUES ('schema_version', '2');
`;

const V2_TABLES = ["memory_operations", "memory_records", "metadata"] as const;

export interface MemoryRecordListPageV1 {
  readonly items: readonly MemoryRecordV1[];
  readonly nextCursor: string | null;
}

export interface Ml1EpisodeListPageV1 {
  readonly items: readonly Ml1EpisodeRecordV1[];
  readonly nextCursor: string | null;
}

export interface MemoryLogicalDumpV1 {
  readonly activeRevisionIds: readonly string[];
  readonly canonicalBytes: number;
  readonly count: number;
  readonly logicalSha256: string;
  readonly operationBytes: number;
  readonly operationCount: number;
  readonly operations: readonly MemoryOperationV1[];
  /** Active records only; derived retrieval must never index inactive revisions. */
  readonly records: readonly MemoryRecordV1[];
  readonly revisionBytes: number;
  readonly revisionCount: number;
  readonly revisions: readonly MemoryRecordV1[];
}

/** ML2 source compatibility; the logical dump now carries schema-2 lifecycle state. */
export type Ml1LogicalDumpV1 = MemoryLogicalDumpV1;

export type Ml1EpisodeIngestResultV1 =
  | Readonly<{ readonly status: "already_present" }>
  | Readonly<{ readonly status: "inserted" }>;

export interface MemoryRecordStateV1 {
  readonly headOperation: MemoryOperationV1;
  readonly record: MemoryRecordV1;
  readonly status: "active" | "retracted";
}

export interface MemoryCapacityV1 {
  readonly automaticIngestAllowed: boolean;
  readonly maxOperationBytes: number;
  readonly maxOperations: number;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly operationBytes: number;
  readonly operationCount: number;
  readonly recordBytes: number;
  readonly recordCount: number;
  readonly retractOperationReserve: number;
}

export interface MemoryStoreDiagnosticsV1 {
  readonly capacity: MemoryCapacityV1;
  readonly databaseBytes: number;
  readonly logicalSha256: string;
  readonly pathPrivacy: "platform_managed" | "private";
  readonly quickCheck: "ok";
  readonly schemaVersion: 2;
}

export type ExplicitMemoryMutationResultV1 = Readonly<{
  readonly operation: MemoryOperationV1;
  readonly record: ExplicitMemoryRecordV1;
  readonly status: "added" | "superseded";
}>;

export type MemoryRetractResultV1 = Readonly<{
  readonly operation: MemoryOperationV1;
  readonly record: MemoryRecordV1;
  readonly status: "already_retracted" | "retracted";
}>;

export interface MemoryStorePort {
  addExplicitRecord(record: ExplicitMemoryRecordV1): Promise<ExplicitMemoryMutationResultV1>;
  capacity(): Promise<MemoryCapacityV1>;
  diagnostics(scope: Ml1MemoryScopeV1): Promise<MemoryStoreDiagnosticsV1>;
  getActiveRecord(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordV1 | null>;
  getEpisode(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeRecordV1 | null>;
  getRecordState(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordStateV1 | null>;
  ingestEpisode(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeIngestResultV1>;
  listActiveRecords(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordListPageV1>;
  listEpisodes(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeListPageV1>;
  logicalDump(scope: Ml1MemoryScopeV1): Promise<MemoryLogicalDumpV1>;
  retractRecord(input: Readonly<{
    readonly commandId: string;
    readonly occurredAt: string;
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRetractResultV1>;
  supersedeExplicitRecord(record: ExplicitMemoryRecordV1): Promise<ExplicitMemoryMutationResultV1>;
}

/** Backward-compatible port name used by focused ML1 tests and pack probes. */
export type Ml1EpisodeStorePort = MemoryStorePort;

interface CursorV2 {
  readonly occurredAt: string;
  readonly recordId: string;
  readonly revisionId: string;
  readonly schemaVersion: 2;
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

function nullableTextColumn(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") {
    throw new Ml1MemoryError("memory_store_corrupt", "memory store row has an invalid nullable text column");
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

function scopeArgs(scope: Ml1MemoryScopeV1): readonly [string, string, string] {
  const parsed = ml1MemoryScopeV1Schema.parse(scope);
  return [parsed.ownerPrincipalId, parsed.applicationRepositoryId, parsed.canonicalRootIdentitySha256];
}

function encodeCursor(scope: Ml1MemoryScopeV1, record: MemoryRecordV1): string {
  const value: CursorV2 = {
    occurredAt: record.occurredAt,
    recordId: record.recordId,
    revisionId: memoryRecordRevisionId(record),
    schemaVersion: 2,
    scopeSha256: sha256Canonical(scope),
  };
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function decodeCursor(scope: Ml1MemoryScopeV1, cursor: string): CursorV2 {
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
      Object.keys(parsed).sort().join(",") !== "occurredAt,recordId,revisionId,schemaVersion,scopeSha256"
    ) {
      throw new Error("cursor shape is invalid");
    }
    const value = parsed as unknown as CursorV2;
    if (
      canonicalJson(value) !== source || value.schemaVersion !== 2 ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)) ||
      typeof value.recordId !== "string" || !/^(?:episode|memory)_[a-f0-9]{64}$/u.test(value.recordId) ||
      typeof value.revisionId !== "string" || !/^(?:episode|revision)_[a-f0-9]{64}$/u.test(value.revisionId) ||
      value.scopeSha256 !== sha256Canonical(scope)
    ) {
      throw new Error("cursor binding is invalid");
    }
    return value;
  } catch (error) {
    throw new Ml1MemoryError("memory_cursor_invalid", "memory cursor is invalid for this scope", { cause: error });
  }
}

function limitValue(requested: number | undefined, fallback: number, maximum: number): number {
  const value = requested ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Ml1MemoryError("memory_record_invalid", "memory store limit is invalid");
  }
  return Math.min(value, maximum);
}

function metadataVersion(database: DatabaseSync): string {
  const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key ASC").all();
  if (rows.length !== 1 || textColumn(rows[0]!, "key") !== "schema_version") {
    throw new Ml1MemoryError("memory_store_corrupt", "memory database metadata is invalid");
  }
  return textColumn(rows[0]!, "value");
}

function columnSignature(database: DatabaseSync, table: string): readonly unknown[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => [
    numberColumn(row, "cid"),
    textColumn(row, "name"),
    textColumn(row, "type"),
    numberColumn(row, "notnull"),
    row.dflt_value,
    numberColumn(row, "pk"),
  ]);
}

function indexKeySignature(database: DatabaseSync, index: string): readonly unknown[] {
  return database.prepare(`PRAGMA index_xinfo(${index})`).all()
    .filter((row) => numberColumn(row, "key") === 1)
    .map((row) => [textColumn(row, "name"), numberColumn(row, "desc")]);
}

function validateLegacySchema(database: DatabaseSync): void {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
  ).all().map((row) => textColumn(row, "name"));
  if (tables.join(",") !== "episode_records,metadata" || metadataVersion(database) !== "1") {
    throw new Ml1MemoryError("memory_store_corrupt", "memory database is not the supported ML1 schema");
  }
  if (canonicalJson(columnSignature(database, "metadata")) !== canonicalJson([
    [0, "key", "TEXT", 1, null, 1],
    [1, "value", "TEXT", 1, null, 0],
  ]) || canonicalJson(columnSignature(database, "episode_records")) !== canonicalJson([
    [0, "record_id", "TEXT", 1, null, 1],
    [1, "owner_principal_id", "TEXT", 1, null, 0],
    [2, "application_repository_id", "TEXT", 1, null, 0],
    [3, "canonical_root_identity_sha256", "TEXT", 1, null, 0],
    [4, "occurred_at", "TEXT", 1, null, 0],
    [5, "record_sha256", "TEXT", 1, null, 0],
    [6, "canonical_bytes", "INTEGER", 1, null, 0],
    [7, "canonical_json", "BLOB", 1, null, 0],
  ])) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory database ML1 columns are invalid");
  }
  const indexes = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'episode_records' ORDER BY name ASC",
  ).all().map((row) => textColumn(row, "name"));
  if (indexes.join(",") !== "episode_scope_time_v1") {
    throw new Ml1MemoryError("memory_store_corrupt", "memory database ML1 index is invalid");
  }
  if (canonicalJson(indexKeySignature(database, "episode_scope_time_v1")) !== canonicalJson([
    ["owner_principal_id", 0],
    ["application_repository_id", 0],
    ["canonical_root_identity_sha256", 0],
    ["occurred_at", 1],
    ["record_id", 0],
  ])) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory database ML1 index columns are invalid");
  }
}

function insertRecordRow(database: DatabaseSync, record: MemoryRecordV1, bytes: Buffer): void {
  const scope = scopeArgs(record.scope);
  database.prepare(`
    INSERT INTO memory_records(
      revision_id, record_id, revision, kind, owner_principal_id,
      application_repository_id, canonical_root_identity_sha256,
      occurred_at, record_sha256, canonical_bytes, canonical_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memoryRecordRevisionId(record), record.recordId, memoryRecordRevision(record), record.kind,
    scope[0], scope[1], scope[2], record.occurredAt, record.recordSha256,
    bytes.byteLength, bytes,
  );
}

function insertOperationRow(database: DatabaseSync, operation: MemoryOperationV1, bytes: Buffer): void {
  const scope = scopeArgs(operation.scope);
  database.prepare(`
    INSERT INTO memory_operations(
      operation_id, sequence, record_id, operation, new_revision_id,
      target_revision_id, owner_principal_id, application_repository_id,
      canonical_root_identity_sha256, occurred_at, operation_sha256,
      canonical_bytes, canonical_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation.operationId, operation.sequence, operation.recordId, operation.operation,
    operation.newRevisionId, operation.targetRevisionId, scope[0], scope[1], scope[2],
    operation.occurredAt, operation.operationSha256, bytes.byteLength, bytes,
  );
}

function migrateLegacySchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(V2_TABLE_SQL);
    const rows = database.prepare(
      "SELECT * FROM episode_records ORDER BY occurred_at ASC, record_id ASC",
    ).all();
    let sequence = 0;
    for (const row of rows) {
      const stored = row.canonical_json;
      if (!(stored instanceof Uint8Array)) {
        throw new Ml1MemoryError("memory_store_corrupt", "legacy episode payload is not a blob");
      }
      const bytes = Buffer.from(stored);
      const record = decodeMl1EpisodeRecord(bytes);
      const scope = scopeArgs(record.scope);
      if (
        textColumn(row, "record_id") !== record.recordId ||
        textColumn(row, "record_sha256") !== record.recordSha256 ||
        textColumn(row, "owner_principal_id") !== scope[0] ||
        textColumn(row, "application_repository_id") !== scope[1] ||
        textColumn(row, "canonical_root_identity_sha256") !== scope[2] ||
        textColumn(row, "occurred_at") !== record.occurredAt ||
        numberColumn(row, "canonical_bytes") !== bytes.byteLength
      ) {
        throw new Ml1MemoryError("memory_store_corrupt", "legacy episode columns disagree with canonical bytes");
      }
      insertRecordRow(database, record, bytes);
      sequence += 1;
      const operation = createMemoryOperationV1({
        actor: { kind: "deterministic_episode" },
        newRevisionId: record.recordId,
        occurredAt: record.occurredAt,
        operation: "ADD",
        recordId: record.recordId,
        scope: record.scope,
        sequence,
        targetRevisionId: null,
      });
      insertOperationRow(database, operation, encodeMemoryOperationV1(operation));
    }
    database.exec("DROP TABLE episode_records;");
    database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
    database.exec("COMMIT;");
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* preserve the migration failure */ }
    throw error;
  }
}

function validateLifecycle(
  revisions: readonly MemoryRecordV1[],
  operations: readonly MemoryOperationV1[],
  activeRecords: readonly MemoryRecordV1[],
): void {
  const byRevision = new Map(revisions.map((record) => [memoryRecordRevisionId(record), record] as const));
  const referenced = new Set<string>();
  const heads = new Map<string, Readonly<{ readonly active: boolean; readonly revisionId: string }>>();
  for (const operation of operations) {
    const prior = heads.get(operation.recordId);
    if (operation.operation === "ADD") {
      const record = operation.newRevisionId === null ? undefined : byRevision.get(operation.newRevisionId);
      if (
        prior !== undefined || record === undefined || record.recordId !== operation.recordId ||
        memoryRecordRevision(record) !== 1 || record.occurredAt !== operation.occurredAt ||
        (record.kind === "episode"
          ? operation.actor.kind !== "deterministic_episode"
          : operation.actor.kind !== "local_user_command" || operation.actor.commandId !== record.source.commandId)
      ) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory ADD operation disagrees with its revision");
      }
      referenced.add(operation.newRevisionId!);
      heads.set(operation.recordId, { active: true, revisionId: operation.newRevisionId! });
      continue;
    }
    if (operation.operation === "SUPERSEDE") {
      const target = operation.targetRevisionId === null ? undefined : byRevision.get(operation.targetRevisionId);
      const record = operation.newRevisionId === null ? undefined : byRevision.get(operation.newRevisionId);
      if (
        prior === undefined || !prior.active || prior.revisionId !== operation.targetRevisionId ||
        target === undefined || record === undefined || target.kind === "episode" || record.kind === "episode" ||
        target.recordId !== operation.recordId || record.recordId !== operation.recordId ||
        target.kind !== record.kind || memoryRecordRevision(record) !== memoryRecordRevision(target) + 1 ||
        record.source.supersedesRevisionId !== operation.targetRevisionId ||
        record.occurredAt !== operation.occurredAt || operation.actor.kind !== "local_user_command" ||
        operation.actor.commandId !== record.source.commandId
      ) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory SUPERSEDE operation disagrees with its revisions");
      }
      referenced.add(operation.newRevisionId!);
      heads.set(operation.recordId, { active: true, revisionId: operation.newRevisionId! });
      continue;
    }
    if (
      prior === undefined || !prior.active || prior.revisionId !== operation.targetRevisionId ||
      operation.actor.kind !== "local_user_command"
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory RETRACT operation disagrees with its active head");
    }
    heads.set(operation.recordId, { active: false, revisionId: prior.revisionId });
  }
  if (referenced.size !== revisions.length || revisions.some((record) => !referenced.has(memoryRecordRevisionId(record)))) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory store contains an unreferenced canonical revision");
  }
  const expectedActive = [...heads.values()].filter((head) => head.active).map((head) => head.revisionId).sort();
  const observedActive = activeRecords.map(memoryRecordRevisionId).sort();
  if (canonicalJson(expectedActive) !== canonicalJson(observedActive)) {
    throw new Ml1MemoryError("memory_store_corrupt", "memory active projection disagrees with the operation ledger");
  }
}

export class SqliteEpisodeStore implements MemoryStorePort {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    readonly paths: Ml1MemoryStatePaths,
    private readonly limits: Readonly<{
      readonly maxOperationBytes: number;
      readonly maxOperations: number;
      readonly maxRecords: number;
      readonly maxTotalBytes: number;
    }>,
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
        throw new Ml1MemoryError("memory_store_corrupt", "existing memory database has no supported schema");
      }
      if (tables.length === 0) {
        database.exec("BEGIN IMMEDIATE;");
        try {
          database.exec(SCHEMA_V2_SQL);
          database.exec("COMMIT;");
        } catch (error) {
          database.exec("ROLLBACK;");
          throw error;
        }
      } else {
        const version = tables.includes("metadata") ? metadataVersion(database) : "unknown";
        if (version === "1") {
          validateLegacySchema(database);
          migrateLegacySchema(database);
        } else if (version !== String(MEMORY_STORE_SCHEMA_VERSION)) {
          throw new Ml1MemoryError("memory_store_corrupt", "memory database schema version is unsupported");
        }
      }
      const maxRecords = limitValue(input.limits?.maxRecords, ML1_EPISODE_MAX_RECORDS, ML1_EPISODE_MAX_RECORDS);
      const store = new SqliteEpisodeStore(database, paths, Object.freeze({
        maxOperationBytes: MEMORY_MAX_OPERATION_BYTES,
        maxOperations: Math.min(maxRecords * 2, MEMORY_MAX_OPERATIONS),
        maxRecords,
        maxTotalBytes: limitValue(
          input.limits?.maxTotalBytes,
          ML1_EPISODE_MAX_TOTAL_BYTES,
          ML1_EPISODE_MAX_TOTAL_BYTES,
        ),
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
      const bytes = encodeMemoryRecordV1(record);
      this.assertAdmitted(record);
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const existing = this.database.prepare(
          "SELECT record_sha256, canonical_json FROM memory_records WHERE revision_id = ?",
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
        if (this.headOperation(record.recordId, record.scope) !== null) {
          throw new Ml1MemoryError("memory_store_corrupt", "episode logical identity has an unexpected lifecycle head");
        }
        this.assertRecordCapacity(bytes.byteLength);
        const sequence = this.nextSequence();
        const operation = createMemoryOperationV1({
          actor: { kind: "deterministic_episode" },
          newRevisionId: record.recordId,
          occurredAt: record.occurredAt,
          operation: "ADD",
          recordId: record.recordId,
          scope: record.scope,
          sequence,
          targetRevisionId: null,
        });
        const operationBytes = encodeMemoryOperationV1(operation);
        this.assertOperationCapacity(operationBytes.byteLength);
        insertRecordRow(this.database, record, bytes);
        insertOperationRow(this.database, operation, operationBytes);
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

  async addExplicitRecord(record: ExplicitMemoryRecordV1): Promise<ExplicitMemoryMutationResultV1> {
    return this.mutateExplicit(record, "ADD");
  }

  async supersedeExplicitRecord(record: ExplicitMemoryRecordV1): Promise<ExplicitMemoryMutationResultV1> {
    return this.mutateExplicit(record, "SUPERSEDE");
  }

  async retractRecord(input: Readonly<{
    readonly commandId: string;
    readonly occurredAt: string;
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRetractResultV1> {
    try {
      this.assertOpen();
      const scope = ml1MemoryScopeV1Schema.parse(input.scope);
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const head = this.headOperation(input.recordId, scope);
        if (head === null) {
          throw new Ml1MemoryError("memory_record_not_found", "memory record was not found in this scope");
        }
        const currentRevisionId = head.operation === "RETRACT" ? head.targetRevisionId : head.newRevisionId;
        if (currentRevisionId === null) {
          throw new Ml1MemoryError("memory_store_corrupt", "memory lifecycle head has no target revision");
        }
        const record = this.recordByRevision(currentRevisionId, scope);
        if (record === null || record.recordId !== input.recordId) {
          throw new Ml1MemoryError("memory_store_corrupt", "memory lifecycle head points to a missing revision");
        }
        if (head.operation === "RETRACT") {
          this.database.exec("COMMIT;");
          return Object.freeze({ operation: head, record, status: "already_retracted" });
        }
        const operation = createMemoryOperationV1({
          actor: { commandId: input.commandId, kind: "local_user_command" },
          newRevisionId: null,
          occurredAt: input.occurredAt,
          operation: "RETRACT",
          recordId: input.recordId,
          scope,
          sequence: this.nextSequence(),
          targetRevisionId: currentRevisionId,
        });
        const bytes = encodeMemoryOperationV1(operation);
        // MEMORY-ML4: retract has a dedicated operation reserve and never checks record capacity.
        this.assertOperationCapacity(bytes.byteLength);
        insertOperationRow(this.database, operation, bytes);
        this.database.exec("COMMIT;");
        return Object.freeze({ operation, record, status: "retracted" });
      } catch (error) {
        try { this.database.exec("ROLLBACK;"); } catch { /* mapped below */ }
        throw error;
      }
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async getActiveRecord(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordV1 | null> {
    try {
      this.assertOpen();
      const head = this.headOperation(input.recordId, input.scope);
      if (head === null || head.operation === "RETRACT" || head.newRevisionId === null) return null;
      const record = this.recordByRevision(head.newRevisionId, input.scope);
      if (record === null || record.recordId !== input.recordId) {
        throw new Ml1MemoryError("memory_store_corrupt", "active lifecycle head points to a missing revision");
      }
      return record;
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async getRecordState(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordStateV1 | null> {
    try {
      this.assertOpen();
      const headOperation = this.headOperation(input.recordId, input.scope);
      if (headOperation === null) return null;
      const revisionId = headOperation.operation === "RETRACT"
        ? headOperation.targetRevisionId
        : headOperation.newRevisionId;
      if (revisionId === null) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory lifecycle head has no inspectable revision");
      }
      const record = this.recordByRevision(revisionId, input.scope);
      if (record === null || record.recordId !== input.recordId) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory lifecycle head points to a missing revision");
      }
      return Object.freeze({
        headOperation,
        record,
        status: headOperation.operation === "RETRACT" ? "retracted" : "active",
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  /** ML1 compatibility: retrieval now uses getActiveRecord directly. */
  async getEpisode(input: Readonly<{
    readonly recordId: string;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeRecordV1 | null> {
    const record = await this.getActiveRecord(input);
    return record?.kind === "episode" ? record : null;
  }

  async listActiveRecords(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<MemoryRecordListPageV1> {
    return this.listActive(input, null);
  }

  /** ML1 compatibility page restricted to active episodes. */
  async listEpisodes(input: Readonly<{
    readonly cursor?: string;
    readonly limit: number;
    readonly scope: Ml1MemoryScopeV1;
  }>): Promise<Ml1EpisodeListPageV1> {
    const page = await this.listActive(input, "episode");
    return Object.freeze({
      items: Object.freeze(page.items.map((record) => {
        if (record.kind !== "episode") throw new Ml1MemoryError("memory_store_corrupt", "episode page contained another kind");
        return record;
      })),
      nextCursor: page.nextCursor,
    });
  }

  async logicalDump(scopeInput: Ml1MemoryScopeV1): Promise<MemoryLogicalDumpV1> {
    try {
      this.assertOpen();
      const scope = ml1MemoryScopeV1Schema.parse(scopeInput);
      const args = scopeArgs(scope);
      const revisionRows = this.database.prepare(`
        SELECT * FROM memory_records
        WHERE owner_principal_id = ? AND application_repository_id = ?
          AND canonical_root_identity_sha256 = ?
        ORDER BY record_id ASC, revision ASC
      `).all(...args);
      const operationRows = this.database.prepare(`
        SELECT * FROM memory_operations
        WHERE owner_principal_id = ? AND application_repository_id = ?
          AND canonical_root_identity_sha256 = ?
        ORDER BY sequence ASC
      `).all(...args);
      const revisions = Object.freeze(revisionRows.map((row) => this.decodeRecordRow(row, scope)));
      const operations = Object.freeze(operationRows.map((row) => this.decodeOperationRow(row, scope)));
      const activeRows = this.activeRows(scope, null);
      const records = Object.freeze(activeRows.map((row) => this.decodeRecordRow(row, scope)));
      validateLifecycle(revisions, operations, records);
      const activeRevisionIds = Object.freeze(records.map(memoryRecordRevisionId));
      const revisionBytes = revisionRows.reduce((total, row) => total + numberColumn(row, "canonical_bytes"), 0);
      const operationBytes = operationRows.reduce((total, row) => total + numberColumn(row, "canonical_bytes"), 0);
      const canonical = {
        active_revision_ids: activeRevisionIds,
        operations,
        revisions,
        schema_version: 2,
        scope,
      } as const;
      return Object.freeze({
        activeRevisionIds,
        canonicalBytes: revisionBytes + operationBytes,
        count: records.length,
        logicalSha256: sha256Canonical(canonical),
        operationBytes,
        operationCount: operations.length,
        operations,
        records,
        revisionBytes,
        revisionCount: revisions.length,
        revisions,
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async capacity(): Promise<MemoryCapacityV1> {
    try {
      this.assertOpen();
      const totals = this.capacityTotals();
      return Object.freeze({
        automaticIngestAllowed:
          totals.recordCount < this.limits.maxRecords && totals.recordBytes < this.limits.maxTotalBytes,
        maxOperationBytes: this.limits.maxOperationBytes,
        maxOperations: this.limits.maxOperations,
        maxRecordBytes: this.limits.maxTotalBytes,
        maxRecords: this.limits.maxRecords,
        operationBytes: totals.operationBytes,
        operationCount: totals.operationCount,
        recordBytes: totals.recordBytes,
        recordCount: totals.recordCount,
        retractOperationReserve: Math.max(0, this.limits.maxOperations - totals.operationCount),
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async diagnostics(scope: Ml1MemoryScopeV1): Promise<MemoryStoreDiagnosticsV1> {
    try {
      this.assertOpen();
      this.validateSchema();
      const metadata = await stat(this.paths.databasePath);
      const privacy = process.platform === "win32" || (metadata.mode & 0o077) === 0;
      if (!privacy) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory database permissions are not private");
      }
      const capacity = await this.capacity();
      const dump = await this.logicalDump(scope);
      return Object.freeze({
        capacity,
        databaseBytes: metadata.size,
        logicalSha256: dump.logicalSha256,
        pathPrivacy: process.platform === "win32" ? "platform_managed" : "private",
        quickCheck: "ok",
        schemaVersion: 2,
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  private async mutateExplicit(
    record: ExplicitMemoryRecordV1,
    operationType: "ADD" | "SUPERSEDE",
  ): Promise<ExplicitMemoryMutationResultV1> {
    try {
      this.assertOpen();
      const bytes = encodeMemoryRecordV1(record);
      this.assertAdmitted(record);
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const head = this.headOperation(record.recordId, record.scope);
        let targetRevisionId: string | null = null;
        if (operationType === "ADD") {
          if (head !== null || record.revision !== 1 || record.source.supersedesRevisionId !== null) {
            throw new Ml1MemoryError("memory_lifecycle_conflict", "memory ADD requires a fresh revision-one identity");
          }
        } else {
          if (head === null || head.operation === "RETRACT" || head.newRevisionId === null) {
            throw new Ml1MemoryError("memory_lifecycle_conflict", "memory SUPERSEDE requires an active target");
          }
          const current = this.recordByRevision(head.newRevisionId, record.scope);
          if (
            current === null || current.kind === "episode" || current.recordId !== record.recordId ||
            current.kind !== record.kind || record.revision !== memoryRecordRevision(current) + 1 ||
            record.source.supersedesRevisionId !== memoryRecordRevisionId(current)
          ) {
            throw new Ml1MemoryError("memory_lifecycle_conflict", "memory SUPERSEDE does not match the active explicit revision");
          }
          targetRevisionId = memoryRecordRevisionId(current);
        }
        if (this.database.prepare("SELECT revision_id FROM memory_records WHERE revision_id = ?")
          .get(record.revisionId) !== undefined) {
          throw new Ml1MemoryError("memory_lifecycle_conflict", "memory revision identity already exists");
        }
        this.assertRecordCapacity(bytes.byteLength);
        const operation = createMemoryOperationV1({
          actor: { commandId: record.source.commandId, kind: "local_user_command" },
          newRevisionId: record.revisionId,
          occurredAt: record.occurredAt,
          operation: operationType,
          recordId: record.recordId,
          scope: record.scope,
          sequence: this.nextSequence(),
          targetRevisionId,
        });
        const operationBytes = encodeMemoryOperationV1(operation);
        this.assertOperationCapacity(operationBytes.byteLength);
        insertRecordRow(this.database, record, bytes);
        insertOperationRow(this.database, operation, operationBytes);
        this.database.exec("COMMIT;");
        return Object.freeze({
          operation,
          record,
          status: operationType === "ADD" ? "added" : "superseded",
        });
      } catch (error) {
        try { this.database.exec("ROLLBACK;"); } catch { /* mapped below */ }
        throw error;
      }
    } catch (error) {
      return mapStoreError(error);
    }
  }

  private async listActive(
    input: Readonly<{
      readonly cursor?: string;
      readonly limit: number;
      readonly scope: Ml1MemoryScopeV1;
    }>,
    kind: "episode" | null,
  ): Promise<MemoryRecordListPageV1> {
    try {
      this.assertOpen();
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ML1_EPISODE_PAGE_MAX) {
        throw new Ml1MemoryError("memory_cursor_invalid", "memory list limit must be between 1 and 100");
      }
      const scope = ml1MemoryScopeV1Schema.parse(input.scope);
      const cursor = input.cursor === undefined ? undefined : decodeCursor(scope, input.cursor);
      let rows = this.activeRows(scope, kind);
      if (cursor !== undefined) {
        rows = rows.filter((row) => {
          const occurredAt = textColumn(row, "occurred_at");
          const recordId = textColumn(row, "record_id");
          const revisionId = textColumn(row, "revision_id");
          return occurredAt < cursor.occurredAt ||
            (occurredAt === cursor.occurredAt && recordId > cursor.recordId) ||
            (occurredAt === cursor.occurredAt && recordId === cursor.recordId && revisionId > cursor.revisionId);
        });
      }
      const selected = rows.slice(0, input.limit + 1);
      const items = selected.slice(0, input.limit).map((row) => this.decodeRecordRow(row, scope));
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: selected.length > input.limit && last !== undefined ? encodeCursor(scope, last) : null,
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  private activeRows(scope: Ml1MemoryScopeV1, kind: "episode" | null): Record<string, unknown>[] {
    const args = scopeArgs(scope);
    return this.database.prepare(`
      WITH latest AS (
        SELECT record_id, MAX(sequence) AS sequence
        FROM memory_operations
        WHERE owner_principal_id = ? AND application_repository_id = ?
          AND canonical_root_identity_sha256 = ?
        GROUP BY record_id
      ), active AS (
        SELECT operation.record_id, operation.new_revision_id
        FROM memory_operations AS operation
        JOIN latest ON latest.record_id = operation.record_id AND latest.sequence = operation.sequence
        WHERE operation.operation <> 'RETRACT' AND operation.new_revision_id IS NOT NULL
      )
      SELECT record.*
      FROM active
      JOIN memory_records AS record ON record.revision_id = active.new_revision_id
      ${kind === null ? "" : "WHERE record.kind = 'episode'"}
      ORDER BY record.occurred_at DESC, record.record_id ASC, record.revision_id ASC
    `).all(...args);
  }

  private headOperation(recordId: string, scope: Ml1MemoryScopeV1): MemoryOperationV1 | null {
    const args = scopeArgs(scope);
    const row = this.database.prepare(`
      SELECT * FROM memory_operations
      WHERE owner_principal_id = ? AND application_repository_id = ?
        AND canonical_root_identity_sha256 = ? AND record_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(...args, recordId);
    return row === undefined ? null : this.decodeOperationRow(row, scope);
  }

  private recordByRevision(revisionId: string, scope: Ml1MemoryScopeV1): MemoryRecordV1 | null {
    const args = scopeArgs(scope);
    const row = this.database.prepare(`
      SELECT * FROM memory_records
      WHERE owner_principal_id = ? AND application_repository_id = ?
        AND canonical_root_identity_sha256 = ? AND revision_id = ?
    `).get(...args, revisionId);
    return row === undefined ? null : this.decodeRecordRow(row, scope);
  }

  private nextSequence(): number {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM memory_operations",
    ).get();
    if (row === undefined) throw new Ml1MemoryError("memory_store_corrupt", "memory operation sequence is unavailable");
    const next = numberColumn(row, "maximum") + 1;
    if (!Number.isSafeInteger(next)) throw new Ml1MemoryError("memory_capacity_reached", "memory operation sequence is exhausted");
    return next;
  }

  private capacityTotals(): Readonly<{
    readonly operationBytes: number;
    readonly operationCount: number;
    readonly recordBytes: number;
    readonly recordCount: number;
  }> {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_records) AS record_count,
        (SELECT COALESCE(SUM(canonical_bytes), 0) FROM memory_records) AS record_bytes,
        (SELECT COUNT(*) FROM memory_operations) AS operation_count,
        (SELECT COALESCE(SUM(canonical_bytes), 0) FROM memory_operations) AS operation_bytes
    `).get();
    if (row === undefined) throw new Ml1MemoryError("memory_store_corrupt", "memory capacity totals are unavailable");
    return Object.freeze({
      operationBytes: numberColumn(row, "operation_bytes"),
      operationCount: numberColumn(row, "operation_count"),
      recordBytes: numberColumn(row, "record_bytes"),
      recordCount: numberColumn(row, "record_count"),
    });
  }

  private assertRecordCapacity(additionalBytes: number): void {
    const totals = this.capacityTotals();
    if (
      totals.recordCount >= this.limits.maxRecords ||
      totals.recordBytes + additionalBytes > this.limits.maxTotalBytes
    ) {
      throw new Ml1MemoryError("memory_capacity_reached", "memory store reached its hard record capacity bound");
    }
  }

  private assertOperationCapacity(additionalBytes: number): void {
    const totals = this.capacityTotals();
    if (
      totals.operationCount >= this.limits.maxOperations ||
      totals.operationBytes + additionalBytes > this.limits.maxOperationBytes
    ) {
      throw new Ml1MemoryError("memory_capacity_reached", "memory store reached its hard lifecycle capacity bound");
    }
  }

  private assertAdmitted(record: MemoryRecordV1): void {
    const admission = inspectMemoryAdmission([
      record.text,
      ...(record.kind === "episode" ? [record.taskPreview] : []),
    ]);
    if (!admission.admitted) {
      throw new Ml1MemoryError("memory_record_not_admitted", "memory record did not pass sensitive-content admission");
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
    if (canonicalJson(tables) !== canonicalJson(V2_TABLES)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database schema contains unknown or missing tables");
    }
    if (metadataVersion(this.database) !== String(MEMORY_STORE_SCHEMA_VERSION)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database schema version is unsupported");
    }
    const expectedMetadata = [
      [0, "key", "TEXT", 1, null, 1],
      [1, "value", "TEXT", 1, null, 0],
    ];
    const expectedRecords = [
      [0, "revision_id", "TEXT", 1, null, 1],
      [1, "record_id", "TEXT", 1, null, 0],
      [2, "revision", "INTEGER", 1, null, 0],
      [3, "kind", "TEXT", 1, null, 0],
      [4, "owner_principal_id", "TEXT", 1, null, 0],
      [5, "application_repository_id", "TEXT", 1, null, 0],
      [6, "canonical_root_identity_sha256", "TEXT", 1, null, 0],
      [7, "occurred_at", "TEXT", 1, null, 0],
      [8, "record_sha256", "TEXT", 1, null, 0],
      [9, "canonical_bytes", "INTEGER", 1, null, 0],
      [10, "canonical_json", "BLOB", 1, null, 0],
    ];
    const expectedOperations = [
      [0, "operation_id", "TEXT", 1, null, 1],
      [1, "sequence", "INTEGER", 1, null, 0],
      [2, "record_id", "TEXT", 1, null, 0],
      [3, "operation", "TEXT", 1, null, 0],
      [4, "new_revision_id", "TEXT", 0, null, 0],
      [5, "target_revision_id", "TEXT", 0, null, 0],
      [6, "owner_principal_id", "TEXT", 1, null, 0],
      [7, "application_repository_id", "TEXT", 1, null, 0],
      [8, "canonical_root_identity_sha256", "TEXT", 1, null, 0],
      [9, "occurred_at", "TEXT", 1, null, 0],
      [10, "operation_sha256", "TEXT", 1, null, 0],
      [11, "canonical_bytes", "INTEGER", 1, null, 0],
      [12, "canonical_json", "BLOB", 1, null, 0],
    ];
    if (
      canonicalJson(columnSignature(this.database, "metadata")) !== canonicalJson(expectedMetadata) ||
      canonicalJson(columnSignature(this.database, "memory_records")) !== canonicalJson(expectedRecords) ||
      canonicalJson(columnSignature(this.database, "memory_operations")) !== canonicalJson(expectedOperations)
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database columns do not match schema 2");
    }
    const indexes = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name ASC",
    ).all().map((row) => textColumn(row, "name"));
    if (canonicalJson(indexes) !== canonicalJson([
      "memory_operation_record_sequence_v2",
      "memory_operation_scope_sequence_v2",
      "memory_operation_sequence_v2",
      "memory_record_logical_revision_v2",
      "memory_record_scope_time_v2",
    ])) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory database indexes are incomplete");
    }
    const expectedIndexKeys = new Map<string, readonly unknown[]>([
      ["memory_operation_record_sequence_v2", [["record_id", 0], ["sequence", 1]]],
      ["memory_operation_scope_sequence_v2", [
        ["owner_principal_id", 0],
        ["application_repository_id", 0],
        ["canonical_root_identity_sha256", 0],
        ["sequence", 0],
      ]],
      ["memory_operation_sequence_v2", [["sequence", 0]]],
      ["memory_record_logical_revision_v2", [["record_id", 0], ["revision", 0]]],
      ["memory_record_scope_time_v2", [
        ["owner_principal_id", 0],
        ["application_repository_id", 0],
        ["canonical_root_identity_sha256", 0],
        ["occurred_at", 1],
        ["record_id", 0],
        ["revision", 1],
      ]],
    ]);
    for (const [name, expected] of expectedIndexKeys) {
      if (canonicalJson(indexKeySignature(this.database, name)) !== canonicalJson(expected)) {
        throw new Ml1MemoryError("memory_store_corrupt", "memory database index columns do not match schema 2");
      }
    }
  }

  private decodeRecordRow(row: Record<string, unknown>, expectedScope: Ml1MemoryScopeV1): MemoryRecordV1 {
    const stored = row.canonical_json;
    if (!(stored instanceof Uint8Array)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory record payload is not a blob");
    }
    const bytes = Buffer.from(stored);
    const record = decodeMemoryRecordV1(bytes);
    const scope = scopeArgs(expectedScope);
    if (
      textColumn(row, "revision_id") !== memoryRecordRevisionId(record) ||
      textColumn(row, "record_id") !== record.recordId ||
      numberColumn(row, "revision") !== memoryRecordRevision(record) ||
      textColumn(row, "kind") !== record.kind ||
      textColumn(row, "record_sha256") !== record.recordSha256 ||
      textColumn(row, "owner_principal_id") !== scope[0] ||
      textColumn(row, "application_repository_id") !== scope[1] ||
      textColumn(row, "canonical_root_identity_sha256") !== scope[2] ||
      textColumn(row, "occurred_at") !== record.occurredAt ||
      numberColumn(row, "canonical_bytes") !== bytes.byteLength ||
      !sameMemoryScope(record.scope, expectedScope)
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory row columns disagree with canonical record bytes");
    }
    this.assertAdmitted(record);
    return record;
  }

  private decodeOperationRow(row: Record<string, unknown>, expectedScope: Ml1MemoryScopeV1): MemoryOperationV1 {
    const stored = row.canonical_json;
    if (!(stored instanceof Uint8Array)) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory operation payload is not a blob");
    }
    const bytes = Buffer.from(stored);
    const operation = decodeMemoryOperationV1(bytes);
    const scope = scopeArgs(expectedScope);
    if (
      textColumn(row, "operation_id") !== operation.operationId ||
      numberColumn(row, "sequence") !== operation.sequence ||
      textColumn(row, "record_id") !== operation.recordId ||
      textColumn(row, "operation") !== operation.operation ||
      nullableTextColumn(row, "new_revision_id") !== operation.newRevisionId ||
      nullableTextColumn(row, "target_revision_id") !== operation.targetRevisionId ||
      textColumn(row, "operation_sha256") !== operation.operationSha256 ||
      textColumn(row, "owner_principal_id") !== scope[0] ||
      textColumn(row, "application_repository_id") !== scope[1] ||
      textColumn(row, "canonical_root_identity_sha256") !== scope[2] ||
      textColumn(row, "occurred_at") !== operation.occurredAt ||
      numberColumn(row, "canonical_bytes") !== bytes.byteLength ||
      !sameMemoryScope(operation.scope, expectedScope)
    ) {
      throw new Ml1MemoryError("memory_store_corrupt", "memory operation columns disagree with canonical bytes");
    }
    return operation;
  }
}
