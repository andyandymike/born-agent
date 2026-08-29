import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { SqliteVectorProjection } from "../src/sqlite-vector-projection.js";

function unit(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}

describe("FAL-EM-R1 retained SQLite vector projection", () => {
  it("round-trips Float32 rows and applies exact-cosine threshold ordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-em-r1-vector-"));
    const identity = {
      activeRevisionSetSha256: sha256Canonical(["revision-a", "revision-b", "revision-c"]),
      canonicalLogicalSha256: sha256Canonical({ corpus: "unit", schemaVersion: 1 }),
      modelArtifactManifestSha256: "a".repeat(64),
      projectionSchemaSha256: "b".repeat(64),
      scopeSha256: "c".repeat(64),
    };
    const rows = [
      { key: "a", occurredAt: "2026-01-03T00:00:00.000Z", projectionInputSha256: "d".repeat(64), recordId: "record-a", revisionId: "revision-a", vector: unit(0) },
      { key: "b", occurredAt: "2026-01-02T00:00:00.000Z", projectionInputSha256: "e".repeat(64), recordId: "record-b", revisionId: "revision-b", vector: unit(1) },
      { key: "c", occurredAt: "2026-01-01T00:00:00.000Z", projectionInputSha256: "f".repeat(64), recordId: "record-c", revisionId: "revision-c", vector: unit(2) },
    ];
    const projection = await SqliteVectorProjection.build({
      identity,
      path: join(root, "vectors.sqlite"),
      rows,
    });
    try {
      expect(projection.rows).toHaveLength(3);
      expect(projection.scan(unit(0), 1_000_000).map((entry) => entry.key)).toEqual(["a"]);
      expect(projection.scan(unit(0), 1).map((entry) => entry.key)).toEqual(["a"]);
      expect(projection.scan(unit(0), 0).map((entry) => entry.key)).toEqual(["a", "b", "c"]);
      expect(projection.databaseBytes).toBeGreaterThan(0);
    } finally {
      projection.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
