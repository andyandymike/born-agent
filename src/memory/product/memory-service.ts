import { ExactSessionEvidenceReader, type ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import { buildDeterministicMl1Episode, calculateMl1RangeSha256 } from "../episodes/deterministic-episode-builder.js";
import type { Ml1EpisodeRecordV1, Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import type { Ml1EpisodeIngestResultV1, Ml1EpisodeListPageV1, Ml1EpisodeStorePort } from "../store/sqlite-episode-store.js";

export type Ml1SourceStatusV1 = "available" | "stale";

export interface Ml1EpisodeViewV1 {
  readonly record: Ml1EpisodeRecordV1;
  readonly sourceStatus: Ml1SourceStatusV1;
  readonly staleReason: "missing_or_corrupt_session" | "range_mismatch" | null;
}

export interface Ml1MemoryStatusV1 {
  readonly canonicalBytes: number;
  readonly databasePathCategory: "private_state/memory/v1/memory.sqlite3";
  readonly episodeCount: number;
  readonly logicalSha256: string;
  readonly maturity: "experimental_ml1";
  readonly mode: "local";
  readonly schemaVersion: 1;
}

export class Ml1MemoryService {
  constructor(private readonly input: Readonly<{
    readonly evidenceReader?: ExactSessionEvidenceReader;
    readonly repositoryId: string;
    readonly scope: Ml1MemoryScopeV1;
    readonly store: Ml1EpisodeStorePort;
    readonly workspace: string;
  }>) {}

  async ingestCompletedRun(sessionId: string, runId: string): Promise<
    | Readonly<{ reason: string; status: "not_admitted" }>
    | Readonly<{ record: Ml1EpisodeRecordV1; result: Ml1EpisodeIngestResultV1; status: "stored" }>
  > {
    const evidence = await this.reader().read({ sessionId, workspace: this.input.workspace });
    const built = buildDeterministicMl1Episode({
      evidence,
      repositoryId: this.input.repositoryId,
      runId,
      scope: this.input.scope,
    });
    if (built.status === "not_admitted") {
      return Object.freeze({ reason: built.admission.reason, status: "not_admitted" });
    }
    const result = await this.input.store.ingestEpisode(built.record);
    return Object.freeze({ record: built.record, result, status: "stored" });
  }

  async status(): Promise<Ml1MemoryStatusV1> {
    const dump = await this.input.store.logicalDump(this.input.scope);
    return Object.freeze({
      canonicalBytes: dump.canonicalBytes,
      databasePathCategory: "private_state/memory/v1/memory.sqlite3",
      episodeCount: dump.count,
      logicalSha256: dump.logicalSha256,
      maturity: "experimental_ml1",
      mode: "local",
      schemaVersion: 1,
    });
  }

  async list(input: Readonly<{ readonly cursor?: string; readonly limit: number }>): Promise<
    Readonly<{ readonly items: readonly Ml1EpisodeViewV1[]; readonly nextCursor: string | null }>
  > {
    const page: Ml1EpisodeListPageV1 = await this.input.store.listEpisodes({
      ...input,
      scope: this.input.scope,
    });
    const views = await Promise.all(page.items.map((record) => this.inspectEpisodeSource(record)));
    return Object.freeze({
      items: Object.freeze(views.filter((view) => view.sourceStatus === "available")),
      nextCursor: page.nextCursor,
    });
  }

  async show(recordId: string): Promise<Ml1EpisodeViewV1 | null> {
    const record = await this.input.store.getEpisode({ recordId, scope: this.input.scope });
    return record === null ? null : this.inspectEpisodeSource(record);
  }

  /** ML2 reuses the exact ML1 source check before exposing any ranked hit. */
  async inspectEpisodeSource(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeViewV1> {
    let evidence: ExactSessionEvidenceV1;
    try {
      evidence = await this.reader().read({
        sessionId: record.source.sessionId,
        workspace: this.input.workspace,
      });
    } catch {
      return Object.freeze({ record, sourceStatus: "stale", staleReason: "missing_or_corrupt_session" });
    }
    const range = evidence.events.slice(record.source.startSequence - 1, record.source.endSequence);
    const start = range[0];
    const end = range.at(-1);
    const matches =
      start?.eventId === record.source.startEventId &&
      end?.eventId === record.source.endEventId &&
      start !== undefined && end !== undefined &&
      evidence.rawSha256.get(start.eventId) === record.source.startRawSha256 &&
      evidence.rawSha256.get(end.eventId) === record.source.endRawSha256 &&
      range.length === record.source.endSequence - record.source.startSequence + 1 &&
      calculateMl1RangeSha256(evidence, range, record.source.runId) === record.source.rangeSha256;
    return matches
      ? Object.freeze({ record, sourceStatus: "available", staleReason: null })
      : Object.freeze({ record, sourceStatus: "stale", staleReason: "range_mismatch" });
  }

  private reader(): ExactSessionEvidenceReader {
    return this.input.evidenceReader ?? new ExactSessionEvidenceReader();
  }
}

export function safeMl1MemoryDiagnostic(error: unknown): string {
  if (error instanceof Ml1MemoryError) return error.code;
  return "memory_ingest_failed";
}
