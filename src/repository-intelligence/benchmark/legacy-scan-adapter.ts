import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { createReadonlyToolRegistry } from "../../tools/create-readonly-tool-registry.js";
import type { ToolRegistryLike } from "../../tools/tool-types.js";
import type { RepositoryVisibleQuery } from "./benchmark-schema.js";
import type { RepositoryBenchmarkAttempt } from "./benchmark-report-schema.js";
import type { RepositoryBenchmarkAdapter, RepositoryBenchmarkObservation } from "./benchmark-adapter.js";

export type LegacyScanObservation = RepositoryBenchmarkObservation;

function safeFixturePath(workspace: string, path: string): string {
  const candidate = resolve(workspace, path);
  const difference = relative(workspace, candidate);
  if (
    path.includes("\0") ||
    isAbsolute(path) ||
    difference === ".." ||
    difference.startsWith("../") ||
    difference.startsWith("..\\") ||
    isAbsolute(difference)
  ) {
    throw new Error("fixture action path escapes the temporary benchmark workspace");
  }
  return candidate;
}

function parseCandidates(
  tool: "list_files" | "read_file" | "search",
  output: string,
): readonly { column: number | null; line: number | null; path: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true) return [];
  if (tool === "list_files" && Array.isArray(record.files)) {
    return record.files
      .filter((path): path is string => typeof path === "string")
      .map((path) => ({ column: null, line: null, path }));
  }
  if (tool === "search" && Array.isArray(record.matches)) {
    return record.matches.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const match = value as Record<string, unknown>;
      return typeof match.path === "string" && typeof match.line === "number" && typeof match.column === "number"
        ? [{ column: match.column, line: match.line, path: match.path }]
        : [];
    });
  }
  return [];
}

async function applyActions(
  workspace: string,
  query: RepositoryVisibleQuery,
  completedStep: number,
): Promise<void> {
  for (const action of query.fixtureActions.filter((candidate) => candidate.afterStep === completedStep)) {
    if (action.kind === "write_file") {
      const path = safeFixturePath(workspace, action.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, action.content, "utf8");
    } else if (action.kind === "rename_file") {
      await rename(safeFixturePath(workspace, action.from), safeFixturePath(workspace, action.to));
    } else {
      await unlink(safeFixturePath(workspace, action.path));
    }
  }
}

export class LegacyScanAdapter implements RepositoryBenchmarkAdapter {
  readonly identity = Object.freeze({
    adapter: "legacy_scan_v1",
    engine: "bornagent_readonly_tools",
    packageName: null,
    packageVersion: null,
    protocolVersion: 1,
  });

  constructor(
    private readonly registryFactory: (workspace: string) => Promise<ToolRegistryLike> = createReadonlyToolRegistry,
  ) {}

  async run(
    caseId: string,
    category: RepositoryBenchmarkAttempt["category"],
    workspace: string,
    query: RepositoryVisibleQuery,
    signal: AbortSignal,
  ): Promise<LegacyScanObservation> {
    const started = performance.now();
    const registry = await this.registryFactory(workspace);
    const candidates: { column: number | null; line: number | null; path: string }[] = [];
    const toolCalls: { argumentsSha256: string; name: "list_files" | "read_file" | "search"; observationBytes: number }[] = [];
    let observationBytes = 0;
    let coverage: "complete" | "partial" | "unsupported" = "complete";
    let errorCode: string | null = null;
    let status: "completed" | "cancelled" | "error" | "timeout" = "completed";

    for (const [index, step] of query.program.entries()) {
      if (signal.aborted) {
        status = "cancelled";
        coverage = "partial";
        errorCode = "repository_benchmark_cancelled";
        break;
      }
      const argumentsJson = JSON.stringify(step.arguments);
      const execution = await registry.execute(
        { argumentsJson, callId: `repo-${caseId}-${index + 1}`, name: step.tool, step: index + 1 },
        signal,
      );
      const bytes = Buffer.byteLength(execution.output, "utf8");
      observationBytes += bytes;
      toolCalls.push({ argumentsSha256: sha256Canonical({ arguments: step.arguments, tool: step.tool }), name: step.tool, observationBytes: bytes });
      candidates.push(...parseCandidates(step.tool, execution.output));
      if (!execution.ok) {
        coverage = "unsupported";
        errorCode = execution.error.code;
        status = execution.error.code.includes("timeout") ? "timeout" : execution.error.category === "cancelled" ? "cancelled" : "error";
        break;
      }
      if (execution.truncated) coverage = "partial";
      await applyActions(workspace, query, index);
    }

    const deduplicated = [...new Map(candidates.map((candidate) => [`${candidate.path}:${candidate.line ?? ""}:${candidate.column ?? ""}`, candidate])).values()];
    // Text search cannot prove a semantic definition/reference is absent. Only a complete
    // bounded file-outline query has exact absence semantics in the legacy adapter.
    const confirmedAbsent =
      coverage === "complete" && query.requestKind === "outline" && deduplicated.length === 0;
    return {
      attempt: Object.freeze({
        candidates: deduplicated,
        caseId,
        category,
        confirmedAbsent,
        coverage,
        durationMs: performance.now() - started,
        errorCode,
        evidenceLevel: "textual_fallback" as const,
        observationBytes,
        sourceBytesScanned: null,
        status,
        toolCalls,
      }),
    };
  }
}
