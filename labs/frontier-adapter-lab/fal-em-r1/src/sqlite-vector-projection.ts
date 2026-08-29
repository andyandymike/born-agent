import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

export interface EmR1VectorProjectionRow {
  readonly key: string;
  readonly occurredAt: string;
  readonly projectionInputSha256: string;
  readonly recordId: string;
  readonly revisionId: string;
  readonly vector: Float32Array;
}

export interface EmR1ScoredVectorRow extends EmR1VectorProjectionRow {
  readonly similarityMicros: number;
}

export interface EmR1VectorProjectionIdentity {
  readonly activeRevisionSetSha256: string;
  readonly canonicalLogicalSha256: string;
  readonly modelArtifactManifestSha256: string;
  readonly projectionSchemaSha256: string;
  readonly scopeSha256: string;
}

const CREATE_SQL = `
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE vectors (
  record_id TEXT NOT NULL,
  revision_id TEXT PRIMARY KEY,
  fixture_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  projection_input_sha256 TEXT NOT NULL,
  model_manifest_sha256 TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = 384),
  vector_float32_le BLOB NOT NULL CHECK (length(vector_float32_le) = 1536)
) STRICT;
`;

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vectorBytes(vector: Float32Array): Uint8Array {
  if (vector.length !== 384) throw new Error("EM-R1 vector projection requires 384 dimensions");
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function vectorFromBytes(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength !== 384 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("EM-R1 vector projection row has an invalid byte length");
  }
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer, copy.byteOffset, 384);
}

function metadata(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key ASC").all() as Array<{
    readonly key: string;
    readonly value: string;
  }>;
  return new Map(rows.map((entry) => [entry.key, entry.value]));
}

function validateVector(vector: Float32Array): void {
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("EM-R1 vector projection contains a non-finite value");
    normSquared += value * value;
  }
  if (Math.abs(Math.sqrt(normSquared) - 1) > 1e-3) {
    throw new Error("EM-R1 vector projection row is not L2 normalized");
  }
}

function orderedRows<T extends Readonly<{
  readonly occurredAt: string;
  readonly recordId: string;
  readonly revisionId: string;
}>>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.recordId.localeCompare(right.recordId) ||
    left.revisionId.localeCompare(right.revisionId));
}

export class SqliteVectorProjection {
  private constructor(
    private readonly database: DatabaseSync,
    readonly databaseBytes: number,
    readonly identity: EmR1VectorProjectionIdentity,
    readonly logicalSha256: string,
    readonly rows: readonly EmR1VectorProjectionRow[],
  ) {}

  static async build(input: Readonly<{
    readonly identity: EmR1VectorProjectionIdentity;
    readonly path: string;
    readonly rows: readonly EmR1VectorProjectionRow[];
  }>): Promise<SqliteVectorProjection> {
    await mkdir(dirname(input.path), { recursive: true });
    const temporaryPath = `${input.path}.${randomUUID()}.tmp`;
    const database = new DatabaseSync(temporaryPath);
    try {
      database.exec("PRAGMA page_size = 16384;");
      database.exec(CREATE_SQL);
      const insertMetadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
      const canonicalRows = orderedRows(input.rows);
      const rowLogical = canonicalRows.map((entry) => ({
        key: entry.key,
        occurredAt: entry.occurredAt,
        projectionInputSha256: entry.projectionInputSha256,
        recordId: entry.recordId,
        revisionId: entry.revisionId,
        vectorSha256: rawSha256(vectorBytes(entry.vector)),
      }));
      const logicalSha256 = sha256Canonical({
        identity: input.identity,
        rows: rowLogical,
        schemaVersion: 1,
      });
      const metadataRows = {
        active_revision_set_sha256: input.identity.activeRevisionSetSha256,
        canonical_logical_sha256: input.identity.canonicalLogicalSha256,
        logical_sha256: logicalSha256,
        model_manifest_sha256: input.identity.modelArtifactManifestSha256,
        projection_schema_sha256: input.identity.projectionSchemaSha256,
        row_count: String(input.rows.length),
        scope_sha256: input.identity.scopeSha256,
        schema_version: "1",
      };
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const [key, value] of Object.entries(metadataRows)) insertMetadata.run(key, value);
        const insert = database.prepare(`
          INSERT INTO vectors(
            record_id, revision_id, fixture_key, occurred_at,
            projection_input_sha256, model_manifest_sha256,
            dimensions, vector_float32_le
          ) VALUES (?, ?, ?, ?, ?, ?, 384, ?)
        `);
        for (const row of canonicalRows) {
          validateVector(row.vector);
          insert.run(
            row.recordId,
            row.revisionId,
            row.key,
            row.occurredAt,
            row.projectionInputSha256,
            input.identity.modelArtifactManifestSha256,
            vectorBytes(row.vector),
          );
        }
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      database.close();
    }
    await rename(temporaryPath, input.path);
    return await SqliteVectorProjection.open(input.path, input.identity);
  }

  static async open(
    path: string,
    expectedIdentity: EmR1VectorProjectionIdentity,
  ): Promise<SqliteVectorProjection> {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const quickCheck = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      if (!Object.values(quickCheck).includes("ok")) {
        throw new Error("EM-R1 vector projection quick_check failed");
      }
      const values = metadata(database);
      const expected = {
        active_revision_set_sha256: expectedIdentity.activeRevisionSetSha256,
        canonical_logical_sha256: expectedIdentity.canonicalLogicalSha256,
        model_manifest_sha256: expectedIdentity.modelArtifactManifestSha256,
        projection_schema_sha256: expectedIdentity.projectionSchemaSha256,
        scope_sha256: expectedIdentity.scopeSha256,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (values.get(key) !== value) throw new Error(`EM-R1 vector projection ${key} mismatch`);
      }
      const rows = (database.prepare(`
        SELECT record_id, revision_id, fixture_key, occurred_at,
          projection_input_sha256, model_manifest_sha256, dimensions, vector_float32_le
        FROM vectors ORDER BY occurred_at DESC, record_id ASC, revision_id ASC
      `).all() as Array<Record<string, unknown>>).map((entry) => {
        if (
          entry.model_manifest_sha256 !== expectedIdentity.modelArtifactManifestSha256 ||
          entry.dimensions !== 384 ||
          !(entry.vector_float32_le instanceof Uint8Array)
        ) throw new Error("EM-R1 vector projection row metadata is invalid");
        const vector = vectorFromBytes(entry.vector_float32_le);
        validateVector(vector);
        return Object.freeze({
          key: String(entry.fixture_key),
          occurredAt: String(entry.occurred_at),
          projectionInputSha256: String(entry.projection_input_sha256),
          recordId: String(entry.record_id),
          revisionId: String(entry.revision_id),
          vector,
        });
      });
      if (String(rows.length) !== values.get("row_count")) {
        throw new Error("EM-R1 vector projection row count mismatch");
      }
      const rowLogical = rows.map((entry) => ({
        key: entry.key,
        occurredAt: entry.occurredAt,
        projectionInputSha256: entry.projectionInputSha256,
        recordId: entry.recordId,
        revisionId: entry.revisionId,
        vectorSha256: rawSha256(vectorBytes(entry.vector)),
      }));
      const logicalSha256 = sha256Canonical({
        identity: expectedIdentity,
        rows: rowLogical,
        schemaVersion: 1,
      });
      if (logicalSha256 !== values.get("logical_sha256")) {
        throw new Error("EM-R1 vector projection logical hash mismatch");
      }
      return new SqliteVectorProjection(
        database,
        (await stat(path)).size,
        expectedIdentity,
        logicalSha256,
        Object.freeze(rows),
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  scan(query: Float32Array, thresholdSimilarityMicros: number): readonly EmR1ScoredVectorRow[] {
    return Object.freeze(this.scoreAll(query)
      .filter((row) => row.similarityMicros >= thresholdSimilarityMicros)
      .slice(0, 100));
  }

  scoreAll(query: Float32Array): readonly EmR1ScoredVectorRow[] {
    validateVector(query);
    const scored: EmR1ScoredVectorRow[] = [];
    for (const row of this.rows) {
      let cosine = 0;
      for (let index = 0; index < 384; index += 1) cosine += query[index]! * row.vector[index]!;
      const similarityMicros = Math.round(cosine * 1_000_000);
      scored.push(Object.freeze({ ...row, similarityMicros }));
    }
    scored.sort((left, right) =>
      right.similarityMicros - left.similarityMicros ||
      right.occurredAt.localeCompare(left.occurredAt) ||
      left.recordId.localeCompare(right.recordId) ||
      left.revisionId.localeCompare(right.revisionId));
    return Object.freeze(scored);
  }

  close(): void {
    this.database.close();
  }
}
