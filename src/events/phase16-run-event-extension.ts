import { z } from "zod";

import {
  agentModeSchema,
  agentModeSourceSchema,
} from "../agent/agent-mode.js";
import { goalIdSchema, revisionSchema } from "../goals/goal-schema.js";
import { planIdSchema, sha256Schema } from "../plans/plan-schema.js";

export const phase16RunBindingSchema = z
  .object({
    agent_mode: agentModeSchema,
    agent_mode_source: agentModeSourceSchema,
    goal_change_ledger_sha256: sha256Schema.nullable(),
    goal_id: goalIdSchema,
    goal_revision: revisionSchema,
    model_qualification_sha256: sha256Schema,
    plan_id: planIdSchema.nullable(),
    plan_revision: revisionSchema.nullable(),
    plan_sha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const planFields = [
      value.plan_id,
      value.plan_revision,
      value.plan_sha256,
    ];
    if (
      !(
        planFields.every((field) => field === null) ||
        planFields.every((field) => field !== null)
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Plan binding fields must be all null or all non-null",
      });
    }
    if (
      (value.agent_mode === "plan" &&
        value.goal_change_ledger_sha256 !== null) ||
      (value.agent_mode === "build" &&
        value.goal_change_ledger_sha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Plan mode requires a null Goal-change ledger and Build mode requires a hash",
        path: ["goal_change_ledger_sha256"],
      });
    }
  });

export type Phase16RunBinding = Readonly<
  z.infer<typeof phase16RunBindingSchema>
>;

export const PHASE16_RUN_BINDING_KEYS = Object.freeze([
  "agent_mode",
  "agent_mode_source",
  "goal_change_ledger_sha256",
  "goal_id",
  "goal_revision",
  "model_qualification_sha256",
  "plan_id",
  "plan_revision",
  "plan_sha256",
] as const);

export function stripPhase16RunBinding(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...data };
  for (const key of PHASE16_RUN_BINDING_KEYS) delete result[key];
  return result;
}
