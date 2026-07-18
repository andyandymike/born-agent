import { z } from "zod";

import { EvalCoreError } from "./eval-errors.js";
import { persistedRuntimePolicyEvidenceSchema } from "../policy/policy-evidence.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nullableUsage = z
  .object({
    completeness: z.enum(["complete", "partial", "none"]),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const evalNoCostEvidenceSchema = z
  .object({
    policy: z.literal("zero-paid-provider-v1"),
    policySha256: sha256,
    sourceKind: z.enum(["in_process_test", "local_ollama"]),
    endpointScope: z.enum(["none", "literal_loopback"]),
    credentialAccessEnabled: z.literal(false),
    proxyEnabled: z.literal(false),
    redirectsEnabled: z.literal(false),
    remoteFallbackEnabled: z.literal(false),
    automaticPullEnabled: z.literal(false),
    billableProviderRequestsSent: z.literal(0),
    forbiddenProviderRequestsBlocked: z.number().int().nonnegative(),
    estimatedCostUsd: z.null(),
    billedCostUsd: z.null(),
    costReason: z.enum(["test_backend", "local_unpriced_backend"]),
  })
  .strict();

const outcomeSchema = z
  .object({
    agentCompleted: z.boolean(),
    pathPolicyPassed: z.boolean(),
    gradersPassed: z.boolean(),
    solutionPassed: z.boolean(),
    taskPassed: z.boolean(),
    falseComplete: z.boolean(),
    solvedIncomplete: z.boolean(),
    safetyViolation: z.boolean(),
    quadrant: z.enum([
      "completed_solved",
      "completed_unsolved",
      "incomplete_solved",
      "incomplete_unsolved",
    ]),
  })
  .strict();

export const evalAttemptReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    evalRunId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
    taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    taskVersion: z.number().int().positive(),
    repetition: z.number().int().positive(),
    status: z.enum(["complete", "partial", "harness_invalid", "cancelled"]),
    validAttempt: z.boolean(),
    outcome: outcomeSchema.nullable(),
    primaryCategory: z
      .enum(["harness", "environment", "provider", "permission", "tool", "context", "completion", "model"])
      .nullable(),
    secondaryCodes: z.array(z.string().min(1).max(128)),
    taskManifestSha256: sha256,
    scenarioSha256: sha256,
    scenarioConfigSha256: sha256,
    serviceSetSha256: sha256,
    initialWorkspaceSha256: sha256,
    finalWorkspaceSha256: sha256.nullable(),
    observationSha256: sha256.nullable(),
    usage: nullableUsage,
    baselineGitHead: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
    graderSha256: sha256.optional(),
    changedPaths: z.array(z.string()).optional(),
    changedLines: z.number().int().nonnegative().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    agentTerminal: z.enum(["completed", "incomplete", "failed", "cancelled"]).nullable().optional(),
    executionSourceSha256: sha256.optional(),
    provider: z.string().min(1).max(256).optional(),
    model: z.string().min(1).max(512).optional(),
    installedModelDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u).nullable().optional(),
    adapter: z.enum(["in-process-eval-v1", "ollama-direct-loopback-v1"]).optional(),
    noCostEvidence: evalNoCostEvidenceSchema,
    runtimePolicy: persistedRuntimePolicyEvidenceSchema.optional(),
    fullSuiteExecution: z.enum(["not_run_by_policy", "executed"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.fullSuiteExecution === "executed" &&
      (value.runtimePolicy?.profile_mode !== "local_free" ||
        value.runtimePolicy.explicit_selection !== true ||
        value.runtimePolicy.paid_capable ||
        !value.runtimePolicy.allowed_eval_suites.includes("full"))
    ) {
      context.addIssue({
        code: "custom",
        message: "full execution requires an explicit local profile allowing full",
      });
    }
  });

export type EvalAttemptReport = z.infer<typeof evalAttemptReportSchema>;

export function parseEvalAttemptReport(input: unknown): EvalAttemptReport {
  const parsed = evalAttemptReportSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_report_corrupt", "eval attempt report is corrupt", 1, { cause: parsed.error });
  }
  return Object.freeze(parsed.data);
}
