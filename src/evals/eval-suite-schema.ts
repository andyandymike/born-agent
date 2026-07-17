import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const taskIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

const suiteTaskRefSchema = z
  .object({
    id: taskIdSchema,
    task_version: z.number().int().positive(),
    task_manifest_sha256: sha256Schema,
    initial_workspace_sha256: sha256Schema,
    grader_sha256: sha256Schema,
  })
  .strict();

export const evalSuiteSchema = z
  .object({
    schema_version: z.literal(1),
    id: taskIdSchema,
    suite_version: z.number().int().positive(),
    tasks: z.array(suiteTaskRefSchema).min(20),
    smoke_task_ids: z.array(taskIdSchema).length(5),
    full_task_ids: z.array(taskIdSchema).min(20),
    repetition_policy: z
      .object({
        smoke_default: z.number().int().min(1).max(10),
        full_default: z.number().int().min(1).max(10),
        maximum: z.literal(10),
      })
      .strict(),
    attempt_inclusion_rule: z.literal("valid_started_v1"),
    metric_definition_version: z.literal(1),
    price_currency: z.literal("USD"),
  })
  .strict();

export type EvalSuite = z.infer<typeof evalSuiteSchema>;
export type EvalSuiteTaskRef = z.infer<typeof suiteTaskRefSchema>;

export interface LoadedEvalSuite {
  readonly suite: EvalSuite;
  readonly suiteSha256: string;
  readonly repetitionPolicySha256: string;
}

export function loadEvalSuite(input: unknown): LoadedEvalSuite {
  const parsed = evalSuiteSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_manifest_invalid", "invalid eval suite schema", 1, { cause: parsed.error });
  }
  const taskIds = parsed.data.tasks.map((task) => task.id);
  const known = new Set(taskIds);
  if (known.size !== taskIds.length) {
    throw new EvalCoreError("eval_harness_invariant", "suite contains duplicate task IDs", 1);
  }
  for (const [label, ids] of [
    ["smoke", parsed.data.smoke_task_ids],
    ["full", parsed.data.full_task_ids],
  ] as const) {
    if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw new EvalCoreError("eval_harness_invariant", `${label} task list is not a fixed subset of suite tasks`, 1);
    }
  }
  if (parsed.data.full_task_ids.length !== taskIds.length || taskIds.some((id) => !parsed.data.full_task_ids.includes(id))) {
    throw new EvalCoreError("eval_harness_invariant", "full task list must contain the complete fixed task set", 1);
  }
  return Object.freeze({
    suite: Object.freeze(parsed.data),
    suiteSha256: sha256Canonical(parsed.data),
    repetitionPolicySha256: sha256Canonical(parsed.data.repetition_policy),
  });
}

export function selectEvalTaskIds(
  suite: LoadedEvalSuite,
  kind: "smoke" | "full",
): readonly string[] {
  return Object.freeze([...(kind === "smoke" ? suite.suite.smoke_task_ids : suite.suite.full_task_ids)]);
}
