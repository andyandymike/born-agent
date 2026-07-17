import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { evalServiceRefSchema, type EvalServiceRegistry, type ResolvedEvalService } from "./eval-service-registry.js";

export const evalFaultHookSchema = z.enum([
  "after_checkpoint_created",
  "after_patch_apply_started",
  "after_command_started",
  "after_context_plan_created",
  "after_mcp_call_started",
]);

const scenarioConfigSchema = z
  .object({
    context_window_tokens: z.number().int().min(2_048).max(131_072),
    executor: z.literal("docker_v1"),
  })
  .strict();

const runStepSchema = z
  .object({
    kind: z.literal("run"),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    prompt: z.string().min(1).max(100_000).optional(),
    fault: z
      .object({
        hook: evalFaultHookSchema,
        action: z.literal("terminate_once"),
      })
      .strict()
      .optional(),
  })
  .strict();

const resumeStepSchema = z
  .object({
    kind: z.literal("resume"),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    from: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  })
  .strict();

const singleRunScenarioSchema = z
  .object({
    kind: z.literal("single_run"),
    config: scenarioConfigSchema,
    services: z.array(evalServiceRefSchema).max(16),
  })
  .strict();

const scriptedScenarioSchema = z
  .object({
    kind: z.literal("scripted_v1"),
    config: scenarioConfigSchema,
    services: z.array(evalServiceRefSchema).max(16),
    steps: z.array(z.discriminatedUnion("kind", [runStepSchema, resumeStepSchema])).min(1).max(8),
  })
  .strict();

export const evalScenarioSchema = z.discriminatedUnion("kind", [singleRunScenarioSchema, scriptedScenarioSchema]);

export type EvalScenario = z.infer<typeof evalScenarioSchema>;
export type EvalFaultHook = z.infer<typeof evalFaultHookSchema>;
export type EvalScenarioStep = z.infer<typeof runStepSchema> | z.infer<typeof resumeStepSchema>;

export interface LoadedEvalScenario {
  readonly scenario: EvalScenario;
  readonly resolvedServices: readonly ResolvedEvalService[];
  readonly scenarioSha256: string;
  readonly scenarioConfigSha256: string;
  readonly serviceSetSha256: string;
}

function validateScriptedSteps(steps: readonly EvalScenarioStep[]): void {
  const ids = new Set<string>();
  let runs = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) {
      throw new EvalCoreError("eval_scenario_invalid", "scenario step is missing", 1);
    }
    if (ids.has(step.id)) {
      throw new EvalCoreError("eval_scenario_invalid", `duplicate scenario step id: ${step.id}`, 1);
    }
    ids.add(step.id);
    if (step.kind === "run") {
      runs += 1;
      if (step.fault !== undefined) {
        const next = steps[index + 1];
        if (next?.kind !== "resume" || next.from !== step.id) {
          throw new EvalCoreError(
            "eval_scenario_invalid",
            `faulted run '${step.id}' must be followed immediately by its resume step`,
            1,
          );
        }
      }
      continue;
    }
    const previous = steps[index - 1];
    if (previous?.kind !== "run" || previous.fault?.action !== "terminate_once" || step.from !== previous.id) {
      throw new EvalCoreError(
        "eval_scenario_invalid",
        `resume '${step.id}' must immediately follow and reference a terminate_once run`,
        1,
      );
    }
  }
  if (runs === 0) {
    throw new EvalCoreError("eval_scenario_invalid", "scripted scenario must contain at least one run", 1);
  }
}

export function loadEvalScenario(input: unknown, serviceRegistry: EvalServiceRegistry): LoadedEvalScenario {
  const parsed = evalScenarioSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_scenario_invalid", "invalid eval scenario schema", 1, { cause: parsed.error });
  }
  if (parsed.data.kind === "scripted_v1") {
    validateScriptedSteps(parsed.data.steps);
  }
  const resolved = serviceRegistry.resolveSet(parsed.data.services);
  // PHASE14: the small DSL permits a crash only at durable allowlisted boundaries, making resume evidence repeatable and unavailable to normal CLI input.
  return Object.freeze({
    scenario: Object.freeze(parsed.data),
    resolvedServices: resolved.services,
    scenarioSha256: sha256Canonical(parsed.data),
    scenarioConfigSha256: sha256Canonical(parsed.data.config),
    serviceSetSha256: resolved.serviceSetSha256,
  });
}
