import { canonicalJson } from "../completion/canonical-json.js";
import { planeForRuntime } from "../control-plane/adapters/agent-cli-adapter.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { Ml1MemoryError } from "../memory/core/ml1-memory-error.js";
import type { Ml1MemoryScopeV1 } from "../memory/core/ml1-episode-record.js";
import {
  explicitMemoryKindV1Schema,
  memoryRecordRevision,
  memoryRecordRevisionId,
  memoryRecordSourceReferenceSha256,
  type ExplicitMemoryKindV1,
  type MemoryRecordV1,
} from "../memory/core/memory-record-v1.js";
import { MemoryService } from "../memory/product/memory-service.js";
import { Fts5EpisodeProjection } from "../memory/retrieval/fts5-episode-projection.js";
import { LexicalMemorySearchService } from "../memory/retrieval/lexical-memory-search-service.js";
import { ML2_SEARCH_DEFAULT_RESULTS, ML2_SEARCH_MAX_RESULTS } from "../memory/retrieval/ml2-search-contract.js";
import { SqliteEpisodeStore } from "../memory/store/sqlite-episode-store.js";

interface MemoryCommandContext {
  readonly repositoryId: string;
  readonly scope: Ml1MemoryScopeV1;
  readonly workspace: string;
}

async function resolveMemoryCommandContext(runtime: CliRuntime, io: CliIO): Promise<MemoryCommandContext> {
  if (runtime.controlPlaneStateRoot === undefined) {
    throw new Ml1MemoryError("memory_repository_unregistered", "memory commands require an existing Host state root");
  }
  const plane = await planeForRuntime(runtime, io);
  const preview = await plane.repositories.previewRoot(runtime.cwd);
  const matches = (await plane.repositories.list()).filter(
    (candidate) => candidate.status === "active" &&
      candidate.canonicalRootIdentitySha256 === preview.canonicalRootIdentitySha256,
  );
  if (matches.length === 0) {
    throw new Ml1MemoryError("memory_repository_unregistered", "current repository is not registered in this Host state root");
  }
  if (matches.length !== 1) {
    throw new Ml1MemoryError("memory_scope_ambiguous", "current repository has more than one active identity");
  }
  const repository = matches[0]!;
  const workspace = await plane.repositories.readRoot(repository);
  return Object.freeze({
    repositoryId: repository.repositoryId,
    scope: Object.freeze({
      applicationRepositoryId: repository.repositoryId,
      canonicalRootIdentitySha256: repository.canonicalRootIdentitySha256,
      ownerPrincipalId: plane.authority.localOwner.principalId,
    }),
    workspace,
  });
}

function commandFailure(error: unknown, io: CliIO): number {
  const code = error instanceof Ml1MemoryError ? error.code : "memory_store_corrupt";
  const exitCode = new Set([
    "memory_cursor_invalid",
    "memory_lifecycle_conflict",
    "memory_query_invalid",
    "memory_record_invalid",
    "memory_record_not_admitted",
    "memory_record_not_found",
    "memory_record_too_large",
    "memory_repository_unregistered",
    "memory_scope_ambiguous",
  ]).has(code)
    ? 2
    : code === "memory_store_busy"
      ? 8
      : 1;
  io.stderr.write(`${canonicalJson({ code, error: "memory command failed" })}\n`);
  return exitCode;
}

async function withService<T>(
  runtime: CliRuntime,
  io: CliIO,
  derived: boolean,
  execute: (service: MemoryService) => Promise<T> | T,
): Promise<T> {
  const context = await resolveMemoryCommandContext(runtime, io);
  const stateRoot = runtime.controlPlaneStateRoot!;
  const store = await SqliteEpisodeStore.create({ stateRoot });
  try {
    const projection = derived
      ? await Fts5EpisodeProjection.create({ scope: context.scope, stateRoot })
      : undefined;
    return await execute(new MemoryService({
      ...(projection === undefined ? {} : { derivedProjection: projection }),
      repositoryId: context.repositoryId,
      scope: context.scope,
      store,
      workspace: context.workspace,
    }));
  } finally {
    store.close();
  }
}

async function withSearchService<T>(
  runtime: CliRuntime,
  io: CliIO,
  execute: (service: LexicalMemorySearchService) => Promise<T> | T,
): Promise<T> {
  const context = await resolveMemoryCommandContext(runtime, io);
  const stateRoot = runtime.controlPlaneStateRoot!;
  const store = await SqliteEpisodeStore.create({ stateRoot });
  try {
    const memory = new MemoryService({
      repositoryId: context.repositoryId,
      scope: context.scope,
      store,
      workspace: context.workspace,
    });
    const projection = await Fts5EpisodeProjection.create({ scope: context.scope, stateRoot });
    return await execute(new LexicalMemorySearchService({
      inspectSource: (record) => memory.inspectRecordSource(record),
      projection,
      scope: context.scope,
      store,
    }));
  } finally {
    store.close();
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^[0-9]+$/u.test(value)) {
    throw new Ml1MemoryError("memory_cursor_invalid", "memory list limit is invalid");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Ml1MemoryError("memory_cursor_invalid", "memory list limit must be between 1 and 100");
  }
  return parsed;
}

function parseSearchLimit(value: string | undefined): number {
  if (value === undefined) return ML2_SEARCH_DEFAULT_RESULTS;
  if (!/^[0-9]+$/u.test(value)) {
    throw new Ml1MemoryError("memory_query_invalid", "memory search result limit is invalid");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ML2_SEARCH_MAX_RESULTS) {
    throw new Ml1MemoryError("memory_query_invalid", "memory search result limit must be between 1 and 20");
  }
  return parsed;
}

function parseRecordId(value: string): string {
  if (!/^(?:episode|memory)_[a-f0-9]{64}$/u.test(value)) {
    throw new Ml1MemoryError("memory_record_invalid", "memory record id is invalid");
  }
  return value;
}

function recordPreview(record: MemoryRecordV1): string {
  const source = record.kind === "episode" ? record.taskPreview : record.text;
  const compact = source.replace(/\s+/gu, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
}

function recordSourceLine(record: MemoryRecordV1): string {
  if (record.kind === "episode") {
    return `session=${record.source.sessionId} run=${record.source.runId} range=${record.source.rangeSha256}`;
  }
  return `command=${record.source.commandId} occurred_at=${record.source.occurredAt} source_sha256=${memoryRecordSourceReferenceSha256(record)}`;
}

export async function executeMemoryStatus(
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const status = await withService(runtime, io, false, (service) => service.status());
    io.stdout.write(options.json
      ? `${canonicalJson(status)}\n`
      : `MEMORY | mode=${status.mode} | schema=${String(status.schemaVersion)} | path=${status.databasePathCategory} | active=${String(status.activeRecordCount)} | revisions=${String(status.revisionCount)} | operations=${String(status.operationCount)} | bytes=${String(status.canonicalBytes)} | maturity=${status.maturity}\n`);
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryList(
  options: Readonly<{ readonly cursor?: string; readonly json: boolean; readonly limit?: string }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const page = await withService(runtime, io, false, (service) => service.list({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: parseLimit(options.limit),
    }));
    const output = Object.freeze({ items: page.items, nextCursor: page.nextCursor, schemaVersion: 1 as const });
    if (options.json) {
      io.stdout.write(`${canonicalJson(output)}\n`);
    } else if (page.items.length === 0) {
      io.stdout.write("No active available local memory records.\n");
    } else {
      for (const view of page.items) {
        io.stdout.write(`${view.record.recordId} | r${String(memoryRecordRevision(view.record))} | ${view.record.occurredAt} | ${view.record.kind} | ${recordPreview(view.record)}\n`);
      }
      if (page.nextCursor !== null) io.stdout.write(`next cursor: ${page.nextCursor}\n`);
    }
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemorySearch(
  query: string,
  options: Readonly<{ readonly explain: boolean; readonly json: boolean; readonly limit?: string }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const result = await withSearchService(runtime, io, (service) => service.search({
      limit: parseSearchLimit(options.limit),
      query,
    }));
    if (options.json) {
      io.stdout.write(`${canonicalJson(result)}\n`);
      return 0;
    }
    if (result.status === "abstained") {
      io.stdout.write(`No available memory match (${result.abstentionReason ?? "no_available_match"}).\n`);
      return 0;
    }
    for (const hit of result.hits) {
      io.stdout.write(`${hit.record.recordId} | ${hit.record.occurredAt} | ${hit.reason} | ${recordPreview(hit.record)}\n`);
      if (options.explain) {
        io.stdout.write(
          `  revision=${memoryRecordRevisionId(hit.record)} exact_id=${String(hit.score.exactId)} exact_phrase=${String(hit.score.exactPhrase)} bm25=${hit.score.lexicalBm25 === null ? "none" : String(hit.score.lexicalBm25)} source=${hit.sourceStatus} text_bytes=${String(hit.textBytes)} estimated_tokens=${String(hit.estimatedTokens)}\n`,
        );
      }
    }
    if (options.explain) {
      io.stdout.write(
        `SEARCH | retriever=${result.retriever.id}@${result.retriever.version} | projection=${result.projection.action} | candidates=${String(result.candidates.matched)}/${String(result.candidates.cap)} | available=${String(result.candidates.available)} | text_bytes=${String(result.budget.textBytesUsed)}/${String(result.budget.textBytesLimit)} | estimated_tokens=${String(result.budget.estimatedTokensUsed)}/${String(result.budget.estimatedTokensLimit)}\n`,
      );
    }
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryShow(
  recordIdInput: string,
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const recordId = parseRecordId(recordIdInput);
    const view = await withService(runtime, io, false, (service) => service.show(recordId));
    if (view === null) throw new Ml1MemoryError("memory_record_not_found", "memory record was not found");
    io.stdout.write(options.json
      ? `${canonicalJson({ ...view, schemaVersion: 1 })}\n`
      : [
          `Kind: ${view.record.kind}`,
          view.record.text,
          `Lifecycle: ${view.lifecycleStatus} revision=${String(memoryRecordRevision(view.record))} revision_id=${memoryRecordRevisionId(view.record)}`,
          `Scope: principal=${view.record.scope.ownerPrincipalId} repository=${view.record.scope.applicationRepositoryId} root=${view.record.scope.canonicalRootIdentitySha256}`,
          `Source: ${view.sourceStatus}${view.staleReason === null ? "" : ` (${view.staleReason})`} ${recordSourceLine(view.record)}`,
          `Record: ${view.record.recordId} sha256=${view.record.recordSha256}`,
          "",
        ].join("\n"));
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryRemember(
  kindInput: string,
  text: string,
  options: Readonly<{ readonly json: boolean; readonly supersedes?: string }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const parsedKind = explicitMemoryKindV1Schema.safeParse(kindInput);
    if (!parsedKind.success) {
      throw new Ml1MemoryError("memory_record_invalid", "explicit memory kind is invalid");
    }
    const kind: ExplicitMemoryKindV1 = parsedKind.data;
    const supersedesRecordId = options.supersedes === undefined ? undefined : parseRecordId(options.supersedes);
    const result = await withService(runtime, io, true, (service) => service.remember({
      commandId: runtime.randomUUID(),
      kind,
      occurredAt: runtime.timestamp(),
      ...(supersedesRecordId === undefined ? {} : { supersedesRecordId }),
      text,
    }));
    io.stdout.write(options.json
      ? `${canonicalJson({ ...result, schemaVersion: 1 })}\n`
      : `MEMORY ${result.status.toUpperCase()} | record=${result.record.recordId} | revision=${String(result.record.revision)} | revision_id=${result.record.revisionId} | operation=${result.operation.operationId}\n`);
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryRetract(
  recordIdInput: string,
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const result = await withService(runtime, io, true, (service) => service.retract({
      commandId: runtime.randomUUID(),
      occurredAt: runtime.timestamp(),
      recordId: parseRecordId(recordIdInput),
    }));
    io.stdout.write(options.json
      ? `${canonicalJson({ ...result, schemaVersion: 1 })}\n`
      : `MEMORY ${result.status.toUpperCase()} | record=${result.record.recordId} | operation=${result.operation.operationId} | active=false\n`);
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryRebuild(
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const result = await withService(runtime, io, true, (service) => service.rebuild());
    io.stdout.write(options.json
      ? `${canonicalJson(result)}\n`
      : `MEMORY REBUILT | records=${String(result.recordCount)} | logical=${result.beforeLogicalSha256} | projection=fts5-v2\n`);
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryDoctor(
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const result = await withService(runtime, io, true, (service) => service.doctor());
    io.stdout.write(options.json
      ? `${canonicalJson(result)}\n`
      : `MEMORY DOCTOR | status=${result.status} | sqlite=${result.checks.quickCheck} | schema=${String(result.checks.storeSchemaVersion)} | fts=${result.checks.fts.status}/${result.checks.fts.action} | sources=${String(result.checks.sources.available)} available,${String(result.checks.sources.stale)} stale | records=${String(result.checks.capacity.recordCount)}/${String(result.checks.capacity.maxRecords)} | retract_reserve=${String(result.checks.capacity.retractOperationReserve)}\n`);
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}
