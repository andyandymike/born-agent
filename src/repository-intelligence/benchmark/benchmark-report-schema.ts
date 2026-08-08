import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const benchmarkCandidateSchema = z
  .object({
    column: z.number().int().positive().nullable(),
    line: z.number().int().positive().nullable(),
    path: z.string().min(1),
  })
  .strict();

export const repositoryBenchmarkAttemptSchema = z
  .object({
    candidates: z.array(benchmarkCandidateSchema),
    caseId: z.string(),
    category: z.enum(["definition", "references", "outline", "rules", "freshness", "unsupported"]),
    confirmedAbsent: z.boolean(),
    coverage: z.enum(["complete", "partial", "unsupported"]),
    durationMs: z.number().nonnegative(),
    errorCode: z.string().nullable(),
    evidenceLevel: z.enum(["semantic", "syntactic", "textual_fallback"]),
    grading: z
      .object({
        confirmedAbsenceCorrect: z.boolean(),
        falseNegatives: z.number().int().nonnegative(),
        falsePositives: z.number().int().nonnegative(),
        top1Correct: z.boolean(),
        top5Correct: z.boolean(),
        truePositives: z.number().int().nonnegative(),
      })
      .strict(),
    observationBytes: z.number().int().nonnegative(),
    sourceBytesScanned: z.number().int().nonnegative().nullable(),
    status: z.enum(["completed", "cancelled", "error", "timeout"]),
    toolCalls: z.array(
      z.object({ argumentsSha256: sha256Schema, name: z.enum(["list_files", "read_file", "search"]), observationBytes: z.number().int().nonnegative() }).strict(),
    ),
  })
  .strict();

export type RepositoryBenchmarkAttempt = Readonly<z.infer<typeof repositoryBenchmarkAttemptSchema>>;

export const repositoryBenchmarkMetricsSchema = z
  .object({
    confirmedAbsenceAccuracy: z.number().min(0).max(1).nullable(),
    definitionTop1: z.number().min(0).max(1).nullable(),
    definitionTop5: z.number().min(0).max(1).nullable(),
    harnessInvalidCount: z.number().int().nonnegative(),
    observationBytesMedian: z.number().nonnegative().nullable(),
    observationBytesP95: z.number().nonnegative().nullable(),
    observationBytesTotal: z.number().int().nonnegative(),
    outlinePrecision: z.number().min(0).max(1).nullable(),
    outlineRecall: z.number().min(0).max(1).nullable(),
    referenceF1: z.number().min(0).max(1).nullable(),
    referencePrecision: z.number().min(0).max(1).nullable(),
    referenceRecall: z.number().min(0).max(1).nullable(),
    ruleScopeAccuracy: z.number().min(0).max(1).nullable(),
    scheduledAttempts: z.number().int().nonnegative(),
    staleFalseNegativeCount: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type RepositoryBenchmarkMetrics = Readonly<z.infer<typeof repositoryBenchmarkMetricsSchema>>;

export const repositoryBenchmarkReportSchema = z
  .object({
    attempts: z.array(repositoryBenchmarkAttemptSchema),
    engineIdentitySha256: sha256Schema,
    environmentFingerprint: sha256Schema,
    metrics: repositoryBenchmarkMetricsSchema,
    modelFreeRetrieval: z.literal(true),
    modelQualityEvidence: z.literal("not_measured"),
    remoteExecution: z.literal("not_run_by_policy"),
    runId: z.string().min(1),
    schemaVersion: z.literal(1),
    sourceCorpusSha256: sha256Schema,
    suiteId: z.string().min(1),
    suiteSha256: sha256Schema,
    suiteVersion: z.number().int().positive(),
  })
  .strict();

export type RepositoryBenchmarkReportV1 = Readonly<z.infer<typeof repositoryBenchmarkReportSchema>>;
