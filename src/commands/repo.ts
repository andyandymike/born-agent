import { canonicalJson } from "../completion/canonical-json.js";
import { ZodError } from "zod";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { DefaultRepositoryNavigationService } from "../repository-intelligence/navigation-service.js";
import { RepositoryIntelligenceError } from "../repository-intelligence/repository-intelligence-error.js";

export interface RepoStatusOptions { readonly json: boolean }
export interface RepoIndexOptions { readonly json: boolean; readonly rebuild: boolean }

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new TypeError("repository query numeric option is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError("repository query numeric option is outside its bound");
  return parsed;
}

function failure(error: unknown, io: CliIO): number {
  const invalidQuery = error instanceof TypeError || error instanceof ZodError;
  const code = error instanceof RepositoryIntelligenceError
    ? error.code
    : invalidQuery
      ? "repository_query_invalid"
      : "repository_navigation_failed";
  const exitCode = error instanceof RepositoryIntelligenceError ? error.exitCode : invalidQuery ? 2 : 1;
  io.stderr.write(`${canonicalJson({ code, error: "repository intelligence command failed" })}\n`);
  return exitCode;
}

export async function executeRepoStatus(options: RepoStatusOptions, runtime: CliRuntime, io: CliIO): Promise<number> {
  try {
    // PHASE17: status opens only an already-existing cache. Merely inspecting a repository does
    // not create current.json, a generation, a lock, or any other derived state.
    const status = await DefaultRepositoryNavigationService.inspect(runtime.cwd);
    io.stdout.write(options.json
      ? `${canonicalJson(status)}\n`
      : `REPO | engine=${status.engineId ?? "none"} | gen=${status.generationSha256?.slice(0, 8) ?? "none"} | coverage=${status.coverage ?? "none"} | index=${status.indexState}\n`);
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeRepoIndex(options: RepoIndexOptions, runtime: CliRuntime, io: CliIO): Promise<number> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error("repository index cancelled"));
  process.once("SIGINT", onInterrupt);
  try {
    const service = await DefaultRepositoryNavigationService.create(runtime.cwd);
    const current = options.rebuild
      ? await service.rebuild(controller.signal)
      : await service.ensureCurrent({ allowBuild: true, signal: controller.signal });
    const value = {
      buildMode: current.buildMode,
      coverage: current.stored.generation.coverage,
      counts: current.stored.generation.counts,
      engineIdentitySha256: current.stored.generation.engineIdentitySha256,
      generationSha256: current.stored.generation.generationSha256,
      incrementalUpdate: current.incrementalPlan === null ? null : {
        changeSetSha256: current.incrementalPlan.changeSet.changeSetSha256,
        dependencyInvalidated: current.incrementalPlan.dependencyInvalidated,
        directChanged: current.incrementalPlan.directChanged,
        reason: current.incrementalPlan.reason,
        reparsedUnits: current.incrementalPlan.reparsedUnits,
        reusedUnits: current.incrementalPlan.reusedUnits,
        updateMode: current.incrementalPlan.updateMode,
        updatePlanSha256: current.incrementalPlan.updatePlanSha256,
      },
      ruleManifestSha256: current.stored.generation.ruleManifestSha256,
      schemaVersion: 1,
      sourceStateSha256: current.stored.generation.sourceStateSha256,
    };
    io.stdout.write(options.json ? `${canonicalJson(value)}\n` : `repository index ${value.buildMode}: ${value.generationSha256} (${value.coverage})\n`);
    return 0;
  } catch (error) {
    return failure(error, io);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

export async function executeRepoQueryOutline(
  path: string | undefined,
  options: { readonly cursor?: string; readonly json: boolean; readonly limit?: string; readonly maxDepth?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const service = await DefaultRepositoryNavigationService.create(runtime.cwd);
    const result = await service.outline({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: boundedInteger(options.limit, 100, 1, 500),
      max_depth: boundedInteger(options.maxDepth, 2, 0, 4),
      ...(path === undefined ? {} : { path }),
    }, new AbortController().signal);
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeRepoQuerySymbol(
  query: string,
  options: { readonly cursor?: string; readonly json: boolean; readonly limit?: string; readonly path?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const service = await DefaultRepositoryNavigationService.create(runtime.cwd);
    const result = await service.findSymbols({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: boundedInteger(options.limit, 20, 1, 50),
      ...(options.path === undefined ? {} : { path_prefix: options.path }),
      query,
    }, new AbortController().signal);
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeRepoQueryReferences(
  symbolId: string,
  options: { readonly cursor?: string; readonly json: boolean; readonly limit?: string; readonly relations: readonly string[] },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const allowed = new Set(["read", "write", "call", "import", "type", "unknown"] as const);
    if (options.relations.some((relation) => !allowed.has(relation as never)) || new Set(options.relations).size !== options.relations.length) {
      throw new TypeError("repository reference relation is invalid or duplicated");
    }
    const relations = options.relations as readonly ("read" | "write" | "call" | "import" | "type" | "unknown")[];
    const service = await DefaultRepositoryNavigationService.create(runtime.cwd);
    const result = await service.findReferences({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: boundedInteger(options.limit, 50, 1, 100),
      ...(relations.length === 0 ? {} : { relations: [...relations] }),
      symbol_id: symbolId,
    }, new AbortController().signal);
    io.stdout.write(`${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}
