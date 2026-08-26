import { canonicalJson } from "../completion/canonical-json.js";
import { planeForRuntime } from "../control-plane/adapters/agent-cli-adapter.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { Ml1MemoryService } from "../memory/product/memory-service.js";
import { Ml1MemoryError } from "../memory/core/ml1-memory-error.js";
import type { Ml1MemoryScopeV1 } from "../memory/core/ml1-episode-record.js";
import { SqliteEpisodeStore } from "../memory/store/sqlite-episode-store.js";

interface Ml1CommandContext {
  readonly repositoryId: string;
  readonly scope: Ml1MemoryScopeV1;
  readonly workspace: string;
}

async function resolveMl1CommandContext(runtime: CliRuntime, io: CliIO): Promise<Ml1CommandContext> {
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
  const exitCode = code === "memory_repository_unregistered" || code === "memory_scope_ambiguous" ||
      code === "memory_cursor_invalid" || code === "memory_record_invalid"
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
  execute: (service: Ml1MemoryService) => Promise<T> | T,
): Promise<T> {
  const context = await resolveMl1CommandContext(runtime, io);
  const store = await SqliteEpisodeStore.create({ stateRoot: runtime.controlPlaneStateRoot! });
  try {
    return await execute(new Ml1MemoryService({
      repositoryId: context.repositoryId,
      scope: context.scope,
      store,
      workspace: context.workspace,
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

export async function executeMemoryStatus(
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const status = await withService(runtime, io, (service) => service.status());
    io.stdout.write(options.json
      ? `${canonicalJson(status)}\n`
      : `MEMORY | mode=${status.mode} | schema=${String(status.schemaVersion)} | path=${status.databasePathCategory} | episodes=${String(status.episodeCount)} | bytes=${String(status.canonicalBytes)} | maturity=${status.maturity}\n`);
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
    const page = await withService(runtime, io, (service) => service.list({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: parseLimit(options.limit),
    }));
    const output = Object.freeze({
      items: page.items,
      nextCursor: page.nextCursor,
      schemaVersion: 1 as const,
    });
    if (options.json) {
      io.stdout.write(`${canonicalJson(output)}\n`);
    } else if (page.items.length === 0) {
      io.stdout.write("No available local memory episodes.\n");
    } else {
      for (const view of page.items) {
        io.stdout.write(`${view.record.recordId} | ${view.record.occurredAt} | ${view.record.taskPreview}\n`);
      }
      if (page.nextCursor !== null) io.stdout.write(`next cursor: ${page.nextCursor}\n`);
    }
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}

export async function executeMemoryShow(
  recordId: string,
  options: Readonly<{ readonly json: boolean }>,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    if (!/^episode_[a-f0-9]{64}$/u.test(recordId)) {
      throw new Ml1MemoryError("memory_record_invalid", "memory record id is invalid");
    }
    const view = await withService(runtime, io, (service) => service.show(recordId));
    if (view === null) {
      io.stderr.write(`${canonicalJson({ code: "memory_record_not_found", error: "memory episode was not found" })}\n`);
      return 2;
    }
    io.stdout.write(options.json
      ? `${canonicalJson({ ...view, schemaVersion: 1 })}\n`
      : [
          `Kind: ${view.record.kind}`,
          view.record.text,
          `Scope: principal=${view.record.scope.ownerPrincipalId} repository=${view.record.scope.applicationRepositoryId} root=${view.record.scope.canonicalRootIdentitySha256}`,
          `Source: ${view.sourceStatus}${view.staleReason === null ? "" : ` (${view.staleReason})`} session=${view.record.source.sessionId} run=${view.record.source.runId} range=${view.record.source.rangeSha256}`,
          `Record: ${view.record.recordId} sha256=${view.record.recordSha256}`,
          "",
        ].join("\n"));
    return 0;
  } catch (error) {
    return commandFailure(error, io);
  }
}
