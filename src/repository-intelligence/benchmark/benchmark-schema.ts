import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { RepositoryIntelligenceError } from "../repository-intelligence-error.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeRefSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !isAbsolute(value) &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "reference must be a canonical relative path",
  );

export const repositoryBenchmarkCaseSchema = z
  .object({
    category: z.enum(["definition", "references", "outline", "rules", "freshness", "unsupported"]),
    hiddenExpectedRef: safeRefSchema,
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u),
    limits: z
      .object({
        maxObservationBytes: z.number().int().positive().max(4 * 1024 * 1024),
        timeoutMs: z.number().int().positive().max(60_000),
      })
      .strict(),
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
    visibleQueryRef: safeRefSchema,
    workspaceRef: safeRefSchema,
    workspaceSha256: sha256Schema,
  })
  .strict();

export type RepositoryBenchmarkCaseV1 = Readonly<z.infer<typeof repositoryBenchmarkCaseSchema>>;

export const repositoryBenchmarkSuiteSchema = z
  .object({
    cases: z.array(repositoryBenchmarkCaseSchema).min(20),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u),
    schemaVersion: z.literal(1),
    smokeCaseIds: z.array(z.string()).length(8),
    suiteVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.cases.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "benchmark case IDs must be unique" });
    }
    if (new Set(value.smokeCaseIds).size !== value.smokeCaseIds.length) {
      context.addIssue({ code: "custom", message: "smoke case IDs must be unique" });
    }
    for (const id of value.smokeCaseIds) {
      if (!ids.includes(id)) context.addIssue({ code: "custom", message: `unknown smoke case: ${id}` });
    }
  });

export type RepositoryBenchmarkSuiteV1 = Readonly<z.infer<typeof repositoryBenchmarkSuiteSchema>>;

const toolStepSchema = z
  .object({
    arguments: z.record(z.string(), z.unknown()),
    tool: z.enum(["list_files", "read_file", "search"]),
  })
  .strict();

const fixtureActionSchema = z.discriminatedUnion("kind", [
  z.object({ afterStep: z.number().int().nonnegative(), content: z.string().max(1024 * 1024), kind: z.literal("write_file"), path: safeRefSchema }).strict(),
  z.object({ afterStep: z.number().int().nonnegative(), from: safeRefSchema, kind: z.literal("rename_file"), to: safeRefSchema }).strict(),
  z.object({ afterStep: z.number().int().nonnegative(), kind: z.literal("delete_file"), path: safeRefSchema }).strict(),
]);

export const repositoryVisibleQuerySchema = z
  .object({
    fixtureActions: z.array(fixtureActionSchema),
    program: z.array(toolStepSchema).min(1).max(20),
    requestKind: z.enum(["definition", "references", "outline", "rules", "freshness", "unsupported"]),
    schemaVersion: z.literal(1),
  })
  .strict();

export type RepositoryVisibleQuery = Readonly<z.infer<typeof repositoryVisibleQuerySchema>>;

const expectedCandidateSchema = z
  .object({
    column: z.number().int().positive().nullable(),
    line: z.number().int().positive().nullable(),
    path: safeRefSchema,
  })
  .strict();

export const repositoryHiddenExpectedSchema = z
  .object({
    caseId: z.string(),
    confirmedAbsent: z.boolean(),
    expected: z.array(expectedCandidateSchema),
    schemaVersion: z.literal(1),
  })
  .strict();

export type RepositoryHiddenExpected = Readonly<z.infer<typeof repositoryHiddenExpectedSchema>>;

export interface LoadedRepositoryBenchmarkSuite {
  readonly root: string;
  readonly suite: RepositoryBenchmarkSuiteV1;
  readonly suiteSha256: string;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function resolveBenchmarkRef(root: string, ref: string): string {
  const candidate = resolve(root, ref);
  if (!inside(resolve(root), candidate)) {
    throw new RepositoryIntelligenceError(
      "repository_benchmark_manifest_invalid",
      "benchmark reference escapes the assets root",
      2,
    );
  }
  return candidate;
}

async function readStrictJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new RepositoryIntelligenceError(
      "repository_benchmark_manifest_invalid",
      "benchmark JSON could not be decoded",
      2,
      { cause: error },
    );
  }
}

export async function loadRepositoryBenchmarkSuite(path: string): Promise<LoadedRepositoryBenchmarkSuite> {
  try {
    const raw = await readStrictJson(path);
    const suite = repositoryBenchmarkSuiteSchema.parse(raw);
    const root = dirname(path);
    for (const entry of suite.cases) {
      resolveBenchmarkRef(root, entry.visibleQueryRef);
      resolveBenchmarkRef(root, entry.hiddenExpectedRef);
      resolveBenchmarkRef(root, entry.workspaceRef);
    }
    return Object.freeze({ root, suite, suiteSha256: sha256Canonical(suite) });
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError(
      "repository_benchmark_manifest_invalid",
      "benchmark suite failed strict validation",
      2,
      { cause: error },
    );
  }
}

export async function loadVisibleQuery(path: string): Promise<RepositoryVisibleQuery> {
  try {
    return repositoryVisibleQuerySchema.parse(await readStrictJson(path));
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError("repository_benchmark_manifest_invalid", "visible query failed strict validation", 2, { cause: error });
  }
}

export async function loadHiddenExpected(path: string, caseId: string): Promise<RepositoryHiddenExpected> {
  try {
    const expected = repositoryHiddenExpectedSchema.parse(await readStrictJson(path));
    if (expected.caseId !== caseId) throw new Error("hidden expected case ID mismatch");
    return expected;
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError("repository_benchmark_harness_invalid", "hidden expected failed strict validation", 1, { cause: error });
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
