import { ExactSessionEvidenceReader, type ExactSessionEvidenceV1 } from "../../control-plane/exact-session-evidence-reader.js";
import { buildDeterministicMl1Episode, calculateMl1RangeSha256 } from "../episodes/deterministic-episode-builder.js";
import type { Ml1EpisodeRecordV1, Ml1MemoryScopeV1 } from "../core/ml1-episode-record.js";
import { Ml1MemoryError } from "../core/ml1-memory-error.js";
import {
  createExplicitMemoryRecordV1,
  memoryRecordRevision,
  memoryRecordRevisionId,
  type ExplicitMemoryKindV1,
  type MemoryRecordV1,
} from "../core/memory-record-v1.js";
import { inspectMemoryAdmission } from "../episodes/memory-admission.js";
import type {
  MemoryLogicalDumpV1,
  MemoryStoreDiagnosticsV1,
  MemoryStorePort,
  Ml1EpisodeIngestResultV1,
} from "../store/sqlite-episode-store.js";

export type MemorySourceStatusV1 = "available" | "stale";
export type MemoryStaleReasonV1 = "missing_or_corrupt_session" | "range_mismatch" | null;

export interface MemoryRecordViewV1 {
  readonly lifecycleStatus: "active" | "retracted";
  readonly record: MemoryRecordV1;
  readonly sourceStatus: MemorySourceStatusV1;
  readonly staleReason: MemoryStaleReasonV1;
}

export interface Ml1EpisodeViewV1 {
  readonly lifecycleStatus?: "active" | "retracted";
  readonly record: Ml1EpisodeRecordV1;
  readonly sourceStatus: MemorySourceStatusV1;
  readonly staleReason: MemoryStaleReasonV1;
}

export interface MemoryDerivedProjectionPort {
  doctor(dump: MemoryLogicalDumpV1): Promise<Readonly<{
    readonly action: "corrupt" | "missing" | "stale" | "verified";
    readonly recordCount: number;
    readonly schemaVersion: number;
    readonly status: "ok" | "warning";
  }>>;
  invalidate(): Promise<Readonly<{ readonly removed: boolean }>>;
  rebuild(dump: MemoryLogicalDumpV1): Promise<Readonly<{
    readonly action: "rebuilt";
    readonly recordCount: number;
    readonly schemaVersion: number;
  }>>;
}

export interface MemoryStatusV1 {
  readonly activeRecordCount: number;
  readonly canonicalBytes: number;
  readonly capacity: Awaited<ReturnType<MemoryStorePort["capacity"]>>;
  readonly databasePathCategory: "private_state/memory/v1/memory.sqlite3";
  readonly episodeCount: number;
  readonly logicalSha256: string;
  readonly maturity: "experimental_ml4";
  readonly mode: "local";
  readonly operationCount: number;
  readonly revisionCount: number;
  readonly schemaVersion: 2;
}

export type Ml1MemoryStatusV1 = MemoryStatusV1;

export class MemoryService {
  constructor(private readonly input: Readonly<{
    readonly derivedProjection?: MemoryDerivedProjectionPort;
    readonly evidenceReader?: ExactSessionEvidenceReader;
    readonly repositoryId: string;
    readonly scope: Ml1MemoryScopeV1;
    readonly store: MemoryStorePort;
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
    if (result.status === "inserted") await this.input.derivedProjection?.invalidate();
    return Object.freeze({ record: built.record, result, status: "stored" });
  }

  async remember(input: Readonly<{
    readonly commandId: string;
    readonly kind: ExplicitMemoryKindV1;
    readonly occurredAt: string;
    readonly supersedesRecordId?: string;
    readonly text: string;
  }>) {
    const admission = inspectMemoryAdmission([input.text]);
    if (!admission.admitted) {
      throw new Ml1MemoryError("memory_record_not_admitted", "explicit memory did not pass sensitive-content admission");
    }
    if (input.supersedesRecordId === undefined) {
      const record = createExplicitMemoryRecordV1({
        commandId: input.commandId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        revision: 1,
        scope: this.input.scope,
        supersedesRevisionId: null,
        text: input.text,
      });
      const result = await this.input.store.addExplicitRecord(record);
      const cleanup = await this.invalidateDerived();
      return Object.freeze({ ...result, derivedCleanup: cleanup });
    }

    const current = await this.input.store.getRecordState({
      recordId: input.supersedesRecordId,
      scope: this.input.scope,
    });
    if (current === null) {
      throw new Ml1MemoryError("memory_record_not_found", "superseded memory record was not found");
    }
    if (
      current.status !== "active" || current.record.kind === "episode" ||
      current.record.kind !== input.kind
    ) {
      throw new Ml1MemoryError(
        "memory_lifecycle_conflict",
        "supersede requires an active explicit record with the same kind",
      );
    }
    const record = createExplicitMemoryRecordV1({
      commandId: input.commandId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      recordId: current.record.recordId,
      revision: memoryRecordRevision(current.record) + 1,
      scope: this.input.scope,
      supersedesRevisionId: memoryRecordRevisionId(current.record),
      text: input.text,
    });
    const result = await this.input.store.supersedeExplicitRecord(record);
    const cleanup = await this.invalidateDerived();
    return Object.freeze({ ...result, derivedCleanup: cleanup });
  }

  async retract(input: Readonly<{
    readonly commandId: string;
    readonly occurredAt: string;
    readonly recordId: string;
  }>) {
    const result = await this.input.store.retractRecord({ ...input, scope: this.input.scope });
    const cleanup = result.status === "retracted"
      ? await this.invalidateDerived()
      : "unchanged" as const;
    return Object.freeze({ ...result, derivedCleanup: cleanup });
  }

  async status(): Promise<MemoryStatusV1> {
    const [dump, capacity] = await Promise.all([
      this.input.store.logicalDump(this.input.scope),
      this.input.store.capacity(),
    ]);
    return Object.freeze({
      activeRecordCount: dump.count,
      canonicalBytes: dump.canonicalBytes,
      capacity,
      databasePathCategory: "private_state/memory/v1/memory.sqlite3",
      episodeCount: dump.records.filter((record) => record.kind === "episode").length,
      logicalSha256: dump.logicalSha256,
      maturity: "experimental_ml4",
      mode: "local",
      operationCount: dump.operationCount,
      revisionCount: dump.revisionCount,
      schemaVersion: 2,
    });
  }

  async list(input: Readonly<{ readonly cursor?: string; readonly limit: number }>): Promise<
    Readonly<{ readonly items: readonly MemoryRecordViewV1[]; readonly nextCursor: string | null }>
  > {
    const page = await this.input.store.listActiveRecords({ ...input, scope: this.input.scope });
    const views: MemoryRecordViewV1[] = [];
    for (const record of page.items) {
      const inspected = await this.inspectRecordSource(record);
      if (inspected.sourceStatus === "available") {
        views.push(Object.freeze({ ...inspected, lifecycleStatus: "active" }));
      }
    }
    return Object.freeze({ items: Object.freeze(views), nextCursor: page.nextCursor });
  }

  async show(recordId: string): Promise<MemoryRecordViewV1 | null> {
    const state = await this.input.store.getRecordState({ recordId, scope: this.input.scope });
    if (state === null) return null;
    const inspected = await this.inspectRecordSource(state.record);
    return Object.freeze({ ...inspected, lifecycleStatus: state.status });
  }

  /** ML2/ML3 use this exact source check after active canonical refetch. */
  async inspectRecordSource(record: MemoryRecordV1): Promise<Omit<MemoryRecordViewV1, "lifecycleStatus">> {
    if (record.kind !== "episode") {
      return Object.freeze({ record, sourceStatus: "available", staleReason: null });
    }
    const inspected = await this.inspectEpisodeSource(record);
    return Object.freeze({
      record,
      sourceStatus: inspected.sourceStatus,
      staleReason: inspected.staleReason,
    });
  }

  /** Backward-compatible ML1 source view. */
  async inspectEpisodeSource(record: Ml1EpisodeRecordV1): Promise<Ml1EpisodeViewV1> {
    let evidence: ExactSessionEvidenceV1;
    try {
      evidence = await this.reader().read({
        sessionId: record.source.sessionId,
        workspace: this.input.workspace,
      });
    } catch {
      return Object.freeze({
        lifecycleStatus: "active",
        record,
        sourceStatus: "stale",
        staleReason: "missing_or_corrupt_session",
      });
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
      ? Object.freeze({ lifecycleStatus: "active", record, sourceStatus: "available", staleReason: null })
      : Object.freeze({ lifecycleStatus: "active", record, sourceStatus: "stale", staleReason: "range_mismatch" });
  }

  async rebuild() {
    const projection = this.requireProjection();
    const before = await this.input.store.logicalDump(this.input.scope);
    const rebuilt = await projection.rebuild(before);
    const after = await this.input.store.logicalDump(this.input.scope);
    if (before.logicalSha256 !== after.logicalSha256) {
      throw new Ml1MemoryError("memory_projection_failed", "canonical memory changed during derived rebuild");
    }
    return Object.freeze({
      afterLogicalSha256: after.logicalSha256,
      beforeLogicalSha256: before.logicalSha256,
      projections: Object.freeze([Object.freeze({ id: "fts5-v2", ...rebuilt })]),
      recordCount: after.count,
      schemaVersion: 1 as const,
      status: "rebuilt" as const,
    });
  }

  async doctor() {
    const projection = this.requireProjection();
    const store: MemoryStoreDiagnosticsV1 = await this.input.store.diagnostics(this.input.scope);
    const dump = await this.input.store.logicalDump(this.input.scope);
    let availableSources = 0;
    let staleSources = 0;
    for (const record of dump.records) {
      const inspected = await this.inspectRecordSource(record);
      if (inspected.sourceStatus === "available") availableSources += 1;
      else staleSources += 1;
    }
    const fts = await projection.doctor(dump);
    return Object.freeze({
      checks: Object.freeze({
        capacity: store.capacity,
        fts,
        pathPrivacy: store.pathPrivacy,
        quickCheck: store.quickCheck,
        sources: Object.freeze({ available: availableSources, stale: staleSources }),
        storeSchemaVersion: store.schemaVersion,
      }),
      logicalSha256: dump.logicalSha256,
      schemaVersion: 1 as const,
      status: staleSources === 0 && fts.status === "ok" ? "ok" as const : "warning" as const,
    });
  }

  private async invalidateDerived(): Promise<"not_configured" | "removed"> {
    if (this.input.derivedProjection === undefined) return "not_configured";
    await this.input.derivedProjection.invalidate();
    return "removed";
  }

  private requireProjection(): MemoryDerivedProjectionPort {
    if (this.input.derivedProjection === undefined) {
      throw new Ml1MemoryError("memory_projection_failed", "memory derived projection is not configured");
    }
    return this.input.derivedProjection;
  }

  private reader(): ExactSessionEvidenceReader {
    return this.input.evidenceReader ?? new ExactSessionEvidenceReader();
  }
}

/** Keep the ML1 export while callers migrate to the formal MemoryService name. */
export { MemoryService as Ml1MemoryService };

export function safeMl1MemoryDiagnostic(error: unknown): string {
  if (error instanceof Ml1MemoryError) return error.code;
  return "memory_ingest_failed";
}
