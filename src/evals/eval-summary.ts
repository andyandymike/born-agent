import { z } from "zod";

import type { EvalNoCostEvidence } from "./eval-no-cost-policy.js";
import { evalNoCostEvidenceSchema, type EvalAttemptReport } from "./eval-report-schema.js";
import type { LoadedEvalAssets } from "./eval-suite-loader.js";
import { aggregateEvalDenominators, aggregateReportedUsage, summarizeDistribution, type EvalAttemptMetricRow } from "./metrics-collector.js";
import type { EvalExitCode } from "./eval-exit-code.js";
import type { EvalRunCompatibility, ComparableEvalRun } from "./eval-comparator.js";
import type { persistRuntimePolicyEvidence } from "../policy/policy-evidence.js";
import { persistedRuntimePolicyEvidenceSchema } from "../policy/policy-evidence.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const compatibilityTaskSchema = z.object({
  id: z.string(), taskVersion: z.number().int().positive(), workspaceSha256: sha256, graderSha256: sha256,
  scenarioSchemaVersion: z.number().int().positive(), scenarioKind: z.enum(["single_run", "scripted_v1"]),
  scenarioSha256: sha256, scenarioConfigSha256: sha256, serviceSetSha256: sha256,
}).strict();

export const evalRunSummarySchema = z.object({
  schemaVersion: z.literal(1),
  evalRunId: z.string(),
  suiteId: z.string(),
  suiteVersion: z.number().int().positive(),
  suiteSha256: sha256,
  suiteKind: z.enum(["smoke", "full", "targeted"]),
  partialSuite: z.boolean(),
  status: z.enum(["complete", "config_error", "harness_invalid", "cancelled", "partial"]),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(9), z.literal(130)]),
  provider: z.string(),
  model: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  fullSuiteExecution: z.enum(["not_run_by_policy", "executed"]),
  noCostEvidence: evalNoCostEvidenceSchema,
  runtimePolicy: persistedRuntimePolicyEvidenceSchema.optional(),
  denominators: z.object({
    scheduled: z.number().int().nonnegative(), valid: z.number().int().nonnegative(), harnessInvalid: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), taskPasses: z.number().int().nonnegative(),
    taskPassDenominator: z.number().int().nonnegative(), falseCompletes: z.number().int().nonnegative(),
    solvedIncomplete: z.number().int().nonnegative(), safetyViolations: z.number().int().nonnegative(),
  }).strict(),
  usage: z.object({
    completeness: z.enum(["complete", "partial", "none"]), inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(), cacheWriteTokens: z.number().int().nonnegative().nullable(), reasoningTokens: z.number().int().nonnegative().nullable(), totalTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  latencyMs: z.object({ scheduledN: z.number().int().nonnegative(), observedN: z.number().int().nonnegative(), median: z.number().nonnegative().nullable(), p95: z.number().nonnegative().nullable() }).strict(),
  compatibility: z.object({
    suiteVersion: z.number().int().positive(), tasks: z.array(compatibilityTaskSchema), repetitionPolicySha256: sha256,
    attemptInclusionRule: z.string(), reportSchemaVersion: z.number().int().positive(), metricDefinitionVersion: z.number().int().positive(),
    priceCurrency: z.literal("USD"),
    repetitions: z.number().int().min(1).max(10),
  }).strict(),
  config: z.record(z.string(), z.unknown()),
  tasks: z.array(z.object({
    taskId: z.string(), passed: z.boolean(), falseComplete: z.boolean(), solvedIncomplete: z.boolean(), safetyViolation: z.boolean(),
  }).strict()),
  limitation: z.literal("descriptive_only_no_statistical_significance_claim"),
}).strict().superRefine((value, context) => {
  if (
    value.fullSuiteExecution === "executed" &&
    (value.suiteKind !== "full" ||
      value.runtimePolicy?.profile_mode !== "local_free" ||
      value.runtimePolicy.explicit_selection !== true ||
      value.runtimePolicy.paid_capable ||
      !value.runtimePolicy.allowed_eval_suites.includes("full"))
  ) {
    context.addIssue({
      code: "custom",
      message: "full summary requires an explicit local profile allowing full",
    });
  }
});

export type EvalRunSummary = z.infer<typeof evalRunSummarySchema>;

export function parseEvalRunSummary(input: unknown): EvalRunSummary {
  return evalRunSummarySchema.parse(input);
}

export function createRunCompatibility(assets: LoadedEvalAssets, selectedTaskIds: readonly string[], repetitions: number): EvalRunCompatibility {
  return Object.freeze({
    suiteVersion: assets.suite.suite.suite_version,
    tasks: Object.freeze(selectedTaskIds.map((id) => {
      const reference = assets.suite.suite.tasks.find((candidate) => candidate.id === id);
      const asset = assets.tasks.get(id);
      if (reference === undefined || asset === undefined) throw new Error(`missing loaded eval task ${id}`);
      return Object.freeze({
        id,
        taskVersion: reference.task_version,
        workspaceSha256: reference.initial_workspace_sha256,
        graderSha256: reference.grader_sha256,
        scenarioSchemaVersion: 1,
        scenarioKind: asset.task.scenario.scenario.kind,
        scenarioSha256: asset.task.scenario.scenarioSha256,
        scenarioConfigSha256: asset.task.scenario.scenarioConfigSha256,
        serviceSetSha256: asset.task.scenario.serviceSetSha256,
      });
    })),
    repetitionPolicySha256: assets.suite.repetitionPolicySha256,
    attemptInclusionRule: assets.suite.suite.attempt_inclusion_rule,
    reportSchemaVersion: 1,
    metricDefinitionVersion: assets.suite.suite.metric_definition_version,
    priceCurrency: assets.suite.suite.price_currency,
    repetitions,
  });
}

export function buildEvalRunSummary(input: {
  readonly assets: LoadedEvalAssets;
  readonly evalRunId: string;
  readonly suiteKind: "smoke" | "full" | "targeted";
  readonly selectedTaskIds: readonly string[];
  readonly attempts: readonly EvalAttemptReport[];
  readonly repetitions: number;
  readonly provider: string;
  readonly model: string;
  readonly noCostEvidence: EvalNoCostEvidence;
  readonly fullSuiteExecution: "executed" | "not_run_by_policy";
  readonly runtimePolicy?: ReturnType<typeof persistRuntimePolicyEvidence>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode: EvalExitCode;
  readonly status: "complete" | "config_error" | "harness_invalid" | "cancelled" | "partial";
}): EvalRunSummary {
  const attemptsByTask = new Map<string, EvalAttemptReport[]>();
  for (const attempt of input.attempts) {
    const current = attemptsByTask.get(attempt.taskId) ?? [];
    current.push(attempt);
    attemptsByTask.set(attempt.taskId, current);
  }
  const rows: EvalAttemptMetricRow[] = input.attempts.map((attempt) => ({
    status: attempt.status === "harness_invalid" ? "harness_invalid" as const : attempt.status === "cancelled" ? "cancelled" as const : "valid" as const,
    taskPassed: attempt.outcome?.taskPassed ?? null,
    falseComplete: attempt.outcome?.falseComplete ?? null,
    solvedIncomplete: attempt.outcome?.solvedIncomplete ?? null,
    safetyViolation: attempt.outcome?.safetyViolation ?? null,
  }));
  const missing = input.selectedTaskIds.length * input.repetitions - input.attempts.length;
  for (let index = 0; index < missing; index += 1) rows.push({ status: "missing" as const, taskPassed: null, falseComplete: null, solvedIncomplete: null, safetyViolation: null });
  const denominators = aggregateEvalDenominators(rows);
  const tasks = input.selectedTaskIds.map((taskId) => {
    const attempts = attemptsByTask.get(taskId) ?? [];
    return Object.freeze({
      taskId,
      passed: attempts.length === input.repetitions && attempts.every((attempt) => attempt.outcome?.taskPassed === true),
      falseComplete: attempts.some((attempt) => attempt.outcome?.falseComplete === true),
      solvedIncomplete: attempts.some((attempt) => attempt.outcome?.solvedIncomplete === true),
      safetyViolation: attempts.some((attempt) => attempt.outcome?.safetyViolation === true),
    });
  });
  const compatibility = createRunCompatibility(input.assets, input.selectedTaskIds, input.repetitions);
  return evalRunSummarySchema.parse({
    schemaVersion: 1,
    evalRunId: input.evalRunId,
    suiteId: input.assets.suite.suite.id,
    suiteVersion: input.assets.suite.suite.suite_version,
    suiteSha256: input.assets.suite.suiteSha256,
    suiteKind: input.suiteKind,
    partialSuite: input.suiteKind === "targeted",
    status: input.status,
    exitCode: input.exitCode,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    fullSuiteExecution: input.fullSuiteExecution,
    noCostEvidence: input.noCostEvidence,
    ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
    denominators,
    usage: aggregateReportedUsage(input.attempts.map((attempt) => attempt.usage)),
    latencyMs: summarizeDistribution(input.attempts.map((attempt) => attempt.durationMs ?? null)),
    compatibility: { ...compatibility, tasks: [...compatibility.tasks] },
    config: {
      provider: input.provider,
      model: input.model,
      noCostPolicySha256: input.noCostEvidence.policySha256,
      ...(input.runtimePolicy === undefined
        ? {}
        : {
            runtimePolicyProfileId: input.runtimePolicy.profile_id,
            runtimePolicyProfileSha256: input.runtimePolicy.profile_sha256,
          }),
    },
    tasks: [...tasks],
    limitation: "descriptive_only_no_statistical_significance_claim",
  });
}

export function summaryAsComparable(summary: EvalRunSummary): ComparableEvalRun {
  return Object.freeze({ compatibility: summary.compatibility, config: summary.config, tasks: summary.tasks, harnessInvalidCount: summary.denominators.harnessInvalid, reportCorrupt: false });
}

export function renderEvalSummary(summary: EvalRunSummary): string {
  const denominator = summary.denominators.taskPassDenominator;
  const percent = denominator === 0 ? "n/a" : `${((summary.denominators.taskPasses / denominator) * 100).toFixed(1)}%`;
  return [
    `Eval run:            ${summary.evalRunId}`,
    `Status:              ${summary.status}`,
    `Scheduled attempts:  ${String(summary.denominators.scheduled)}`,
    `Valid attempts:      ${String(summary.denominators.valid)}`,
    `Harness-invalid:     ${String(summary.denominators.harnessInvalid)}`,
    `Task passes:         ${String(summary.denominators.taskPasses)} / ${String(denominator)} (${percent})`,
    `False completes:     ${String(summary.denominators.falseCompletes)} / ${String(denominator)}`,
    `Solved incomplete:   ${String(summary.denominators.solvedIncomplete)} / ${String(denominator)}`,
    `Execution policy:    ${summary.noCostEvidence.policy}`,
    ...(summary.runtimePolicy === undefined
      ? []
      : [
          `Runtime profile:     ${String(summary.runtimePolicy.profile_id)} (${String(summary.runtimePolicy.profile_mode)})`,
          `Runtime policy SHA:  ${String(summary.runtimePolicy.profile_sha256)}`,
        ]),
    `Model source:        ${summary.noCostEvidence.sourceKind}`,
    `Billable requests:   ${String(summary.noCostEvidence.billableProviderRequestsSent)} sent / ${String(summary.noCostEvidence.forbiddenProviderRequestsBlocked)} blocked`,
    `Estimated API cost:  null (${summary.noCostEvidence.costReason})`,
    "Billed API cost:     null (billing systems not queried)",
    `Full suite:          ${summary.fullSuiteExecution}`,
    `Provider tokens:     ${summary.usage.totalTokens === null ? `unknown (${summary.usage.completeness})` : String(summary.usage.totalTokens)}`,
    `Median / p95:        ${summary.latencyMs.median === null ? "unknown" : String(summary.latencyMs.median)} / ${summary.latencyMs.p95 === null ? "unknown" : String(summary.latencyMs.p95)} ms (n=${String(summary.latencyMs.observedN)})`,
    `Result limitation:   ${summary.limitation}`,
    "",
  ].join("\n");
}
