import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/completion/canonical-json.js";
import { encodeMl1EpisodeRecord } from "../../src/memory/core/ml1-episode-codec.js";
import type { Ml1EpisodeRecordV1, Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import { createExplicitMemoryRecordV1 } from "../../src/memory/core/memory-record-v1.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function stateRoot(prefix = "bornagent-ml4-lifecycle-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

const scope: Ml1MemoryScopeV1 = Object.freeze({
  applicationRepositoryId: "00000000-0000-4000-8000-000000000411",
  canonicalRootIdentitySha256: "5".repeat(64),
  ownerPrincipalId: "local_owner",
});

function explicit(input: Readonly<{
  readonly commandId: string;
  readonly occurredAt: string;
  readonly recordId?: string;
  readonly revision: number;
  readonly supersedesRevisionId: string | null;
  readonly text: string;
}>) {
  return createExplicitMemoryRecordV1({ ...input, kind: "fact", scope });
}

async function episodeFixture(): Promise<Ml1EpisodeRecordV1> {
  return (JSON.parse(await readFile(resolve("fixtures/agent-memory/ml1/manifest.json"), "utf8")) as {
    readonly expectedRecord: Ml1EpisodeRecordV1;
  }).expectedRecord;
}

describe("Agent memory ML4 lifecycle store", () => {
  it("exposes only the active superseding revision and makes retract idempotent", async () => {
    const store = await SqliteEpisodeStore.create({ stateRoot: await stateRoot() });
    try {
      const first = explicit({
        commandId: "00000000-0000-4000-8000-000000000412",
        occurredAt: "2026-08-26T05:00:00.000Z",
        revision: 1,
        supersedesRevisionId: null,
        text: "The memory lifecycle starts at revision one.",
      });
      expect(await store.addExplicitRecord(first)).toMatchObject({ status: "added" });
      expect(await store.getActiveRecord({ recordId: first.recordId, scope })).toEqual(first);

      const second = explicit({
        commandId: "00000000-0000-4000-8000-000000000413",
        occurredAt: "2026-08-26T05:01:00.000Z",
        recordId: first.recordId,
        revision: 2,
        supersedesRevisionId: first.revisionId,
        text: "The active memory lifecycle now points only at revision two.",
      });
      expect(await store.supersedeExplicitRecord(second)).toMatchObject({ status: "superseded" });
      expect(await store.getActiveRecord({ recordId: first.recordId, scope })).toEqual(second);
      expect((await store.listActiveRecords({ limit: 100, scope })).items).toEqual([second]);
      expect(await store.logicalDump(scope)).toMatchObject({ count: 1, operationCount: 2, revisionCount: 2 });

      const retracted = await store.retractRecord({
        commandId: "00000000-0000-4000-8000-000000000414",
        occurredAt: "2026-08-26T05:02:00.000Z",
        recordId: first.recordId,
        scope,
      });
      expect(retracted).toMatchObject({ status: "retracted" });
      expect(await store.getActiveRecord({ recordId: first.recordId, scope })).toBeNull();
      expect(await store.getRecordState({ recordId: first.recordId, scope })).toMatchObject({
        record: second,
        status: "retracted",
      });
      expect(await store.logicalDump(scope)).toMatchObject({ count: 0, operationCount: 3, revisionCount: 2 });

      const again = await store.retractRecord({
        commandId: "00000000-0000-4000-8000-000000000415",
        occurredAt: "2026-08-26T05:03:00.000Z",
        recordId: first.recordId,
        scope,
      });
      expect(again).toMatchObject({ status: "already_retracted" });
      expect((await store.logicalDump(scope)).operationCount).toBe(3);
    } finally {
      store.close();
    }
  });

  it("keeps one retract operation available after automatic episode ingest reaches record capacity", async () => {
    const store = await SqliteEpisodeStore.create({
      limits: { maxRecords: 1 },
      stateRoot: await stateRoot("bornagent-ml4-capacity-"),
    });
    try {
      const episode = await episodeFixture();
      expect(await store.ingestEpisode(episode)).toEqual({ status: "inserted" });
      const explicitRecord = explicit({
        commandId: "00000000-0000-4000-8000-000000000416",
        occurredAt: "2026-08-26T05:04:00.000Z",
        revision: 1,
        supersedesRevisionId: null,
        text: "This record cannot cross the full capacity boundary.",
      });
      await expect(store.addExplicitRecord(explicitRecord)).rejects.toMatchObject({ code: "memory_capacity_reached" });
      expect((await store.capacity()).automaticIngestAllowed).toBe(false);
      await expect(store.retractRecord({
        commandId: "00000000-0000-4000-8000-000000000417",
        occurredAt: "2026-08-26T05:05:00.000Z",
        recordId: episode.recordId,
        scope: episode.scope,
      })).resolves.toMatchObject({ status: "retracted" });
    } finally {
      store.close();
    }
  });

  it("rejects secret-bearing explicit text before any canonical revision or operation is inserted", async () => {
    const store = await SqliteEpisodeStore.create({ stateRoot: await stateRoot("bornagent-ml4-secret-") });
    try {
      const secret = explicit({
        commandId: "00000000-0000-4000-8000-000000000418",
        occurredAt: "2026-08-26T05:06:00.000Z",
        revision: 1,
        supersedesRevisionId: null,
        text: "Authorization: Bearer fixture-secret-value",
      });
      await expect(store.addExplicitRecord(secret)).rejects.toMatchObject({ code: "memory_record_not_admitted" });
      expect(await store.logicalDump(scope)).toMatchObject({ operationCount: 0, revisionCount: 0 });
    } finally {
      store.close();
    }
  });

  it("atomically migrates the exact ML1 episode bytes into schema 2 revision and ADD operation", async () => {
    const root = await stateRoot("bornagent-ml4-migration-");
    const path = join(root, "memory", "v1", "memory.sqlite3");
    await mkdir(dirname(path), { recursive: true });
    const episode = await episodeFixture();
    const bytes = encodeMl1EpisodeRecord(episode);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
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
        owner_principal_id, application_repository_id, canonical_root_identity_sha256,
        occurred_at DESC, record_id ASC
      );
      INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
    `);
    legacy.prepare(`
      INSERT INTO episode_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.recordId,
      episode.scope.ownerPrincipalId,
      episode.scope.applicationRepositoryId,
      episode.scope.canonicalRootIdentitySha256,
      episode.occurredAt,
      episode.recordSha256,
      bytes.byteLength,
      bytes,
    );
    legacy.close();

    const store = await SqliteEpisodeStore.create({ stateRoot: root });
    try {
      const migrated = await store.getActiveRecord({ recordId: episode.recordId, scope: episode.scope });
      expect(canonicalJson(migrated)).toBe(canonicalJson(episode));
      expect(await store.logicalDump(episode.scope)).toMatchObject({
        count: 1,
        operationCount: 1,
        revisionCount: 1,
      });
    } finally {
      store.close();
    }
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(inspected.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: "2" });
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([{ name: "memory_operations" }, { name: "memory_records" }, { name: "metadata" }]);
    inspected.close();
  });
});
