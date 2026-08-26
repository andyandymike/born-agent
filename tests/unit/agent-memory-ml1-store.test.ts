import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { createMl1EpisodeRecordV1, type Ml1EpisodeRecordV1, type Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import { SqliteEpisodeStore } from "../../src/memory/store/sqlite-episode-store.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixtureRecord(): Promise<Ml1EpisodeRecordV1> {
  const manifest = JSON.parse(await readFile(resolve("fixtures/agent-memory/ml1/manifest.json"), "utf8")) as {
    readonly expectedRecord: Ml1EpisodeRecordV1;
  };
  return manifest.expectedRecord;
}

function alternateRecord(record: Ml1EpisodeRecordV1): Ml1EpisodeRecordV1 {
  const source = {
    ...record.source,
    endEventId: "alternate-end",
    rangeSha256: "b".repeat(64),
    runId: "alternate-run",
  };
  const recordId = `episode_${sha256Canonical({ schema_version: 1, scope: record.scope, source })}`;
  const { recordSha256: _recordSha256, ...content } = record;
  void _recordSha256;
  return createMl1EpisodeRecordV1({ ...content, recordId, source });
}

function conflictingRecord(record: Ml1EpisodeRecordV1): Ml1EpisodeRecordV1 {
  const taskPreview = "Different task projection";
  const { recordSha256: _recordSha256, ...content } = record;
  void _recordSha256;
  return createMl1EpisodeRecordV1({
    ...content,
    taskInputSha256: "c".repeat(64),
    taskPreview,
    text: [
      `Task: ${taskPreview}`,
      "Outcome: completed",
      `Completion mode: ${record.completion.mode}`,
      `Steps: ${String(record.completion.steps)}`,
      `Tool calls: ${String(record.completion.toolCalls)}`,
      `Evidence: ${record.completion.evidenceSha256 ?? "none"}`,
    ].join("\n"),
  });
}

async function store(limits?: Readonly<{ readonly maxRecords?: number; readonly maxTotalBytes?: number }>) {
  const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-ml1-store-"));
  temporary.push(stateRoot);
  return { opened: await SqliteEpisodeStore.create({ ...(limits === undefined ? {} : { limits }), stateRoot }), stateRoot };
}

describe("Agent memory ML1 SQLite episode store", () => {
  it("ML1 SQLite episode store applies exact scope predicates to every get and list", async () => {
    const { opened } = await store();
    try {
      const record = await fixtureRecord();
      await opened.ingestEpisode(record);
      await opened.ingestEpisode(alternateRecord(record));
      const first = await opened.listEpisodes({ limit: 1, scope: record.scope });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();

      for (const scope of [
        { ...record.scope, ownerPrincipalId: "another_owner" },
        { ...record.scope, applicationRepositoryId: "another_repository" },
        { ...record.scope, canonicalRootIdentitySha256: "e".repeat(64) },
      ] satisfies Ml1MemoryScopeV1[]) {
        expect(await opened.getEpisode({ recordId: record.recordId, scope })).toBeNull();
        expect((await opened.listEpisodes({ limit: 100, scope })).items).toEqual([]);
        await expect(opened.listEpisodes({ cursor: first.nextCursor!, limit: 1, scope }))
          .rejects.toMatchObject({ code: "memory_cursor_invalid" });
      }
    } finally {
      opened.close();
    }
  });

  it("ML1 SQLite episode store makes duplicate ingest idempotent and conflicting bytes corrupt", async () => {
    const { opened } = await store();
    try {
      const record = await fixtureRecord();
      expect(await opened.ingestEpisode(record)).toEqual({ status: "inserted" });
      for (let index = 0; index < 9; index += 1) {
        expect(await opened.ingestEpisode(record)).toEqual({ status: "already_present" });
      }
      expect((await opened.logicalDump(record.scope)).count).toBe(1);
      await expect(opened.ingestEpisode(conflictingRecord(record)))
        .rejects.toMatchObject({ code: "memory_store_corrupt" });
      expect((await opened.getEpisode({ recordId: record.recordId, scope: record.scope }))?.recordSha256).toBe(record.recordSha256);
    } finally {
      opened.close();
    }
  });

  it("fails closed on a future schema without replacing the database", async () => {
    const { opened, stateRoot } = await store();
    const path = opened.paths.databasePath;
    opened.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
    raw.close();
    await expect(SqliteEpisodeStore.create({ stateRoot }))
      .rejects.toMatchObject({ code: "memory_store_corrupt" });
    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: "2" });
    readback.close();
  });

  it("fails closed on an existing invalid database instead of initializing over it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bornagent-ml1-invalid-store-"));
    temporary.push(stateRoot);
    const versionRoot = join(stateRoot, "memory", "v1");
    const path = join(versionRoot, "memory.sqlite3");
    await mkdir(versionRoot, { recursive: true });
    await writeFile(path, Buffer.alloc(0));
    await expect(SqliteEpisodeStore.create({ stateRoot }))
      .rejects.toMatchObject({ code: "memory_store_corrupt" });
    expect((await stat(path)).size).toBe(0);
  });

  it("stops automatic ingest at the hard logical capacity without a partial row", async () => {
    const { opened } = await store({ maxRecords: 1 });
    try {
      const record = await fixtureRecord();
      expect(await opened.ingestEpisode(record)).toEqual({ status: "inserted" });
      await expect(opened.ingestEpisode(alternateRecord(record)))
        .rejects.toMatchObject({ code: "memory_capacity_reached" });
      expect((await opened.logicalDump(record.scope)).count).toBe(1);
    } finally {
      opened.close();
    }
  });
});
