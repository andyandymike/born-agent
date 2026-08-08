import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { createTypeScriptEngineIdentity, TYPESCRIPT_ENGINE_ASSET } from "../engine-identity.js";
import { analyzeTypeScriptSnapshot } from "../engines/typescript-program-analysis.js";
import { RepositorySourceSnapshotter } from "../source-snapshotter.js";
import type { RepositorySourceSnapshotResult } from "../source-snapshot.js";
import type { RepositoryBenchmarkAdapter, RepositoryBenchmarkObservation } from "./benchmark-adapter.js";
import type { RepositoryVisibleQuery } from "./benchmark-schema.js";
import type { RepositoryBenchmarkAttempt } from "./benchmark-report-schema.js";

type Candidate = { readonly column: number | null; readonly line: number | null; readonly path: string };

interface CandidateStepResult {
  readonly candidates: readonly Candidate[];
  readonly confirmedAbsent: boolean;
  readonly coverage: "complete" | "partial" | "unsupported";
  readonly evidenceLevel: "semantic" | "syntactic" | "textual_fallback";
  readonly sourceBytesScanned: number;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

async function applyActions(workspace: string, query: RepositoryVisibleQuery, completedStep: number): Promise<void> {
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

function queryString(argumentsValue: Readonly<Record<string, unknown>>): string {
  return typeof argumentsValue.query === "string" ? argumentsValue.query : "";
}

function symbolQuery(text: string): string | null {
  const declaration = /\b(?:class|const|enum|function|interface|let|type|var)\s+([A-Za-z_$][\w$]*)/u.exec(text);
  if (declaration?.[1] !== undefined) return declaration[1];
  const call = /([A-Za-z_$][\w$]*)\s*\(\)/u.exec(text);
  if (call?.[1] !== undefined) return call[1];
  const identifiers = text.match(/[A-Za-z_$][\w$]*/gu);
  return identifiers?.at(-1) ?? null;
}

function lineCandidate(path: string, line: number, column: number): Candidate {
  return Object.freeze({ column, line, path });
}

function deduplicate(candidates: readonly Candidate[], perLine = false): readonly Candidate[] {
  return Object.freeze(
    [...new Map(candidates.map((candidate) => [
      perLine ? `${candidate.path}:${candidate.line ?? ""}` : `${candidate.path}:${candidate.line ?? ""}:${candidate.column ?? ""}`,
      candidate,
    ])).values()].sort((left, right) =>
      ordinal(`${left.path}:${String(left.line ?? 0).padStart(12, "0")}:${String(left.column ?? 0).padStart(12, "0")}`, `${right.path}:${String(right.line ?? 0).padStart(12, "0")}:${String(right.column ?? 0).padStart(12, "0")}`),
    ),
  );
}

function ignorePatterns(snapshot: RepositorySourceSnapshotResult): readonly string[] {
  const bytes = snapshot.sourceBytes.get(".ignore");
  if (bytes === undefined) return [];
  return Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}

function ignored(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\//u, "");
    if (normalized.endsWith("/")) return path.startsWith(normalized);
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function compactObservation(result: CandidateStepResult): string {
  // This is the exact candidate-visible observation counted by the harness. Short keys are a
  // versioned transport choice, not omission of coverage, evidence, or absence semantics.
  return JSON.stringify({
    a: result.confirmedAbsent,
    c: result.candidates.map((candidate) => [candidate.path, candidate.line, candidate.column]),
    e: result.evidenceLevel,
    v: result.coverage,
  });
}

async function textualSearch(snapshot: RepositorySourceSnapshotResult, text: string): Promise<readonly Candidate[]> {
  const output: Candidate[] = [];
  for (const entry of snapshot.snapshot.entries) {
    if (entry.textEncoding !== "utf8") continue;
    const bytes = snapshot.sourceBytes.get(entry.relativePath);
    if (bytes === undefined) continue;
    for (const [index, line] of Buffer.from(bytes).toString("utf8").split(/\r?\n/u).entries()) {
      const column = line.indexOf(text);
      if (column >= 0) output.push(lineCandidate(entry.relativePath, index + 1, column + 1));
    }
  }
  return deduplicate(output);
}

async function executeStep(
  workspace: string,
  category: RepositoryBenchmarkAttempt["category"],
  step: RepositoryVisibleQuery["program"][number],
  semanticReferences: boolean,
  signal: AbortSignal,
): Promise<CandidateStepResult> {
  const snapshot = await (await RepositorySourceSnapshotter.create(workspace)).snapshot(signal);
  const sourceBytesScanned = snapshot.snapshot.entries.reduce((total, entry) => total + entry.byteLength, 0);
  const coverage = snapshot.snapshot.coverage === "complete" ? "complete" : "partial";
  const records = analyzeTypeScriptSnapshot(workspace, snapshot, {
    evidenceLevel: semanticReferences ? "semantic" : "syntactic",
  });

  if (category === "outline" || (category === "freshness" && step.tool === "list_files")) {
    const pathPrefix = typeof step.arguments.path === "string" ? `${step.arguments.path.replaceAll("\\", "/").replace(/\/$/u, "")}/` : null;
    const patterns = ignorePatterns(snapshot);
    const candidates = snapshot.snapshot.entries
      .map((entry) => entry.relativePath)
      .filter((path) => pathPrefix === null || path.startsWith(pathPrefix))
      .filter((path) => !ignored(path, patterns))
      .map((path) => Object.freeze({ column: null, line: null, path }));
    return Object.freeze({ candidates: deduplicate(candidates), confirmedAbsent: candidates.length === 0 && coverage === "complete", coverage, evidenceLevel: "syntactic", sourceBytesScanned });
  }

  if (category === "rules") {
    const candidates = snapshot.snapshot.entries
      .filter((entry) => entry.relativePath === "AGENTS.md" || entry.relativePath.endsWith("/AGENTS.md"))
      .map((entry) => Object.freeze({ column: null, line: null, path: entry.relativePath }));
    return Object.freeze({ candidates: deduplicate(candidates), confirmedAbsent: candidates.length === 0 && coverage === "complete", coverage, evidenceLevel: "syntactic", sourceBytesScanned });
  }

  const visibleText = queryString(step.arguments);
  if (category === "unsupported") {
    const candidates = await textualSearch(snapshot, visibleText);
    return Object.freeze({ candidates, confirmedAbsent: false, coverage: "unsupported", evidenceLevel: "textual_fallback", sourceBytesScanned });
  }

  if (category === "references") {
    if (!semanticReferences) {
      return Object.freeze({ candidates: [], confirmedAbsent: false, coverage: "partial", evidenceLevel: "syntactic", sourceBytesScanned });
    }
    const importQuery = /\bfrom\s+["']([^"']+)["']/u.exec(visibleText)?.[1];
    if (importQuery !== undefined) {
      const candidates = records.imports
        .filter((entry) => entry.specifier === importQuery)
        .map((entry) => lineCandidate(entry.sourcePath, entry.range.startLine, entry.range.startColumnUtf16));
      return Object.freeze({ candidates: deduplicate(candidates, true), confirmedAbsent: candidates.length === 0 && coverage === "complete", coverage, evidenceLevel: "semantic", sourceBytesScanned });
    }
    const name = symbolQuery(visibleText);
    const targetIds = new Set(records.symbols.filter((symbol) => symbol.name === name).map((symbol) => symbol.recordId));
    const candidates = records.references
      .filter((reference) => reference.targetSymbolRecordId !== null && targetIds.has(reference.targetSymbolRecordId))
      .map((reference) => lineCandidate(reference.sourcePath, reference.range.startLine, reference.range.startColumnUtf16));
    return Object.freeze({ candidates: deduplicate(candidates, true), confirmedAbsent: candidates.length === 0 && coverage === "complete", coverage, evidenceLevel: "semantic", sourceBytesScanned });
  }

  const name = symbolQuery(visibleText);
  const candidates = records.symbols
    .filter((symbol) => symbol.name === name)
    .map((symbol) => lineCandidate(symbol.relativePath, symbol.range.startLine, symbol.range.startColumnUtf16));
  return Object.freeze({ candidates: deduplicate(candidates), confirmedAbsent: candidates.length === 0 && coverage === "complete", coverage, evidenceLevel: semanticReferences ? "semantic" : "syntactic", sourceBytesScanned });
}

abstract class TypeScriptCandidateAdapter implements RepositoryBenchmarkAdapter {
  abstract readonly identity: Readonly<Record<string, unknown>>;
  protected abstract readonly semanticReferences: boolean;

  async run(
    caseId: string,
    category: RepositoryBenchmarkAttempt["category"],
    workspace: string,
    query: RepositoryVisibleQuery,
    signal: AbortSignal,
  ): Promise<RepositoryBenchmarkObservation> {
    const started = performance.now();
    let finalResult: CandidateStepResult = Object.freeze({ candidates: [], confirmedAbsent: false, coverage: "partial", evidenceLevel: "syntactic", sourceBytesScanned: 0 });
    let observationBytes = 0;
    try {
      for (const [index, step] of query.program.entries()) {
        if (signal.aborted) throw signal.reason ?? new Error("candidate benchmark cancelled");
        finalResult = await executeStep(workspace, category, step, this.semanticReferences, signal);
        observationBytes += Buffer.byteLength(compactObservation(finalResult), "utf8");
        await applyActions(workspace, query, index);
      }
      return {
        attempt: Object.freeze({
          candidates: [...finalResult.candidates],
          caseId,
          category,
          confirmedAbsent: finalResult.confirmedAbsent,
          coverage: finalResult.coverage,
          durationMs: performance.now() - started,
          errorCode: null,
          evidenceLevel: finalResult.evidenceLevel,
          observationBytes,
          sourceBytesScanned: finalResult.sourceBytesScanned,
          status: "completed" as const,
          toolCalls: [],
        }),
      };
    } catch {
      return {
        attempt: Object.freeze({
          candidates: [],
          caseId,
          category,
          confirmedAbsent: false,
          coverage: "partial" as const,
          durationMs: performance.now() - started,
          errorCode: signal.aborted ? "repository_benchmark_cancelled" : "repository_candidate_failed",
          evidenceLevel: this.semanticReferences ? "semantic" as const : "syntactic" as const,
          observationBytes,
          sourceBytesScanned: null,
          status: signal.aborted ? "cancelled" as const : "error" as const,
          toolCalls: [],
        }),
      };
    }
  }
}

export class TypeScriptSyntacticCandidateAdapter extends TypeScriptCandidateAdapter {
  readonly identity = Object.freeze({
    adapter: "typescript_syntactic_candidate_v1",
    capabilities: Object.freeze({ definitions: "syntactic", imports: "syntactic", references: "unsupported" }),
    engine: "typescript_compiler_ast",
    packageIntegritySha256: sha256Canonical(TYPESCRIPT_ENGINE_ASSET),
    packageName: TYPESCRIPT_ENGINE_ASSET.package,
    packageVersion: TYPESCRIPT_ENGINE_ASSET.version,
    protocolVersion: 1,
    securityEnvelope: Object.freeze({ childProcess: false, network: false, repositoryConfig: false, repositoryPlugins: false }),
  });
  protected readonly semanticReferences = false;
}

export class TypeScriptSemanticCandidateAdapter extends TypeScriptCandidateAdapter {
  readonly identity = createTypeScriptEngineIdentity();
  protected readonly semanticReferences = true;
}
