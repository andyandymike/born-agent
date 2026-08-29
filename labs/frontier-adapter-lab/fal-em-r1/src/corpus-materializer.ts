import { createHash } from "node:crypto";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  createMl1EpisodeRecordV1,
  type Ml1EpisodeRecordV1,
  type Ml1MemoryScopeV1,
} from "../../../../src/memory/core/ml1-episode-record.js";
import {
  createExplicitMemoryRecordV1,
  memoryRecordRevisionId,
  type ExplicitMemoryRecordV1,
  type MemoryRecordV1,
} from "../../../../src/memory/core/memory-record-v1.js";
import { Fts5EpisodeProjection } from "../../../../src/memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../../../../src/memory/retrieval/lexical-memory-search-service.js";
import { SqliteEpisodeStore } from "../../../../src/memory/store/sqlite-episode-store.js";
import type { EmR1Pool, EmR1PoolRow } from "./experiment-schema.js";

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function emR1ScopeFor(
  split: EmR1Pool["split"],
  kind: EmR1PoolRow["scope"],
): Ml1MemoryScopeV1 {
  const current = Object.freeze({
    ownerPrincipalId: "fal-em-r1-local-user",
    applicationRepositoryId: `fal-em-r1:${split}`,
    canonicalRootIdentitySha256: rawSha256(`fal-em-r1-root:${split}`),
  });
  if (kind === "current") return current;
  if (kind === "foreign_repository") {
    return Object.freeze({
      ...current,
      applicationRepositoryId: `${current.applicationRepositoryId}:foreign`,
      canonicalRootIdentitySha256: rawSha256(`fal-em-r1-foreign-root:${split}`),
    });
  }
  return Object.freeze({ ...current, ownerPrincipalId: "fal-em-r1-foreign-user" });
}

function episodeRecord(split: EmR1Pool["split"], fixture: EmR1PoolRow): Ml1EpisodeRecordV1 {
  const scope = emR1ScopeFor(split, fixture.scope);
  const sourceIdentity = `${split}:${fixture.key}`;
  const source = Object.freeze({
    endEventId: `end-${sourceIdentity}`,
    endRawSha256: rawSha256(`end:${sourceIdentity}`),
    endSequence: 2,
    kind: "session_run_range" as const,
    rangeSha256: rawSha256(`range:${sourceIdentity}`),
    runId: `run-${sourceIdentity}`,
    sessionId: `session-${sourceIdentity}`,
    startEventId: `start-${sourceIdentity}`,
    startRawSha256: rawSha256(`start:${sourceIdentity}`),
    startSequence: 1,
  });
  const taskPreview = `${fixture.title}: ${fixture.text}`;
  return createMl1EpisodeRecordV1({
    completion: {
      evidenceSha256: null,
      mode: "model_final",
      reportSha256: null,
      steps: 1,
      toolCalls: 0,
    },
    kind: "episode",
    occurredAt: fixture.occurredAt,
    origin: "deterministic_episode",
    recordId: `episode_${sha256Canonical({ schema_version: 1, scope, source })}`,
    schemaVersion: 1,
    scope,
    source,
    taskInputSha256: rawSha256(`${fixture.title}\n${fixture.text}`),
    taskPreview,
    text: [
      `Task: ${taskPreview}`,
      "Outcome: completed",
      "Completion mode: model_final",
      "Steps: 1",
      "Tool calls: 0",
      "Evidence: none",
    ].join("\n"),
  });
}

function explicitRecord(
  split: EmR1Pool["split"],
  fixture: EmR1PoolRow,
  input: Readonly<{
    readonly recordId?: string;
    readonly revision: number;
    readonly supersedesRevisionId: string | null;
  }>,
): ExplicitMemoryRecordV1 {
  return createExplicitMemoryRecordV1({
    commandId: `fal-em-r1:${split}:${fixture.key}`,
    kind: "decision",
    occurredAt: fixture.occurredAt,
    ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
    revision: input.revision,
    scope: emR1ScopeFor(split, "current"),
    supersedesRevisionId: input.supersedesRevisionId,
    text: fixture.text,
  });
}

export interface MaterializedEmR1Corpus {
  readonly currentScope: Ml1MemoryScopeV1;
  readonly fixtureByRevisionId: ReadonlyMap<string, EmR1PoolRow>;
  readonly keyByRevisionId: ReadonlyMap<string, string>;
  readonly projection: Fts5EpisodeProjection;
  readonly recordByKey: ReadonlyMap<string, MemoryRecordV1>;
  readonly service: LexicalMemorySearchService;
  readonly store: SqliteEpisodeStore;
}

export async function materializeEmR1Corpus(
  stateRoot: string,
  pool: EmR1Pool,
): Promise<MaterializedEmR1Corpus> {
  const store = await SqliteEpisodeStore.create({ stateRoot });
  const recordByKey = new Map<string, MemoryRecordV1>();
  const keyByRevisionId = new Map<string, string>();
  const fixtureByRevisionId = new Map<string, EmR1PoolRow>();
  const remember = (fixture: EmR1PoolRow, record: MemoryRecordV1): void => {
    const revisionId = memoryRecordRevisionId(record);
    recordByKey.set(fixture.key, record);
    keyByRevisionId.set(revisionId, fixture.key);
    fixtureByRevisionId.set(revisionId, fixture);
  };

  try {
    for (const fixture of pool.rows) {
      if (fixture.lifecycle !== "episode_active") continue;
      const record = episodeRecord(pool.split, fixture);
      await store.ingestEpisode(record);
      remember(fixture, record);
    }
    for (const fixture of pool.rows) {
      if (fixture.lifecycle === "explicit_active") {
        const record = explicitRecord(pool.split, fixture, {
          revision: 1,
          supersedesRevisionId: null,
        });
        await store.addExplicitRecord(record);
        remember(fixture, record);
      }
      if (fixture.lifecycle === "explicit_retracted") {
        const record = explicitRecord(pool.split, fixture, {
          revision: 1,
          supersedesRevisionId: null,
        });
        await store.addExplicitRecord(record);
        await store.retractRecord({
          commandId: `fal-em-r1-retract:${pool.split}:${fixture.key}`,
          occurredAt: new Date(Date.parse(fixture.occurredAt) + 1).toISOString(),
          recordId: record.recordId,
          scope: record.scope,
        });
        remember(fixture, record);
      }
    }
    const groups = new Map<string, EmR1PoolRow[]>();
    for (const fixture of pool.rows) {
      if (fixture.revisionGroup === null) continue;
      groups.set(fixture.revisionGroup, [
        ...(groups.get(fixture.revisionGroup) ?? []),
        fixture,
      ]);
    }
    for (const entries of groups.values()) {
      const previousFixture = entries[0]!;
      const currentFixture = entries[1]!;
      const previous = explicitRecord(pool.split, previousFixture, {
        revision: 1,
        supersedesRevisionId: null,
      });
      await store.addExplicitRecord(previous);
      remember(previousFixture, previous);
      const current = explicitRecord(pool.split, currentFixture, {
        recordId: previous.recordId,
        revision: 2,
        supersedesRevisionId: previous.revisionId,
      });
      await store.supersedeExplicitRecord(current);
      remember(currentFixture, current);
    }

    const currentScope = emR1ScopeFor(pool.split, "current");
    const projection = await Fts5EpisodeProjection.create({ scope: currentScope, stateRoot });
    const service = new LexicalMemorySearchService({
      inspectSource: async (record) => {
        const fixture = fixtureByRevisionId.get(memoryRecordRevisionId(record));
        if (fixture === undefined) throw new Error("EM-R1 source fixture is missing");
        return Object.freeze({
          sourceStatus: fixture.sourceStatus === "available" ? "available" : "stale",
        });
      },
      projection,
      scope: currentScope,
      store,
    });
    return Object.freeze({
      currentScope,
      fixtureByRevisionId,
      keyByRevisionId,
      projection,
      recordByKey,
      service,
      store,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function sourceAvailable(
  materialized: Pick<MaterializedEmR1Corpus, "fixtureByRevisionId">,
  record: MemoryRecordV1,
): boolean {
  return materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record))?.sourceStatus ===
    "available";
}

export function emR1FixtureTitle(
  materialized: Pick<MaterializedEmR1Corpus, "fixtureByRevisionId">,
  record: MemoryRecordV1,
): string {
  const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record));
  if (fixture === undefined) throw new Error("EM-R1 record lacks its frozen fixture title");
  return fixture.title;
}
