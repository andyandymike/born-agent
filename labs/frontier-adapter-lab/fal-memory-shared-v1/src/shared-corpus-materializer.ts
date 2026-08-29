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

import type { SharedExecutorPack } from "./benchmark-schema.js";

type SharedTimeline = SharedExecutorPack["timelines"][number];
type SharedRecord = SharedTimeline["records"][number];

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeFor(record: Pick<SharedRecord, "principalId" | "repositoryId">): Ml1MemoryScopeV1 {
  return Object.freeze({
    ownerPrincipalId: record.principalId,
    applicationRepositoryId: record.repositoryId,
    canonicalRootIdentitySha256: rawSha256(`fal-memory-shared-root:${record.repositoryId}`),
  });
}

function episodeRecord(timelineId: string, fixture: SharedRecord): Ml1EpisodeRecordV1 {
  const scope = scopeFor(fixture);
  const sourceIdentity = `${timelineId}:${fixture.recordId}`;
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
  const completion = Object.freeze({
    evidenceSha256: null,
    mode: "model_final" as const,
    reportSha256: null,
    steps: 1,
    toolCalls: 0,
  });
  return createMl1EpisodeRecordV1({
    completion,
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
      `Completion mode: ${completion.mode}`,
      `Steps: ${String(completion.steps)}`,
      `Tool calls: ${String(completion.toolCalls)}`,
      "Evidence: none",
    ].join("\n"),
  });
}

function explicitRecord(
  timelineId: string,
  fixture: SharedRecord,
  input: Readonly<{
    readonly recordId?: string;
    readonly revision: number;
    readonly supersedesRevisionId: string | null;
  }>,
): ExplicitMemoryRecordV1 {
  return createExplicitMemoryRecordV1({
    commandId: `fal-memory-shared:${timelineId}:${fixture.recordId}`,
    kind: "decision",
    occurredAt: fixture.occurredAt,
    ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
    revision: input.revision,
    scope: scopeFor(fixture),
    supersedesRevisionId: input.supersedesRevisionId,
    text: fixture.text,
  });
}

export interface MaterializedSharedTimeline {
  readonly currentScope: Ml1MemoryScopeV1;
  readonly fixtureByRevisionId: ReadonlyMap<string, SharedRecord>;
  readonly keyByRevisionId: ReadonlyMap<string, string>;
  readonly projection: Fts5EpisodeProjection;
  readonly recordByKey: ReadonlyMap<string, MemoryRecordV1>;
  readonly service: LexicalMemorySearchService;
  readonly store: SqliteEpisodeStore;
}

export async function materializeSharedTimeline(
  stateRoot: string,
  timeline: SharedTimeline,
): Promise<MaterializedSharedTimeline> {
  const store = await SqliteEpisodeStore.create({ stateRoot });
  const recordByKey = new Map<string, MemoryRecordV1>();
  const keyByRevisionId = new Map<string, string>();
  const fixtureByRevisionId = new Map<string, SharedRecord>();
  const remember = (fixture: SharedRecord, record: MemoryRecordV1): void => {
    const revisionId = memoryRecordRevisionId(record);
    recordByKey.set(fixture.recordId, record);
    keyByRevisionId.set(revisionId, fixture.recordId);
    fixtureByRevisionId.set(revisionId, fixture);
  };

  try {
    for (const fixture of timeline.records) {
      if (fixture.lifecycle !== "episode_active") continue;
      const record = episodeRecord(timeline.timelineId, fixture);
      await store.ingestEpisode(record);
      remember(fixture, record);
    }
    for (const fixture of timeline.records) {
      if (fixture.lifecycle === "explicit_active") {
        const record = explicitRecord(timeline.timelineId, fixture, {
          revision: 1,
          supersedesRevisionId: null,
        });
        await store.addExplicitRecord(record);
        remember(fixture, record);
      }
      if (fixture.lifecycle === "explicit_retracted") {
        const record = explicitRecord(timeline.timelineId, fixture, {
          revision: 1,
          supersedesRevisionId: null,
        });
        await store.addExplicitRecord(record);
        await store.retractRecord({
          commandId: `fal-memory-shared-retract:${timeline.timelineId}:${fixture.recordId}`,
          occurredAt: new Date(Date.parse(fixture.occurredAt) + 1).toISOString(),
          recordId: record.recordId,
          scope: record.scope,
        });
        remember(fixture, record);
      }
    }
    const revisionGroups = new Map<string, SharedRecord[]>();
    for (const fixture of timeline.records) {
      if (fixture.revisionGroup === null) continue;
      revisionGroups.set(fixture.revisionGroup, [
        ...(revisionGroups.get(fixture.revisionGroup) ?? []),
        fixture,
      ]);
    }
    for (const entries of revisionGroups.values()) {
      const ordered = [...entries].sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.recordId.localeCompare(right.recordId));
      const previousFixture = ordered.find((entry) => entry.lifecycle === "explicit_superseded");
      const currentFixture = ordered.find((entry) => entry.lifecycle === "explicit_current");
      if (previousFixture === undefined || currentFixture === undefined || ordered.length !== 2) {
        throw new Error("shared benchmark revision group must contain one superseded and one current record");
      }
      const previous = explicitRecord(timeline.timelineId, previousFixture, {
        revision: 1,
        supersedesRevisionId: null,
      });
      await store.addExplicitRecord(previous);
      remember(previousFixture, previous);
      const current = explicitRecord(timeline.timelineId, currentFixture, {
        recordId: previous.recordId,
        revision: 2,
        supersedesRevisionId: previous.revisionId,
      });
      await store.supersedeExplicitRecord(current);
      remember(currentFixture, current);
    }

    const currentScope = Object.freeze({
      ownerPrincipalId: timeline.principalId,
      applicationRepositoryId: timeline.repositoryId,
      canonicalRootIdentitySha256: rawSha256(`fal-memory-shared-root:${timeline.repositoryId}`),
    });
    const projection = await Fts5EpisodeProjection.create({ scope: currentScope, stateRoot });
    const service = new LexicalMemorySearchService({
      inspectSource: async (record) => Object.freeze({
        sourceStatus: fixtureByRevisionId.get(memoryRecordRevisionId(record))?.sourceStatus ===
          "available" ? "available" : "stale",
      }),
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

export function sharedSourceAvailable(
  materialized: Pick<MaterializedSharedTimeline, "fixtureByRevisionId">,
  record: MemoryRecordV1,
): boolean {
  return materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record))?.sourceStatus ===
    "available";
}

export function sharedFixtureTitle(
  materialized: Pick<MaterializedSharedTimeline, "fixtureByRevisionId">,
  record: MemoryRecordV1,
): string {
  const fixture = materialized.fixtureByRevisionId.get(memoryRecordRevisionId(record));
  if (fixture === undefined) throw new Error("shared benchmark record lacks its fixture title");
  return fixture.title;
}
